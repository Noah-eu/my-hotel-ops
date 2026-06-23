import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const emailImportFunction = require('../netlify/functions/previo-import-email.js')

const root = process.cwd()

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

async function resolveExistingPath(candidates) {
    for (const rel of candidates) {
        const full = path.isAbsolute(rel) ? rel : path.join(root, rel)
        try {
            await fs.access(full)
            return full
        } catch {
            // try next
        }
    }
    return null
}

function deepMerge(base, patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
    const source = (base && typeof base === 'object' && !Array.isArray(base)) ? base : {}
    const merged = { ...source }
    Object.entries(patch).forEach(([key, value]) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            merged[key] = deepMerge(source[key], value)
            return
        }
        merged[key] = value
    })
    return merged
}

function makeInMemoryFirebaseContext() {
    const storedFiles = new Map()
    const importJobsById = new Map()
    let nextJobId = 1

    const bucket = {
        file(storagePath) {
            return {
                async save(buffer, options = {}) {
                    storedFiles.set(storagePath, {
                        size: buffer.byteLength,
                        contentType: options.contentType || '',
                        metadata: options.metadata || null
                    })
                }
            }
        }
    }

    const db = {
        collection(name) {
            assert(name === 'hotels', `Unexpected top-level collection: ${name}`)
            return {
                doc(hotelId) {
                    return {
                        collection(child) {
                            if (child === 'importJobs') {
                                return {
                                    doc() {
                                        const id = `job-test-${nextJobId++}`
                                        return {
                                            id,
                                            async set(patch, options = {}) {
                                                const previous = importJobsById.get(id) || {}
                                                const next = options.merge ? deepMerge(previous, patch) : patch
                                                importJobsById.set(id, next)
                                            }
                                        }
                                    }
                                }
                            }

                            if (child === 'rooms') {
                                return {
                                    async get() {
                                        return { docs: [] }
                                    }
                                }
                            }

                            throw new Error(`Unexpected nested collection under hotel ${hotelId}: ${child}`)
                        }
                    }
                }
            }
        }
    }

    return {
        context: {
            db,
            bucketName: 'test-bucket',
            bucket
        },
        readStoredImportJob() {
            const entries = Array.from(importJobsById.entries())
            assert(entries.length === 1, `Expected exactly one import job, got ${entries.length}`)
            const [jobId, data] = entries[0]
            return { jobId, data }
        },
        readStoredFiles() {
            return Array.from(storedFiles.entries())
        }
    }
}

async function main() {
    assert(emailImportFunction && typeof emailImportFunction.handler === 'function', 'previo-import-email handler is unavailable')
    assert(emailImportFunction._test && typeof emailImportFunction._test.setFirebaseContextProvider === 'function', 'previo-import-email test hooks are unavailable')

    const xlsxPath = await resolveExistingPath([
        'private-sources/previo/denni_prehled - Stav - 22. 6. - 27. 6..xlsx',
        'private-sources/previo/Stav.xlsx'
    ])
    const pdfPath = await resolveExistingPath([
        'private-sources/previo/stav-2026-06-22-1901.pdf',
        'private-sources/previo/stav-2026-06-22-0702.pdf'
    ])

    if (!xlsxPath || !pdfPath) {
        console.log('[validate:previo-import-email-runtime] SKIP')
        console.log(`- Missing local fixtures. xlsx: ${xlsxPath ? 'ok' : 'missing'}, pdf: ${pdfPath ? 'ok' : 'missing'}`)
        process.exit(0)
    }

    const [xlsxBuffer, pdfBuffer] = await Promise.all([
        fs.readFile(xlsxPath),
        fs.readFile(pdfPath)
    ])

    const inMemory = makeInMemoryFirebaseContext()
    emailImportFunction._test.setFirebaseContextProvider(() => inMemory.context)

    const oldSecret = process.env.PREVIO_IMPORT_SECRET
    const oldHotelId = process.env.PREVIO_IMPORT_HOTEL_ID
    process.env.PREVIO_IMPORT_SECRET = 'test-import-secret'
    process.env.PREVIO_IMPORT_HOTEL_ID = 'chill-apartments'

    try {
        const event = {
            httpMethod: 'POST',
            headers: {
                'X-Import-Secret': 'test-import-secret'
            },
            body: JSON.stringify({
                source: 'email',
                importerMode: 'gmail-apps-script',
                fileName: path.basename(xlsxPath),
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                fileBase64: xlsxBuffer.toString('base64'),
                overlayFileName: path.basename(pdfPath),
                overlayContentType: 'application/pdf',
                overlayFileBase64: pdfBuffer.toString('base64')
            }),
            isBase64Encoded: false
        }

        const response = await emailImportFunction.handler(event)
        const body = JSON.parse(String(response?.body || '{}'))

        assert(response?.statusCode === 200, `Expected HTTP 200, got ${response?.statusCode}`)
        assert(body?.ok === true, 'Expected ok=true response')
        assert(body?.autoPreview === 'done', `Expected autoPreview=done, got ${String(body?.autoPreview || '')}`)
        assert(!String(body?.error || '').toLowerCase().includes('preview is not defined'), 'Response error still contains "preview is not defined"')

        const { jobId, data: savedJob } = inMemory.readStoredImportJob()
        assert(jobId === body.jobId, `Response jobId mismatch: ${body.jobId} vs ${jobId}`)
        assert(savedJob.status === 'needs_review' || savedJob.status === 'parsed', `Unexpected saved status: ${savedJob.status}`)

        const previewSummary = savedJob.previewSummary || {}
        assert(previewSummary.preview && Array.isArray(previewSummary.preview.days), 'Saved job is missing previewSummary.preview.days')
        assert(previewSummary.byDate && Object.keys(previewSummary.byDate).length > 0, 'Saved job is missing previewSummary.byDate')
        assert(previewSummary.parsedTabDates && Object.keys(previewSummary.parsedTabDates).length > 0, 'Saved job is missing previewSummary.parsedTabDates')

        const diagnostics = previewSummary.diagnostics || {}
        assert(diagnostics.processingPath === 'email-ingest', `Expected diagnostics.processingPath=email-ingest, got ${diagnostics.processingPath}`)
        assert(diagnostics.endpoint === 'previo-import-email', `Expected diagnostics.endpoint=previo-import-email, got ${diagnostics.endpoint}`)
        assert(typeof diagnostics.parserBuildId === 'string' && diagnostics.parserBuildId.length > 0, 'Missing diagnostics.parserBuildId')
        assert(diagnostics.primary && diagnostics.primary.storagePath, 'Missing diagnostics.primary.storagePath')
        assert(diagnostics.overlay && diagnostics.overlay.storagePath, 'Missing diagnostics.overlay.storagePath')
        assert(diagnostics.overlay && diagnostics.overlay.attached === true, 'Expected diagnostics.overlay.attached=true')

        const storedFiles = inMemory.readStoredFiles()
        assert(storedFiles.length === 2, `Expected two stored files (primary+overlay), got ${storedFiles.length}`)

        console.log('[validate:previo-import-email-runtime] PASS')
        console.log(`- jobId: ${jobId}`)
        console.log(`- status: ${savedJob.status}`)
        console.log(`- preview days: ${previewSummary.preview.days.length}`)
        console.log(`- byDate dates: ${Object.keys(previewSummary.byDate).length}`)
    } finally {
        emailImportFunction._test.clearFirebaseContextProvider()

        if (typeof oldSecret === 'undefined') delete process.env.PREVIO_IMPORT_SECRET
        else process.env.PREVIO_IMPORT_SECRET = oldSecret

        if (typeof oldHotelId === 'undefined') delete process.env.PREVIO_IMPORT_HOTEL_ID
        else process.env.PREVIO_IMPORT_HOTEL_ID = oldHotelId
    }
}

main().catch((error) => {
    console.error('[validate:previo-import-email-runtime] FAIL')
    console.error(error?.stack || String(error))
    process.exit(1)
})
