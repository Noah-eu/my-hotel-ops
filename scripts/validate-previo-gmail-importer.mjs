import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
    selectPrevioAttachmentBatch,
    selectPreferredPrevioAttachment,
    buildProcessedKey,
    buildImportPayload,
    processPrevioMessage
} = require('./previo-gmail-importer.js')

function assert(condition, message) {
    if (!condition) {
        throw new Error(message)
    }
}

function createAttachment({ name, contentType, text }) {
    const buffer = Buffer.from(text || name, 'utf8')
    return {
        getName() {
            return name
        },
        getContentType() {
            return contentType
        },
        getSize() {
            return buffer.byteLength
        },
        getBytes() {
            return buffer
        }
    }
}

function createMessage({ id, attachments }) {
    let unread = true
    const addedLabels = []

    return {
        getId() {
            return id
        },
        getAttachments() {
            return attachments
        },
        isUnread() {
            return unread
        },
        markRead() {
            unread = false
        },
        getThread() {
            return {
                addLabel(label) {
                    addedLabels.push(label && label.name ? label.name : String(label || ''))
                }
            }
        },
        debugState() {
            return { unread, addedLabels }
        }
    }
}

function createPropertiesStore() {
    const map = new Map()
    return {
        getProperty(key) {
            return map.has(key) ? map.get(key) : null
        },
        setProperty(key, value) {
            map.set(key, value)
        },
        debugMap() {
            return map
        }
    }
}

function validateAttachmentPreference() {
    const pdf = createAttachment({
        name: 'Previo Stav 2026-06-22.pdf',
        contentType: 'application/pdf'
    })
    const xlsx = createAttachment({
        name: 'Previo Stav 2026-06-22.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })

    const selected = selectPreferredPrevioAttachment([pdf, xlsx])
    assert(selected === xlsx, 'XLSX attachment should be preferred over PDF when both are present')

    const batch = selectPrevioAttachmentBatch([pdf, xlsx])
    assert(batch && batch.primary === xlsx, 'Batch selector should use XLSX as primary when available')
    assert(batch && batch.overlay === pdf, 'Batch selector should attach PDF as overlay when XLSX primary is selected')

    const payload = buildImportPayload(selected)
    assert(payload.fileName.endsWith('.xlsx'), 'Selected payload should keep the XLSX file name')
    assert(payload.contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Selected payload should keep the XLSX content type')
    assert(typeof payload.fileBase64 === 'string' && payload.fileBase64.length > 0, 'Selected payload should contain base64 file content')

    const batchPayload = buildImportPayload(batch)
    assert(batchPayload.fileName.endsWith('.xlsx'), 'Batch payload should keep XLSX primary name')
    assert(batchPayload.overlayFileName && batchPayload.overlayFileName.endsWith('.pdf'), 'Batch payload should include paired PDF overlay')
    assert(typeof batchPayload.overlayFileBase64 === 'string' && batchPayload.overlayFileBase64.length > 0, 'Batch payload should include overlay base64')
}

function validateSuccessFlowDedupes() {
    const properties = createPropertiesStore()
    const attachment = createAttachment({
        name: 'Previo Stav retry-safe.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })
    const message = createMessage({ id: 'message-1', attachments: [attachment] })

    const firstResult = processPrevioMessage(message, {
        properties,
        successLabel: null,
        importUploader() {
            return { ok: true, jobId: 'job-123', status: 'needs_review' }
        }
    })

    assert(firstResult.status === 'imported', 'Successful import should return imported status')
    assert(message.debugState().unread === false, 'Message should be marked read only after successful import')

    const processedKey = buildProcessedKey('message-1', { primary: attachment, overlay: null })
    assert(Boolean(properties.getProperty(processedKey)), 'Successful import should persist a processed key')

    const duplicateMessage = createMessage({ id: 'message-1', attachments: [attachment] })
    const duplicateResult = processPrevioMessage(duplicateMessage, {
        properties,
        successLabel: null,
        importUploader() {
            throw new Error('Uploader should not be called for duplicates')
        }
    })

    assert(duplicateResult.status === 'duplicate', 'Processed messages should be skipped on repeated runs')
    assert(duplicateMessage.debugState().unread === true, 'Duplicate skip should not mutate message state')
}

function validateFailureLeavesRetryable() {
    const properties = createPropertiesStore()
    const attachment = createAttachment({
        name: 'Previo Stav failed.pdf',
        contentType: 'application/pdf'
    })
    const message = createMessage({ id: 'message-2', attachments: [attachment] })

    let didThrow = false
    try {
        processPrevioMessage(message, {
            properties,
            successLabel: null,
            importUploader() {
                throw new Error('Endpoint returned failed preview state')
            }
        })
    } catch {
        didThrow = true
    }

    assert(didThrow, 'Failed uploads should bubble an error to the caller')
    assert(message.debugState().unread === true, 'Failed uploads must leave the message unread for retry')
    assert(properties.debugMap().size === 0, 'Failed uploads must not store a processed key')
}

function validateProcessedKeyIncludesOverlayFingerprint() {
    const xlsx = createAttachment({
        name: 'Previo Stav key-check.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })
    const pdf = createAttachment({
        name: 'Previo Stav key-check.pdf',
        contentType: 'application/pdf'
    })

    const keyWithoutOverlay = buildProcessedKey('message-key', { primary: xlsx, overlay: null })
    const keyWithOverlay = buildProcessedKey('message-key', { primary: xlsx, overlay: pdf })

    assert(keyWithOverlay !== keyWithoutOverlay, 'Processed key should include overlay fingerprint when paired PDF exists')
}

function main() {
    validateAttachmentPreference()
    validateSuccessFlowDedupes()
    validateFailureLeavesRetryable()
    validateProcessedKeyIncludesOverlayFingerprint()

    console.log('[validate:previo-gmail-importer] PASS')
}

main()
