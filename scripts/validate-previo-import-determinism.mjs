import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { PREVIO_STAV_PARSER_VERSION } = require('../netlify/functions/lib/previo-state-preview.js')
const {
    parseImportSources,
    resolveImportKind,
    computeBufferSha256,
    buildImportPreviewArtifacts
} = require('../netlify/functions/lib/previo-import-processing.js')

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

function sortKeysDeep(value) {
    if (Array.isArray(value)) return value.map(sortKeysDeep)
    if (!value || typeof value !== 'object') return value

    return Object.keys(value)
        .sort()
        .reduce((acc, key) => {
            acc[key] = sortKeysDeep(value[key])
            return acc
        }, {})
}

function stableJson(value) {
    return JSON.stringify(sortKeysDeep(value))
}

function buildCoreSignature(artifacts) {
    return {
        nextStatus: artifacts.nextStatus,
        missingDateLabels: artifacts.missingDateLabels,
        previewWarnings: artifacts.previewWarnings,
        preview: artifacts.preview,
        byDate: artifacts.byDate,
        safety: artifacts.safety,
        arrivalOverlayMismatchRows: artifacts.arrivalOverlayMismatchRows,
        debugProbeRows: artifacts.debugProbeRows
    }
}

function buildArtifacts(input) {
    const parserBuildId = 'determinism-test-build'
    const previewGeneratedAt = '2026-06-22T19:01:00.000Z'

    return buildImportPreviewArtifacts({
        ...input,
        referenceDate: new Date('2026-06-22T00:00:00.000Z'),
        importedAt: '22.06.2026 19:01',
        parserVersion: PREVIO_STAV_PARSER_VERSION,
        parserBuildId,
        parserFileVersion: PREVIO_STAV_PARSER_VERSION,
        previewGeneratedAt,
        debugProbeKeys: [
            '2026-06-22/201',
            '2026-06-22/202',
            '2026-06-24/205'
        ]
    })
}

async function main() {
    const xlsxPath = await resolveExistingPath([
        'private-sources/previo/denni_prehled - Stav - 22. 6. - 27. 6..xlsx',
        'private-sources/previo/Stav.xlsx'
    ])
    const pdfPath = await resolveExistingPath([
        'private-sources/previo/stav-2026-06-22-1901.pdf',
        'private-sources/previo/stav-2026-06-22-0702.pdf'
    ])

    if (!xlsxPath || !pdfPath) {
        console.log('[validate:previo-import-determinism] SKIP')
        console.log(`- Missing local fixtures. xlsx: ${xlsxPath ? 'ok' : 'missing'}, pdf: ${pdfPath ? 'ok' : 'missing'}`)
        process.exit(0)
    }

    const [xlsxBuffer, pdfBuffer] = await Promise.all([
        fs.readFile(xlsxPath),
        fs.readFile(pdfPath)
    ])

    const parseResult = await parseImportSources({
        primary: {
            buffer: xlsxBuffer,
            fileName: path.basename(xlsxPath),
            contentType: '',
            storagePath: 'hotels/chill-apartments/importJobs/determinism/source.xlsx',
            importKind: resolveImportKind(path.basename(xlsxPath), '', 'source.xlsx')
        },
        overlay: {
            buffer: pdfBuffer,
            fileName: path.basename(pdfPath),
            contentType: 'application/pdf',
            storagePath: 'hotels/chill-apartments/importJobs/determinism/overlay.pdf',
            importKind: 'pdf'
        },
        referenceDate: new Date('2026-06-22T00:00:00.000Z')
    })

    const roomCatalog = []

    const ingestRunOne = buildArtifacts({
        parsed: parseResult.parsed,
        arrivalOverlay: parseResult.arrivalOverlay,
        roomCatalog,
        previewGeneratedBy: 'previo-import-email',
        previewRequestId: 'determinism-email-1',
        previewFreshGenerated: true,
        processingPath: 'email-ingest',
        source: 'email',
        importerMode: 'gmail-apps-script',
        primary: {
            fileName: path.basename(xlsxPath),
            contentType: '',
            storagePath: 'hotels/chill-apartments/importJobs/determinism/source.xlsx',
            importKind: 'xlsx',
            sizeBytes: xlsxBuffer.byteLength,
            sha256: computeBufferSha256(xlsxBuffer)
        },
        overlay: {
            fileName: path.basename(pdfPath),
            contentType: 'application/pdf',
            storagePath: 'hotels/chill-apartments/importJobs/determinism/overlay.pdf',
            importKind: 'pdf',
            sizeBytes: pdfBuffer.byteLength,
            sha256: computeBufferSha256(pdfBuffer)
        }
    })

    const ingestRunTwo = buildArtifacts({
        parsed: parseResult.parsed,
        arrivalOverlay: parseResult.arrivalOverlay,
        roomCatalog,
        previewGeneratedBy: 'previo-import-email',
        previewRequestId: 'determinism-email-2',
        previewFreshGenerated: true,
        processingPath: 'email-ingest',
        source: 'email',
        importerMode: 'gmail-apps-script',
        primary: {
            fileName: path.basename(xlsxPath),
            contentType: '',
            storagePath: 'hotels/chill-apartments/importJobs/determinism/source.xlsx',
            importKind: 'xlsx',
            sizeBytes: xlsxBuffer.byteLength,
            sha256: computeBufferSha256(xlsxBuffer)
        },
        overlay: {
            fileName: path.basename(pdfPath),
            contentType: 'application/pdf',
            storagePath: 'hotels/chill-apartments/importJobs/determinism/overlay.pdf',
            importKind: 'pdf',
            sizeBytes: pdfBuffer.byteLength,
            sha256: computeBufferSha256(pdfBuffer)
        }
    })

    const regenerateRun = buildArtifacts({
        parsed: parseResult.parsed,
        arrivalOverlay: parseResult.arrivalOverlay,
        roomCatalog,
        previewGeneratedBy: 'previo-import-preview',
        previewRequestId: 'determinism-regenerate-1',
        previewFreshGenerated: false,
        processingPath: 'preview-regenerate',
        source: 'email',
        importerMode: 'gmail-apps-script',
        primary: {
            fileName: path.basename(xlsxPath),
            contentType: '',
            storagePath: 'hotels/chill-apartments/importJobs/determinism/source.xlsx',
            importKind: 'xlsx',
            sizeBytes: xlsxBuffer.byteLength,
            sha256: computeBufferSha256(xlsxBuffer)
        },
        overlay: {
            fileName: path.basename(pdfPath),
            contentType: 'application/pdf',
            storagePath: 'hotels/chill-apartments/importJobs/determinism/overlay.pdf',
            importKind: 'pdf',
            sizeBytes: pdfBuffer.byteLength,
            sha256: computeBufferSha256(pdfBuffer)
        }
    })

    const ingestCoreOne = buildCoreSignature(ingestRunOne)
    const ingestCoreTwo = buildCoreSignature(ingestRunTwo)
    const regenerateCore = buildCoreSignature(regenerateRun)

    assert(
        stableJson(ingestCoreOne) === stableJson(ingestCoreTwo),
        'Determinism failed: identical ingest runs produced different core artifacts.'
    )

    assert(
        stableJson(ingestCoreOne) === stableJson(regenerateCore),
        'Path parity failed: ingest vs regenerate produced different core artifacts.'
    )

    assert(ingestRunOne.previewSummary.previewFreshGenerated === true, 'Ingest summary should mark previewFreshGenerated=true')
    assert(regenerateRun.previewSummary.previewFreshGenerated === false, 'Regenerate summary should mark previewFreshGenerated=false')

    console.log('[validate:previo-import-determinism] PASS')
    console.log(`- XLS fixture: ${path.basename(xlsxPath)}`)
    console.log(`- PDF fixture: ${path.basename(pdfPath)}`)
    console.log(`- byDate dates: ${Object.keys(ingestRunOne.byDate || {}).length}`)
    console.log(`- overlay applied rows: ${parseResult.arrivalOverlay?.appliedRows || 0}`)
}

main().catch((error) => {
    console.error('[validate:previo-import-determinism] FAIL')
    console.error(error?.stack || String(error))
    process.exit(1)
})
