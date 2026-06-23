const TEMPLATE_ARRIVAL_TIMES = new Set([
    '11:00',
    '12:00',
    '13:00',
    '14:00',
    '15:00',
    '16:00',
    '17:00',
    '18:00'
])

function normalizeForMatch(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
}

function normalizeRoomNumber(raw) {
    return String(raw || '').trim().replace(/^0+/, '').padStart(3, '0')
}

function normalizeRoomKey(raw) {
    const text = String(raw || '')
    const match = text.match(/\b(\d{3})\b/)
    if (match) return normalizeRoomNumber(match[1])

    const compactDigits = text.replace(/\D/g, '')
    if (compactDigits.length >= 3) return normalizeRoomNumber(compactDigits.slice(-3))
    return text.trim()
}

function normalizeTime(raw) {
    const value = String(raw || '').trim().replace('.', ':')
    if (!value) return ''

    const parts = value.split(':')
    if (parts.length !== 2) return value

    const hour = Number(parts[0])
    const minute = Number(parts[1])
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return value
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return value

    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function toMinutesSafe(hhmm) {
    if (!hhmm || !/^\d{2}:\d{2}$/.test(String(hhmm))) return null
    const [h, m] = String(hhmm).split(':').map(Number)
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null
    if (h < 0 || h > 23 || m < 0 || m > 59) return null
    return h * 60 + m
}

function hasArrivalSignal(row) {
    return Boolean(
        row
        && (
            row.arrivalTime
            || row.arrivalGuestName
            || typeof row.arrivalGuestCount === 'number'
            || row.mainDisplayedArrivalTime
        )
    )
}

function isTemplateArrivalTime(value) {
    return TEMPLATE_ARRIVAL_TIMES.has(String(value || '').trim())
}

function hasAlfredHints(notes) {
    return (notes || []).some((note) => normalizeForMatch(note).includes('alfred'))
}

function rowKey(row) {
    return `${String(row?.dateIso || '').trim()}__${normalizeRoomKey(row?.roomNumber || '')}`
}

function cloneParsedRow(row) {
    return {
        ...row,
        departureNotes: Array.isArray(row?.departureNotes) ? [...row.departureNotes] : [],
        arrivalNotes: Array.isArray(row?.arrivalNotes) ? [...row.arrivalNotes] : [],
        warnings: Array.isArray(row?.warnings) ? [...row.warnings] : []
    }
}

function tokenizeGuestName(value) {
    return normalizeForMatch(value)
        .replace(/[^\p{L}\s'’-]+/gu, ' ')
        .split(' ')
        .map((token) => token.trim())
        .filter(Boolean)
}

function calculateArrivalMatchScore(primaryRow, overlayRow) {
    let score = 0

    const primaryName = normalizeForMatch(primaryRow?.arrivalGuestName)
    const overlayName = normalizeForMatch(overlayRow?.arrivalGuestName)
    if (primaryName && overlayName) {
        if (primaryName === overlayName) {
            score += 5
        } else if (primaryName.includes(overlayName) || overlayName.includes(primaryName)) {
            score += 3
        } else {
            const primaryTokens = tokenizeGuestName(primaryName)
            const overlayTokens = tokenizeGuestName(overlayName)
            const overlap = overlayTokens.filter((token) => primaryTokens.includes(token)).length
            if (overlap >= 2) score += 2
            else if (overlap === 1) score += 1
            else score -= 2
        }
    } else {
        score += 1
    }

    const primaryCount = primaryRow?.arrivalGuestCount
    const overlayCount = overlayRow?.arrivalGuestCount
    if (typeof primaryCount === 'number' && typeof overlayCount === 'number') {
        if (primaryCount === overlayCount) score += 1
        else score -= 1
    }

    return score
}

function getOverlayMainArrivalTime(overlayRow) {
    return normalizeTime(overlayRow?.mainDisplayedArrivalTime || overlayRow?.arrivalTime)
}

function hasExplicitMainDisplayedTime(overlayRow) {
    return Boolean(normalizeTime(overlayRow?.mainDisplayedArrivalTime))
}

function getOverlayAlfredWindow(overlayRow) {
    const value = normalizeTimeRangeLabel(overlayRow?.alfredWindow)
    return value || null
}

function normalizeTimeRangeLabel(raw) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim()
    if (!text) return ''

    const match = text.match(/([01]?\d|2[0-3])[:.]([0-5]\d)\s*-\s*([01]?\d|2[0-3])[:.]([0-5]\d)/)
    if (!match) return text

    const start = normalizeTime(`${match[1]}:${match[2]}`)
    const end = normalizeTime(`${match[3]}:${match[4]}`)
    if (!start || !end) return text
    return `${start} - ${end}`
}

function shouldOverlayArrivalTime(primaryRow, overlayMainTime, overlayRow) {
    const baseTime = normalizeTime(primaryRow?.arrivalTime)

    if (!overlayMainTime) return false
    if (!baseTime) return true
    if (baseTime === overlayMainTime) return false

    // Main displayed PDF time is authoritative for arrivalTime when present.
    if (hasExplicitMainDisplayedTime(overlayRow)) return true

    const baseTemplate = isTemplateArrivalTime(baseTime)
    const overlayTemplate = isTemplateArrivalTime(overlayMainTime)

    if (hasAlfredHints(primaryRow?.arrivalNotes) && baseTime !== overlayMainTime) {
        return true
    }

    if (baseTemplate && !overlayTemplate) return true
    if (baseTemplate && overlayTemplate && baseTime !== overlayMainTime) return true

    const baseMinutes = toMinutesSafe(baseTime)
    const overlayMinutes = toMinutesSafe(overlayMainTime)
    if (baseMinutes !== null && overlayMinutes !== null) {
        const baseHasMinutePrecision = baseMinutes % 60 !== 0
        const overlayHasMinutePrecision = overlayMinutes % 60 !== 0
        if (!baseHasMinutePrecision && overlayHasMinutePrecision) return true
    }

    return false
}

function createAuditRecord({ overlayRow, primaryRow, finalRow, reason }) {
    return {
        dateIso: String(overlayRow?.dateIso || '').trim(),
        roomNumber: normalizeRoomKey(overlayRow?.roomNumber || ''),
        pdfMainTime: getOverlayMainArrivalTime(overlayRow) || null,
        alfredWindow: getOverlayAlfredWindow(overlayRow),
        xlsTime: normalizeTime(primaryRow?.arrivalTime) || null,
        finalTime: normalizeTime(finalRow?.arrivalTime) || null,
        reason
    }
}

function overlayArrivalTimesFromPdf({ primaryParsed, overlayParsed, primaryKind }) {
    const normalizedPrimaryKind = String(primaryKind || '').toLowerCase()
    const primaryRows = Array.isArray(primaryParsed?.rows) ? primaryParsed.rows : []
    const overlayRows = Array.isArray(overlayParsed?.rows) ? overlayParsed.rows : []

    const parsedOut = {
        ...(primaryParsed || {}),
        rows: primaryRows.map((row) => cloneParsedRow(row)),
        warnings: Array.isArray(primaryParsed?.warnings) ? [...primaryParsed.warnings] : []
    }

    const summary = {
        enabled: false,
        mode: 'none',
        primaryKind: normalizedPrimaryKind,
        overlayKind: 'pdf',
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

    if (!(normalizedPrimaryKind === 'xlsx' || normalizedPrimaryKind === 'xls')) {
        return { parsed: parsedOut, overlay: summary }
    }
    if (overlayRows.length === 0 || primaryRows.length === 0) {
        return { parsed: parsedOut, overlay: summary }
    }

    summary.enabled = true
    summary.mode = 'xlsx_pdf_arrival_overlay'

    const overlayCandidatesByKey = new Map()
    const overlayRowsWithMainTime = []

    overlayRows.forEach((row) => {
        if (!row || !hasArrivalSignal(row)) return

        const overlayMainTime = getOverlayMainArrivalTime(row)
        if (!overlayMainTime) {
            summary.skippedWithoutMainTime += 1
            return
        }

        const key = rowKey(row)
        if (!overlayCandidatesByKey.has(key)) overlayCandidatesByKey.set(key, [])
        overlayCandidatesByKey.get(key).push(row)
        overlayRowsWithMainTime.push(row)
    })

    const reasonByKey = new Map()

    parsedOut.rows = parsedOut.rows.map((row) => {
        summary.consideredRows += 1

        const key = rowKey(row)
        const candidates = overlayCandidatesByKey.get(key) || []
        if (candidates.length === 0) return row

        const scoredCandidates = candidates
            .map((candidate) => ({
                candidate,
                score: calculateArrivalMatchScore(row, candidate)
            }))
            .sort((left, right) => right.score - left.score)

        const best = scoredCandidates[0]
        if (!best || !best.candidate) {
            reasonByKey.set(key, 'missing_overlay_candidate')
            return row
        }

        if (scoredCandidates.length > 1) {
            const second = scoredCandidates[1]
            const closeScores = second && Math.abs(best.score - second.score) <= 1
            if (closeScores) {
                summary.skippedByAmbiguousMatch += 1
                reasonByKey.set(key, 'ambiguous_match')
                return row
            }
        }

        summary.matchedRows += 1

        if (best.score < -2 && scoredCandidates.length > 1) {
            summary.skippedByIdentityMismatch += 1
            reasonByKey.set(key, 'identity_mismatch')
            return row
        }

        const overlayMainTime = getOverlayMainArrivalTime(best.candidate)
        if (!shouldOverlayArrivalTime(row, overlayMainTime, best.candidate)) {
            summary.skippedBySpecificity += 1
            reasonByKey.set(key, 'kept_xls_time')
            return row
        }

        const fromTime = normalizeTime(row.arrivalTime)
        const toTime = overlayMainTime
        const nextRow = {
            ...row,
            arrivalTime: toTime,
            mainDisplayedArrivalTime: toTime,
            alfredWindow: getOverlayAlfredWindow(best.candidate),
            warnings: Array.isArray(row.warnings) ? [...row.warnings] : []
        }
        if (!nextRow.warnings.includes('Cas prijezdu byl upresnen z paroveho PDF reportu.')) {
            nextRow.warnings.push('Cas prijezdu byl upresnen z paroveho PDF reportu.')
        }

        summary.appliedRows += 1
        reasonByKey.set(key, 'applied_pdf_main_time')
        summary.applied.push({
            dateIso: String(row.dateIso || ''),
            roomNumber: normalizeRoomKey(row.roomNumber || ''),
            fromTime: fromTime || null,
            toTime,
            guestName: row.arrivalGuestName || null,
            pdfMainTime: toTime,
            pdfAlfredWindow: getOverlayAlfredWindow(best.candidate)
        })

        return nextRow
    })

    const primaryByKey = new Map(primaryRows.map((row) => [rowKey(row), row]))
    const finalByKey = new Map(parsedOut.rows.map((row) => [rowKey(row), row]))

    const audit = []
    overlayRowsWithMainTime.forEach((overlayRow) => {
        const key = rowKey(overlayRow)
        const primaryRow = primaryByKey.get(key)
        const finalRow = finalByKey.get(key)

        let reason = 'ok'
        const pdfMainTime = getOverlayMainArrivalTime(overlayRow)
        const finalTime = normalizeTime(finalRow?.arrivalTime)

        if (!primaryRow) {
            reason = 'missing_primary_row'
        } else if (!finalRow) {
            reason = 'missing_final_row'
        } else if (!pdfMainTime) {
            reason = 'missing_pdf_main_time'
        } else if (finalTime !== pdfMainTime) {
            reason = reasonByKey.get(key) || 'final_time_differs'
        }

        audit.push(createAuditRecord({
            overlayRow,
            primaryRow,
            finalRow,
            reason
        }))
    })

    const auditMismatches = audit.filter((item) => item.reason !== 'ok')
    summary.auditCheckedRows = audit.length
    summary.auditMismatches = auditMismatches.length
    summary.audit = audit.slice(0, 80)

    if (summary.appliedRows > 0) {
        parsedOut.warnings.push(`Parovy PDF overlay upresnil cas prijezdu u ${summary.appliedRows} pokoju.`)
    }

    if (summary.auditMismatches > 0) {
        parsedOut.warnings.push(`Parovy PDF overlay: ${summary.auditMismatches} radku ma PDF hlavni cas prijezdu, ale finalni cas se lisi.`)
        auditMismatches.slice(0, 5).forEach((item) => {
            parsedOut.warnings.push(
                `Overlay audit ${item.dateIso}/${item.roomNumber}: PDF ${item.pdfMainTime || '-'} vs final ${item.finalTime || '-'} (${item.reason}).`
            )
        })
    }

    return {
        parsed: parsedOut,
        overlay: {
            ...summary,
            applied: summary.applied.slice(0, 80),
            audit: summary.audit.slice(0, 80)
        }
    }
}

function buildAppliedOverlayKeySet(appliedRows) {
    const keySet = new Set()
        ; (appliedRows || []).forEach((item) => {
            const dateIso = String(item?.dateIso || '').trim()
            const roomNumber = normalizeRoomKey(item?.roomNumber || '')
            if (!dateIso || !roomNumber) return
            keySet.add(`${dateIso}__${roomNumber}`)
        })
    return keySet
}

function annotatePreviewWithArrivalOverlay(preview, appliedRows) {
    const keySet = buildAppliedOverlayKeySet(appliedRows)
    if (!preview || keySet.size === 0) return preview

    return {
        ...preview,
        days: (preview.days || []).map((day) => ({
            ...day,
            rows: (day.rows || []).map((row) => {
                const key = `${String(day.dateIso || '').trim()}__${normalizeRoomKey(row?.roomNumber || '')}`
                if (!keySet.has(key)) return row
                return {
                    ...row,
                    arrivalTimeSource: 'pdf_overlay'
                }
            })
        }))
    }
}

function annotateByDateWithArrivalOverlay(byDate, appliedRows) {
    const keySet = buildAppliedOverlayKeySet(appliedRows)
    if (!byDate || keySet.size === 0) return byDate

    const next = {}
    Object.entries(byDate).forEach(([dateIso, rooms]) => {
        next[dateIso] = (rooms || []).map((room) => {
            const key = `${String(dateIso || '').trim()}__${normalizeRoomKey(room?.number || '')}`
            if (!keySet.has(key)) return room
            return {
                ...room,
                arrivalTimeSource: 'pdf_overlay',
                arrival: room?.arrival
                    ? {
                        ...room.arrival,
                        timeSource: 'pdf_overlay'
                    }
                    : room?.arrival
            }
        })
    })
    return next
}

module.exports = {
    overlayArrivalTimesFromPdf,
    annotatePreviewWithArrivalOverlay,
    annotateByDateWithArrivalOverlay
}
