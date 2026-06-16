const { cert, getApps, initializeApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')

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

function getFirestoreDb() {
    if (getApps().length > 0) {
        return getFirestore(getApps()[0])
    }

    const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    if (!serviceAccountRaw) {
        throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON for email import function.')
    }

    const serviceAccount = JSON.parse(serviceAccountRaw)
    const app = initializeApp({
        credential: cert(serviceAccount)
    })

    return getFirestore(app)
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
    const source = payload.source === 'manual' ? 'manual' : 'email'
    const hotelId = process.env.PREVIO_IMPORT_HOTEL_ID || 'chill-apartments'

    try {
        const db = getFirestoreDb()
        const jobRef = db.collection('hotels').doc(hotelId).collection('importJobs').doc()
        const nowIso = new Date().toISOString()
        const estimatedSizeBytes = payload.pdfBase64 ? Buffer.from(payload.pdfBase64, 'base64').byteLength : undefined

        await jobRef.set({
            type: 'previo-state-pdf',
            source,
            status: 'received',
            fileName,
            receivedAt: nowIso,
            parsedAt: null,
            confirmedAt: null,
            confirmedBy: null,
            detectedDaysCount: null,
            turnoverCount: null,
            stayoverCount: null,
            freeCount: null,
            warnings: [],
            error: null,
            storagePath: payload.storagePath || null,
            previewSummary: null,
            parserVersion: 'email-ingest-v1',
            payloadSizeBytes: estimatedSizeBytes || null
        })

        return json(200, {
            ok: true,
            jobId: jobRef.id,
            status: 'received'
        })
    } catch (error) {
        return json(500, {
            error: error && error.message ? error.message : 'Failed to create import job.'
        })
    }
}
