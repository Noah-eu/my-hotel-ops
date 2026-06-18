const { cert, getApps, initializeApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const { getStorage } = require('firebase-admin/storage')
const {
    PREVIO_STAV_PARSER_VERSION,
    extractStateTextFromPdfBuffer,
    parsePrevioStatePdfText,
    buildPrevioStateImportPreview,
    evaluatePrevioStateImportSafety,
    detectMissingDatesInRange,
    buildByDateFromPreview
} = require('./lib/previo-state-preview')
const { sanitizeForFirestore, runSanitizerSelfCheck } = require('./lib/firestore-sanitize')

const MAX_PDF_BYTES = 10 * 1024 * 1024
const DEV = process.env.NODE_ENV !== 'production'

if (DEV) {
    try {
        runSanitizerSelfCheck()
    } catch (error) {
        console.error('[previo-import-email] Firestore sanitizer self-check failed', error)
        throw error
    }
}

function json(statusCode, body) {
    return {
        statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body)
    }
}

function getHeader(headers, key) {
    const exact = headers[key]
    if (exact) return exact
    const normalizedKey = key.toLowerCase()
    const match = Object.keys(headers || {}).find((headerKey) => headerKey.toLowerCase() === normalizedKey)
    return match ? headers[match] : undefined
}

function parseServiceAccount() {
    const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    if (!serviceAccountRaw) {
        throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON for email import function.')
    }

    return JSON.parse(serviceAccountRaw)
}

function getFirebaseApp() {
    if (getApps().length > 0) {
        return getApps()[0]
    }

    const serviceAccount = parseServiceAccount()
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET || serviceAccount.storage_bucket
    return initializeApp({
        credential: cert(serviceAccount),
        storageBucket: bucketName || undefined
    })
}

function getFirebaseContext() {
    const app = getFirebaseApp()
    const db = getFirestore(app)
    const storage = getStorage(app)
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET || app.options.storageBucket
    return {
        db,
        bucketName: bucketName || null,
        bucket: bucketName ? storage.bucket(bucketName) : null
    }
}

function looksLikePdf(fileName, contentType) {
    const lowerName = (fileName || '').toLowerCase()
    const lowerContentType = (contentType || '').toLowerCase()
    return lowerContentType === 'application/pdf' || lowerName.endsWith('.pdf')
}

function normalizeBase64(base64Value) {
    const raw = (base64Value || '').trim()
    if (!raw) return ''
    const dataUrlMatch = raw.match(/^data:application\/pdf;base64,(.+)$/i)
    const stripped = dataUrlMatch ? dataUrlMatch[1] : raw
    return stripped.replace(/\s+/g, '')
}

function decodePdfBase64(base64Value) {
    const normalized = normalizeBase64(base64Value)
    if (!normalized) {
        return { error: 'Missing pdfBase64 payload.' }
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) {
        return { error: 'Invalid pdfBase64 payload.' }
    }

    let buffer
    try {
        buffer = Buffer.from(normalized, 'base64')
    } catch {
        return { error: 'Invalid pdfBase64 payload.' }
    }

    if (!buffer || buffer.length === 0) {
        return { error: 'Invalid pdfBase64 payload.' }
    }

    if (buffer.length > MAX_PDF_BYTES) {
        return { error: 'PDF payload too large. Max 10 MB.', tooLarge: true }
    }

    return { buffer }
}

function normalizeContentType(contentType, fileName) {
    const value = typeof contentType === 'string' ? contentType.trim().toLowerCase() : ''
    if (value === 'application/pdf') return 'application/pdf'
    if (looksLikePdf(fileName, value)) return 'application/pdf'
    return null
}

function buildStoragePath(hotelId, jobId) {
    return `hotels/${hotelId}/importJobs/${jobId}/source.pdf`
}

function serializeError(error, fallbackMessage) {
    return error && error.message ? error.message : fallbackMessage
}

function sanitizePatchForWrite(payload, rootPath) {
    return sanitizeForFirestore(payload, rootPath).cleaned
}

function readBooleanEnv(name, fallback) {
    const value = process.env[name]
    if (typeof value !== 'string' || !value.trim()) return fallback
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false
    return fallback
}

function resolveAutoConfirmMode() {
    const enabled = readBooleanEnv('AUTO_CONFIRM_STAV_IMPORTS', false)
    const dryRun = readBooleanEnv('AUTO_CONFIRM_STAV_IMPORTS_DRY_RUN', true)
    if (enabled) return 'enabled'
    if (dryRun) return 'dry-run'
    return 'off'
}

function formatDateLabel(dateIso) {
    const date = new Date(`${dateIso}T00:00:00`)
    if (Number.isNaN(date.getTime())) return dateIso
    return date.toLocaleDateString('cs-CZ', {
        day: 'numeric',
        month: 'numeric',
        year: 'numeric'
    })
}

function buildAutoConfirmSummary({ mode, nextStatus, byDate, parsedTabDates, safety }) {
    const blockedReasons = []

    if (nextStatus !== 'needs_review') {
        blockedReasons.push('Import není ve stavu čeká na kontrolu.')
    }
    if (!byDate || Object.keys(byDate).length === 0) {
        blockedReasons.push('Chybí byDate data v náhledu.')
    }
    if (!parsedTabDates || Object.keys(parsedTabDates).length === 0) {
        blockedReasons.push('Chybí parsedTabDates v náhledu.')
    }
    if (!safety) {
        blockedReasons.push('Chybí safety summary importu.')
    } else if (safety.blocked) {
        blockedReasons.push('Safety kontrola import blokuje.')
    }

    const eligible = blockedReasons.length === 0
    const dryRun = mode !== 'enabled'
    const wouldConfirm = mode !== 'off' && eligible
    const decision = mode === 'off'
        ? 'blocked'
        : wouldConfirm
            ? (mode === 'dry-run' ? 'would_confirm' : 'pending')
            : 'blocked'

    return {
        mode,
        dryRun,
        evaluatedAt: new Date().toISOString(),
        eligible,
        wouldConfirm,
        blockedReasons,
        parserVersion: PREVIO_STAV_PARSER_VERSION,
        safetyStatus: safety?.status,
        decision
    }
}

function safeErrorMessage(error) {
    const code = String(error?.code || '')
    const message = String(error?.message || '')

    if (code.includes('storage/object-not-found') || message.includes('No such object')) {
        return 'Zdrojove PDF ve Storage nebylo nalezeno.'
    }
    if (code.includes('storage/unauthorized') || message.toLowerCase().includes('permission denied')) {
        return 'Server nema opravneni cist zdrojove PDF ve Storage.'
    }
    if (message) return message.slice(0, 300)
    return 'Generovani nahledu selhalo.'
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return json(405, { error: 'Method not allowed' })
    }

    const configuredSecret = process.env.PREVIO_IMPORT_SECRET
    if (!configuredSecret) {
        return json(500, { error: 'Server is missing PREVIO_IMPORT_SECRET.' })
    }

    const providedSecret = getHeader(event.headers || {}, 'X-Import-Secret')
    if (!providedSecret || providedSecret !== configuredSecret) {
        return json(401, { error: 'Unauthorized import request.' })
    }

    let payload
    try {
        const rawBody = event.isBase64Encoded && event.body
            ? Buffer.from(event.body, 'base64').toString('utf-8')
            : (event.body || '{}')
        payload = JSON.parse(rawBody)
    } catch {
        return json(400, { error: 'Invalid JSON body.' })
    }

    const fileName = (payload.fileName || '').trim() || 'previo-stav.pdf'
    const contentType = normalizeContentType(payload.contentType, fileName)

    if (!contentType) {
        return json(400, { error: 'Only PDF payloads are accepted.' })
    }

    const decodedPdf = decodePdfBase64(payload.pdfBase64)
    if (decodedPdf.error) {
        return json(decodedPdf.tooLarge ? 413 : 400, { error: decodedPdf.error })
    }

    const hotelId = process.env.PREVIO_IMPORT_HOTEL_ID || 'chill-apartments'

    try {
        const { db, bucket, bucketName } = getFirebaseContext()
        if (!bucket || !bucketName) {
            return json(500, { error: 'PDF storage not configured' })
        }

        const jobRef = db.collection('hotels').doc(hotelId).collection('importJobs').doc()
        const nowIso = new Date().toISOString()
        const sizeBytes = decodedPdf.buffer.byteLength
        const storagePath = buildStoragePath(hotelId, jobRef.id)
        const autoConfirmMode = resolveAutoConfirmMode()
        const autoConfirmDryRun = autoConfirmMode !== 'enabled'

        await bucket.file(storagePath).save(decodedPdf.buffer, {
            resumable: false,
            contentType,
            metadata: {
                contentType,
                metadata: {
                    hotelId,
                    source: 'email',
                    jobId: jobRef.id,
                    fileName,
                    receivedAt: nowIso
                }
            }
        })

        await jobRef.set(sanitizePatchForWrite({
            type: 'previo-state-pdf',
            source: 'email',
            status: 'received',
            fileName,
            contentType,
            sizeBytes,
            receivedAt: nowIso,
            parsedAt: null,
            confirmedAt: null,
            confirmedBy: null,
            detectedDaysCount: null,
            turnoverCount: null,
            stayoverCount: null,
            freeCount: null,
            warnings: ['PDF z e-mailu je uložené. Náhled bude dostupný po serverovém zpracování.'],
            error: null,
            storagePath,
            previewSummary: null,
            parserVersion: 'email-ingest-v3',
            automation: {
                autoPreview: {
                    status: 'pending',
                    checkedAt: nowIso
                },
                autoConfirm: {
                    mode: autoConfirmMode,
                    dryRun: autoConfirmDryRun,
                    evaluatedAt: nowIso,
                    eligible: false,
                    wouldConfirm: false,
                    blockedReasons: ['Ceka na serverove zpracovani nahledu.'],
                    parserVersion: PREVIO_STAV_PARSER_VERSION,
                    decision: autoConfirmMode === 'off' ? 'blocked' : 'pending'
                }
            }
        }, 'importJob.initialPatch'))

        try {
            const [pdfBuffer] = await bucket.file(storagePath).download()
            const extracted = await extractStateTextFromPdfBuffer(pdfBuffer)
            const parsed = parsePrevioStatePdfText(extracted, new Date())

            const roomsSnap = await db.collection('hotels').doc(hotelId).collection('rooms').get()
            const roomCatalog = roomsSnap.docs
                .map((d) => d.data() || {})
                .map((room) => ({ roomNumber: String(room.roomNumber || '').trim() }))
                .filter((room) => room.roomNumber)

            const preview = buildPrevioStateImportPreview(parsed, roomCatalog, new Date())
            const missingDateIsos = detectMissingDatesInRange(preview.days.map((day) => day.dateIso))
            const missingDateLabels = missingDateIsos.map((dateIso) => formatDateLabel(dateIso))
            const byDate = buildByDateFromPreview(preview, roomCatalog)
            const safety = evaluatePrevioStateImportSafety({
                preview,
                missingDateLabels,
                parserVersion: PREVIO_STAV_PARSER_VERSION,
                checkedAt: new Date()
            })

            const previewWarnings = [...preview.warnings, ...safety.warnings, ...safety.blocks]
            if (missingDateLabels.length > 0) {
                previewWarnings.push(`V nahledu chybi dny uprostred rozsahu: ${missingDateLabels.join(', ')}`)
            }

            const nextStatus = preview.confidenceLow || missingDateLabels.length > 0 || safety.blocked
                ? 'parsed'
                : 'needs_review'

            const autoConfirmSummary = buildAutoConfirmSummary({
                mode: autoConfirmMode,
                nextStatus,
                byDate,
                parsedTabDates: preview.parsedTabDates,
                safety
            })

            const parsedPatch = sanitizePatchForWrite({
                status: nextStatus,
                parsedAt: new Date().toISOString(),
                detectedDaysCount: preview.days.length,
                turnoverCount: preview.turnoverCount,
                stayoverCount: preview.stayoverCount,
                freeCount: preview.derivedFreeCount,
                warnings: previewWarnings,
                previewSummary: {
                    parsedTabDates: preview.parsedTabDates,
                    byDate,
                    missingDateLabels,
                    parserVersion: PREVIO_STAV_PARSER_VERSION,
                    safety,
                    preview
                },
                parserVersion: PREVIO_STAV_PARSER_VERSION,
                error: null,
                automation: {
                    autoPreview: {
                        status: 'done',
                        checkedAt: new Date().toISOString(),
                        error: null
                    },
                    autoConfirm: autoConfirmSummary
                }
            }, 'importJob.autoPreviewPatch')

            await jobRef.set(parsedPatch, { merge: true })

            return json(200, {
                ok: true,
                jobId: jobRef.id,
                status: nextStatus,
                sizeBytes,
                autoPreview: 'done',
                autoConfirmMode,
                autoConfirmDryRun,
                autoConfirmWouldConfirm: autoConfirmSummary.wouldConfirm,
                autoConfirmBlockedReasons: autoConfirmSummary.blockedReasons
            })
        } catch (previewError) {
            const safeMessage = safeErrorMessage(previewError)
            const failedPatch = sanitizePatchForWrite({
                status: 'failed',
                parsedAt: new Date().toISOString(),
                error: safeMessage,
                automation: {
                    autoPreview: {
                        status: 'error',
                        checkedAt: new Date().toISOString(),
                        error: safeMessage
                    },
                    autoConfirm: {
                        mode: autoConfirmMode,
                        dryRun: autoConfirmDryRun,
                        evaluatedAt: new Date().toISOString(),
                        eligible: false,
                        wouldConfirm: false,
                        blockedReasons: ['Automaticky nahled selhal.'],
                        parserVersion: PREVIO_STAV_PARSER_VERSION,
                        decision: 'blocked'
                    }
                }
            }, 'importJob.autoPreviewFailurePatch')

            await jobRef.set(failedPatch, { merge: true })

            return json(200, {
                ok: true,
                jobId: jobRef.id,
                status: 'failed',
                sizeBytes,
                autoPreview: 'error',
                error: safeMessage
            })
        }
    } catch (error) {
        return json(500, {
            error: serializeError(error, 'Failed to create import job.')
        })
    }
}
