const { cert, getApps, initializeApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const { getStorage } = require('firebase-admin/storage')

const MAX_PDF_BYTES = 10 * 1024 * 1024

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

        await jobRef.set({
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
            parserVersion: 'email-ingest-v2'
        })

        return json(200, {
            ok: true,
            jobId: jobRef.id,
            status: 'received',
            sizeBytes
        })
    } catch (error) {
        return json(500, {
            error: serializeError(error, 'Failed to create import job.')
        })
    }
}
