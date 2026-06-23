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

function calculateArrivalMatchScore(primaryRow, overlayRow) {
    let score = 0

    const primaryName = normalizeForMatch(primaryRow?.arrivalGuestName)
    const overlayName = normalizeForMatch(overlayRow?.arrivalGuestName)
    if (primaryName && overlayName) {
        if (primaryName === overlayName) score += 6
        else score -= 6
    } else {
        score += 1
    }

    const primaryCount = primaryRow?.arrivalGuestCount
    const overlayCount = overlayRow?.arrivalGuestCount
    if (typeof primaryCount === 'number' && typeof overlayCount === 'number') {
        if (primaryCount === overlayCount) score += 2
        else score -= 2
    }

    return score
}

function shouldOverlayArrivalTime(primaryRow, overlayRow) {
    const baseTime = normalizeTime(primaryRow?.arrivalTime)
    const overlayTime = normalizeTime(overlayRow?.arrivalTime)

    if (!overlayTime) return false
    if (!baseTime) return true
    if (baseTime === overlayTime) return false

    const baseTemplate = isTemplateArrivalTime(baseTime)
    const overlayTemplate = isTemplateArrivalTime(overlayTime)

    if (hasAlfredHints(primaryRow?.arrivalNotes) && baseTime !== overlayTime) {
        return true
    }

    if (baseTemplate && !overlayTemplate) return true
    if (baseTemplate && overlayTemplate && baseTime !== overlayTime) return true

    const baseMinutes = toMinutesSafe(baseTime)
    const overlayMinutes = toMinutesSafe(overlayTime)
    if (baseMinutes !== null && overlayMinutes !== null) {
        const baseHasMinutePrecision = baseMinutes % 60 !== 0
        const overlayHasMinutePrecision = overlayMinutes % 60 !== 0
        if (!baseHasMinutePrecision && overlayHasMinutePrecision) return true
    }

    return false
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
        applied: []
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
    overlayRows.forEach((row) => {
        if (!row || !row.arrivalTime || !hasArrivalSignal(row)) return
        const key = rowKey(row)
        if (!overlayCandidatesByKey.has(key)) overlayCandidatesByKey.set(key, [])
        overlayCandidatesByKey.get(key).push(row)
    })

    parsedOut.rows = parsedOut.rows.map((row) => {
        if (!hasArrivalSignal(row)) return row
        summary.consideredRows += 1

        const key = rowKey(row)
        const candidates = overlayCandidatesByKey.get(key) || []
        if (candidates.length === 0) return row

        let bestCandidate = null
        let bestScore = Number.NEGATIVE_INFINITY
        candidates.forEach((candidate) => {
            const score = calculateArrivalMatchScore(row, candidate)
            if (score > bestScore) {
                bestScore = score
                bestCandidate = candidate
            }
        })

        if (!bestCandidate) return row
        summary.matchedRows += 1

        if (bestScore < 0) {
            summary.skippedByIdentityMismatch += 1
            return row
        }

        if (!shouldOverlayArrivalTime(row, bestCandidate)) {
            summary.skippedBySpecificity += 1
            return row
        }

        const fromTime = normalizeTime(row.arrivalTime)
        const toTime = normalizeTime(bestCandidate.arrivalTime)
        const nextRow = {
            ...row,
            arrivalTime: toTime,
            warnings: Array.isArray(row.warnings) ? [...row.warnings] : []
        }
        if (!nextRow.warnings.includes('Čas příjezdu byl upřesněn z párového PDF reportu.')) {
            nextRow.warnings.push('Čas příjezdu byl upřesněn z párového PDF reportu.')
        }

        summary.appliedRows += 1
        summary.applied.push({
            dateIso: String(row.dateIso || ''),
            roomNumber: normalizeRoomKey(row.roomNumber || ''),
            fromTime: fromTime || null,
            toTime,
            guestName: row.arrivalGuestName || null
        })

        return nextRow
    })

    if (summary.appliedRows > 0) {
        parsedOut.warnings.push(`Párový PDF overlay upřesnil čas příjezdu u ${summary.appliedRows} pokojů.`)
    }

    return {
        parsed: parsedOut,
        overlay: {
            ...summary,
            applied: summary.applied.slice(0, 40)
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