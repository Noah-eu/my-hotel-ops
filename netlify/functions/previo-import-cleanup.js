const { cert, getApps, initializeApp } = require('firebase-admin/app')
const { getAuth } = require('firebase-admin/auth')
const { getFirestore } = require('firebase-admin/firestore')
const { getStorage } = require('firebase-admin/storage')

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

function getBearerToken(headers) {
    const authHeader = getHeader(headers || {}, 'Authorization') || ''
    const match = String(authHeader).match(/^Bearer\s+(.+)$/i)
    return match ? match[1].trim() : null
}

function parseServiceAccount() {
    const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    if (!serviceAccountRaw) {
        throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON for import cleanup function.')
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
    const auth = getAuth(app)
    const storage = getStorage(app)
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET || app.options.storageBucket

    return {
        db,
        auth,
        bucketName: bucketName || null,
        bucket: bucketName ? storage.bucket(bucketName) : null
    }
}

function safeMessage(error, fallback) {
    if (error && error.message) return String(error.message).slice(0, 280)
    return fallback
}

function normalizeJobIds(raw) {
    if (!Array.isArray(raw)) return []
    return Array.from(new Set(raw
        .filter((value) => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)))
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

    const hotelId = String(payload?.hotelId || process.env.PREVIO_IMPORT_HOTEL_ID || 'chill-apartments').trim()
    const jobIds = normalizeJobIds(payload?.jobIds)

    if (jobIds.length === 0) {
        return json(400, { error: 'Missing jobIds.' })
    }

    if (jobIds.length > 200) {
        return json(400, { error: 'Too many jobIds. Max 200 per request.' })
    }

    const bearerToken = getBearerToken(event.headers || {})
    if (!bearerToken) {
        return json(401, { error: 'Missing Authorization Bearer token.' })
    }

    try {
        const firebase = getFirebaseContext()
        const decoded = await firebase.auth.verifyIdToken(bearerToken)
        const requesterUid = String(decoded?.uid || '')

        if (!requesterUid) {
            return json(401, { error: 'Invalid auth token.' })
        }

        const isAdmin = await ensureAdminUser(firebase.db, hotelId, requesterUid)
        if (!isAdmin) {
            return json(403, { error: 'Admin access is required for import cleanup.' })
        }

        const deletedJobIds = []
        const notFoundJobIds = []
        const storageWarnings = []
        let storageDeletedCount = 0

        for (const jobId of jobIds) {
            const jobRef = firebase.db.collection('hotels').doc(hotelId).collection('importJobs').doc(jobId)
            const jobSnap = await jobRef.get()

            if (!jobSnap.exists) {
                notFoundJobIds.push(jobId)
                continue
            }

            const job = jobSnap.data() || {}
            const storagePath = String(job.storagePath || '').trim()

            if (storagePath) {
                if (!firebase.bucket) {
                    storageWarnings.push({ jobId, warning: 'Storage bucket is not configured on server.' })
                } else {
                    try {
                        await firebase.bucket.file(storagePath).delete({ ignoreNotFound: true })
                        storageDeletedCount += 1
                    } catch (error) {
                        storageWarnings.push({
                            jobId,
                            warning: safeMessage(error, 'Storage PDF could not be deleted.')
                        })
                    }
                }
            }

            await firebase.db.collection('hotels').doc(hotelId).collection('importBackups').doc(jobId).delete().catch(() => {})
            await jobRef.delete()
            deletedJobIds.push(jobId)
        }

        return json(200, {
            ok: true,
            deletedJobIds,
            notFoundJobIds,
            storageDeletedCount,
            storageWarnings
        })
    } catch (error) {
        const code = String(error?.code || '')
        const unauthorized = code.startsWith('auth/')
        return json(unauthorized ? 401 : 500, {
            error: safeMessage(error, 'Import cleanup failed.')
        })
    }
}
