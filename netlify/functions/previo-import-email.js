const { cert, getApps, initializeApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const { getStorage } = require('firebase-admin/storage')
const {
    PREVIO_STAV_PARSER_VERSION
} = require('./lib/previo-state-preview')
const {
    resolveImportKind,
    parseImportSources,
    resolveParserBuildId,
    createPreviewRequestId,
    computeBufferSha256,
    buildImportPreviewArtifacts
} = require('./lib/previo-import-processing')
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

const testOverrides = {
    getFirebaseContext: null
}

function resolveFirebaseContext() {
    if (typeof testOverrides.getFirebaseContext === 'function') {
        return testOverrides.getFirebaseContext()
    }
    return getFirebaseContext()
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

function resolvePrimaryAttachmentPayload(payload) {
    const fileName = String(payload?.fileName || '').trim() || 'previo-stav.pdf'
    const contentType = normalizeContentType(payload?.contentType, fileName)
    const importKind = resolveImportKind(fileName, contentType, fileName)
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
    const importKind = resolveImportKind(fileName, contentType, fileName)
    const decodedFile = decodeImportBase64(overlayBase64)

    return {
        fileName,
        contentType,
        importKind,
        decodedFile
    }
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
    const explicitEnabledRaw = process.env.VITE_PREVIO_AUTO_CONFIRM
    const legacyEnabledRaw = process.env.VITE_AUTO_CONFIRM_STAV_IMPORTS ?? process.env.AUTO_CONFIRM_STAV_IMPORTS
    const legacyDryRunRaw = process.env.VITE_AUTO_CONFIRM_STAV_IMPORTS_DRY_RUN ?? process.env.AUTO_CONFIRM_STAV_IMPORTS_DRY_RUN

    const explicitEnabled = readBooleanEnv('VITE_PREVIO_AUTO_CONFIRM', false)
    const hasExplicitEnabled = typeof explicitEnabledRaw === 'string' && explicitEnabledRaw.trim().length > 0
    if (hasExplicitEnabled) return explicitEnabled ? 'enabled' : 'off'

    const legacyEnabled = typeof legacyEnabledRaw === 'string'
        ? readBooleanEnv(process.env.VITE_AUTO_CONFIRM_STAV_IMPORTS !== undefined ? 'VITE_AUTO_CONFIRM_STAV_IMPORTS' : 'AUTO_CONFIRM_STAV_IMPORTS', false)
        : false
    if (legacyEnabled) return 'enabled'

    const hasLegacyDryRun = typeof legacyDryRunRaw === 'string' && legacyDryRunRaw.trim().length > 0
    if (hasLegacyDryRun) {
        const dryRun = readBooleanEnv(process.env.VITE_AUTO_CONFIRM_STAV_IMPORTS_DRY_RUN !== undefined ? 'VITE_AUTO_CONFIRM_STAV_IMPORTS_DRY_RUN' : 'AUTO_CONFIRM_STAV_IMPORTS_DRY_RUN', false)
        if (dryRun) return 'dry-run'
    }

    return 'off'
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
    const importerMode = String(payload?.importerMode || (payload?.source === 'email' ? 'gmail-apps-script' : '') || '').trim() || null

    try {
        const { db, bucket, bucketName } = resolveFirebaseContext()
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
        const parserBuildId = resolveParserBuildId()
        const previewGeneratedBy = 'previo-import-email'
        const previewGeneratedAt = new Date().toISOString()
        const previewRequestId = createPreviewRequestId('email-ingest')
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
            parserVersion: PREVIO_STAV_PARSER_VERSION,
            confirmationDiagnostics: {
                operationalMerge: {
                    status: 'pending',
                    touchedRoomCount: 0,
                    statusPreservedCount: 0,
                    assignmentPreservedCount: 0,
                    estimatePreservedCount: 0,
                    problemPreservedCount: 0,
                    carryOverPreservedCount: 0,
                    inconsistencyWarningCount: 0
                }
            },
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
            const parseResult = await parseImportSources({
                primary: {
                    buffer: primaryBuffer,
                    fileName: primaryPayload.fileName,
                    contentType: primaryPayload.contentType,
                    storagePath,
                    importKind: primaryPayload.importKind
                },
                overlay: overlayPayload
                    ? {
                        buffer: overlayBuffer,
                        fileName: overlayPayload.fileName,
                        contentType: overlayPayload.contentType,
                        storagePath: overlayStoragePath,
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

            const previewArtifacts = buildImportPreviewArtifacts({
                parsed,
                arrivalOverlay,
                roomCatalog,
                referenceDate: new Date(),
                importedAt: previewGeneratedAt,
                parserVersion: PREVIO_STAV_PARSER_VERSION,
                parserBuildId,
                parserFileVersion: PREVIO_STAV_PARSER_VERSION,
                previewGeneratedAt,
                previewGeneratedBy,
                previewRequestId,
                previewFreshGenerated: true,
                processingPath: 'email-ingest',
                source: String(payload?.source || 'email'),
                importerMode,
                primary: {
                    fileName: primaryPayload.fileName,
                    contentType: primaryPayload.contentType,
                    storagePath,
                    importKind: primaryPayload.importKind,
                    sizeBytes,
                    sha256: computeBufferSha256(primaryBuffer)
                },
                overlay: overlayPayload
                    ? {
                        fileName: overlayPayload.fileName,
                        contentType: overlayPayload.contentType,
                        storagePath: overlayStoragePath,
                        importKind: overlayPayload.importKind,
                        sizeBytes: overlaySizeBytes,
                        sha256: computeBufferSha256(overlayBuffer)
                    }
                    : null
            })
            const byDate = previewArtifacts.byDate
            const nextStatus = previewArtifacts.nextStatus
            const safety = previewArtifacts.safety

            const autoConfirmSummary = buildAutoConfirmSummary({
                mode: autoConfirmMode,
                nextStatus,
                byDate,
                parsedTabDates: previewArtifacts.preview.parsedTabDates,
                safety
            })

            const parsedPatch = sanitizePatchForWrite({
                status: nextStatus,
                parsedAt: previewGeneratedAt,
                detectedDaysCount: previewArtifacts.preview.days.length,
                turnoverCount: previewArtifacts.preview.turnoverCount,
                stayoverCount: previewArtifacts.preview.stayoverCount,
                freeCount: previewArtifacts.preview.derivedFreeCount,
                warnings: previewArtifacts.previewWarnings,
                previewSummary: previewArtifacts.previewSummary,
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
                diagnostics: {
                    parserBuildId,
                    parserFileVersion: PREVIO_STAV_PARSER_VERSION,
                    previewGeneratedAt,
                    previewGeneratedBy,
                    previewRequestId,
                    sourceStoragePath: storagePath,
                    overlayStoragePath: overlayStoragePath || null,
                    arrivalOverlay,
                    arrivalOverlayMismatchRows: previewArtifacts.arrivalOverlayMismatchRows,
                    freshGenerated: true,
                    processingPath: 'email-ingest',
                    importerMode
                },
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

exports._test = {
    setFirebaseContextProvider(provider) {
        testOverrides.getFirebaseContext = provider
    },
    clearFirebaseContextProvider() {
        testOverrides.getFirebaseContext = null
    }
}
