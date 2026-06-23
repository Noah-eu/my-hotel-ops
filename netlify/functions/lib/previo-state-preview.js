const XLSX = require('xlsx')

const PDF_PAGE_BREAK = '[[[PREVIO_PAGE_BREAK]]]'
const PREVIO_STAV_PARSER_VERSION = 'stav-parser-v3-real-pdf-fixture'

const MASTER_ROOM_NUMBERS = [
    '001', '101', '102', '103', '104', '105', '201', '202', '203', '204', '205', '301', '302', '303', '304', '305'
]

const MASTER_ROOM_SET = new Set(MASTER_ROOM_NUMBERS)
const ROOM_CAPACITY_BY_NUMBER = {
    '102': 2,
    '105': 2,
    '205': 2,
    '305': 2
}

function normalizeForMatch(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
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
    const normalized = String(raw || '').replace('.', ':')
    const [h, m] = normalized.split(':')
    if (!h || !m) return normalized
    return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
}

function normalizeTimeWithMeridiem(hourRaw, minuteRaw, meridiemRaw) {
    let hour = Number(hourRaw)
    const minute = Number(minuteRaw)
    const meridiem = String(meridiemRaw || '').toUpperCase()

    if (meridiem === 'AM') {
        if (hour === 12) hour = 0
    } else if (meridiem === 'PM') {
        if (hour >= 1 && hour <= 11) hour += 12
    }

    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function toMinutes(hhmm) {
    const [h, m] = String(hhmm || '').split(':').map(Number)
    return h * 60 + m
}

function toMinutesSafe(hhmm) {
    if (!hhmm || !/^\d{1,2}:\d{2}$/.test(String(hhmm))) return null
    return toMinutes(String(hhmm))
}

function formatLocalDate(date) {
    const y = date.getFullYear()
    const m = `${date.getMonth() + 1}`.padStart(2, '0')
    const d = `${date.getDate()}`.padStart(2, '0')
    return `${y}-${m}-${d}`
}

function formatDateLabel(dateIso) {
    const date = new Date(`${dateIso}T00:00:00`)
    if (Number.isNaN(date.getTime())) return dateIso
    return date.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' })
}

function parsePageDateHeader(line) {
    const normalized = normalizeForMatch(line).replace(/\s+/g, ' ').trim()
    const match = normalized.match(/(?:^|\s)(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\s*-\s*(po|ut|st|ct|pa|so|ne)(?=\s|$)/i)
    if (!match) return null
    const day = Number(match[1])
    const month = Number(match[2])
    const year = Number(match[3])
    const date = new Date(year, month - 1, day)
    return Number.isNaN(date.getTime()) ? null : date
}

function parseDateToken(token, fallbackYear) {
    const match = String(token || '').match(/\b(\d{1,2})\.\s*(\d{1,2})\.?\b/)
    if (!match) return null
    const day = Number(match[1])
    const month = Number(match[2])
    const date = new Date(fallbackYear, month - 1, day)
    return Number.isNaN(date.getTime()) ? null : date
}

function shouldIgnoreLine(line) {
    const normalized = normalizeForMatch(line).replace(/\s+/g, ' ').trim()
    if (!normalized) return true

    if (normalized === 'chill apartments') return true
    if (normalized === 'pokoj') return true
    if (normalized === 'datum') return true
    if (normalized === 'odjezd') return true
    if (normalized === 'prijezd') return true
    if (normalized === 'poznamka') return true
    if (normalized === 'celkem') return true
    if (/^strana \d+ z \d+$/.test(normalized)) return true
    if (/strana \d+ z \d+/.test(normalized)) return true
    if (normalized === '(prijezd)' || normalized === '(odjezd)') return true
    if (normalized === 'datum datum') return true
    if (normalized === 'odjezd prijezd odjezd prijezd') return true
    if (/prijizdejici\s*:\s*\d+/.test(normalized)) return true
    if (/odjizdejici\s*:\s*\d+/.test(normalized)) return true
    if (/probihajici\s*:\s*\d+/.test(normalized)) return true
    return false
}

function parseTotalsLine(line) {
    const normalized = normalizeForMatch(line)
    if (!normalized.includes('prijizdejici:') || !normalized.includes('odjizdejici:') || !normalized.includes('probihajici:')) {
        return null
    }

    const arr = normalized.match(/prijizdejici:\s*(\d+)/)
    const dep = normalized.match(/odjizdejici:\s*(\d+)/)
    const stay = normalized.match(/probihajici:\s*(\d+)/)

    return {
        arrivals: arr ? Number(arr[1]) : undefined,
        departures: dep ? Number(dep[1]) : undefined,
        stayovers: stay ? Number(stay[1]) : undefined
    }
}

function normalizeBoxText(text) {
    let normalized = String(text || '')
        .replace(/\bB\s*OX\b/gi, 'BOX')
        .replace(/\bbox\b/gi, 'BOX')
        .replace(/\s+/g, ' ')
        .trim()

    normalized = normalized.replace(/Recepce\s*:\s*BOX/gi, 'Recepce: BOX')
    normalized = normalized.replace(/\bBOX\s*([a-z0-9-]+)/gi, (_, value) => `BOX ${String(value).toUpperCase()}`)

    return normalized
}

function splitNoteGroups(rawText) {
    return String(rawText || '')
        .split(/\.\.\.+|…+/)
        .map((part) => normalizeBoxText(part))
        .map((part) => part.trim())
        .filter(Boolean)
}

function looksLikeStandaloneGuestNameLine(line) {
    const trimmed = String(line || '').trim()
    if (!trimmed) return false
    return /^(\p{Lu}[\p{L}'’-]+)(\s+\p{Lu}[\p{L}'’-]+){0,3}$/u.test(trimmed)
}

function isSafeNoteContinuationLine(line) {
    const trimmed = String(line || '').trim()
    if (!trimmed) return false
    if (isNoteLine(trimmed)) return false
    if (detectRoomToken(trimmed)) return false
    if (isCapacityLine(trimmed)) return false
    if (isAlfredWindow(trimmed)) return false
    if (detectTimes(trimmed).length > 0) return false
    if (/\b\d{1,2}\.\s*\d{1,2}\.?\b/.test(trimmed)) return false
    if (/^\(?\d{1,2}\)?$/.test(trimmed)) return false
    if (looksLikeStandaloneGuestNameLine(trimmed)) return false
    return /\p{L}/u.test(trimmed)
}

function isSkippableNoteInterruptionLine(line) {
    const trimmed = String(line || '').trim()
    if (!trimmed) return false
    if (isAlfredWindow(trimmed)) return true
    if (detectTimes(trimmed).length > 0) return true
    if (/\b\d{1,2}\.\s*\d{1,2}\.?\b/.test(trimmed)) return true
    if (/^\(?\d{1,2}\)?$/.test(trimmed)) return true
    return false
}

function extractNoteSourceLines(text) {
    const noteLines = []
    let currentNote = ''

    String(text || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line) => {
            if (isNoteLine(line)) {
                if (currentNote) noteLines.push(currentNote)
                currentNote = line
                return
            }

            if (currentNote && isSafeNoteContinuationLine(line)) {
                currentNote = `${currentNote} ${line}`.replace(/\s+/g, ' ').trim()
                return
            }

            if (currentNote && isSkippableNoteInterruptionLine(line)) {
                return
            }

            if (currentNote) {
                noteLines.push(currentNote)
                currentNote = ''
            }
        })

    if (currentNote) noteLines.push(currentNote)
    return noteLines
}

function isNoteLine(line) {
    const normalized = normalizeForMatch(line)
    return normalized.includes('recepce') || /\bbox\b/i.test(line) || /\bb\s*ox\b/i.test(line)
}

function isCapacityLine(line) {
    return /^\[\s*\d{1,2}\s*\+\s*\d{1,2}\s*\]$/.test(String(line || '').trim())
}

function matchAlfredWindows(sourceText) {
    return String(sourceText || '').matchAll(
        /\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(AM|PM)?\s*-\s*([01]?\d|2[0-3])[:.]([0-5]\d)\s*(AM|PM)?\s*\(?alfred\)?/gi
    )
}

function extractAlfredWindows(sourceText) {
    const windows = []
    for (const match of matchAlfredWindows(sourceText)) {
        const sharedMeridiem = match[3] || match[6] || ''
        const startTime = normalizeTimeWithMeridiem(match[1], match[2], match[3] || sharedMeridiem)
        const endTime = normalizeTimeWithMeridiem(match[4], match[5], match[6] || sharedMeridiem)
        windows.push({
            startTime,
            endTime,
            raw: String(match[0] || '').replace(/\s+/g, ' ').trim()
        })
    }
    return windows
}

function formatAlfredWindowLabel(window) {
    if (!window || !window.startTime || !window.endTime) return undefined
    return `${window.startTime} - ${window.endTime}`
}

function isAlfredWindow(line) {
    return extractAlfredWindows(line).length > 0
}

function stripAlfredWindowSegments(line) {
    return String(line || '')
        .replace(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(AM|PM)?\s*-\s*([01]?\d|2[0-3])[:.]([0-5]\d)\s*(AM|PM)?\s*\(?alfred\)?/gi, ' ')
    .replace(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(?:AM|PM)?\s*-\s*([01]?\d|2[0-3])[:.]([0-5]\d)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function detectRoomToken(line) {
    const collapsed = String(line || '').replace(/\s+/g, ' ').trim()
    const start = collapsed.match(/^(\d{3})(?:\s+studio)?\b/i)
    if (start) {
        const room = normalizeRoomNumber(start[1])
        if (MASTER_ROOM_SET.has(room)) return room
    }
    return undefined
}

function detectTimes(blockText) {
    const detected = []
    const source = stripAlfredWindowSegments(String(blockText || ''))
    const matches = source.matchAll(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(AM|PM)?\b/gi)
    for (const match of matches) {
        detected.push(normalizeTimeWithMeridiem(match[1], match[2], match[3]))
    }
    return detected
}

function detectTimedEntries(blockText) {
    const entries = []
    const source = stripAlfredWindowSegments(String(blockText || ''))
    const matches = source.matchAll(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(AM|PM)?\b/gi)

    for (const match of matches) {
        const index = typeof match.index === 'number' ? match.index : 0
        const prefix = source.slice(Math.max(0, index - 16), index)
        const countMatch = prefix.match(/\((\d{1,2})\)\s*$/)

        entries.push({
            time: normalizeTimeWithMeridiem(match[1], match[2], match[3]),
            guestCount: countMatch ? Number(countMatch[1]) : undefined,
            index
        })
    }

    return entries
}

function extractMainDisplayedArrivalTime(sideText) {
    const entries = detectTimedEntries(sideText)
    if (entries.length === 0) {
        const times = detectTimes(sideText)
        return times.length > 0 ? times[times.length - 1] : undefined
    }

    const withGuestCount = entries.filter((entry) => typeof entry.guestCount === 'number')
    const candidates = withGuestCount.length > 0 ? withGuestCount : entries
    const selected = candidates[candidates.length - 1]
    return selected && selected.time
}

function chooseTimes(detectedTimes, noteGroupsCount) {
    if (detectedTimes.length >= 2) {
        const ordered = [...detectedTimes].sort((a, b) => toMinutes(a) - toMinutes(b))
        const first = ordered[0]
        const last = ordered[ordered.length - 1]
        return { departureTime: first, arrivalTime: last }
    }

    if (detectedTimes.length === 1) {
        const only = detectedTimes[0]
        if (noteGroupsCount >= 2) return { departureTime: only, arrivalTime: only }
        if (toMinutes(only) <= 12 * 60) return { departureTime: only, arrivalTime: undefined }
        return { departureTime: undefined, arrivalTime: only }
    }

    return { departureTime: undefined, arrivalTime: undefined }
}

function chooseGuestCounts(timedEntries, departureTime, arrivalTime, noteGroupsCount = 0) {
    if (!departureTime && !arrivalTime) {
        return { departureGuestCount: undefined, arrivalGuestCount: undefined }
    }

    if (timedEntries.length === 0) {
        return { departureGuestCount: undefined, arrivalGuestCount: undefined }
    }

    const ordered = [...timedEntries].sort((a, b) => {
        const minuteDiff = toMinutes(a.time) - toMinutes(b.time)
        if (minuteDiff !== 0) return minuteDiff
        return a.index - b.index
    })

    const guestCountForTime = (time, useLast) => {
        const matches = ordered.filter((entry) => entry.time === time)
        if (matches.length === 0) return undefined
        const selected = useLast ? matches[matches.length - 1] : matches[0]
        return selected && selected.guestCount
    }

    if (departureTime && arrivalTime) {
        if (ordered.length >= 2) {
            return {
                departureGuestCount: ordered[0] && ordered[0].guestCount,
                arrivalGuestCount: ordered[ordered.length - 1] && ordered[ordered.length - 1].guestCount
            }
        }

        const singleCount = ordered[0] && ordered[0].guestCount
        if (noteGroupsCount >= 2) {
            return {
                departureGuestCount: singleCount,
                arrivalGuestCount: singleCount
            }
        }

        if (toMinutes(ordered[0].time) <= 12 * 60) {
            return {
                departureGuestCount: singleCount,
                arrivalGuestCount: undefined
            }
        }

        return {
            departureGuestCount: undefined,
            arrivalGuestCount: singleCount
        }
    }

    if (departureTime) {
        return {
            departureGuestCount: guestCountForTime(departureTime, false),
            arrivalGuestCount: undefined
        }
    }

    return {
        departureGuestCount: undefined,
        arrivalGuestCount: guestCountForTime(arrivalTime, true)
    }
}

function extractStandaloneGuestCounts(blockText) {
    const source = stripAlfredWindowSegments(String(blockText || ''))
    const parenthesis = [...source.matchAll(/\((\d{1,2})\)/g)].map((m) => Number(m[1]))
    const suffixCounts = [...source.matchAll(/\b(\d{1,2})\s*(?:p|os|host|pax)\b/gi)].map((m) => Number(m[1]))
    const all = [...parenthesis, ...suffixCounts].filter((value) => Number.isFinite(value) && value >= 0)
    return Array.from(new Set(all))
}

function chooseStayoverGuestCount(roomNumber, ...texts) {
    const allCounts = texts.flatMap((text) => extractStandaloneGuestCounts(text))
    if (allCounts.length === 0) return undefined

    const roomCapacity = ROOM_CAPACITY_BY_NUMBER[normalizeRoomKey(roomNumber)]
    const filteredCounts = typeof roomCapacity === 'number'
        ? allCounts.filter((count) => count <= roomCapacity)
        : allCounts

    if (filteredCounts.length === 0) return undefined
    return filteredCounts.sort((a, b) => a - b)[0]
}

function assignNotesBySide(noteGroups, departureTime, arrivalTime) {
    const departureNotes = []
    const arrivalNotes = []
    const sideWarnings = []

    if (noteGroups.length === 0) return { departureNotes, arrivalNotes, sideWarnings }

    if (departureTime && arrivalTime) {
        if (noteGroups[0]) departureNotes.push(noteGroups[0])
        if (noteGroups[1]) arrivalNotes.push(noteGroups[1])
        if (noteGroups.length > 2) {
            sideWarnings.push('Více než dvě poznámkové skupiny v bloku')
        }
        return { departureNotes, arrivalNotes, sideWarnings }
    }

    if (departureTime && !arrivalTime) {
        departureNotes.push(noteGroups[0])
        if (noteGroups.length > 1) {
            sideWarnings.push('Pouze odjezdový čas, další poznámky ignorovány')
        }
        return { departureNotes, arrivalNotes, sideWarnings }
    }

    if (arrivalTime && !departureTime) {
        arrivalNotes.push(noteGroups[0])
        if (noteGroups.length > 1) {
            sideWarnings.push('Pouze příjezdový čas, další poznámky ignorovány')
        }
        return { departureNotes, arrivalNotes, sideWarnings }
    }

    departureNotes.push(noteGroups[0])
    return { departureNotes, arrivalNotes, sideWarnings }
}

function extractNameCandidates(blockLines) {
    const candidates = []
    const singleTokenLines = []
    const forbiddenTokens = new Set([
        'odjezd', 'prijezd', 'datum', 'pokoj', 'poznamka',
        'recepce', 'box', 'studio', 'alfred', 'chill', 'apartments'
    ])

    function normalizeCandidateCase(value) {
        return String(value || '')
            .split(' ')
            .map((token) => {
                if (!/^\p{Ll}[\p{L}'’-]+$/u.test(token)) return token
                return `${token[0].toUpperCase()}${token.slice(1)}`
            })
            .join(' ')
    }

    function pushCandidate(value) {
        const formatted = normalizeCandidateCase(value)
        const containsForbiddenToken = formatted
            .split(' ')
            .map((token) => normalizeForMatch(token))
            .some((token) => forbiddenTokens.has(token))
        if (containsForbiddenToken) return

        const normalized = normalizeForMatch(formatted)
        if (!normalized || candidates.some((item) => normalizeForMatch(item) === normalized)) return
        candidates.push(formatted)
    }

    blockLines.forEach((line) => {
        const trimmed = String(line || '').trim()
        if (!trimmed) return
        if (detectRoomToken(trimmed)) return
        if (isCapacityLine(trimmed)) return
        if (isNoteLine(trimmed)) return
        if (isAlfredWindow(trimmed)) return

        const cleaned = trimmed
            .replace(/\b\d{1,2}\.\s*\d{1,2}\.?\b/g, ' ')
            .replace(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(?:AM|PM)?\b/gi, ' ')
            .replace(/\b(?:AM|PM)\b/gi, ' ')
            .replace(/\[\s*\d{1,2}\s*\+\s*\d{1,2}\s*\]/g, ' ')
            .replace(/[()]/g, ' ')
            .replace(/\b(?:odjezd|prijezd|datum|pokoj|poznamka|recepce|box|alfred|studio|chill|apartments)\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim()

        if (!cleaned || !/[A-Za-zÀ-ž]/.test(cleaned)) return

        const pairMatches = [...cleaned.matchAll(/(\p{Lu}[\p{L}'’-]+\s+\p{Lu}[\p{L}'’-]+)/gu)]
            .map((match) => match[1].trim())
        if (pairMatches.length > 0) {
            pairMatches.forEach(pushCandidate)
            return
        }

        const mixedCasePairs = [...cleaned.matchAll(/(\p{Ll}[\p{L}'’-]+\s+\p{Lu}[\p{L}'’-]+)/gu)]
            .map((match) => match[1].trim())
        if (mixedCasePairs.length > 0) {
            mixedCasePairs.forEach(pushCandidate)
            return
        }

        const tokens = cleaned.split(' ').map((token) => token.trim()).filter(Boolean)
        if (tokens.length === 1 && /^\p{L}[\p{L}'’-]*$/u.test(tokens[0])) {
            singleTokenLines.push(tokens[0])
        }

        for (let i = 0; i + 1 < tokens.length; i++) {
            const first = tokens[i]
            const second = tokens[i + 1]
            const firstUpper = /^\p{Lu}[\p{L}'’-]+$/u.test(first)
            const firstLower = /^\p{Ll}[\p{L}'’-]+$/u.test(first)
            const secondUpper = /^\p{Lu}[\p{L}'’-]+$/u.test(second)
            const secondLower = /^\p{Ll}[\p{L}'’-]+$/u.test(second)
            const secondInitial = /^\p{Lu}$/u.test(second)
            if ((firstUpper && (secondUpper || secondInitial)) || (firstLower && secondUpper) || (firstLower && secondLower)) {
                pushCandidate(`${first} ${second}`)
            }
        }
    })

    for (let i = 0; i + 1 < singleTokenLines.length; i++) {
        const first = singleTokenLines[i]
        const second = singleTokenLines[i + 1]
        const firstNameLike = /^\p{L}[\p{L}'’-]*$/u.test(first)
        const secondNameLike = /^\p{L}[\p{L}'’-]*$/u.test(second)
        if (firstNameLike && secondNameLike) {
            pushCandidate(`${first} ${second}`)
        }
    }

    return candidates
}

function mergeMissingFieldsFromTextFallback(primaryRows, fallbackRows) {
    const fallbackByKey = new Map()
    fallbackRows.forEach((row) => {
        const key = `${row.dateIso}__${normalizeRoomKey(row.roomNumber)}`
        fallbackByKey.set(key, row)
    })

    primaryRows.forEach((row) => {
        const key = `${row.dateIso}__${normalizeRoomKey(row.roomNumber)}`
        const fallback = fallbackByKey.get(key)
        if (!fallback) return

        const hasFutureStayoverWindow = Boolean(
            !row.departureTime
            && !row.arrivalTime
            && row.stayoverUntil
            && row.stayoverUntil > row.dateIso
        )

        const hasPrimaryDepartureSignal = Boolean(
            row.departureGuestName
            || typeof row.departureGuestCount === 'number'
            || ((row.departureNotes || []).length || 0) > 0
        )
        const hasPrimaryArrivalSignal = Boolean(
            row.arrivalGuestName
            || typeof row.arrivalGuestCount === 'number'
            || ((row.arrivalNotes || []).length || 0) > 0
        )
        const canMergeDepartureSide = hasPrimaryDepartureSignal && !hasFutureStayoverWindow
        const canMergeArrivalSide = hasPrimaryArrivalSignal && !hasFutureStayoverWindow

        if (!row.departureTime && fallback.departureTime && canMergeDepartureSide) row.departureTime = fallback.departureTime
        if (!row.arrivalTime && fallback.arrivalTime && canMergeArrivalSide) row.arrivalTime = fallback.arrivalTime
        if (!row.mainDisplayedArrivalTime && fallback.mainDisplayedArrivalTime && canMergeArrivalSide) {
            row.mainDisplayedArrivalTime = fallback.mainDisplayedArrivalTime
        }
        if (!row.alfredWindow && fallback.alfredWindow) {
            row.alfredWindow = fallback.alfredWindow
        }

        if (canMergeDepartureSide && typeof row.departureGuestCount !== 'number' && typeof fallback.departureGuestCount === 'number') {
            row.departureGuestCount = fallback.departureGuestCount
        }
        if (canMergeArrivalSide && typeof row.arrivalGuestCount !== 'number' && typeof fallback.arrivalGuestCount === 'number') {
            row.arrivalGuestCount = fallback.arrivalGuestCount
        }
        if (typeof row.stayoverGuestCount !== 'number' && typeof fallback.stayoverGuestCount === 'number') {
            row.stayoverGuestCount = fallback.stayoverGuestCount
        }

        const isSameTimeTurnover = Boolean(
            row.departureTime
            && row.arrivalTime
            && row.departureTime === row.arrivalTime
        )
        if (
            isSameTimeTurnover
            && namesDiffer(row.departureGuestName, row.arrivalGuestName)
            && typeof row.departureGuestCount === 'number'
            && typeof row.arrivalGuestCount === 'number'
            && row.departureGuestCount === row.arrivalGuestCount
            && typeof fallback.departureGuestCount === 'number'
            && typeof fallback.arrivalGuestCount === 'number'
            && fallback.departureGuestCount !== fallback.arrivalGuestCount
        ) {
            if (fallback.departureGuestCount === row.departureGuestCount) {
                row.arrivalGuestCount = fallback.arrivalGuestCount
            } else if (fallback.arrivalGuestCount === row.departureGuestCount) {
                row.arrivalGuestCount = fallback.departureGuestCount
            }
        }

        if (!row.departureGuestName && fallback.departureGuestName && canMergeDepartureSide) row.departureGuestName = fallback.departureGuestName
        if (!row.arrivalGuestName && fallback.arrivalGuestName && canMergeArrivalSide) row.arrivalGuestName = fallback.arrivalGuestName
        if (!row.stayoverGuestName && fallback.stayoverGuestName) row.stayoverGuestName = fallback.stayoverGuestName

        const hasPrimaryNotes = (row.departureNotes && row.departureNotes.length > 0)
            || (row.arrivalNotes && row.arrivalNotes.length > 0)
        if (!hasPrimaryNotes) {
            if (fallback.departureNotes && fallback.departureNotes.length > 0) {
                row.departureNotes = [...fallback.departureNotes]
            }
            if (fallback.arrivalNotes && fallback.arrivalNotes.length > 0) {
                row.arrivalNotes = [...fallback.arrivalNotes]
            }
        }

        if (!row.stayoverUntil && fallback.stayoverUntil) row.stayoverUntil = fallback.stayoverUntil
        row.isStayover = !row.departureTime && !row.arrivalTime
    })
}

function addDaysIso(dateIso, days) {
    const date = new Date(`${dateIso}T00:00:00`)
    if (Number.isNaN(date.getTime())) return ''
    date.setDate(date.getDate() + days)
    return formatLocalDate(date)
}

function extractStandaloneBoxNotes(notes) {
    return (notes || [])
        .map((note) => normalizeBoxText(note))
        .filter((note) => /^BOX\s+\d+$/i.test(note))
}

function extractBoxNotes(notes) {
    return (notes || [])
        .map((note) => normalizeBoxText(note))
        .filter((note) => /\bBOX\s+\d+\b/i.test(note))
}

function getSingleBoxNote(notes) {
    const boxes = extractBoxNotes(notes)
    const unique = Array.from(new Set(boxes.map((note) => {
        const match = note.match(/\bBOX\s+\d+\b/i)
        return match ? normalizeBoxText(match[0]) : normalizeBoxText(note)
    })))

    return unique.length === 1 ? unique[0] : undefined
}

function repairSameGuestNextDayBoxContinuity(rows) {
    const byKey = new Map()
    rows.forEach((row) => {
        byKey.set(`${row.dateIso}__${normalizeRoomKey(row.roomNumber)}`, row)
    })

    rows.forEach((arrivalRow) => {
        const roomKey = normalizeRoomKey(arrivalRow.roomNumber)
        const arrivalGuest = String(arrivalRow.arrivalGuestName || '').trim()
        if (!roomKey || !arrivalGuest) return

        const nextRow = byKey.get(`${addDaysIso(arrivalRow.dateIso, 1)}__${roomKey}`)
        const departureGuest = String((nextRow && nextRow.departureGuestName) || '').trim()
        if (!nextRow || !departureGuest) return
        if (normalizeForMatch(arrivalGuest) !== normalizeForMatch(departureGuest)) return

        const arrivalBox = getSingleBoxNote(arrivalRow.arrivalNotes || [])
        const departureBox = getSingleBoxNote(nextRow.departureNotes || [])
        if (arrivalBox && departureBox) return

        const canUseRepeatedStandaloneBox = Boolean(
            arrivalRow.departureGuestName
            && arrivalRow.departureTime
            && arrivalRow.arrivalTime
            && nextRow.departureTime
            && nextRow.arrivalTime
            && nextRow.arrivalGuestName
        )

        const currentDayStandaloneBoxes = canUseRepeatedStandaloneBox
            ? rows
                .filter((row) => row.dateIso === arrivalRow.dateIso && normalizeRoomKey(row.roomNumber) !== roomKey)
                .flatMap((row) => extractStandaloneBoxNotes([...(row.departureNotes || []), ...(row.arrivalNotes || [])]))
            : []
        const nextDayStandaloneBoxes = canUseRepeatedStandaloneBox
            ? rows
                .filter((row) => row.dateIso === nextRow.dateIso && normalizeRoomKey(row.roomNumber) !== roomKey)
                .flatMap((row) => extractStandaloneBoxNotes([...(row.departureNotes || []), ...(row.arrivalNotes || [])]))
            : []

        const continuityBox = arrivalBox || departureBox || currentDayStandaloneBoxes.find((box) => nextDayStandaloneBoxes.includes(box))
        if (!continuityBox) return

        if (!arrivalBox && extractBoxNotes(arrivalRow.arrivalNotes || []).length === 0) {
            arrivalRow.arrivalNotes = normalizeNotesList([...(arrivalRow.arrivalNotes || []), continuityBox])
        }
        if (!departureBox && extractBoxNotes(nextRow.departureNotes || []).length === 0) {
            nextRow.departureNotes = normalizeNotesList([...(nextRow.departureNotes || []), continuityBox])
        }
    })
}

function extractDateTokens(text) {
    const tokens = new Set()
    const matches = String(text || '').matchAll(/\b(\d{1,2})\.\s*(\d{1,2})\.?\b/g)
    for (const match of matches) {
        tokens.add(`${Number(match[1])}. ${Number(match[2])}.`)
    }
    return Array.from(tokens)
}

function buildMergedRowText(items) {
    return items
        .sort((a, b) => a.x - b.x)
        .map((item) => item.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function collectColumnText(rows, minX, maxX = Number.POSITIVE_INFINITY) {
    return rows
        .map((row) => {
            const line = row.items
                .filter((item) => item.x >= minX && item.x < maxX)
                .sort((a, b) => a.x - b.x)
                .map((item) => item.text)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim()
            return line
        })
        .filter(Boolean)
        .join('\n')
}

function detectSplitX(items) {
    const byLabel = (label) => items
        .filter((item) => normalizeForMatch(item.text) === label)
        .map((item) => item.x)
        .sort((a, b) => a - b)

    const datum = byLabel('datum')
    if (datum.length >= 2) return (datum[0] + datum[1]) / 2

    const odjezd = byLabel('odjezd')
    if (odjezd.length >= 2) return (odjezd[0] + odjezd[1]) / 2

    const prijezd = byLabel('prijezd')
    if (prijezd.length >= 2) return (prijezd[0] + prijezd[1]) / 2

    const xs = items.map((item) => item.x).sort((a, b) => a - b)
    if (xs.length === 0) return 250
    return xs[Math.floor(xs.length / 2)]
}

function detectNoteSplitX(items, fallbackSplitX) {
    const byLabel = (label) => items
        .filter((item) => normalizeForMatch(item.text) === label)
        .map((item) => item.x)
        .sort((a, b) => a - b)

    const odjezd = byLabel('odjezd')
    const prijezd = byLabel('prijezd')
    if (odjezd.length >= 2 && prijezd.length >= 2) {
        const split = (odjezd[1] + prijezd[1]) / 2
        if (Number.isFinite(split) && split > fallbackSplitX + 80) return split
    }

    const poznamka = byLabel('poznamka')
    if (poznamka.length >= 1) {
        const split = poznamka[0]
        if (Number.isFinite(split) && split > fallbackSplitX + 80) return split
    }

    return Number.POSITIVE_INFINITY
}

function detectNoteContentStartX(items, fallbackSplitX, fallbackNoteSplitX) {
    const noteContentXs = items
        .filter((item) => item.x > fallbackSplitX + 80)
        .filter((item) => isNoteLine(item.text) || /\bbox\b/i.test(item.text))
        .map((item) => item.x)
        .sort((a, b) => a - b)

    if (noteContentXs.length >= 2) return noteContentXs[0]
    return fallbackNoteSplitX
}

function detectRoomColumnMaxX(items, splitX) {
    const pokojHeader = items
        .filter((item) => normalizeForMatch(item.text) === 'pokoj')
        .map((item) => item.x)
        .sort((a, b) => a - b)[0]

    if (typeof pokojHeader === 'number') {
        return Math.min(splitX - 20, pokojHeader + 65)
    }

    const minX = items.reduce((min, item) => Math.min(min, item.x), Number.POSITIVE_INFINITY)
    if (!Number.isFinite(minX)) return splitX - 60
    return Math.min(splitX - 20, minX + 75)
}

function findRoomInRow(items, roomColumnMaxX) {
    const roomItems = items.filter((item) => item.x <= roomColumnMaxX)
    for (const item of roomItems) {
        const tokenMatch = item.text.match(/\b(\d{3})\b/)
        if (!tokenMatch) continue
        const normalized = normalizeRoomNumber(tokenMatch[1])
        if (MASTER_ROOM_SET.has(normalized)) return normalized
    }

    const joined = buildMergedRowText(roomItems)
    return detectRoomToken(joined)
}

function extractStateColumnBlocks(page) {
    if (!page || !page.items || page.items.length === 0) return []

    const splitX = detectSplitX(page.items)
    const noteSplitX = detectNoteSplitX(page.items, splitX)
    const noteContentStartX = detectNoteContentStartX(page.items, splitX, noteSplitX)
    const roomColumnMaxX = detectRoomColumnMaxX(page.items, splitX)
    const sideSplitPadding = 12

    const rowMap = new Map()
    page.items.forEach((item) => {
        const bucket = Math.round(item.y)
        if (!rowMap.has(bucket)) rowMap.set(bucket, [])
        rowMap.get(bucket).push({ text: item.text, x: item.x })
    })

    const rows = Array.from(rowMap.entries())
        .sort((a, b) => b[0] - a[0])
        .map(([y, items]) => ({
            y,
            items: items.sort((x, y) => x.x - y.x),
            text: buildMergedRowText(items)
        }))
        .filter((row) => row.text)
        .filter((row) => !shouldIgnoreLine(row.text) && parsePageDateHeader(row.text) === null)

    const starts = []
    rows.forEach((row, index) => {
        const room = findRoomInRow(row.items, roomColumnMaxX)
        if (room) starts.push({ index, room, y: row.y })
    })

    if (starts.length === 0) return []

    const rowsByStartIndex = new Map()
    starts.forEach((start) => rowsByStartIndex.set(start.index, []))

    starts.forEach((start, index) => {
        const prev = index > 0 ? starts[index - 1] : null
        const next = index + 1 < starts.length ? starts[index + 1] : null

        const topBoundary = prev ? start.y + (prev.y - start.y) * 0.6 : Number.POSITIVE_INFINITY
        const bottomBoundary = next ? start.y - (start.y - next.y) * 0.4 : Number.NEGATIVE_INFINITY

        rows.forEach((row) => {
            if (row.y <= topBoundary && row.y > bottomBoundary) {
                rowsByStartIndex.get(start.index)?.push(row)
            }
        })
    })

    return starts.map((start) => {
        const assignedRows = [...(rowsByStartIndex.get(start.index) || [])].sort((a, b) => b.y - a.y)
        const firstOwnSignalAboveMarker = assignedRows
            .filter((row) => row.y > start.y)
            .filter((row) => isNoteLine(row.text) || detectTimes(row.text).length > 0)
            .sort((a, b) => b.y - a.y)[0]
        const blockRows = firstOwnSignalAboveMarker
            ? assignedRows.filter((row) => row.y <= firstOwnSignalAboveMarker.y || findRoomInRow(row.items, roomColumnMaxX) === start.room)
            : assignedRows
        const departureText = collectColumnText(blockRows, roomColumnMaxX + 1, splitX + sideSplitPadding)
        const hasNoteSplit = Number.isFinite(noteSplitX)
        const arrivalText = collectColumnText(
            blockRows,
            splitX + sideSplitPadding,
            Number.isFinite(noteContentStartX) ? noteContentStartX : Number.POSITIVE_INFINITY
        )
        const departureNoteText = hasNoteSplit
            ? collectColumnText(blockRows, splitX + sideSplitPadding, noteSplitX)
            : ''
        const arrivalNoteText = hasNoteSplit
            ? collectColumnText(blockRows, noteSplitX)
            : ''
        const rawText = blockRows.map((row) => row.text).join('\n')

        return {
            room: start.room,
            departureText,
            arrivalText,
            departureNoteText,
            arrivalNoteText,
            rawText
        }
    })
}

function extractSideNotes(sideText) {
    const noteSource = extractNoteSourceLines(sideText)
        .join(' ')

    return splitNoteGroups(noteSource)
}

function extractSideTimeAndCount(sideText, side) {
    const alfredWindows = side === 'arrival' ? extractAlfredWindows(sideText) : []
    const mainDisplayedArrivalTime = side === 'arrival'
        ? extractMainDisplayedArrivalTime(sideText)
        : undefined
    const entries = detectTimedEntries(sideText)
    const times = detectTimes(sideText)
    const standaloneCounts = extractStandaloneGuestCounts(sideText)

    let combined = entries.slice()

    if (combined.length === 0 && times.length > 0) {
        combined = times.map((t, idx) => ({ time: t, guestCount: undefined, index: idx }))
    }

    if (combined.length === 0) {
        return {
            time: undefined,
            guestCount: undefined,
            hadAmPm: /\b(?:AM|PM)\b/i.test(sideText),
            mainDisplayedArrivalTime,
            alfredWindow: formatAlfredWindowLabel(alfredWindows[0])
        }
    }

    const ordered = [...combined].sort((a, b) => {
        const minuteDiff = toMinutes(a.time) - toMinutes(b.time)
        if (minuteDiff !== 0) return minuteDiff
        return a.index - b.index
    })

    const selected = side === 'departure' ? ordered[0] : ordered[ordered.length - 1]

    let inferredCount = selected && selected.guestCount
    if (typeof inferredCount === 'undefined' && standaloneCounts.length > 0) {
        if (standaloneCounts.length === 1) {
            inferredCount = standaloneCounts[0]
        } else if (times.length === standaloneCounts.length) {
            const selIdx = ordered.findIndex((e) => e.time === selected && e.index === selected.index)
            inferredCount = standaloneCounts[selIdx] || standaloneCounts[0]
        } else {
            inferredCount = side === 'departure' ? standaloneCounts[0] : standaloneCounts[standaloneCounts.length - 1]
        }
    }

    return {
        time: selected && selected.time,
        guestCount: inferredCount,
        hadAmPm: /\b(?:AM|PM)\b/i.test(sideText),
        mainDisplayedArrivalTime,
        alfredWindow: formatAlfredWindowLabel(alfredWindows[0])
    }
}

function namesDiffer(left, right) {
    if (!left || !right) return false
    return normalizeForMatch(left) !== normalizeForMatch(right)
}

function extractRawNoteGroups(rawText) {
    const noteSource = extractNoteSourceLines(String(rawText || ''))
        .join(' ')

    return splitNoteGroups(noteSource)
}

function backfillAmbiguousTurnoverFromRawBlock({
    rawText,
    departureTime,
    arrivalTime,
    departureGuestName,
    arrivalGuestName,
    departureGuestCount,
    arrivalGuestCount,
    departureNotes,
    arrivalNotes
}) {
    const rawNoteGroups = extractRawNoteGroups(rawText)
    const hasDistinctGuests = namesDiffer(departureGuestName, arrivalGuestName)
    const hasMatchingCounts = typeof departureGuestCount === 'number'
        && typeof arrivalGuestCount === 'number'
        && departureGuestCount === arrivalGuestCount
    const canAssumeSameTimeTurnover = hasDistinctGuests && (rawNoteGroups.length >= 2 || hasMatchingCounts)

    if (departureTime && !arrivalTime && canAssumeSameTimeTurnover) {
        arrivalTime = departureTime
    }
    if (arrivalTime && !departureTime && canAssumeSameTimeTurnover) {
        departureTime = arrivalTime
    }

    if (rawNoteGroups.length > 0) {
        // Conservative fallback: only infer raw note groups when both sides are empty.
        // This prevents cross-side note leakage (e.g. arrival BOX being moved to departure).
        const hadDepartureNotes = Array.isArray(departureNotes) && departureNotes.length > 0
        const hadArrivalNotes = Array.isArray(arrivalNotes) && arrivalNotes.length > 0

        if (!hadDepartureNotes && !hadArrivalNotes) {
            if (departureTime && rawNoteGroups[0]) {
                departureNotes = [rawNoteGroups[0]]
            }
            if (arrivalTime) {
                if (departureTime && rawNoteGroups[1]) {
                    arrivalNotes = [rawNoteGroups[1]]
                } else if (!departureTime && rawNoteGroups[0]) {
                    arrivalNotes = [rawNoteGroups[0]]
                }
            }
        }
    }

    return {
        departureTime,
        arrivalTime,
        departureNotes,
        arrivalNotes
    }
}

function normalizeNotesList(notes) {
    return (notes || [])
        .map((note) => normalizeBoxText(String(note || '').trim()))
        .filter(Boolean)
        .filter((note, index, all) => all.indexOf(note) === index)
}

function normalizeGuestNoteCandidate(value) {
    return normalizeForMatch(value)
        .replace(/\.\.\.+|…+/g, ' ')
        .replace(/[^\p{L}\s'’-]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripTrailingGuestNameFromNote(note, guestNames) {
    let cleaned = String(note || '').trim()
    if (!cleaned) return cleaned

        ; (guestNames || []).forEach((guestName) => {
            const name = String(guestName || '').trim()
            if (!name) return
            const namePattern = name
                .split(/\s+/)
                .map(escapeRegExp)
                .join('\\s+')
            cleaned = cleaned.replace(new RegExp(`\\s+${namePattern}\\s*$`, 'iu'), '').trim()
        })

    return cleaned
}

function noteMatchesGuestName(note, guestNames) {
    const noteNorm = normalizeGuestNoteCandidate(note)
    if (!noteNorm || /\bbox\b/i.test(note) || normalizeForMatch(note).includes('recepce')) return false

    const noteTokens = noteNorm.split(' ').filter(Boolean)
    if (noteTokens.length < 2) return false

    return (guestNames || []).some((guestName) => {
        const guestNorm = normalizeGuestNoteCandidate(String(guestName || ''))
        if (!guestNorm) return false
        if (noteNorm === guestNorm) return true
        if (guestNorm.startsWith(`${noteNorm} `)) return true
        return false
    })
}

function removeGuestNameNotes(notes, guestNames) {
    return (notes || [])
        .map((note) => stripTrailingGuestNameFromNote(note, guestNames))
        .filter((note) => note && !noteMatchesGuestName(note, guestNames))
}

function haveSameNotes(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    if (left.length !== right.length) return false
    const leftNorm = left.map((note) => normalizeForMatch(note).replace(/\s+/g, ' ').trim())
    const rightNorm = right.map((note) => normalizeForMatch(note).replace(/\s+/g, ' ').trim())
    return leftNorm.every((note, index) => note === rightNorm[index])
}

function hasMultipleNoteMentions(rawText) {
    const noteMentions = String(rawText || '').match(/recepce\s*:/gi) || []
    return noteMentions.length >= 2
}

function extractNameTokensFromSideText(sideText) {
    return String(sideText || '')
        .split(/\r?\n/)
        .flatMap((line) => {
            const trimmed = String(line || '').trim()
            if (!trimmed) return []

            const withoutRoomPrefix = trimmed.replace(/^\d{1,3}\s+/, '')
            const cleaned = withoutRoomPrefix
                .replace(/\b\d{1,2}\.\s*\d{1,2}\.?\b/g, ' ')
                .replace(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(?:AM|PM)?\b/gi, ' ')
                .replace(/\b(?:AM|PM)\b/gi, ' ')
                .replace(/\[\s*\d{1,2}\s*\+\s*\d{1,2}\s*\]/g, ' ')
                .replace(/[()]/g, ' ')
                .replace(/\.\.\./g, ' ')
                .replace(/\b(?:odjezd|prijezd|datum|pokoj|poznamka|recepce|box|alfred|studio|chill|apartments)\b/gi, ' ')
                .replace(/\s+/g, ' ')
                .trim()

            if (!cleaned) return []
            return cleaned
                .split(' ')
                .map((token) => token.trim())
                .filter((token) => /^\p{L}[\p{L}'’-]*$/u.test(token))
        })
}

function expandPrimaryGuestName(sideText, baseName) {
    const normalizedBase = String(baseName || '').trim()
    if (!normalizedBase) return undefined

    const tokens = extractNameTokensFromSideText(sideText)
    const baseTokens = normalizedBase.split(' ').map((token) => token.trim()).filter(Boolean)
    if (tokens.length === 0 || baseTokens.length === 0) return normalizedBase

    const baseNormTokens = baseTokens.map((token) => normalizeForMatch(token))
    let startIndex = -1
    for (let i = 0; i <= tokens.length - baseTokens.length; i++) {
        const segment = tokens.slice(i, i + baseTokens.length).map((token) => normalizeForMatch(token))
        const same = segment.every((token, index) => token === baseNormTokens[index])
        if (same) {
            startIndex = i
            break
        }
    }
    if (startIndex < 0) return normalizedBase

    const expandedTokens = [...baseTokens]
    let cursor = startIndex + baseTokens.length
    const initialTokens = []

    while (cursor < tokens.length && /^\p{Lu}$/u.test(tokens[cursor])) {
        initialTokens.push(tokens[cursor])
        cursor += 1
    }

    if (initialTokens.length > 0) {
        expandedTokens.push(...initialTokens)
        if (cursor < tokens.length && /^\p{Lu}[\p{L}'’-]+$/u.test(tokens[cursor])) {
            expandedTokens.push(tokens[cursor])
        }
        return expandedTokens.join(' ')
    }

    if (cursor < tokens.length && /^\p{Lu}[\p{L}'’-]+$/u.test(tokens[cursor])) {
        const possibleSurname = tokens[cursor]
        const surnameRepeatsLater = tokens
            .slice(cursor + 1)
            .some((token) => normalizeForMatch(token) === normalizeForMatch(possibleSurname))
        if (surnameRepeatsLater) {
            expandedTokens.push(possibleSurname)
        }
    }

    return expandedTokens.join(' ')
}

function pickDepartureGuestName(sideText) {
    const candidates = extractNameCandidates(String(sideText || '').split(/\r?\n/))
    return candidates[0]
}

function pickArrivalGuestName(sideText) {
    const source = String(sideText || '')
    const candidates = extractNameCandidates(source.split(/\r?\n/))
    if (candidates.length === 0) return undefined

    const normalizedSource = normalizeForMatch(source).replace(/\s+/g, ' ')
    const timeRegex = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g
    let lastTimeIndex = -1
    let timeMatch
    while ((timeMatch = timeRegex.exec(normalizedSource)) !== null) {
        lastTimeIndex = timeMatch.index
    }

    let selected = candidates[0]
    if (lastTimeIndex >= 0) {
        const firstAfterTime = candidates.find((candidate) => {
            const candidateIndex = normalizedSource.indexOf(normalizeForMatch(candidate))
            return candidateIndex > lastTimeIndex
        })
        if (firstAfterTime) selected = firstAfterTime
    }

    return expandPrimaryGuestName(source, selected)
}

function pickStayoverGuestName(rawText, fallbackName) {
    const names = []
    const pushName = (value) => {
        const normalized = String(value || '').replace(/\s+/g, ' ').trim()
        if (!normalized) return
        const matchKey = normalizeForMatch(normalized)
        if (names.some((name) => {
            const existingKey = normalizeForMatch(name)
            return existingKey === matchKey || existingKey.includes(matchKey)
        })) return
        for (let index = names.length - 1; index >= 0; index--) {
            if (matchKey.includes(normalizeForMatch(names[index]))) names.splice(index, 1)
        }
        names.push(normalized)
    }

    String(rawText || '').split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim()
        if (!trimmed || isNoteLine(trimmed) || isAlfredWindow(trimmed) || isCapacityLine(trimmed)) return

        const cleaned = trimmed
            .replace(/^\d{1,3}\s+/, '')
            .replace(/\b\d{1,2}\.\s*\d{1,2}\.?\b/g, ' ')
            .replace(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(?:AM|PM)?\b/gi, ' ')
            .replace(/\b(?:AM|PM)\b/gi, ' ')
            .replace(/\[\s*\d{1,2}\s*\+\s*\d{1,2}\s*\]/g, ' ')
            .replace(/[()]/g, ' ')
            .replace(/\b(?:odjezd|prijezd|datum|pokoj|poznamka|recepce|box|alfred|studio|chill|apartments)\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim()

        const tokens = cleaned.split(' ').map((token) => token.trim()).filter(Boolean)
        const allNameLike = tokens.length >= 2
            && tokens.length <= 4
            && tokens.every((token) => /^\p{L}[\p{L}'’-]*$/u.test(token))
        if (allNameLike) pushName(cleaned)
    })

    extractNameCandidates(String(rawText || '').split(/\r?\n/)).forEach(pushName)
    pushName(fallbackName)

    return names.length > 0 ? names.join(', ') : undefined
}

function inferGuestCountNearName(rawText, guestName) {
    if (!guestName) return undefined

    const source = String(rawText || '')
    const countMatches = [...source.matchAll(/\((\d{1,2})\)|\b(\d{1,2})\s*(?:p|os|host|pax)\b/gi)]
    if (countMatches.length === 0) return undefined

    const nameIndex = source.toLowerCase().indexOf(String(guestName || '').toLowerCase())
    if (nameIndex < 0) return undefined

    const nearest = countMatches.reduce((best, match) => {
        const matchIndex = typeof match.index === 'number' ? match.index : 0
        const bestIndex = typeof best.index === 'number' ? best.index : 0
        return Math.abs(matchIndex - nameIndex) < Math.abs(bestIndex - nameIndex) ? match : best
    }, countMatches[0])

    const value = Number(nearest[1] || nearest[2])
    return Number.isFinite(value) ? value : undefined
}

function resolveArrivalGuestCountFromSide(
    roomNumber,
    arrivalText,
    currentArrivalGuestCount,
    departureGuestCount,
    distinctGuests
) {
    const sideCounts = extractStandaloneGuestCounts(arrivalText)
    if (sideCounts.length === 0) return currentArrivalGuestCount

    const roomCapacity = ROOM_CAPACITY_BY_NUMBER[normalizeRoomKey(roomNumber)]
    const cappedCandidates = typeof roomCapacity === 'number'
        ? sideCounts.filter((count) => count <= roomCapacity)
        : sideCounts
    const candidates = cappedCandidates.length > 0 ? cappedCandidates : sideCounts

    if (typeof currentArrivalGuestCount !== 'number') {
        return candidates[0]
    }

    if (typeof roomCapacity === 'number' && currentArrivalGuestCount > roomCapacity) {
        return candidates[0]
    }

    if (
        distinctGuests
        && typeof departureGuestCount === 'number'
        && currentArrivalGuestCount === departureGuestCount
        && candidates.some((count) => count !== departureGuestCount)
    ) {
        return candidates.find((count) => count !== departureGuestCount)
    }

    return currentArrivalGuestCount
}

function isSuspiciousNightTurnover(time) {
    if (!time) return false
    const [hoursRaw] = String(time).split(':')
    const hours = Number(hoursRaw)
    if (!Number.isFinite(hours)) return false
    return hours >= 1 && hours <= 7
}

let pdfRuntimePrimitivesReady = false
let pdfRuntimeModulesPromise = null

function toFiniteNumber(value, fallback = 0) {
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
}

function toMatrix2D(input) {
    if (!input) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

    if (Array.isArray(input)) {
        if (input.length >= 6) {
            return {
                a: toFiniteNumber(input[0], 1),
                b: toFiniteNumber(input[1], 0),
                c: toFiniteNumber(input[2], 0),
                d: toFiniteNumber(input[3], 1),
                e: toFiniteNumber(input[4], 0),
                f: toFiniteNumber(input[5], 0)
            }
        }
        return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
    }

    if (typeof input === 'object') {
        const a = input.a ?? input.m11 ?? 1
        const b = input.b ?? input.m12 ?? 0
        const c = input.c ?? input.m21 ?? 0
        const d = input.d ?? input.m22 ?? 1
        const e = input.e ?? input.m41 ?? 0
        const f = input.f ?? input.m42 ?? 0
        return {
            a: toFiniteNumber(a, 1),
            b: toFiniteNumber(b, 0),
            c: toFiniteNumber(c, 0),
            d: toFiniteNumber(d, 1),
            e: toFiniteNumber(e, 0),
            f: toFiniteNumber(f, 0)
        }
    }

    return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
}

function multiplyMatrix2D(left, right) {
    return {
        a: left.a * right.a + left.c * right.b,
        b: left.b * right.a + left.d * right.b,
        c: left.a * right.c + left.c * right.d,
        d: left.b * right.c + left.d * right.d,
        e: left.a * right.e + left.c * right.f + left.e,
        f: left.b * right.e + left.d * right.f + left.f
    }
}

function createDOMMatrixPolyfillClass() {
    return class DOMMatrixPolyfill {
        constructor(init) {
            const matrix = toMatrix2D(init)
            this.a = matrix.a
            this.b = matrix.b
            this.c = matrix.c
            this.d = matrix.d
            this.e = matrix.e
            this.f = matrix.f
        }

        get is2D() {
            return true
        }

        get isIdentity() {
            return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0
        }

        get m11() { return this.a }
        set m11(value) { this.a = toFiniteNumber(value, 1) }
        get m12() { return this.b }
        set m12(value) { this.b = toFiniteNumber(value, 0) }
        get m21() { return this.c }
        set m21(value) { this.c = toFiniteNumber(value, 0) }
        get m22() { return this.d }
        set m22(value) { this.d = toFiniteNumber(value, 1) }
        get m41() { return this.e }
        set m41(value) { this.e = toFiniteNumber(value, 0) }
        get m42() { return this.f }
        set m42(value) { this.f = toFiniteNumber(value, 0) }

        multiplySelf(other) {
            const current = toMatrix2D(this)
            const next = multiplyMatrix2D(current, toMatrix2D(other))
            this.a = next.a
            this.b = next.b
            this.c = next.c
            this.d = next.d
            this.e = next.e
            this.f = next.f
            return this
        }

        preMultiplySelf(other) {
            const current = toMatrix2D(this)
            const next = multiplyMatrix2D(toMatrix2D(other), current)
            this.a = next.a
            this.b = next.b
            this.c = next.c
            this.d = next.d
            this.e = next.e
            this.f = next.f
            return this
        }

        translateSelf(tx = 0, ty = 0) {
            return this.multiplySelf({ a: 1, b: 0, c: 0, d: 1, e: toFiniteNumber(tx, 0), f: toFiniteNumber(ty, 0) })
        }

        scaleSelf(scaleX = 1, scaleY = scaleX) {
            return this.multiplySelf({ a: toFiniteNumber(scaleX, 1), b: 0, c: 0, d: toFiniteNumber(scaleY, 1), e: 0, f: 0 })
        }

        rotateSelf(rotX = 0, rotY = 0, rotZ = 0) {
            const angle = toFiniteNumber(rotZ || rotY || rotX, 0)
            const radians = (angle * Math.PI) / 180
            const cos = Math.cos(radians)
            const sin = Math.sin(radians)
            return this.multiplySelf({ a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 })
        }

        inverse() {
            const det = this.a * this.d - this.b * this.c
            if (!det) return new this.constructor()
            const invDet = 1 / det
            return new this.constructor({
                a: this.d * invDet,
                b: -this.b * invDet,
                c: -this.c * invDet,
                d: this.a * invDet,
                e: (this.c * this.f - this.d * this.e) * invDet,
                f: (this.b * this.e - this.a * this.f) * invDet
            })
        }

        transformPoint(point) {
            const x = toFiniteNumber(point?.x, 0)
            const y = toFiniteNumber(point?.y, 0)
            return {
                x: this.a * x + this.c * y + this.e,
                y: this.b * x + this.d * y + this.f,
                z: toFiniteNumber(point?.z, 0),
                w: toFiniteNumber(point?.w, 1)
            }
        }

        toFloat32Array() {
            return new Float32Array([
                this.a, this.b, 0, 0,
                this.c, this.d, 0, 0,
                0, 0, 1, 0,
                this.e, this.f, 0, 1
            ])
        }

        toString() {
            return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`
        }

        setMatrixValue(value) {
            const text = String(value || '').trim()
            const match = text.match(/^matrix\(([^)]+)\)$/i)
            if (!match) return this
            const values = match[1].split(',').map((part) => toFiniteNumber(part.trim(), 0))
            if (values.length >= 6) {
                this.a = values[0]
                this.b = values[1]
                this.c = values[2]
                this.d = values[3]
                this.e = values[4]
                this.f = values[5]
            }
            return this
        }

        static fromMatrix(input) {
            return new this(input)
        }
    }
}

function ensurePdfRuntimePrimitives() {
    if (pdfRuntimePrimitivesReady) return

    if (typeof globalThis.DOMMatrix === 'undefined') {
        globalThis.DOMMatrix = createDOMMatrixPolyfillClass()
    }

    if (typeof globalThis.Path2D === 'undefined') {
        globalThis.Path2D = class Path2DPolyfill {
            addPath() { }
            closePath() { }
            moveTo() { }
            lineTo() { }
            bezierCurveTo() { }
            quadraticCurveTo() { }
            rect() { }
            arc() { }
        }
    }

    if (typeof globalThis.ImageData === 'undefined') {
        globalThis.ImageData = class ImageDataPolyfill {
            constructor(data, width, height) {
                this.data = data
                this.width = width
                this.height = height
            }
        }
    }

    pdfRuntimePrimitivesReady = true
}

async function ensurePdfRuntimeModules() {
    if (!pdfRuntimeModulesPromise) {
        pdfRuntimeModulesPromise = (async () => {
            const pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.mjs')

            const hasWorkerHandler = Boolean(
                globalThis.pdfjsWorker
                && globalThis.pdfjsWorker.WorkerMessageHandler
            )

            if (!hasWorkerHandler) {
                const workerModule = await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
                const workerMessageHandler = workerModule?.WorkerMessageHandler
                    || workerModule?.default?.WorkerMessageHandler

                if (workerMessageHandler) {
                    globalThis.pdfjsWorker = {
                        WorkerMessageHandler: workerMessageHandler
                    }
                }
            }

            try {
                if (pdfjsModule?.GlobalWorkerOptions && !pdfjsModule.GlobalWorkerOptions.workerSrc) {
                    pdfjsModule.GlobalWorkerOptions.workerSrc = 'pdfjs-dist/legacy/build/pdf.worker.mjs'
                }
            } catch {
                // Ignore workerSrc assignment errors in constrained runtimes.
            }

            return pdfjsModule
        })()
    }

    return pdfRuntimeModulesPromise
}

async function extractStateTextFromPdfBuffer(pdfBuffer) {
    ensurePdfRuntimePrimitives()
    const { getDocument } = await ensurePdfRuntimeModules()
    const data = new Uint8Array(pdfBuffer)
    const loadingTask = getDocument({ data })
    const pdf = await loadingTask.promise

    const pageTexts = []
    const pages = []
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i)
        const text = await page.getTextContent()

        const rawItems = text.items
            .map((item) => ({
                text: typeof item?.str === 'string' ? item.str.trim() : '',
                x: Array.isArray(item?.transform) ? Number(item.transform[4]) : 0,
                y: Array.isArray(item?.transform) ? Number(item.transform[5]) : 0,
                page: i
            }))
            .filter((item) => item.text)

        const rows = new Map()
        rawItems.forEach((item) => {
            const yBucket = Math.round(item.y)
            if (!rows.has(yBucket)) rows.set(yBucket, [])
            rows.get(yBucket).push({ str: item.text, x: item.x })
        })

        const mergedLines = Array.from(rows.entries())
            .sort((a, b) => b[0] - a[0])
            .map(([, items]) =>
                items
                    .sort((a, b) => a.x - b.x)
                    .map((item) => item.str)
                    .join(' ')
                    .replace(/\s+/g, ' ')
                    .trim()
            )
            .filter(Boolean)

        pageTexts.push(mergedLines.join('\n'))
        pages.push({ page: i, items: rawItems, mergedLines })
    }

    return {
        rawText: pageTexts.join(`\n${PDF_PAGE_BREAK}\n`),
        pages
    }
}

function normalizeSpreadsheetCell(value) {
    if (value === null || value === undefined) return ''
    if (value instanceof Date && Number.isFinite(value.getTime())) {
        return `${value.getDate()}. ${value.getMonth() + 1}. ${value.getFullYear()}`
    }
    return String(value).replace(/\u00a0/g, ' ').trim()
}

function parseSpreadsheetDateIso(value, fallbackYear) {
    const raw = normalizeSpreadsheetCell(value)
    if (!raw) return null

    const isoMatch = raw.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/)
    if (isoMatch) {
        const isoDate = new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]))
        return Number.isNaN(isoDate.getTime()) ? null : formatLocalDate(isoDate)
    }

    const fullMatch = raw.match(/\b(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\b/)
    if (fullMatch) {
        const parsed = new Date(Number(fullMatch[3]), Number(fullMatch[2]) - 1, Number(fullMatch[1]))
        return Number.isNaN(parsed.getTime()) ? null : formatLocalDate(parsed)
    }

    const shortMatch = raw.match(/\b(\d{1,2})\.\s*(\d{1,2})\.?\b/)
    if (shortMatch) {
        const parsed = new Date(Number(fallbackYear), Number(shortMatch[2]) - 1, Number(shortMatch[1]))
        return Number.isNaN(parsed.getTime()) ? null : formatLocalDate(parsed)
    }

    return null
}

function parseSpreadsheetNumber(value) {
    const normalized = normalizeSpreadsheetCell(value)
    if (!normalized) return undefined
    const asNumber = Number(normalized.replace(',', '.'))
    return Number.isFinite(asNumber) ? asNumber : undefined
}

function sanitizeSpreadsheetGuestLabel(raw) {
    return String(raw || '')
        .replace(/\(\s*alfred\s*\)/gi, ' ')
        .replace(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*\-\s*([01]?\d|2[0-3])[:.]([0-5]\d)\b/gi, ' ')
        .replace(/\((\d{1,2})\)/g, ' ')
        .replace(/[;|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^,\s*|,\s*$/g, '')
        .trim()
}

function pickSpreadsheetTime(rawCell, side) {
    const windowMatch = String(rawCell || '').match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(AM|PM)?\s*\-\s*([01]?\d|2[0-3])[:.]([0-5]\d)\s*(AM|PM)?\b/i)
    if (windowMatch) {
        return normalizeTimeWithMeridiem(windowMatch[1], windowMatch[2], windowMatch[3])
    }

    const singleMatch = String(rawCell || '').match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(AM|PM)?\b/i)
    if (singleMatch) {
        return normalizeTimeWithMeridiem(singleMatch[1], singleMatch[2], singleMatch[3])
    }

    const detected = detectTimes(String(rawCell || ''))
    if (detected.length === 0) {
        return side === 'departure' ? '11:00' : '14:00'
    }

    if (side === 'departure') {
        const morning = detected.find((time) => toMinutes(time) <= 12 * 60)
        return morning || detected[0]
    }

    return detected[0]
}

function parseSpreadsheetGuestCell(rawCell, side) {
    const text = normalizeSpreadsheetCell(rawCell)
    if (!text) {
        return {
            hasSignal: false,
            guestName: undefined,
            guestCount: undefined,
            time: undefined,
            hadAmPm: false
        }
    }

    const countMatch = text.match(/\((\d{1,2})\)/)
    const fallbackCountMatch = text.match(/\b(\d{1,2})\s*(?:p|os|host|pax)\b/i)

    const sanitizedName = sanitizeSpreadsheetGuestLabel(text)
    const hasNameLikeValue = /\p{L}/u.test(sanitizedName)
    const nameTokens = sanitizedName
        .split(/\s*,\s*/)
        .map((token) => token.trim())
        .filter(Boolean)

    let guestCount = countMatch ? Number(countMatch[1]) : undefined
    if (typeof guestCount !== 'number' && fallbackCountMatch) {
        guestCount = Number(fallbackCountMatch[1])
    }
    if (typeof guestCount !== 'number' && nameTokens.length > 1) {
        guestCount = nameTokens.length
    }

    const guestName = hasNameLikeValue ? sanitizedName : undefined
    const hasSignal = Boolean(guestName || typeof guestCount === 'number')

    return {
        hasSignal,
        guestName,
        guestCount,
        time: side === 'stayover' || !hasSignal ? undefined : pickSpreadsheetTime(text, side),
        hadAmPm: /\b(?:AM|PM)\b/i.test(text)
    }
}

function parseSpreadsheetNotes(rawCell) {
    const source = normalizeSpreadsheetCell(rawCell)
        .replace(/(?:\.\.\.+|…+)$/g, '')
        .trim()
    if (!source) return []

    const groups = splitNoteGroups(source)
    const normalized = groups
        .map((item) => normalizeBoxText(item))
        .map((item) => item.trim())
        .filter(Boolean)

    return Array.from(new Set(normalized))
}

function createSpreadsheetDebugLine(dateIso, roomNumber, rowCells) {
    const safe = (index) => normalizeSpreadsheetCell((rowCells || [])[index] || '')
    return [
        dateIso,
        roomNumber,
        `prijezd:${safe(0)}`,
        `odjezdHost:${safe(2)}`,
        `prijezdHost:${safe(3)}`,
        `pobyt:${safe(4)}`,
        `odjezdDatum:${safe(5)}`,
        `pozOdjezd:${safe(6)}`,
        `pozPrijezd:${safe(7)}`,
        `pozPobyt:${safe(8)}`
    ].join(' | ')
}

function extractStateDataFromXlsxBuffer(xlsxBuffer) {
    const workbook = XLSX.read(xlsxBuffer, { type: 'buffer', cellDates: true, raw: false })

    const fallbackYear = new Date().getFullYear()
    const sheets = []
    const rawLines = []

    workbook.SheetNames.forEach((sheetName) => {
        const worksheet = workbook.Sheets[sheetName]
        if (!worksheet) return

        const rowMatrix = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' })
        const normalizedRows = rowMatrix.map((row) => (
            Array.isArray(row)
                ? row.map((cell) => normalizeSpreadsheetCell(cell))
                : []
        ))

        const firstDateCell = (normalizedRows.find((row) => normalizeSpreadsheetCell((row || [])[0] || '').length > 0) || [])[0] || ''
        const dateIso = parseSpreadsheetDateIso(sheetName, fallbackYear)
            || parseSpreadsheetDateIso(firstDateCell, fallbackYear)
            || formatLocalDate(new Date())

        const totalsBySheet = {}
        let complete = false

        normalizedRows.forEach((row) => {
            const totalsRowNumbers = [
                parseSpreadsheetNumber((row || [])[0] || ''),
                parseSpreadsheetNumber((row || [])[1] || ''),
                parseSpreadsheetNumber((row || [])[2] || '')
            ]
            if (
                totalsRowNumbers.every((value) => typeof value === 'number')
                && totalsRowNumbers.some((value) => Number(value) > 0)
                && !normalizeForMatch((row || [])[3] || '')
            ) {
                totalsBySheet.arrivals = totalsRowNumbers[0]
                totalsBySheet.departures = totalsRowNumbers[1]
                totalsBySheet.stayovers = totalsRowNumbers[2]
                complete = true
            }
        })

        sheets.push({
            name: sheetName,
            dateIso,
            rows: normalizedRows.map((cells, index) => ({
                rowNumber: index + 1,
                cells
            })),
            totals: totalsBySheet,
            complete
        })

        rawLines.push(`### ${sheetName} (${dateIso})`)
        normalizedRows.forEach((row) => {
            const roomToken = normalizeRoomKey((row || [])[1] || '')
            if (!MASTER_ROOM_SET.has(roomToken)) return
            rawLines.push(createSpreadsheetDebugLine(dateIso, roomToken, row))
        })
    })

    return {
        rawText: rawLines.join('\n'),
        sheets
    }
}

function parsePrevioStateXlsxData(source, referenceDate = new Date()) {
    const warnings = []
    const parsedDates = []
    const completeDates = new Set()
    const dayTotals = {}
    const rows = []
    let amPmEvidence = false

        ; (source.sheets || [])
            .slice()
            .sort((a, b) => String(a.dateIso || '').localeCompare(String(b.dateIso || '')))
            .forEach((sheet) => {
                const dateIso = String(sheet.dateIso || '')
                if (!dateIso) return
                if (!parsedDates.includes(dateIso)) parsedDates.push(dateIso)

                if (sheet.totals && (
                    typeof sheet.totals.arrivals === 'number'
                    || typeof sheet.totals.departures === 'number'
                    || typeof sheet.totals.stayovers === 'number'
                )) {
                    dayTotals[dateIso] = {
                        arrivals: sheet.totals.arrivals,
                        departures: sheet.totals.departures,
                        stayovers: sheet.totals.stayovers
                    }
                }

                ; (sheet.rows || []).forEach((rowEntry) => {
                    const row = (rowEntry && Array.isArray(rowEntry.cells))
                        ? rowEntry.cells.map((cell) => normalizeSpreadsheetCell(cell))
                        : []

                    const firstColNormalized = normalizeForMatch((row || [])[0] || '')
                    if (firstColNormalized.includes('prijizdejici') || firstColNormalized.includes('prijezdejici')) {
                        return
                    }

                    const roomToken = normalizeRoomKey((row || [])[1] || '')
                    if (!MASTER_ROOM_SET.has(roomToken)) return

                    const departureInfo = parseSpreadsheetGuestCell((row || [])[2] || '', 'departure')
                    const arrivalInfo = parseSpreadsheetGuestCell((row || [])[3] || '', 'arrival')
                    const stayoverInfo = parseSpreadsheetGuestCell((row || [])[4] || '', 'stayover')
                    amPmEvidence = amPmEvidence || departureInfo.hadAmPm || arrivalInfo.hadAmPm || stayoverInfo.hadAmPm

                    let departureNotes = parseSpreadsheetNotes((row || [])[6] || '')
                    let arrivalNotes = parseSpreadsheetNotes((row || [])[7] || '')
                    const stayoverNotes = parseSpreadsheetNotes((row || [])[8] || '')

                    const departureTime = departureInfo.hasSignal ? departureInfo.time : undefined
                    const arrivalTime = arrivalInfo.hasSignal ? arrivalInfo.time : undefined

                    const stayoverMode = !departureTime && !arrivalTime && stayoverInfo.hasSignal
                    if (!departureTime && !arrivalTime && !stayoverMode && !departureInfo.hasSignal && !arrivalInfo.hasSignal) {
                        return
                    }

                    if (stayoverMode) {
                        const mergedStayoverNotes = stayoverNotes.length > 0
                            ? stayoverNotes
                            : departureNotes.length > 0
                                ? departureNotes
                                : arrivalNotes
                        departureNotes = mergedStayoverNotes
                        arrivalNotes = []
                    }

                    const stayoverUntil = stayoverMode
                        ? parseSpreadsheetDateIso((row || [])[5] || '', Number(String(dateIso).slice(0, 4)) || referenceDate.getFullYear()) || undefined
                        : undefined

                    const parsedRow = {
                        dateIso,
                        roomNumber: roomToken,
                        departureTime,
                        arrivalTime,
                        departureGuestCount: departureInfo.guestCount,
                        arrivalGuestCount: arrivalInfo.guestCount,
                        departureGuestName: departureInfo.guestName,
                        arrivalGuestName: arrivalInfo.guestName,
                        stayoverGuestName: stayoverMode ? stayoverInfo.guestName : undefined,
                        stayoverGuestCount: stayoverMode ? stayoverInfo.guestCount : undefined,
                        stayoverUntil,
                        departureNotes,
                        arrivalNotes,
                        isStayover: !departureTime && !arrivalTime,
                        warnings: []
                    }

                    if (parsedRow.departureTime && !parsedRow.departureGuestName && typeof parsedRow.departureGuestCount !== 'number') {
                        parsedRow.warnings.push('Odjezd má čas, ale chybí jméno hosta.')
                    }
                    if (parsedRow.arrivalTime && !parsedRow.arrivalGuestName && typeof parsedRow.arrivalGuestCount !== 'number') {
                        parsedRow.warnings.push('Příjezd má čas, ale chybí jméno hosta.')
                    }

                    rows.push(parsedRow)
                })

                if (sheet.complete || rows.some((row) => row.dateIso === dateIso)) {
                    completeDates.add(dateIso)
                }
            })

    const sortedRows = rows.sort((a, b) => {
        const byDate = String(a.dateIso || '').localeCompare(String(b.dateIso || ''))
        if (byDate !== 0) return byDate
        return Number(a.roomNumber || 0) - Number(b.roomNumber || 0)
    })

    repairSameGuestNextDayBoxContinuity(sortedRows)

    return {
        rows: sortedRows,
        warnings,
        parsedDates: parsedDates.sort(),
        rawTextLength: String(source.rawText || '').length,
        lineCount: String(source.rawText || '').split(/\r?\n/).filter(Boolean).length,
        completeDates: Array.from(completeDates).sort(),
        amPmEvidence,
        dayTotals
    }
}

function parsePrevioStatePdfText(source, referenceDate = new Date()) {
    const parsedSource = typeof source === 'string'
        ? { rawText: String(source || ''), pages: [] }
        : {
            rawText: String(source?.rawText || ''),
            pages: Array.isArray(source?.pages) ? source.pages : []
        }

    const rawText = parsedSource.rawText
    const allLines = String(rawText || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

    const warnings = []
    const rows = []
    const parsedDates = []
    const completeDates = new Set()
    let amPmEvidence = false
    const dayTotals = {}

    const pages = String(rawText || '')
        .split(PDF_PAGE_BREAK)
        .map((page) => page.trim())
        .filter(Boolean)

    pages.forEach((pageText, pageIndex) => {
        const pageLines = pageText
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)

        const pageDateLine = pageLines.find((line) => parsePageDateHeader(line) !== null)
        const pageDate = pageDateLine ? parsePageDateHeader(pageDateLine) : null
        if (!pageDate) {
            warnings.push(`Strana ${pageIndex + 1}: nenašel jsem hlavičku data.`)
            return
        }

        const pageDateIso = formatLocalDate(pageDate)
        if (!parsedDates.includes(pageDateIso)) parsedDates.push(pageDateIso)

        const totalsLine = pageLines.find((line) => parseTotalsLine(line) !== null)
        if (totalsLine) {
            const totals = parseTotalsLine(totalsLine)
            if (totals) {
                dayTotals[pageDateIso] = totals
                completeDates.add(pageDateIso)
            }
        }

        const geometryPage = parsedSource.pages && parsedSource.pages[pageIndex]
        const columnBlocks = geometryPage ? extractStateColumnBlocks(geometryPage) : []
        if (columnBlocks.length > 0) {
            columnBlocks.forEach((block) => {
                const departureInfo = extractSideTimeAndCount(block.departureText, 'departure')
                const arrivalInfo = extractSideTimeAndCount(block.arrivalText, 'arrival')

                let departureTime = departureInfo.time
                let arrivalTime = arrivalInfo.time
                let mainDisplayedArrivalTime = arrivalInfo.mainDisplayedArrivalTime
                const alfredWindow = arrivalInfo.alfredWindow
                let departureGuestCount = departureInfo.guestCount
                let arrivalGuestCount = arrivalInfo.guestCount
                let stayoverGuestCount = !departureTime && !arrivalTime
                    ? chooseStayoverGuestCount(block.room, block.departureText, block.arrivalText, block.rawText)
                    : undefined

                let departureNotes = extractSideNotes(block.departureText)
                const departureNotesFromArrivalSide = extractSideNotes(block.departureNoteText)
                if (departureNotes.length === 0) {
                    departureNotes = departureNotesFromArrivalSide
                }

                let arrivalNotes = extractSideNotes(block.arrivalNoteText || block.arrivalText)

                let departureGuestName = pickDepartureGuestName(block.departureText)
                let arrivalGuestName = pickArrivalGuestName(block.arrivalText)
                let stayoverGuestName = !departureTime && !arrivalTime
                    ? pickStayoverGuestName(block.rawText, departureGuestName || arrivalGuestName || extractNameCandidates(block.rawText.split(/\r?\n/))[0])
                    : undefined

                    ; ({
                        departureTime,
                        arrivalTime,
                        departureNotes,
                        arrivalNotes
                    } = backfillAmbiguousTurnoverFromRawBlock({
                        rawText: block.rawText,
                        departureTime,
                        arrivalTime,
                        departureGuestName,
                        arrivalGuestName,
                        departureGuestCount,
                        arrivalGuestCount,
                        departureNotes,
                        arrivalNotes
                    }))

                const distinctGuests = namesDiffer(departureGuestName, arrivalGuestName)
                arrivalGuestCount = resolveArrivalGuestCountFromSide(
                    block.room,
                    block.arrivalText,
                    arrivalGuestCount,
                    departureGuestCount,
                    distinctGuests
                )

                departureNotes = normalizeNotesList(departureNotes)
                arrivalNotes = normalizeNotesList(arrivalNotes)

                if (!arrivalTime && !arrivalGuestName) {
                    arrivalGuestCount = undefined
                    arrivalNotes = []
                }

                if (!departureTime && arrivalTime && !arrivalGuestName && (stayoverGuestName || departureGuestName)) {
                    arrivalTime = undefined
                    arrivalGuestCount = undefined
                    arrivalNotes = []
                }

                if (!arrivalTime && arrivalGuestName) {
                    if (!stayoverGuestName && !departureTime) {
                        stayoverGuestName = arrivalGuestName
                    }
                    if (typeof stayoverGuestCount !== 'number' && !departureTime) {
                        stayoverGuestCount = arrivalGuestCount
                    }
                    arrivalGuestName = undefined
                    arrivalGuestCount = undefined
                    arrivalNotes = []
                }

                if (!departureTime && !arrivalTime) {
                    mainDisplayedArrivalTime = undefined
                    if (departureNotes.length === 0 && arrivalNotes.length > 0) {
                        departureNotes = [...arrivalNotes]
                    }
                    if (!stayoverGuestName) {
                        stayoverGuestName = departureGuestName || arrivalGuestName
                    }
                    if (typeof stayoverGuestCount !== 'number') {
                        stayoverGuestCount = departureGuestCount ?? arrivalGuestCount
                    }
                    arrivalGuestName = undefined
                    arrivalGuestCount = undefined
                    arrivalNotes = []
                }

                if (
                    arrivalTime
                    && arrivalGuestName
                    && distinctGuests
                    && departureNotes.length > 0
                    && haveSameNotes(arrivalNotes, departureNotes)
                    && !hasMultipleNoteMentions(block.rawText)
                ) {
                    arrivalNotes = []
                }

                departureNotes = removeGuestNameNotes(departureNotes, [departureGuestName, arrivalGuestName, stayoverGuestName])
                arrivalNotes = removeGuestNameNotes(arrivalNotes, [departureGuestName, arrivalGuestName, stayoverGuestName])

                if (
                    departureTime
                    && arrivalTime
                    && departureTime === arrivalTime
                    && distinctGuests
                    && typeof departureGuestCount === 'number'
                    && typeof arrivalGuestCount === 'number'
                    && departureGuestCount === arrivalGuestCount
                ) {
                    const nearArrivalNameCount = inferGuestCountNearName(block.rawText, arrivalGuestName)
                    if (typeof nearArrivalNameCount === 'number' && nearArrivalNameCount !== departureGuestCount) {
                        arrivalGuestCount = nearArrivalNameCount
                    } else {
                        const alternativeCount = extractStandaloneGuestCounts(block.rawText)
                            .find((count) => count !== departureGuestCount)
                        if (typeof alternativeCount === 'number') {
                            arrivalGuestCount = alternativeCount
                        }
                    }
                }

                if (departureTime && arrivalTime && arrivalNotes.length > 1) {
                    const allBoxLike = arrivalNotes.every((note) => /\bbox\b/i.test(note))
                    if (allBoxLike) {
                        arrivalNotes = [arrivalNotes[0]]
                    }
                }

                const dateTokens = extractDateTokens(block.rawText)
                const stayoverUntilRaw = (() => {
                    if (dateTokens.length === 0) return undefined
                    const parsed = dateTokens
                        .map((token) => parseDateToken(token, pageDate.getFullYear()))
                        .filter((dt) => dt !== null)
                        .sort((a, b) => a.getTime() - b.getTime())
                    const last = parsed[parsed.length - 1]
                    if (!last) return undefined
                    return formatLocalDate(last)
                })()
                const stayoverUntil = !departureTime && !arrivalTime ? stayoverUntilRaw : undefined

                const blockWarnings = []
                if (!departureTime && !arrivalTime) {
                    blockWarnings.push('Bez času odjezdu/příjezdu - označeno jako probíhající pobyt')
                }
                if (departureTime && !departureGuestName && typeof departureGuestCount !== 'number') {
                    blockWarnings.push('Odjezd má čas, ale chybí jméno hosta.')
                }
                if (arrivalTime && !arrivalGuestName && typeof arrivalGuestCount !== 'number') {
                    blockWarnings.push('Příjezd má čas, ale chybí jméno hosta.')
                }
                if (!MASTER_ROOM_SET.has(block.room)) {
                    blockWarnings.push('Pokoj není v master seznamu')
                }

                const hadAmPm = departureInfo.hadAmPm || arrivalInfo.hadAmPm
                if (hadAmPm) amPmEvidence = true
                if (hadAmPm && (isSuspiciousNightTurnover(departureTime) || isSuspiciousNightTurnover(arrivalTime))) {
                    blockWarnings.push('AM/PM: podezřelý noční čas v obratu, zkontrolujte mapování sloupců')
                }

                // If arrival has a guest name but missing guest count, try to infer from nearby standalone counts in raw text
                if (arrivalGuestName && typeof arrivalGuestCount === 'undefined') {
                    try {
                        const raw = String(block.rawText || '')
                        const re = /\((\d{1,2})\)|\b(\d{1,2})\s*(?:p|os|host|pax)\b/gi
                        const matches = [...raw.matchAll(re)].map((m) => ({ index: typeof m.index === 'number' ? m.index : 0, value: Number(m[1] || m[2]) }))
                        if (matches.length > 0) {
                            const nameIdx = raw.toLowerCase().indexOf(String(arrivalGuestName || '').toLowerCase())
                            let chosen = matches[0]
                            if (nameIdx >= 0) {
                                chosen = matches.reduce((acc, m) => (Math.abs((m.index || 0) - nameIdx) < Math.abs((acc.index || 0) - nameIdx) ? m : acc), matches[0])
                            } else {
                                chosen = matches[matches.length - 1]
                            }
                            if (typeof chosen.value === 'number' && Number.isFinite(chosen.value)) arrivalGuestCount = chosen.value
                        }
                    } catch (e) {
                        // ignore
                    }
                }

                rows.push({
                    dateIso: pageDateIso,
                    roomNumber: block.room,
                    departureTime,
                    arrivalTime,
                    mainDisplayedArrivalTime,
                    alfredWindow,
                    departureGuestCount,
                    arrivalGuestCount,
                    departureGuestName,
                    arrivalGuestName,
                    stayoverGuestName,
                    stayoverGuestCount,
                    stayoverUntil,
                    departureNotes,
                    arrivalNotes,
                    isStayover: !departureTime && !arrivalTime,
                    warnings: blockWarnings
                })

                if (blockWarnings.length > 0) {
                    warnings.push(`Den ${pageDateIso}, pokoj ${block.room}: ${blockWarnings.join(', ')}`)
                }
            })

            return
        }

        const contentLines = pageLines.filter((line) => !shouldIgnoreLine(line) && parsePageDateHeader(line) === null)
        const blockStarts = contentLines
            .map((line, index) => ({ index, isNote: isNoteLine(line) }))
            .filter((entry) => entry.isNote)
            .map((entry) => entry.index)

        if (blockStarts.length === 0) {
            warnings.push(`Strana ${pageIndex + 1}: nenašel jsem bloky pokojů.`)
            return
        }

        function roomFromBlock(lines) {
            for (let i = 0; i < lines.length; i++) {
                const room = detectRoomToken(lines[i])
                if (room) return { room, markerOffset: i }
            }
            return null
        }

        blockStarts.forEach((startIndex, blockIndex) => {
            const endIndex = blockIndex + 1 < blockStarts.length ? blockStarts[blockIndex + 1] - 1 : contentLines.length - 1
            const blockLines = contentLines.slice(startIndex, endIndex + 1)
            const roomInfo = roomFromBlock(blockLines)
            if (!roomInfo) {
                warnings.push(`Strana ${pageIndex + 1}, blok ${blockIndex + 1}: pokoj nebyl rozpoznán.`)
                return
            }

            const markerInBlock = roomInfo.markerOffset
            const beforeMarker = markerInBlock >= 0 ? blockLines.slice(0, markerInBlock) : blockLines
            const afterMarker = markerInBlock >= 0 ? blockLines.slice(markerInBlock + 1) : []
            const rawBlock = blockLines.join('\n')

            const noteLineSource = beforeMarker.filter((line) => isNoteLine(line)).join(' ')
            const noteGroups = splitNoteGroups(noteLineSource || beforeMarker.join(' '))
            const timeSource = blockLines.map((line) => stripAlfredWindowSegments(line)).filter(Boolean).join('\n')
            let mainDisplayedArrivalTime = extractMainDisplayedArrivalTime(rawBlock)
            const alfredWindow = formatAlfredWindowLabel(extractAlfredWindows(rawBlock)[0])
            const timedEntries = detectTimedEntries(timeSource)
            const detectedTimes = detectTimes(timeSource)
            let { departureTime, arrivalTime } = chooseTimes(detectedTimes, noteGroups.length)
            let { departureGuestCount, arrivalGuestCount } = chooseGuestCounts(timedEntries, departureTime, arrivalTime, noteGroups.length)
            let stayoverGuestCount = !departureTime && !arrivalTime
                ? chooseStayoverGuestCount(roomInfo.room, rawBlock)
                : undefined

            let { departureNotes, arrivalNotes, sideWarnings } = assignNotesBySide(noteGroups, departureTime, arrivalTime)
            const guestCandidates = extractNameCandidates(blockLines)

            let departureGuestName
            let arrivalGuestName
            let stayoverGuestName

            if (departureTime && arrivalTime) {
                departureGuestName = guestCandidates[0]
                arrivalGuestName = guestCandidates[1] || guestCandidates[0]
            } else if (departureTime) {
                departureGuestName = guestCandidates[0]
            } else if (arrivalTime) {
                arrivalGuestName = guestCandidates[0]
            } else {
                stayoverGuestName = guestCandidates[0]
            }

            ; ({
                departureTime,
                arrivalTime,
                departureNotes,
                arrivalNotes
            } = backfillAmbiguousTurnoverFromRawBlock({
                rawText: rawBlock,
                departureTime,
                arrivalTime,
                departureGuestName,
                arrivalGuestName,
                departureGuestCount,
                arrivalGuestCount,
                departureNotes,
                arrivalNotes
            }))

            const distinctGuests = namesDiffer(departureGuestName, arrivalGuestName)
            arrivalGuestCount = resolveArrivalGuestCountFromSide(
                roomInfo.room,
                rawBlock,
                arrivalGuestCount,
                departureGuestCount,
                distinctGuests
            )

            departureNotes = normalizeNotesList(departureNotes)
            arrivalNotes = normalizeNotesList(arrivalNotes)

            if (!arrivalTime && !arrivalGuestName) {
                arrivalGuestCount = undefined
                arrivalNotes = []
            }

            if (!departureTime && arrivalTime && !arrivalGuestName && (stayoverGuestName || departureGuestName)) {
                arrivalTime = undefined
                arrivalGuestCount = undefined
                arrivalNotes = []
            }

            if (!arrivalTime && arrivalGuestName) {
                if (!stayoverGuestName && !departureTime) {
                    stayoverGuestName = arrivalGuestName
                }
                if (typeof stayoverGuestCount !== 'number' && !departureTime) {
                    stayoverGuestCount = arrivalGuestCount
                }
                arrivalGuestName = undefined
                arrivalGuestCount = undefined
                arrivalNotes = []
            }

            if (!departureTime && !arrivalTime) {
                mainDisplayedArrivalTime = undefined
                if (departureNotes.length === 0 && arrivalNotes.length > 0) {
                    departureNotes = [...arrivalNotes]
                }
                if (!stayoverGuestName) {
                    stayoverGuestName = departureGuestName || arrivalGuestName
                }
                if (typeof stayoverGuestCount !== 'number') {
                    stayoverGuestCount = departureGuestCount ?? arrivalGuestCount
                }
                arrivalGuestName = undefined
                arrivalGuestCount = undefined
                arrivalNotes = []
            }

            if (
                arrivalTime
                && arrivalGuestName
                && distinctGuests
                && departureNotes.length > 0
                && haveSameNotes(arrivalNotes, departureNotes)
                && !hasMultipleNoteMentions(rawBlock)
            ) {
                arrivalNotes = []
            }

            departureNotes = removeGuestNameNotes(departureNotes, [departureGuestName, arrivalGuestName, stayoverGuestName])
            arrivalNotes = removeGuestNameNotes(arrivalNotes, [departureGuestName, arrivalGuestName, stayoverGuestName])

            if (
                departureTime
                && arrivalTime
                && departureTime === arrivalTime
                && distinctGuests
                && typeof departureGuestCount === 'number'
                && typeof arrivalGuestCount === 'number'
                && departureGuestCount === arrivalGuestCount
            ) {
                const nearArrivalNameCount = inferGuestCountNearName(rawBlock, arrivalGuestName)
                if (typeof nearArrivalNameCount === 'number' && nearArrivalNameCount !== departureGuestCount) {
                    arrivalGuestCount = nearArrivalNameCount
                } else {
                    const alternativeCount = extractStandaloneGuestCounts(rawBlock)
                        .find((count) => count !== departureGuestCount)
                    if (typeof alternativeCount === 'number') {
                        arrivalGuestCount = alternativeCount
                    }
                }
            }

            if (departureTime && arrivalTime && arrivalNotes.length > 1) {
                const allBoxLike = arrivalNotes.every((note) => /\bbox\b/i.test(note))
                if (allBoxLike) {
                    arrivalNotes = [arrivalNotes[0]]
                }
            }

            const dateTokens = extractDateTokens(afterMarker.join(' '))
            const stayoverUntilRaw = (() => {
                if (dateTokens.length === 0) return undefined
                const parsed = dateTokens
                    .map((token) => parseDateToken(token, pageDate.getFullYear()))
                    .filter((dt) => dt !== null)
                    .sort((a, b) => a.getTime() - b.getTime())
                const last = parsed[parsed.length - 1]
                if (!last) return undefined
                return formatLocalDate(last)
            })()
            const stayoverUntil = !departureTime && !arrivalTime ? stayoverUntilRaw : undefined

            const blockWarnings = [...sideWarnings]
            if (!departureTime && !arrivalTime) {
                blockWarnings.push('Bez času odjezdu/příjezdu - označeno jako probíhající pobyt')
            }
            if (departureTime && !departureGuestName && typeof departureGuestCount !== 'number') {
                blockWarnings.push('Odjezd má čas, ale chybí jméno hosta.')
            }
            if (arrivalTime && !arrivalGuestName && typeof arrivalGuestCount !== 'number') {
                blockWarnings.push('Příjezd má čas, ale chybí jméno hosta.')
            }
            if (!MASTER_ROOM_SET.has(roomInfo.room)) {
                blockWarnings.push('Pokoj není v master seznamu')
            }

            const hadAmPm = /\b(?:AM|PM)\b/i.test(timeSource)
            if (hadAmPm) amPmEvidence = true
            if (hadAmPm && (isSuspiciousNightTurnover(departureTime) || isSuspiciousNightTurnover(arrivalTime))) {
                blockWarnings.push('AM/PM: podezřelý noční čas v obratu, zkontrolujte mapování sloupců')
            }

            // If arrival has a guest name but missing guest count, try to infer from nearby standalone counts in rawBlock
            if (arrivalGuestName && typeof arrivalGuestCount === 'undefined') {
                try {
                    const raw = String(rawBlock || '')
                    const re = /\((\d{1,2})\)|\b(\d{1,2})\s*(?:p|os|host|pax)\b/gi
                    const matches = [...raw.matchAll(re)].map((m) => ({ index: typeof m.index === 'number' ? m.index : 0, value: Number(m[1] || m[2]) }))
                    if (matches.length > 0) {
                        const nameIdx = raw.toLowerCase().indexOf(String(arrivalGuestName || '').toLowerCase())
                        let chosen = matches[0]
                        if (nameIdx >= 0) {
                            chosen = matches.reduce((acc, m) => (Math.abs((m.index || 0) - nameIdx) < Math.abs((acc.index || 0) - nameIdx) ? m : acc), matches[0])
                        } else {
                            chosen = matches[matches.length - 1]
                        }
                        if (typeof chosen.value === 'number' && Number.isFinite(chosen.value)) arrivalGuestCount = chosen.value
                    }
                } catch (e) {
                    // ignore
                }
            }

            rows.push({
                dateIso: pageDateIso,
                roomNumber: roomInfo.room,
                departureTime,
                arrivalTime,
                mainDisplayedArrivalTime,
                alfredWindow,
                departureGuestCount,
                arrivalGuestCount,
                departureGuestName,
                arrivalGuestName,
                stayoverGuestName,
                stayoverGuestCount,
                stayoverUntil,
                departureNotes,
                arrivalNotes,
                isStayover: !departureTime && !arrivalTime,
                warnings: blockWarnings
            })

            if (blockWarnings.length > 0) {
                warnings.push(`Den ${pageDateIso}, pokoj ${roomInfo.room}: ${blockWarnings.join(', ')}`)
            }
        })
    })

    let textFallbackRows = []
    if (typeof source !== 'string' && parsedSource.pages && parsedSource.pages.length > 0) {
        const textFallback = parsePrevioStatePdfText(parsedSource.rawText, referenceDate)
        textFallbackRows = textFallback.rows
        mergeMissingFieldsFromTextFallback(rows, textFallbackRows)
    }

    const sortedRows = [...rows].sort((a, b) => {
        if (a.dateIso !== b.dateIso) return a.dateIso.localeCompare(b.dateIso)
        return normalizeRoomKey(a.roomNumber).localeCompare(normalizeRoomKey(b.roomNumber))
    })

    const lastKnownGuestByRoom = new Map()
    sortedRows.forEach((row) => {
        const roomKey = normalizeRoomKey(row.roomNumber)
        const knownGuest = lastKnownGuestByRoom.get(roomKey)

        if (knownGuest && row.departureTime && row.arrivalTime && row.departureGuestName && row.arrivalGuestName) {
            const depMatch = normalizeForMatch(row.departureGuestName).includes(normalizeForMatch(knownGuest))
            const arrMatch = normalizeForMatch(row.arrivalGuestName).includes(normalizeForMatch(knownGuest))
            if (!depMatch && arrMatch) {
                const previousDeparture = row.departureGuestName
                const previousDepartureGuestCount = row.departureGuestCount
                row.departureGuestName = row.arrivalGuestName
                row.arrivalGuestName = previousDeparture
                row.departureGuestCount = row.arrivalGuestCount
                row.arrivalGuestCount = previousDepartureGuestCount
            }
        }

        if (row.arrivalGuestName) {
            lastKnownGuestByRoom.set(roomKey, row.arrivalGuestName)
        } else if (row.stayoverGuestName) {
            lastKnownGuestByRoom.set(roomKey, row.stayoverGuestName)
        }
    })

    const nextDepartureCountByRoomAndGuest = new Map()
    for (let i = sortedRows.length - 1; i >= 0; i--) {
        const row = sortedRows[i]
        const roomKey = normalizeRoomKey(row.roomNumber)

        if (row.arrivalGuestName) {
            const arrivalKey = `${roomKey}__${normalizeForMatch(row.arrivalGuestName)}`
            const knownNextDepartureCount = nextDepartureCountByRoomAndGuest.get(arrivalKey)
            if (
                typeof knownNextDepartureCount === 'number'
                && (
                    typeof row.arrivalGuestCount !== 'number'
                    || (
                        typeof row.departureGuestCount === 'number'
                        && row.arrivalGuestCount === row.departureGuestCount
                        && namesDiffer(row.departureGuestName, row.arrivalGuestName)
                    )
                )
            ) {
                row.arrivalGuestCount = knownNextDepartureCount
            }
        }

        if (row.departureGuestName && typeof row.departureGuestCount === 'number') {
            const departureKey = `${roomKey}__${normalizeForMatch(row.departureGuestName)}`
            nextDepartureCountByRoomAndGuest.set(departureKey, row.departureGuestCount)
        }
    }

    if (textFallbackRows.length > 0) {
        const fallbackByKey = new Map()
        textFallbackRows.forEach((row) => {
            const key = `${row.dateIso}__${normalizeRoomKey(row.roomNumber)}`
            fallbackByKey.set(key, row)
        })

        sortedRows.forEach((row) => {
            if (
                !row.departureTime
                || !row.arrivalTime
                || row.departureTime !== row.arrivalTime
                || !namesDiffer(row.departureGuestName, row.arrivalGuestName)
                || typeof row.departureGuestCount !== 'number'
                || typeof row.arrivalGuestCount !== 'number'
                || row.departureGuestCount !== row.arrivalGuestCount
            ) {
                return
            }

            const key = `${row.dateIso}__${normalizeRoomKey(row.roomNumber)}`
            const fallback = fallbackByKey.get(key)
            if (!fallback) return
            if (
                typeof fallback.departureGuestCount !== 'number'
                || typeof fallback.arrivalGuestCount !== 'number'
                || fallback.departureGuestCount === fallback.arrivalGuestCount
            ) {
                return
            }

            if (fallback.departureGuestCount === row.departureGuestCount) {
                row.arrivalGuestCount = fallback.arrivalGuestCount
                return
            }

            if (fallback.arrivalGuestCount === row.departureGuestCount) {
                row.arrivalGuestCount = fallback.departureGuestCount
            }
        })
    }

    repairSameGuestNextDayBoxContinuity(sortedRows)

    return {
        rows: sortedRows,
        warnings,
        parsedDates: parsedDates.sort(),
        rawTextLength: String(rawText || '').length,
        lineCount: allLines.length,
        completeDates: Array.from(completeDates).sort(),
        amPmEvidence,
        dayTotals
    }
}

function dayDiff(baseDate, comparedDate) {
    const start = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate())
    const end = new Date(comparedDate.getFullYear(), comparedDate.getMonth(), comparedDate.getDate())
    return Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000))
}

function buildPrevioStateImportPreview(parsed, roomCatalog = [], referenceDate = new Date()) {
    const warnings = [...(parsed.warnings || [])]
    const catalogRooms = roomCatalog.map((room) => normalizeRoomKey(room.roomNumber))
    const masterRooms = Array.from(new Set([...MASTER_ROOM_NUMBERS, ...catalogRooms])).sort((a, b) => Number(a) - Number(b))

    const rowsByDate = new Map()
    const unknownRooms = new Set()

    parsed.rows.forEach((row) => {
        const room = normalizeRoomKey(row.roomNumber)
        if (!masterRooms.includes(room)) unknownRooms.add(room)

        if (!rowsByDate.has(row.dateIso)) rowsByDate.set(row.dateIso, new Map())
        const dayMap = rowsByDate.get(row.dateIso)
        const prev = dayMap.get(room)

        if (!prev) {
            dayMap.set(room, { ...row, roomNumber: room })
            return
        }

        const prevScore = Number(Boolean(prev.departureTime)) + Number(Boolean(prev.arrivalTime))
        const nextScore = Number(Boolean(row.departureTime)) + Number(Boolean(row.arrivalTime))
        if (nextScore >= prevScore) dayMap.set(room, { ...row, roomNumber: room })
    })

    const days = Array.from(rowsByDate.keys())
        .sort()
        .map((dateIso) => {
            const dayMap = rowsByDate.get(dateIso)
            const rows = Array.from(dayMap.values()).sort((a, b) => Number(a.roomNumber) - Number(b.roomNumber))
            const presentRooms = rows.map((row) => normalizeRoomKey(row.roomNumber))
            const complete = parsed.completeDates.includes(dateIso)
            const derivedFreeRooms = complete ? masterRooms.filter((room) => !presentRooms.includes(room)) : []

            if (!complete) warnings.push(`Den ${dateIso}: stránka není kompletní, volné pokoje neodvozuji.`)

            const turnoverCount = rows.filter((row) => row.departureTime || row.arrivalTime).length
            const stayoverCount = rows.filter((row) => row.isStayover).length

            return {
                dateIso,
                dateLabel: formatDateLabel(dateIso),
                rows,
                turnoverCount,
                stayoverCount,
                presentRooms,
                derivedFreeRooms,
                complete,
                warnings: rows.flatMap((row) => row.warnings || [])
            }
        })

    const turnoverCount = days.reduce((sum, day) => sum + day.turnoverCount, 0)
    const stayoverCount = days.reduce((sum, day) => sum + day.stayoverCount, 0)
    const derivedFreeCount = days.reduce((sum, day) => sum + day.derivedFreeRooms.length, 0)

    const parsedTabDates = {}
    days.forEach((day) => {
        const offset = dayDiff(referenceDate, new Date(day.dateIso))
        if (offset === 0) parsedTabDates.Dnes = day.dateIso
        if (offset === 1) parsedTabDates.Zitra = day.dateIso
        if (offset === 2) parsedTabDates.Pozitri = day.dateIso
    })

    const suspiciousAmPmRows = days.flatMap((day) => day.rows)
        .filter((row) => (row.warnings || []).some((warning) => String(warning).includes('AM/PM: podezřelý noční čas')))

    if (suspiciousAmPmRows.length > 0) {
        warnings.push('Import není bezpečný - parser našel podezřelé noční časy v AM/PM režimu.')
    }

    const confidenceLow = days.length === 0
        || days.every((day) => day.turnoverCount === 0 && day.stayoverCount === 0)
        || suspiciousAmPmRows.length > 0

    return {
        days,
        warnings,
        unknownRooms: Array.from(unknownRooms).sort((a, b) => Number(a) - Number(b)),
        parsedRows: parsed.rows.length,
        turnoverCount,
        stayoverCount,
        derivedFreeCount,
        confidenceLow,
        amPmEvidence: Boolean(parsed.amPmEvidence),
        parsedDateCount: Array.isArray(parsed.parsedDates) ? parsed.parsedDates.length : 0,
        completeDateCount: Array.isArray(parsed.completeDates) ? parsed.completeDates.length : 0,
        dayTotals: parsed.dayTotals || {},
        parserVersion: PREVIO_STAV_PARSER_VERSION,
        parsedTabDates
    }
}

function evaluatePrevioStateImportSafety({ preview, missingDateLabels = [], parserVersion, checkedAt = new Date() }) {
    const normalizedParserVersion = String(parserVersion || '').trim()
    const parserVersionMissing = !normalizedParserVersion
    const parserVersionOutdated = parserVersionMissing || normalizedParserVersion !== PREVIO_STAV_PARSER_VERSION

    const rows = (preview.days || []).flatMap((day) => day.rows || [])
    const turnoverRows = rows.filter((row) => Boolean(row.departureTime || row.arrivalTime))
    const arrivals = rows.filter((row) => Boolean(row.arrivalTime))
    const departures = rows.filter((row) => Boolean(row.departureTime))

    const blocks = []
    const warnings = []

    const suspiciousNightRows = turnoverRows.filter((row) => {
        const dep = toMinutesSafe(row.departureTime)
        const arr = toMinutesSafe(row.arrivalTime)
        const lower = 60
        const upper = 450
        return (dep !== null && dep >= lower && dep <= upper) || (arr !== null && arr >= lower && arr <= upper)
    })

    if (preview.amPmEvidence && suspiciousNightRows.length > 0) {
        blocks.push('Detekovány podezřelé noční časy (01:00-07:30) v AM/PM režimu.')
    }

    const arrivalsAtEleven = arrivals.filter((row) => row.arrivalTime === '11:00').length
    if (arrivals.length >= 4 && arrivalsAtEleven >= 3 && arrivalsAtEleven / arrivals.length >= 0.35) {
        blocks.push('Příliš mnoho příjezdů je přesně v 11:00.')
    }

    const departuresBeforeEight = departures.filter((row) => {
        const minute = toMinutesSafe(row.departureTime)
        return minute !== null && minute < 8 * 60
    }).length
    if (departures.length >= 4 && departuresBeforeEight >= 3 && departuresBeforeEight / departures.length >= 0.35) {
        blocks.push('Příliš mnoho odjezdů je před 08:00.')
    }

    const turnoverRowsMissingGuestName = turnoverRows.filter((row) => {
        const missingDepartureGuest = Boolean(row.departureTime && !row.departureGuestName)
        const missingArrivalGuest = Boolean(row.arrivalTime && !row.arrivalGuestName)
        return missingDepartureGuest || missingArrivalGuest
    }).length

    const arrivalsMissingIdentity = arrivals.filter((row) => (
        Boolean(row.arrivalTime)
        && !row.arrivalGuestName
    ))
    if (arrivalsMissingIdentity.length > 0) {
        blocks.push('Příjezd má čas, ale chybí jméno hosta.')
    }

    const departuresMissingIdentity = departures.filter((row) => (
        Boolean(row.departureTime)
        && !row.departureGuestName
    ))
    if (departuresMissingIdentity.length > 0) {
        blocks.push('Odjezd má čas, ale chybí jméno hosta.')
    }

    const arrivalsCountWithoutName = rows.filter((row) => (
        typeof row.arrivalGuestCount === 'number' && row.arrivalGuestCount > 0 && !row.arrivalGuestName
    ))
    if (arrivalsCountWithoutName.length > 0) {
        blocks.push('Příjezd má počet hostů, ale chybí jméno hosta.')
    }

    const departuresCountWithoutName = rows.filter((row) => (
        typeof row.departureGuestCount === 'number' && row.departureGuestCount > 0 && !row.departureGuestName
    ))
    if (departuresCountWithoutName.length > 0) {
        blocks.push('Odjezd má počet hostů, ale chybí jméno hosta.')
    }

    const stayoversCountWithoutName = rows.filter((row) => (
        row.isStayover
        && typeof row.stayoverGuestCount === 'number'
        && row.stayoverGuestCount > 0
        && !row.stayoverGuestName
    ))
    if (stayoversCountWithoutName.length > 0) {
        blocks.push('Probíhající pobyt má počet hostů, ale chybí jméno hosta.')
    }

    const capacityViolations = rows.flatMap((row) => {
        const roomNumber = normalizeRoomKey(row.roomNumber)
        const maxCapacity = ROOM_CAPACITY_BY_NUMBER[roomNumber]
        if (typeof maxCapacity !== 'number') return []

        const issues = []
        if (typeof row.arrivalGuestCount === 'number' && row.arrivalGuestCount > maxCapacity) {
            issues.push(`Automatické potvrzení blokováno: pokoj ${roomNumber} má ${row.arrivalGuestCount} osob, kapacita ${maxCapacity}.`)
        }
        if (typeof row.departureGuestCount === 'number' && row.departureGuestCount > maxCapacity) {
            issues.push(`Automatické potvrzení blokováno: pokoj ${roomNumber} má ${row.departureGuestCount} osob, kapacita ${maxCapacity}.`)
        }
        if (typeof row.stayoverGuestCount === 'number' && row.stayoverGuestCount > maxCapacity) {
            issues.push(`Automatické potvrzení blokováno: pokoj ${roomNumber} má ${row.stayoverGuestCount} osob, kapacita ${maxCapacity}.`)
        }
        return issues
    })
    if (capacityViolations.length > 0) {
        blocks.push(...capacityViolations)
    }

    if (turnoverRows.length >= 6 && turnoverRowsMissingGuestName >= 4 && turnoverRowsMissingGuestName / turnoverRows.length >= 0.3) {
        blocks.push('U mnoha turnover řádků chybí jména hostů.')
    }

    if ((preview.parsedDateCount || 0) > (preview.days || []).length) {
        blocks.push('Počet dnů v náhledu je nižší než počet dnů detekovaných v PDF.')
    }

    const minimumExpectedRows = Math.max(12, (preview.days || []).length * 6)
    if ((preview.parsedRows || 0) < minimumExpectedRows) {
        blocks.push(`Počet parsovaných řádků je nečekaně nízký (${preview.parsedRows || 0}).`)
    }

    if (missingDateLabels.length > 0) {
        blocks.push(`V náhledu chybí dny uprostřed rozsahu: ${missingDateLabels.join(', ')}`)
    }

    if (preview.confidenceLow) {
        blocks.push('Import není bezpečný podle confidenceLow parseru.')
    }

    let totalsMismatchDetected = false
    const totalsMismatchDetails = []
    const dayByIso = new Map((preview.days || []).map((day) => [day.dateIso, day]))
    Object.entries(preview.dayTotals || {}).forEach(([dateIso, totals]) => {
        const day = dayByIso.get(dateIso)
        if (!day) return

        const arrivalsCount = (day.rows || []).filter((row) => Boolean(row.arrivalTime)).length
        const departuresCount = (day.rows || []).filter((row) => Boolean(row.departureTime)).length
        const stayoversCount = (day.rows || []).filter((row) => !row.departureTime && !row.arrivalTime).length
        const arrivalGuests = (day.rows || []).reduce((sum, row) => sum + (typeof row.arrivalGuestCount === 'number' ? row.arrivalGuestCount : 0), 0)
        const departureGuests = (day.rows || []).reduce((sum, row) => sum + (typeof row.departureGuestCount === 'number' ? row.departureGuestCount : 0), 0)
        const stayoverGuests = (day.rows || []).reduce((sum, row) => sum + (typeof row.stayoverGuestCount === 'number' ? row.stayoverGuestCount : 0), 0)

        const effectiveArrivals = arrivalGuests > 0 ? arrivalGuests : arrivalsCount
        const effectiveDepartures = departureGuests > 0 ? departureGuests : departuresCount
        const effectiveStayovers = stayoverGuests > 0 ? stayoverGuests : stayoversCount

        const mismatchArrivals = typeof totals.arrivals === 'number'
            && Math.abs(effectiveArrivals - totals.arrivals) > Math.max(2, Math.round(totals.arrivals * 0.2))
        const mismatchDepartures = typeof totals.departures === 'number'
            && Math.abs(effectiveDepartures - totals.departures) > Math.max(2, Math.round(totals.departures * 0.2))
        const mismatchStayovers = typeof totals.stayovers === 'number'
            && Math.abs(effectiveStayovers - totals.stayovers) > Math.max(2, Math.round(totals.stayovers * 0.2))

        if (mismatchArrivals || mismatchDepartures || mismatchStayovers) {
            totalsMismatchDetected = true

            const detailParts = []
            if (mismatchArrivals) detailParts.push(`příjezdy ${effectiveArrivals}/${totals.arrivals}`)
            if (mismatchDepartures) detailParts.push(`odjezdy ${effectiveDepartures}/${totals.departures}`)
            if (mismatchStayovers) detailParts.push(`pobyty ${effectiveStayovers}/${totals.stayovers}`)
            totalsMismatchDetails.push(`${dateIso}: ${detailParts.join(', ')}`)
        }
    })

    if (totalsMismatchDetected) {
        blocks.push('Počty v náhledu nesedí s řádkem Celkem v PDF.')
        totalsMismatchDetails.slice(0, 3).forEach((detail) => {
            blocks.push(`Celkem mismatch: ${detail}`)
        })
    }

    if (parserVersionOutdated) {
        warnings.push('Náhled byl vytvořen starší verzí parseru. Doporučujeme přegenerovat.')
    }

    const blocked = blocks.length > 0

    return {
        status: blocked ? 'blocked' : 'ok',
        blocked,
        warnings,
        blocks,
        checkedAt: checkedAt.toISOString(),
        parserVersion: normalizedParserVersion || PREVIO_STAV_PARSER_VERSION,
        parserVersionMissing,
        parserVersionOutdated,
        metrics: {
            turnoverRows: turnoverRows.length,
            suspiciousNightRows: suspiciousNightRows.length,
            arrivalsAtEleven,
            departuresBeforeEight,
            turnoverRowsMissingGuestName,
            arrivalsMissingIdentity: arrivalsMissingIdentity.length,
            departuresMissingIdentity: departuresMissingIdentity.length,
            parsedRows: preview.parsedRows || 0,
            parsedDayCount: preview.parsedDateCount || 0,
            previewDayCount: (preview.days || []).length
        }
    }
}

function detectMissingDatesInRange(dateIsos) {
    const sorted = Array.from(new Set(dateIsos || [])).sort()
    if (sorted.length < 2) return []

    const missing = []
    for (let i = 0; i < sorted.length - 1; i++) {
        const start = new Date(`${sorted[i]}T00:00:00`)
        const end = new Date(`${sorted[i + 1]}T00:00:00`)
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue

        const cursor = new Date(start)
        cursor.setDate(cursor.getDate() + 1)
        while (cursor < end) {
            missing.push(formatLocalDate(cursor))
            cursor.setDate(cursor.getDate() + 1)
        }
    }

    return missing
}

function formatImportTimestamp(date = new Date()) {
    const d = `${date.getDate()}`.padStart(2, '0')
    const m = `${date.getMonth() + 1}`.padStart(2, '0')
    const y = date.getFullYear()
    const hh = `${date.getHours()}`.padStart(2, '0')
    const mm = `${date.getMinutes()}`.padStart(2, '0')
    return `${d}.${m}.${y} ${hh}:${mm}`
}

function extractArrivalBoxFromNotes(notes) {
    if (!notes || notes.length === 0) return undefined
    const match = notes.join(' ').match(/\bbox\s*([a-z0-9-]+)/i)
    if (!match) return undefined
    return `BOX ${match[1].toUpperCase()}`
}

function buildByDateFromPreview(preview, roomCatalog = [], importedAt = formatImportTimestamp()) {
    const catalogRooms = roomCatalog.map((room) => normalizeRoomKey(room.roomNumber))
    const roomNumbers = Array.from(new Set([...MASTER_ROOM_NUMBERS, ...catalogRooms])).sort((a, b) => Number(a) - Number(b))

    const byDate = {}

    preview.days.forEach((day) => {
        const parsedByRoom = new Map(day.rows.map((row) => [normalizeRoomKey(row.roomNumber), row]))

        byDate[day.dateIso] = roomNumbers.map((roomNumber) => {
            const parsed = parsedByRoom.get(roomNumber)
            const baseRow = {
                id: `r${roomNumber}`,
                number: roomNumber,
                situation: 'volny',
                status: 'neni',
                departure: undefined,
                arrival: undefined,
                nextArrivalPreview: undefined,
                departureTime: undefined,
                arrivalTime: undefined,
                guestCount: undefined,
                box: undefined,
                notes: undefined,
                assigned: undefined,
                estimatedReady: undefined,
                estimateSetAt: undefined,
                statusNote: undefined,
                checkoutException: false,
                occupiedConfirmed: false,
                freeConfirmed: false,
                stateSource: 'previo-state-pdf',
                stateImportedAt: importedAt,
                planDateIso: day.dateIso,
                stayoverGuestName: undefined,
                stayoverUntil: undefined
            }

            if (!parsed) {
                return {
                    ...baseRow,
                    freeConfirmed: Boolean(day.complete && day.derivedFreeRooms.includes(roomNumber))
                }
            }

            const hasDeparture = Boolean(parsed.departureTime)
            const hasArrival = Boolean(parsed.arrivalTime)

            if (!hasDeparture && !hasArrival) {
                const stayoverNotes = parsed.arrivalNotes.length
                    ? parsed.arrivalNotes
                    : parsed.departureNotes.length
                        ? parsed.departureNotes
                        : undefined
                const stayoverBox = extractArrivalBoxFromNotes(stayoverNotes)
                const stayoverGuestCount = parsed.stayoverGuestCount ?? parsed.arrivalGuestCount ?? parsed.departureGuestCount

                return {
                    ...baseRow,
                    occupiedConfirmed: true,
                    stayoverGuestName: parsed.stayoverGuestName || parsed.departureGuestName || parsed.arrivalGuestName,
                    stayoverUntil: parsed.stayoverUntil,
                    guestCount: stayoverGuestCount,
                    box: stayoverBox,
                    notes: stayoverNotes
                }
            }

            const mergedSituation = hasDeparture && hasArrival
                ? 'odjezd_prijezd'
                : hasDeparture
                    ? 'odjezd'
                    : 'prijezd'

            const departureNotes = parsed.departureNotes.length ? parsed.departureNotes : undefined
            const arrivalNotes = parsed.arrivalNotes.length ? parsed.arrivalNotes : undefined
            const arrivalBox = extractArrivalBoxFromNotes(arrivalNotes)

            return {
                ...baseRow,
                situation: mergedSituation,
                departure: hasDeparture ? {
                    time: parsed.departureTime,
                    guestLabel: parsed.departureGuestName,
                    guestCount: parsed.departureGuestCount,
                    notes: departureNotes
                } : undefined,
                arrival: hasArrival ? {
                    time: parsed.arrivalTime,
                    guestLabel: parsed.arrivalGuestName,
                    guestCount: parsed.arrivalGuestCount,
                    box: arrivalBox,
                    notes: arrivalNotes
                } : undefined,
                departureTime: parsed.departureTime,
                arrivalTime: parsed.arrivalTime,
                guestCount: parsed.arrivalGuestCount ?? parsed.departureGuestCount,
                box: arrivalBox,
                status: 'ceka'
            }
        })
    })

    return byDate
}

module.exports = {
    PREVIO_STAV_PARSER_VERSION,
    MASTER_ROOM_NUMBERS,
    extractStateTextFromPdfBuffer,
    extractStateDataFromXlsxBuffer,
    parsePrevioStatePdfText,
    parsePrevioStateXlsxData,
    buildPrevioStateImportPreview,
    evaluatePrevioStateImportSafety,
    repairSameGuestNextDayBoxContinuity,
    detectMissingDatesInRange,
    buildByDateFromPreview,
    formatImportTimestamp
}
