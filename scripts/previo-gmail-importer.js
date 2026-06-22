const DEFAULT_SOURCE_LABEL = 'Previo stav pdf'
const DEFAULT_MAX_THREADS = 20
const DEFAULT_SUCCESS_LABEL = ''

function normalizeText(value) {
    return String(value || '').trim().toLowerCase()
}

function attachmentExtension(fileName) {
    const lowerName = normalizeText(fileName)
    if (lowerName.endsWith('.xlsx')) return 'xlsx'
    if (lowerName.endsWith('.xls')) return 'xls'
    if (lowerName.endsWith('.pdf')) return 'pdf'
    return ''
}

function normalizeAttachmentContentType(fileName, contentType) {
    const normalizedType = normalizeText(contentType)
    const extension = attachmentExtension(fileName)

    if (normalizedType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || extension === 'xlsx') {
        return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }
    if (normalizedType === 'application/vnd.ms-excel' || extension === 'xls') {
        return 'application/vnd.ms-excel'
    }
    if (normalizedType === 'application/pdf' || extension === 'pdf') {
        return 'application/pdf'
    }
    return ''
}

function isSupportedPrevioAttachment(attachment) {
    const fileName = String(attachment && attachment.getName ? attachment.getName() : '').trim()
    const contentType = String(attachment && attachment.getContentType ? attachment.getContentType() : '').trim()
    const lowerName = normalizeText(fileName)
    if (!lowerName.includes('stav')) return false
    return Boolean(normalizeAttachmentContentType(fileName, contentType))
}

function getAttachmentPriority(attachment) {
    const extension = attachmentExtension(attachment && attachment.getName ? attachment.getName() : '')
    if (extension === 'xlsx') return 0
    if (extension === 'xls') return 1
    if (extension === 'pdf') return 2
    return 99
}

function selectPreferredPrevioAttachment(attachments) {
    const candidates = (attachments || []).filter(isSupportedPrevioAttachment)
    if (candidates.length === 0) return null

    return candidates
        .slice()
        .sort((left, right) => getAttachmentPriority(left) - getAttachmentPriority(right))[0]
}

function bytesToBase64(bytes) {
    if (typeof Buffer !== 'undefined') {
        if (Buffer.isBuffer(bytes)) return bytes.toString('base64')
        return Buffer.from(bytes).toString('base64')
    }
    return Utilities.base64Encode(bytes)
}

function encodeAttachmentBase64(attachment) {
    const bytes = attachment.getBytes()
    return bytesToBase64(bytes)
}

function buildAttachmentFingerprint(attachment) {
    const fileName = String(attachment && attachment.getName ? attachment.getName() : '').trim()
    const contentType = normalizeAttachmentContentType(fileName, attachment && attachment.getContentType ? attachment.getContentType() : '')
    const size = String(attachment && attachment.getSize ? attachment.getSize() : '')
    return [fileName, contentType, size].join('|')
}

function buildProcessedKey(messageId, attachment) {
    return ['previo-stav', String(messageId || '').trim(), buildAttachmentFingerprint(attachment)].join('|')
}

function buildImportPayload(attachment) {
    const fileName = String(attachment.getName() || '').trim()
    const contentType = normalizeAttachmentContentType(fileName, attachment.getContentType())
    if (!fileName || !contentType) {
        throw new Error('Attachment is missing a supported file name or content type.')
    }

    return {
        fileName,
        contentType,
        source: 'email',
        fileBase64: encodeAttachmentBase64(attachment)
    }
}

function resolveImporterConfig(scriptProperties) {
    const importUrl = String(scriptProperties.getProperty('PREVIO_IMPORT_URL') || '').trim()
    const importSecret = String(scriptProperties.getProperty('PREVIO_IMPORT_SECRET') || '').trim()
    const sourceLabelName = String(scriptProperties.getProperty('PREVIO_IMPORT_LABEL') || DEFAULT_SOURCE_LABEL).trim()
    const successLabelName = String(scriptProperties.getProperty('PREVIO_IMPORT_SUCCESS_LABEL') || DEFAULT_SUCCESS_LABEL).trim()
    const maxThreadsValue = String(scriptProperties.getProperty('PREVIO_IMPORT_MAX_THREADS') || DEFAULT_MAX_THREADS).trim()
    const maxThreads = Number.parseInt(maxThreadsValue, 10)

    if (!importUrl) throw new Error('Missing PREVIO_IMPORT_URL script property.')
    if (!importSecret) throw new Error('Missing PREVIO_IMPORT_SECRET script property.')
    if (!sourceLabelName) throw new Error('Missing PREVIO_IMPORT_LABEL script property.')

    return {
        importUrl,
        importSecret,
        sourceLabelName,
        successLabelName,
        maxThreads: Number.isFinite(maxThreads) && maxThreads > 0 ? maxThreads : DEFAULT_MAX_THREADS
    }
}

function parseJsonSafe(rawValue) {
    if (!rawValue) return null
    try {
        return JSON.parse(rawValue)
    } catch {
        return null
    }
}

function uploadPrevioAttachment(attachment, config, fetchImpl) {
    const payload = buildImportPayload(attachment)
    const response = fetchImpl(config.importUrl, {
        method: 'post',
        contentType: 'application/json; charset=utf-8',
        muteHttpExceptions: true,
        headers: {
            'X-Import-Secret': config.importSecret
        },
        payload: JSON.stringify(payload)
    })

    const statusCode = typeof response.getResponseCode === 'function'
        ? response.getResponseCode()
        : Number(response.statusCode || 0)
    const rawBody = typeof response.getContentText === 'function'
        ? response.getContentText()
        : String(response.body || '')
    const body = parseJsonSafe(rawBody) || {}

    const treatedAsSuccess = statusCode >= 200
        && statusCode < 300
        && body.ok === true
        && body.status !== 'failed'
        && body.autoPreview !== 'error'

    if (!treatedAsSuccess) {
        const detail = body.error || rawBody || `HTTP ${statusCode}`
        throw new Error(`Import endpoint rejected attachment: ${detail}`)
    }

    return body
}

function processPrevioMessage(message, services) {
    const attachment = selectPreferredPrevioAttachment(message.getAttachments())
    if (!attachment) {
        return { status: 'skipped', reason: 'No supported Stav attachment found.' }
    }

    const processedKey = buildProcessedKey(message.getId(), attachment)
    if (services.properties.getProperty(processedKey)) {
        return { status: 'duplicate', processedKey }
    }

    const result = services.importUploader(attachment)
    const processedValue = JSON.stringify({
        processedAt: new Date().toISOString(),
        fileName: attachment.getName(),
        jobId: result.jobId || null,
        status: result.status || null
    })

    services.properties.setProperty(processedKey, processedValue)
    message.markRead()

    if (services.successLabel && message.getThread) {
        const thread = message.getThread()
        if (thread && typeof thread.addLabel === 'function') {
            thread.addLabel(services.successLabel)
        }
    }

    return {
        status: 'imported',
        processedKey,
        jobId: result.jobId || null,
        importStatus: result.status || null,
        fileName: attachment.getName()
    }
}

function getOrCreateLabel(labelName) {
    if (!labelName) return null
    const existing = GmailApp.getUserLabelByName(labelName)
    return existing || GmailApp.createLabel(labelName)
}

function runPrevioGmailImporter() {
    const scriptProperties = PropertiesService.getScriptProperties()
    const config = resolveImporterConfig(scriptProperties)
    const sourceLabel = GmailApp.getUserLabelByName(config.sourceLabelName)
    if (!sourceLabel) {
        throw new Error(`Missing Gmail label: ${config.sourceLabelName}`)
    }

    const successLabel = config.successLabelName ? getOrCreateLabel(config.successLabelName) : null
    const threads = sourceLabel.getThreads(0, config.maxThreads)
    const summary = {
        scannedMessages: 0,
        importedMessages: 0,
        duplicateMessages: 0,
        skippedMessages: 0,
        failedMessages: 0,
        jobIds: []
    }

    threads.forEach((thread) => {
        thread.getMessages().forEach((message) => {
            if (!message.isUnread()) return
            summary.scannedMessages += 1

            try {
                const result = processPrevioMessage(message, {
                    properties: scriptProperties,
                    successLabel,
                    importUploader: (attachment) => uploadPrevioAttachment(attachment, config, UrlFetchApp.fetch)
                })

                if (result.status === 'imported') {
                    summary.importedMessages += 1
                    if (result.jobId) summary.jobIds.push(result.jobId)
                    Logger.log(`Imported Previo attachment ${result.fileName} for message ${message.getId()} -> ${result.jobId || 'no-job-id'}`)
                    return
                }

                if (result.status === 'duplicate') {
                    summary.duplicateMessages += 1
                    Logger.log(`Skipped already processed Previo message ${message.getId()}`)
                    return
                }

                summary.skippedMessages += 1
                Logger.log(`Skipped message ${message.getId()}: ${result.reason}`)
            } catch (error) {
                summary.failedMessages += 1
                Logger.log(`Previo import failed for message ${message.getId()}: ${error && error.message ? error.message : String(error)}`)
            }
        })
    })

    return summary
}

function installPrevioGmailImporterTrigger() {
    const handler = 'runPrevioGmailImporter'
    const triggers = ScriptApp.getProjectTriggers()
    triggers.forEach((trigger) => {
        if (trigger.getHandlerFunction && trigger.getHandlerFunction() === handler) {
            ScriptApp.deleteTrigger(trigger)
        }
    })

    ScriptApp.newTrigger(handler)
        .timeBased()
        .everyMinutes(15)
        .create()
}

if (typeof module !== 'undefined') {
    module.exports = {
        attachmentExtension,
        normalizeAttachmentContentType,
        isSupportedPrevioAttachment,
        selectPreferredPrevioAttachment,
        buildAttachmentFingerprint,
        buildProcessedKey,
        buildImportPayload,
        resolveImporterConfig,
        uploadPrevioAttachment,
        processPrevioMessage,
        runPrevioGmailImporter
    }
}
