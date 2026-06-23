const crypto = require('node:crypto')
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
} = require('./previo-state-preview')
const {
    overlayArrivalTimesFromPdf,
    annotatePreviewWithArrivalOverlay,
    annotateByDateWithArrivalOverlay
} = require('./previo-arrival-overlay')

const DEFAULT_DEBUG_PROBE_KEYS = [
    '2026-06-21/105',
    '2026-06-21/201',
    '2026-06-22/201',
    '2026-06-22/202',
    '2026-06-24/205',
    '2026-06-24/303'
]

function looksLikePdf(fileName, contentType) {
    const lowerName = String(fileName || '').toLowerCase()
    const lowerContentType = String(contentType || '').toLowerCase()
    return lowerContentType === 'application/pdf' || lowerName.endsWith('.pdf')
}

function resolveImportKind(fileName, contentType, storagePath) {
    const lowerName = String(fileName || '').toLowerCase()
    const lowerContentType = String(contentType || '').toLowerCase()
    const lowerStoragePath = String(storagePath || '').toLowerCase()

    if (
        lowerContentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        || lowerName.endsWith('.xlsx')
        || lowerStoragePath.endsWith('.xlsx')
    ) {
        return 'xlsx'
    }

    if (
        lowerContentType === 'application/vnd.ms-excel'
        || lowerName.endsWith('.xls')
        || lowerStoragePath.endsWith('.xls')
    ) {
        return 'xls'
    }

    if (looksLikePdf(fileName || storagePath, contentType)) {
        return 'pdf'
    }

    return null
}

async function parseImportBuffer({ buffer, fileName, contentType, storagePath, referenceDate }) {
    const importKind = resolveImportKind(fileName, contentType, storagePath)
    if (importKind === 'xlsx' || importKind === 'xls') {
        const extracted = extractStateDataFromXlsxBuffer(buffer)
        return parsePrevioStateXlsxData(extracted, referenceDate)
    }

    const extracted = await extractStateTextFromPdfBuffer(buffer)
    return parsePrevioStatePdfText(extracted, referenceDate)
}

function emptyArrivalOverlaySummary({ primaryKind = null, overlayKind = null } = {}) {
    return {
        enabled: false,
        mode: 'none',
        primaryKind,
        overlayKind,
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

async function parseImportSources({ primary, overlay, referenceDate }) {
    const primaryKind = resolveImportKind(primary.fileName, primary.contentType, primary.storagePath)
    const parsedPrimary = await parseImportBuffer({
        buffer: primary.buffer,
        fileName: primary.fileName,
        contentType: primary.contentType,
        storagePath: primary.storagePath,
        referenceDate
    })

    if (!overlay?.buffer) {
        return {
            parsed: parsedPrimary,
            arrivalOverlay: emptyArrivalOverlaySummary({
                primaryKind,
                overlayKind: null
            }),
            primaryKind,
            overlayKind: null
        }
    }

    const overlayKind = resolveImportKind(overlay.fileName, overlay.contentType, overlay.storagePath)
    if (overlayKind !== 'pdf') {
        return {
            parsed: parsedPrimary,
            arrivalOverlay: emptyArrivalOverlaySummary({
                primaryKind,
                overlayKind
            }),
            primaryKind,
            overlayKind
        }
    }

    const parsedOverlay = await parseImportBuffer({
        buffer: overlay.buffer,
        fileName: overlay.fileName,
        contentType: overlay.contentType,
        storagePath: overlay.storagePath,
        referenceDate
    })

    const overlayResult = overlayArrivalTimesFromPdf({
        primaryParsed: parsedPrimary,
        overlayParsed: parsedOverlay,
        primaryKind
    })

    return {
        parsed: overlayResult.parsed,
        arrivalOverlay: overlayResult.overlay,
        primaryKind,
        overlayKind
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

function buildDebugProbeRows(byDate, keys = DEFAULT_DEBUG_PROBE_KEYS) {
    const probes = {}

    keys.forEach((key) => {
        const [dateIso, roomRaw] = String(key || '').split('/')
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

function buildArrivalOverlayMismatchRows(arrivalOverlay) {
    const auditRows = Array.isArray(arrivalOverlay?.audit) ? arrivalOverlay.audit : []

    return auditRows
        .filter((row) => row && row.reason && row.reason !== 'ok')
        .map((row) => ({
            dateIso: String(row.dateIso || '').trim(),
            roomNumber: String(row.roomNumber || '').trim(),
            pdfMainTime: String(row.pdfMainTime || '').trim() || null,
            xlsTime: String(row.xlsTime || '').trim() || null,
            finalTime: String(row.finalTime || '').trim() || null,
            alfredWindow: row.alfredWindow || null,
            reason: String(row.reason || '').trim() || 'unknown'
        }))
}

function resolveParserBuildId() {
    const explicitBuildId = String(process.env.PREVIO_PREVIEW_BUILD_ID || '').trim()
    if (explicitBuildId) return explicitBuildId

    const commitRef = String(process.env.COMMIT_REF || process.env.DEPLOY_COMMIT_REF || '').trim()
    if (commitRef) return `stav-preview-${commitRef.slice(0, 7)}`

    return 'stav-preview-unknown'
}

function resolveDeployMarker() {
    return String(
        process.env.DEPLOY_ID
        || process.env.DEPLOY_PRIME_URL
        || process.env.URL
        || process.env.COMMIT_REF
        || process.env.DEPLOY_COMMIT_REF
        || ''
    ).trim() || 'unknown'
}

function createPreviewRequestId(prefix = 'preview') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function computeBufferSha256(buffer) {
    if (!buffer) return null
    return crypto.createHash('sha256').update(buffer).digest('hex')
}

function buildImportPreviewArtifacts(input) {
    const {
        parsed,
        arrivalOverlay,
        roomCatalog,
        referenceDate,
        importedAt,
        parserVersion,
        parserBuildId,
        parserFileVersion,
        previewGeneratedAt,
        previewGeneratedBy,
        previewRequestId,
        previewFreshGenerated,
        processingPath,
        source,
        importerMode,
        primary,
        overlay,
        debugProbeKeys
    } = input

    let preview = buildPrevioStateImportPreview(parsed, roomCatalog, referenceDate)
    const missingDateIsos = detectMissingDatesInRange(preview.days.map((day) => day.dateIso))
    const missingDateLabels = missingDateIsos.map((dateIso) => formatDateLabel(dateIso))

    if ((arrivalOverlay?.appliedRows || 0) > 0) {
        preview = annotatePreviewWithArrivalOverlay(preview, arrivalOverlay.applied)
    }

    let byDate = buildByDateFromPreview(preview, roomCatalog, importedAt)
    if ((arrivalOverlay?.appliedRows || 0) > 0) {
        byDate = annotateByDateWithArrivalOverlay(byDate, arrivalOverlay.applied)
    }

    const debugProbeRows = buildDebugProbeRows(byDate, debugProbeKeys)
    const safety = evaluatePrevioStateImportSafety({
        preview,
        missingDateLabels,
        parserVersion,
        checkedAt: new Date(previewGeneratedAt)
    })

    const arrivalOverlayMismatchRows = buildArrivalOverlayMismatchRows(arrivalOverlay)
    const previewWarnings = [...preview.warnings, ...safety.warnings, ...safety.blocks]

    if (missingDateLabels.length > 0) {
        previewWarnings.push(`V náhledu chybí dny uprostřed rozsahu: ${missingDateLabels.join(', ')}`)
    }
    if ((arrivalOverlay?.auditMismatches || 0) > 0) {
        previewWarnings.push(`Párový PDF overlay: ${arrivalOverlay.auditMismatches} řádků má hlavní PDF čas odlišný od finálního času.`)
    }

    const nextStatus = preview.confidenceLow
        || missingDateLabels.length > 0
        || safety.blocked
        || (arrivalOverlay?.auditMismatches || 0) > 0
        ? 'parsed'
        : 'needs_review'

    const diagnostics = {
        processingPath,
        endpoint: previewGeneratedBy,
        source: source || 'email',
        importerMode: importerMode || null,
        parserVersion,
        parserBuildId,
        parserFileVersion,
        deployMarker: resolveDeployMarker(),
        previewFreshGenerated: Boolean(previewFreshGenerated),
        primary: {
            fileName: primary?.fileName || null,
            contentType: primary?.contentType || null,
            storagePath: primary?.storagePath || null,
            importKind: primary?.importKind || null,
            sizeBytes: typeof primary?.sizeBytes === 'number' ? primary.sizeBytes : null,
            sha256: primary?.sha256 || null
        },
        overlay: {
            fileName: overlay?.fileName || null,
            contentType: overlay?.contentType || null,
            storagePath: overlay?.storagePath || null,
            importKind: overlay?.importKind || null,
            sizeBytes: typeof overlay?.sizeBytes === 'number' ? overlay.sizeBytes : null,
            sha256: overlay?.sha256 || null,
            attached: Boolean(overlay?.fileName || overlay?.storagePath)
        },
        arrivalOverlay: {
            enabled: Boolean(arrivalOverlay?.enabled),
            mode: arrivalOverlay?.mode || 'none',
            consideredRows: arrivalOverlay?.consideredRows || 0,
            matchedRows: arrivalOverlay?.matchedRows || 0,
            appliedRows: arrivalOverlay?.appliedRows || 0,
            auditCheckedRows: arrivalOverlay?.auditCheckedRows || 0,
            auditMismatches: arrivalOverlay?.auditMismatches || 0,
            mismatchRows: arrivalOverlayMismatchRows.slice(0, 80)
        },
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
    }

    const previewSummary = {
        parsedTabDates: preview.parsedTabDates,
        byDate,
        missingDateLabels,
        parserVersion,
        parserBuildId,
        parserFileVersion,
        previewGeneratedAt,
        previewGeneratedBy,
        previewRequestId,
        previewFreshGenerated: Boolean(previewFreshGenerated),
        sourceStoragePath: primary?.storagePath || null,
        overlayStoragePath: overlay?.storagePath || null,
        arrivalOverlay,
        arrivalOverlayMismatchRows: arrivalOverlayMismatchRows.slice(0, 80),
        debugProbeRows,
        safety,
        diagnostics,
        preview
    }

    return {
        preview,
        byDate,
        safety,
        previewWarnings,
        nextStatus,
        missingDateLabels,
        debugProbeRows,
        arrivalOverlayMismatchRows,
        diagnostics,
        previewSummary
    }
}

module.exports = {
    DEFAULT_DEBUG_PROBE_KEYS,
    resolveImportKind,
    parseImportBuffer,
    parseImportSources,
    resolveParserBuildId,
    createPreviewRequestId,
    computeBufferSha256,
    buildDebugProbeRows,
    buildArrivalOverlayMismatchRows,
    buildImportPreviewArtifacts
}
