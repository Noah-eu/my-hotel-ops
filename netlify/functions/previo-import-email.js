const { cert, getApps, initializeApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const { getStorage } = require('firebase-admin/storage')
const {
    PREVIO_STAV_PARSER_VERSION,
    extractStateDataFromXlsxBuffer,
    extractStateTextFromPdfBuffer,
    parsePrevioStateXlsxData,
    parsePrevioStatePdfText,
    buildPrevioStateImportPreview,
    evaluatePrevioStateImportSafety,
    detectMissingDatesInRange,
    buildByDateFromPreview
} = require('./lib/previo-state-preview')
const {
    overlayArrivalTimesFromPdf,
    annotatePreviewWithArrivalOverlay,
    annotateByDateWithArrivalOverlay
} = require('./lib/previo-arrival-overlay')
const { sanitizeForFirestore, runSanitizerSelfCheck } = require('./lib/firestore-sanitize')

const MAX_IMPORT_BYTES = 10 * 1024 * 1024
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

function looksLikeSpreadsheet(fileName, contentType) {
    const lowerName = (fileName || '').toLowerCase()
    const lowerContentType = (contentType || '').toLowerCase()
    return lowerContentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        || lowerContentType === 'application/vnd.ms-excel'
        || lowerName.endsWith('.xlsx')
        || lowerName.endsWith('.xls')
}

function resolveImportKind(fileName, contentType) {
    const lowerName = (fileName || '').toLowerCase()
    const lowerContentType = (contentType || '').toLowerCase()

    if (lowerContentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || lowerName.endsWith('.xlsx')) {
        return 'xlsx'
    }
    if (lowerContentType === 'application/vnd.ms-excel' || lowerName.endsWith('.xls')) {
        return 'xls'
    }
    if (looksLikePdf(fileName, contentType)) {
        return 'pdf'
    }
    return null
}

function normalizeBase64(base64Value) {
    const raw = (base64Value || '').trim()
    if (!raw) return ''
    const dataUrlMatch = raw.match(/^data:[^;]+;base64,(.+)$/i)
    const stripped = dataUrlMatch ? dataUrlMatch[1] : raw
    return stripped.replace(/\s+/g, '')
}

function decodeImportBase64(base64Value) {
    const normalized = normalizeBase64(base64Value)
    if (!normalized) {
        return { error: 'Missing fileBase64 payload.' }
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) {
        return { error: 'Invalid fileBase64 payload.' }
    }

    let buffer
    try {
        buffer = Buffer.from(normalized, 'base64')
    } catch {
        return { error: 'Invalid fileBase64 payload.' }
    }

    if (!buffer || buffer.length === 0) {
        return { error: 'Invalid fileBase64 payload.' }
    }

    if (buffer.length > MAX_IMPORT_BYTES) {
        return { error: 'Import payload too large. Max 10 MB.', tooLarge: true }
    }

    return { buffer }
}

function normalizeContentType(contentType, fileName) {
    const value = typeof contentType === 'string' ? contentType.trim().toLowerCase() : ''
    if (value === 'application/pdf') return 'application/pdf'
    if (value === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
        return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }
    if (value === 'application/vnd.ms-excel') return 'application/vnd.ms-excel'
    if (looksLikeSpreadsheet(fileName, value)) {
        return (fileName || '').toLowerCase().endsWith('.xls')
            ? 'application/vnd.ms-excel'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }
    if (looksLikePdf(fileName, value)) return 'application/pdf'
    return null
}

function buildStoragePath(hotelId, jobId, importKind, baseName = 'source') {
    const extension = importKind === 'xlsx'
        ? 'xlsx'
        : importKind === 'xls'
            ? 'xls'
            : 'pdf'
    return `hotels/${hotelId}/importJobs/${jobId}/${baseName}.${extension}`
}

function getSourceFileLabel(importKind) {
    if (importKind === 'xlsx' || importKind === 'xls') return 'XLS Stav'
    return 'PDF Stav'
}

async function parseImportBuffer({ buffer, fileName, contentType, referenceDate }) {
    const importKind = resolveImportKind(fileName, contentType)
    if (importKind === 'xlsx' || importKind === 'xls') {
        const extracted = extractStateDataFromXlsxBuffer(buffer)
        return parsePrevioStateXlsxData(extracted, referenceDate)
    }

    const extracted = await extractStateTextFromPdfBuffer(buffer)
    return parsePrevioStatePdfText(extracted, referenceDate)
}

function resolvePrimaryAttachmentPayload(payload) {
    const fileName = String(payload?.fileName || '').trim() || 'previo-stav.pdf'
    const contentType = normalizeContentType(payload?.contentType, fileName)
    const importKind = resolveImportKind(fileName, contentType)
    const decodedFile = decodeImportBase64(payload?.fileBase64 || payload?.pdfBase64)

    return {
        fileName,
        contentType,
        importKind,
        decodedFile
    }
}

function resolveOverlayAttachmentPayload(payload) {
    const overlayBase64 = payload?.overlayFileBase64 || payload?.overlayPdfBase64
    if (!overlayBase64) return null

    const fileName = String(payload?.overlayFileName || '').trim() || 'previo-stav-overlay.pdf'
    const contentType = normalizeContentType(payload?.overlayContentType, fileName)
    const importKind = resolveImportKind(fileName, contentType)
    const decodedFile = decodeImportBase64(overlayBase64)

    return {
        fileName,
        contentType,
        importKind,
        decodedFile
    }
}

async function parseHybridImportBuffers({ primary, overlay, referenceDate }) {
    const parsedPrimary = await parseImportBuffer({
        buffer: primary.buffer,
        fileName: primary.fileName,
        contentType: primary.contentType,
        referenceDate
    })

    if (!overlay || !overlay.buffer || overlay.importKind !== 'pdf') {
        return {
            parsed: parsedPrimary,
            arrivalOverlay: {
                enabled: false,
                mode: 'none',
                primaryKind: primary.importKind,
                overlayKind: overlay?.importKind || null,
                consideredRows: 0,
                matchedRows: 0,
                appliedRows: 0,
                skippedBySpecificity: 0,
                skippedByIdentityMismatch: 0,
                skippedByAmbiguousMatch: 0,
                skippedWithoutMainTime: 0,
                applied: [],
                auditCheckedRows: 0,
                auditMismatches: 0,
                audit: []
            }
        }
    }

    const parsedOverlay = await parseImportBuffer({
        buffer: overlay.buffer,
        fileName: overlay.fileName,
        contentType: overlay.contentType,
        referenceDate
    })

    return overlayArrivalTimesFromPdf({
        primaryParsed: parsedPrimary,
        overlayParsed: parsedOverlay,
        primaryKind: primary.importKind
    })
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
    const parsedButSuspicious = nextStatus === 'parsed' && Boolean(safety?.blocked)

    if (parsedButSuspicious) {
        blockedReasons.push('Náhled vytvořen, ale import je podezřelý.')
    } else if (nextStatus !== 'needs_review') {
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
            ; (safety.blocks || []).slice(0, 3).forEach((reason) => {
                if (!blockedReasons.includes(reason)) blockedReasons.push(reason)
            })
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
        return 'Zdrojovy soubor ve Storage nebyl nalezen.'
    }
    if (code.includes('storage/unauthorized') || message.toLowerCase().includes('permission denied')) {
        return 'Server nema opravneni cist zdrojovy soubor ve Storage.'
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

    const primaryPayload = resolvePrimaryAttachmentPayload(payload)
    if (!primaryPayload.contentType || !primaryPayload.importKind) {
        return json(400, { error: 'Only PDF, XLS, and XLSX payloads are accepted.' })
    }

    if (primaryPayload.decodedFile.error) {
        return json(primaryPayload.decodedFile.tooLarge ? 413 : 400, { error: primaryPayload.decodedFile.error })
    }

    const overlayPayload = resolveOverlayAttachmentPayload(payload)
    if (overlayPayload) {
        if (!overlayPayload.contentType || !overlayPayload.importKind) {
            return json(400, { error: 'Overlay attachment must be a valid PDF payload.' })
        }
        if (overlayPayload.decodedFile.error) {
            return json(overlayPayload.decodedFile.tooLarge ? 413 : 400, { error: overlayPayload.decodedFile.error })
        }
        if (overlayPayload.importKind !== 'pdf') {
            return json(400, { error: 'Overlay attachment must be a PDF file.' })
        }
        if (!(primaryPayload.importKind === 'xlsx' || primaryPayload.importKind === 'xls')) {
            return json(400, { error: 'PDF overlay is supported only when primary source is XLS/XLSX.' })
        }
    }

    const hotelId = process.env.PREVIO_IMPORT_HOTEL_ID || 'chill-apartments'

    try {
        const { db, bucket, bucketName } = getFirebaseContext()
        if (!bucket || !bucketName) {
            return json(500, { error: 'Import storage not configured' })
        }

        const jobRef = db.collection('hotels').doc(hotelId).collection('importJobs').doc()
        const nowIso = new Date().toISOString()
        const primaryBuffer = primaryPayload.decodedFile.buffer
        const overlayBuffer = overlayPayload ? overlayPayload.decodedFile.buffer : null
        const sizeBytes = primaryBuffer.byteLength
        const overlaySizeBytes = overlayBuffer ? overlayBuffer.byteLength : null
        const storagePath = buildStoragePath(hotelId, jobRef.id, primaryPayload.importKind, 'source')
        const overlayStoragePath = overlayPayload
            ? buildStoragePath(hotelId, jobRef.id, overlayPayload.importKind, 'overlay')
            : null
        const autoConfirmMode = resolveAutoConfirmMode()
        const autoConfirmDryRun = autoConfirmMode !== 'enabled'

        await bucket.file(storagePath).save(primaryBuffer, {
            resumable: false,
            contentType: primaryPayload.contentType,
            metadata: {
                contentType: primaryPayload.contentType,
                metadata: {
                    hotelId,
                    source: 'email',
                    jobId: jobRef.id,
                    fileName: primaryPayload.fileName,
                    receivedAt: nowIso
                }
            }
        })

        if (overlayPayload && overlayStoragePath) {
            await bucket.file(overlayStoragePath).save(overlayBuffer, {
                resumable: false,
                contentType: overlayPayload.contentType,
                metadata: {
                    contentType: overlayPayload.contentType,
                    metadata: {
                        hotelId,
                        source: 'email-overlay',
                        jobId: jobRef.id,
                        fileName: overlayPayload.fileName,
                        receivedAt: nowIso
                    }
                }
            })
        }

        await jobRef.set(sanitizePatchForWrite({
            type: 'previo-state-pdf',
            source: 'email',
            status: 'received',
            fileName: primaryPayload.fileName,
            contentType: primaryPayload.contentType,
            sizeBytes,
            overlayFileName: overlayPayload?.fileName || null,
            overlayContentType: overlayPayload?.contentType || null,
            overlaySizeBytes,
            receivedAt: nowIso,
            parsedAt: null,
            confirmedAt: null,
            confirmedBy: null,
            detectedDaysCount: null,
            turnoverCount: null,
            stayoverCount: null,
            freeCount: null,
            warnings: [
                `${getSourceFileLabel(primaryPayload.importKind)} z e-mailu je uložený. Náhled bude dostupný po serverovém zpracování.`,
                ...(overlayPayload ? ['Párový PDF report je uložený pro overlay časů příjezdů.'] : [])
            ],
            error: null,
            storagePath,
            overlayStoragePath,
            previewSummary: null,
            parserVersion: 'email-ingest-v5',
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
            const parseResult = await parseHybridImportBuffers({
                primary: {
                    buffer: primaryBuffer,
                    fileName: primaryPayload.fileName,
                    contentType: primaryPayload.contentType,
                    importKind: primaryPayload.importKind
                },
                overlay: overlayPayload
                    ? {
                        buffer: overlayBuffer,
                        fileName: overlayPayload.fileName,
                        contentType: overlayPayload.contentType,
                        importKind: overlayPayload.importKind
                    }
                    : null,
                referenceDate: new Date()
            })
            const parsed = parseResult.parsed
            const arrivalOverlay = parseResult.arrivalOverlay

            const roomsSnap = await db.collection('hotels').doc(hotelId).collection('rooms').get()
            const roomCatalog = roomsSnap.docs
                .map((d) => d.data() || {})
                .map((room) => ({ roomNumber: String(room.roomNumber || '').trim() }))
                .filter((room) => room.roomNumber)

            let preview = buildPrevioStateImportPreview(parsed, roomCatalog, new Date())
            const missingDateIsos = detectMissingDatesInRange(preview.days.map((day) => day.dateIso))
            const missingDateLabels = missingDateIsos.map((dateIso) => formatDateLabel(dateIso))
            if ((arrivalOverlay?.appliedRows || 0) > 0) {
                preview = annotatePreviewWithArrivalOverlay(preview, arrivalOverlay.applied)
            }
            let byDate = buildByDateFromPreview(preview, roomCatalog)
            if ((arrivalOverlay?.appliedRows || 0) > 0) {
                byDate = annotateByDateWithArrivalOverlay(byDate, arrivalOverlay.applied)
            }
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
            if ((arrivalOverlay?.auditMismatches || 0) > 0) {
                previewWarnings.push(`Parovy PDF overlay: ${arrivalOverlay.auditMismatches} radku ma hlavni PDF cas odlisny od finalniho casu.`)
            }

            const nextStatus = preview.confidenceLow
                || missingDateLabels.length > 0
                || safety.blocked
                || (arrivalOverlay?.auditMismatches || 0) > 0
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
                    arrivalOverlay,
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
