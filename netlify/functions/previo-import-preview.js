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

function formatDateLabel(dateIso) {
    return new Date(`${dateIso}T00:00:00`).toLocaleDateString('cs-CZ', {
        day: 'numeric',
        month: 'numeric',
        year: 'numeric'
    })
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
            previewWarnings.push(`V náhledu chybí dny uprostřed rozsahu: ${missingDateLabels.join(', ')}`)
        }

        const nextStatus = preview.confidenceLow || missingDateLabels.length > 0 || safety.blocked
            ? 'parsed'
            : 'needs_review'

        const patch = {
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
            error: null
        }

        const sanitizedPatch = sanitizePatchForWrite(patch, 'importJob.previewPatch')
        await jobRef.set(sanitizedPatch, { merge: true })

        const updatedSnap = await jobRef.get()
        return json(200, {
            ok: true,
            jobId,
            status: nextStatus,
            job: { id: jobId, ...(updatedSnap.data() || {}) }
        })
    } catch (error) {
        const safeMessage = safeErrorMessage(error)
        if (jobRef) {
            try {
                const failedPatch = sanitizePatchForWrite({
                    status: 'failed',
                    parsedAt: new Date().toISOString(),
                    error: safeMessage
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
