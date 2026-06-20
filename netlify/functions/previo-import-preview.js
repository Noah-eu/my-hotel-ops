const { cert, getApps, initializeApp } = require('firebase-admin/app')
const { getAuth } = require('firebase-admin/auth')
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

const DEV = process.env.NODE_ENV !== 'production'
const PREVIEW_DEBUG_PROBE_KEYS = [
    '2026-06-21/105',
    '2026-06-21/201',
    '2026-06-22/201',
    '2026-06-22/202',
    '2026-06-24/205',
    '2026-06-24/303'
]

if (DEV) {
    try {
        runSanitizerSelfCheck()
    } catch (error) {
        console.error('[previo-import-preview] Firestore sanitizer self-check failed', error)
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
        throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON for preview function.')
    }
    return JSON.parse(serviceAccountRaw)
}

function getFirebaseApp() {
    if (getApps().length > 0) return getApps()[0]

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
    const auth = getAuth(app)
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET || app.options.storageBucket
    return {
        app,
        db,
        auth,
        bucketName: bucketName || null,
        bucket: bucketName ? storage.bucket(bucketName) : null
    }
}

function getBearerToken(headers) {
    const authHeader = getHeader(headers || {}, 'Authorization') || ''
    const match = String(authHeader).match(/^Bearer\s+(.+)$/i)
    return match ? match[1].trim() : null
}

function safeErrorMessage(error) {
    const code = String(error?.code || '')
    const message = String(error?.message || '')

    if (code.includes('auth/') || message.toLowerCase().includes('token')) {
        return 'Neplatné přihlášení. Přihlaste se prosím znovu.'
    }
    if (code.includes('storage/object-not-found') || message.includes('No such object')) {
        return 'Zdrojové PDF ve Storage nebylo nalezeno.'
    }
    if (code.includes('storage/unauthorized') || message.toLowerCase().includes('permission denied')) {
        return 'Server nemá oprávnění číst zdrojové PDF ve Storage.'
    }
    if (message) {
        return message.slice(0, 300)
    }
    return 'Generování náhledu selhalo.'
}

function sanitizePatchForWrite(payload, rootPath) {
    const { cleaned, removedPaths } = sanitizeForFirestore(payload, rootPath)
    if (DEV && removedPaths.length > 0) {
        console.info('[previo-import-preview] Removed undefined Firestore paths', removedPaths)
    }
    return cleaned
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

function formatDateLabel(dateIso) {
    return new Date(`${dateIso}T00:00:00`).toLocaleDateString('cs-CZ', {
        day: 'numeric',
        month: 'numeric',
        year: 'numeric'
    })
}

function normalizeRoomNumberForProbe(raw) {
    return String(raw || '').trim().replace(/^0+/, '').padStart(3, '0')
}

function resolveParserBuildId() {
    const explicitBuildId = String(process.env.PREVIO_PREVIEW_BUILD_ID || '').trim()
    if (explicitBuildId) return explicitBuildId

    const commitRef = String(process.env.COMMIT_REF || process.env.DEPLOY_COMMIT_REF || '').trim()
    if (commitRef) return `stav-preview-${commitRef.slice(0, 7)}`

    return 'stav-preview-unknown'
}

function createPreviewRequestId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function buildDebugProbeRows(byDate) {
    const probes = {}

    PREVIEW_DEBUG_PROBE_KEYS.forEach((key) => {
        const [dateIso, roomRaw] = key.split('/')
        const roomNumber = normalizeRoomNumberForProbe(roomRaw)
        const rows = Array.isArray(byDate?.[dateIso]) ? byDate[dateIso] : []
        const row = rows.find((item) => normalizeRoomNumberForProbe(item?.number) === roomNumber)

        probes[key] = row
            ? {
                departureTime: row.departureTime || '',
                arrivalTime: row.arrivalTime || '',
                departureGuest: row.departure?.guestLabel || '',
                departureCount: typeof row.departure?.guestCount === 'number' ? row.departure.guestCount : null,
                arrivalGuest: row.arrival?.guestLabel || '',
                arrivalCount: typeof row.arrival?.guestCount === 'number' ? row.arrival.guestCount : null,
                departureNotes: Array.isArray(row.departure?.notes) ? row.departure.notes : [],
                arrivalNotes: Array.isArray(row.arrival?.notes) ? row.arrival.notes : []
            }
            : null
    })

    return probes
}

async function ensureAdminUser(db, hotelId, uid) {
    const profileSnap = await db.collection('hotels').doc(hotelId).collection('staff').doc(uid).get()
    if (!profileSnap.exists) return false
    const profile = profileSnap.data() || {}
    return profile.active !== false && profile.role === 'admin'
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return json(405, { error: 'Method not allowed' })
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

    const jobId = String(payload?.jobId || '').trim()
    const hotelId = String(payload?.hotelId || process.env.PREVIO_IMPORT_HOTEL_ID || 'chill-apartments').trim()
    if (!jobId) {
        return json(400, { error: 'Missing jobId.' })
    }

    const bearerToken = getBearerToken(event.headers || {})
    if (!bearerToken) {
        return json(401, { error: 'Missing Authorization Bearer token.' })
    }

    let db
    let bucket
    let jobRef = null

    try {
        const firebase = getFirebaseContext()
        db = firebase.db
        bucket = firebase.bucket

        if (!bucket) {
            throw new Error('PDF storage not configured')
        }

        const decoded = await firebase.auth.verifyIdToken(bearerToken)
        const requesterUid = String(decoded?.uid || '')
        const isAdmin = requesterUid
            ? await ensureAdminUser(db, hotelId, requesterUid)
            : false

        if (!isAdmin) {
            return json(403, { error: 'Admin access is required for import preview generation.' })
        }

        jobRef = db.collection('hotels').doc(hotelId).collection('importJobs').doc(jobId)
        const jobSnap = await jobRef.get()
        if (!jobSnap.exists) {
            return json(404, { error: 'Import job not found.' })
        }

        const jobData = jobSnap.data() || {}
        const storagePath = String(jobData.storagePath || '').trim()
        if (!storagePath) {
            const errorMessage = 'Import job nemá storagePath se zdrojovým PDF.'
            const failedPatch = sanitizePatchForWrite({
                status: 'failed',
                parsedAt: new Date().toISOString(),
                error: errorMessage
            }, 'importJob.failedPatch')
            await jobRef.set(failedPatch, { merge: true })
            return json(400, { error: errorMessage })
        }

        const parserBuildId = resolveParserBuildId()
        const previewGeneratedBy = 'previo-import-preview'
        const previewGeneratedAt = new Date().toISOString()
        const previewRequestId = createPreviewRequestId()

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
        const debugProbeRows = buildDebugProbeRows(byDate)
        const safety = evaluatePrevioStateImportSafety({
            preview,
            missingDateLabels,
            parserVersion: PREVIO_STAV_PARSER_VERSION,
            checkedAt: new Date()
        })

        const previewWarnings = [...preview.warnings, ...safety.warnings, ...safety.blocks]
        if (missingDateLabels.length > 0) {
            previewWarnings.push(`V náhledu chybí dny uprostřed rozsahu: ${missingDateLabels.join(', ')}`)
        }

        const nextStatus = preview.confidenceLow || missingDateLabels.length > 0 || safety.blocked
            ? 'parsed'
            : 'needs_review'
        const autoConfirmMode = resolveAutoConfirmMode()
        const autoConfirmSummary = buildAutoConfirmSummary({
            mode: autoConfirmMode,
            nextStatus,
            byDate,
            parsedTabDates: preview.parsedTabDates,
            safety
        })

        const patch = {
            status: nextStatus,
            parsedAt: previewGeneratedAt,
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
                parserBuildId,
                parserFileVersion: PREVIO_STAV_PARSER_VERSION,
                previewGeneratedAt,
                previewGeneratedBy,
                previewRequestId,
                previewFreshGenerated: true,
                sourceStoragePath: storagePath,
                debugProbeRows,
                safety,
                preview
            },
            parserVersion: PREVIO_STAV_PARSER_VERSION,
            automation: {
                autoPreview: {
                    status: 'done',
                    checkedAt: new Date().toISOString(),
                    error: null
                },
                autoConfirm: autoConfirmSummary
            },
            error: null
        }

        const sanitizedPatch = sanitizePatchForWrite(patch, 'importJob.previewPatch')
        await jobRef.set(sanitizedPatch, { merge: true })

        const updatedSnap = await jobRef.get()
        return json(200, {
            ok: true,
            jobId,
            status: nextStatus,
            diagnostics: {
                parserBuildId,
                parserFileVersion: PREVIO_STAV_PARSER_VERSION,
                previewGeneratedAt,
                previewGeneratedBy,
                previewRequestId,
                sourceStoragePath: storagePath,
                freshGenerated: true,
                debugProbeRows
            },
            job: { id: jobId, ...(updatedSnap.data() || {}) }
        })
    } catch (error) {
        const safeMessage = safeErrorMessage(error)
        if (jobRef) {
            try {
                const failedPatch = sanitizePatchForWrite({
                    status: 'failed',
                    parsedAt: new Date().toISOString(),
                    error: safeMessage,
                    automation: {
                        autoPreview: {
                            status: 'error',
                            checkedAt: new Date().toISOString(),
                            error: safeMessage
                        }
                    }
                }, 'importJob.exceptionPatch')
                await jobRef.set(failedPatch, { merge: true })
            } catch {
                // Ignore secondary failure while attempting to save failed state.
            }
        }

        const unauthorized = String(error?.code || '').startsWith('auth/')
        return json(unauthorized ? 401 : 500, { error: safeMessage })
    }
}
