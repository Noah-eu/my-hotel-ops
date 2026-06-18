import type { OpsTab } from './opsStore'
import type { PrevioPdfExtract, RoomCatalogItem } from './previoPdfParser'
import { extractTextFromPdfFile } from './previoPdfParser'
import type { ImportJobSafetySummary } from '../types'

const PDF_PAGE_BREAK = '[[[PREVIO_PAGE_BREAK]]]'
export const PREVIO_STAV_PARSER_VERSION = 'stav-parser-v3-real-pdf-fixture'

export const MASTER_ROOM_NUMBERS = [
    '001', '101', '102', '103', '104', '105', '201', '202', '203', '204', '205', '301', '302', '303', '304', '305'
]

const MASTER_ROOM_SET = new Set(MASTER_ROOM_NUMBERS)
const ROOM_CAPACITY_BY_NUMBER: Record<string, number> = {
    '102': 2,
    '105': 2,
    '205': 2,
    '305': 2
}

export type PrevioStateParsedRow = {
    dateIso: string
    roomNumber: string
    departureTime?: string
    arrivalTime?: string
    departureGuestCount?: number
    arrivalGuestCount?: number
    departureGuestName?: string
    arrivalGuestName?: string
    stayoverGuestName?: string
    stayoverGuestCount?: number
    stayoverUntil?: string
    departureNotes: string[]
    arrivalNotes: string[]
    isStayover: boolean
    warnings: string[]
}

export type PrevioStateDayPreview = {
    dateIso: string
    dateLabel: string
    rows: PrevioStateParsedRow[]
    turnoverCount: number
    stayoverCount: number
    presentRooms: string[]
    derivedFreeRooms: string[]
    complete: boolean
    warnings: string[]
}

export type PrevioStateParseResult = {
    rows: PrevioStateParsedRow[]
    warnings: string[]
    parsedDates: string[]
    rawTextLength: number
    lineCount: number
    completeDates: string[]
    amPmEvidence: boolean
    dayTotals: Record<string, { arrivals?: number; departures?: number; stayovers?: number }>
}

export type PrevioStateImportPreview = {
    days: PrevioStateDayPreview[]
    warnings: string[]
    unknownRooms: string[]
    parsedRows: number
    turnoverCount: number
    stayoverCount: number
    derivedFreeCount: number
    confidenceLow: boolean
    amPmEvidence: boolean
    parsedDateCount: number
    completeDateCount: number
    dayTotals: Record<string, { arrivals?: number; departures?: number; stayovers?: number }>
    parserVersion: string
    parsedTabDates: Partial<Record<OpsTab, string>>
}

type PrevioStateImportSafetyInput = {
    preview: Pick<PrevioStateImportPreview, 'days' | 'parsedRows' | 'confidenceLow' | 'amPmEvidence' | 'parsedDateCount' | 'dayTotals'>
    missingDateLabels?: string[]
    parserVersion?: string
    checkedAt?: Date
}

type PrevioStatePdfSource = string | PrevioPdfExtract

function normalizeForMatch(value: string) {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
}

function normalizeRoomNumber(raw: string) {
    return raw.trim().replace(/^0+/, '').padStart(3, '0')
}

function normalizeRoomKey(raw: string) {
    const match = raw.match(/\b(\d{3})\b/)
    if (match) return normalizeRoomNumber(match[1])

    const compactDigits = raw.replace(/\D/g, '')
    if (compactDigits.length >= 3) {
        return normalizeRoomNumber(compactDigits.slice(-3))
    }

    return raw.trim()
}

function normalizeTime(raw: string) {
    const normalized = raw.replace('.', ':')
    const [h, m] = normalized.split(':')
    if (!h || !m) return raw
    return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
}

function normalizeTimeWithMeridiem(hourRaw: string, minuteRaw: string, meridiemRaw?: string) {
    let hour = Number(hourRaw)
    const minute = Number(minuteRaw)
    const meridiem = String(meridiemRaw || '').toUpperCase()

    if (meridiem === 'AM') {
        if (hour === 12) hour = 0
    } else if (meridiem === 'PM') {
        if (hour >= 1 && hour <= 11) hour += 12
    }

    return `${`${hour}`.padStart(2, '0')}:${`${minute}`.padStart(2, '0')}`
}

function toMinutes(hhmm: string) {
    const [h, m] = hhmm.split(':').map(Number)
    return h * 60 + m
}

function toMinutesSafe(hhmm?: string) {
    if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null
    return toMinutes(hhmm)
}

function formatLocalDate(date: Date) {
    const y = date.getFullYear()
    const m = `${date.getMonth() + 1}`.padStart(2, '0')
    const d = `${date.getDate()}`.padStart(2, '0')
    return `${y}-${m}-${d}`
}

function formatDateLabel(dateIso: string) {
    const date = new Date(dateIso)
    if (Number.isNaN(date.getTime())) return dateIso
    return date.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' })
}

function parsePageDateHeader(line: string) {
    // Normalize accents first so headers like "pá" are matched consistently.
    const normalized = normalizeForMatch(line).replace(/\s+/g, ' ').trim()
    const match = normalized.match(/(?:^|\s)(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\s*-\s*(po|ut|st|ct|pa|so|ne)(?=\s|$)/i)
    if (!match) return null

    const day = Number(match[1])
    const month = Number(match[2])
    const year = Number(match[3])
    const date = new Date(year, month - 1, day)
    return Number.isNaN(date.getTime()) ? null : date
}

function parseDateToken(token: string, fallbackYear: number) {
    const match = token.match(/\b(\d{1,2})\.\s*(\d{1,2})\.?\b/)
    if (!match) return null
    const day = Number(match[1])
    const month = Number(match[2])
    const date = new Date(fallbackYear, month - 1, day)
    return Number.isNaN(date.getTime()) ? null : date
}

function shouldIgnoreLine(line: string) {
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

function normalizeBoxText(text: string) {
    let normalized = text
        .replace(/\bB\s*OX\b/gi, 'BOX')
        .replace(/\bbox\b/gi, 'BOX')
        .replace(/\s+/g, ' ')
        .trim()

    normalized = normalized.replace(/Recepce\s*:\s*BOX/gi, 'Recepce: BOX')
    normalized = normalized.replace(/\bBOX\s*([a-z0-9-]+)/gi, (_, value: string) => `BOX ${value.toUpperCase()}`)

    return normalized
}

function splitNoteGroups(rawText: string) {
    return rawText
        .split(/\.\.\.+|…+/)
        .map((part) => normalizeBoxText(part))
        .map((part) => part.trim())
        .filter(Boolean)
}

function isNoteLine(line: string) {
    const normalized = normalizeForMatch(line)
    return normalized.includes('recepce') || /\bbox\b/i.test(line) || /\bb\s*ox\b/i.test(line)
}

function isCapacityLine(line: string) {
    return /^\[\s*\d{1,2}\s*\+\s*\d{1,2}\s*\]$/.test(line.trim())
}

function isAlfredWindow(line: string) {
    return /\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(?:AM|PM)?\s*-\s*([01]?\d|2[0-3])[:.]([0-5]\d)\s*(?:AM|PM)?\b/i.test(line) && /alfred/i.test(line)
}

function stripAlfredWindowSegments(line: string) {
    return line
        .replace(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(?:AM|PM)?\s*-\s*([01]?\d|2[0-3])[:.]([0-5]\d)\s*(?:AM|PM)?(?:\s*\(?alfred\)?)?/gi, ' ')
        .replace(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(?:AM|PM)?\s*-\s*([01]?\d|2[0-3])[:.]([0-5]\d)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function detectRoomToken(line: string) {
    const collapsed = line.replace(/\s+/g, ' ').trim()
    const start = collapsed.match(/^(\d{3})(?:\s+studio)?\b/i)
    if (start) {
        const room = normalizeRoomNumber(start[1])
        if (MASTER_ROOM_SET.has(room)) return room
    }

    return undefined
}

function extractDateTokens(text: string) {
    const tokens = new Set<string>()
    const matches = text.matchAll(/\b(\d{1,2})\.\s*(\d{1,2})\.?\b/g)
    for (const match of matches) {
        tokens.add(`${Number(match[1])}. ${Number(match[2])}.`)
    }
    return Array.from(tokens)
}

type StateColumnBlock = {
    room: string
    departureText: string
    arrivalText: string
    rawText: string
}

function buildMergedRowText(items: Array<{ text: string; x: number }>) {
    return items
        .sort((a, b) => a.x - b.x)
        .map((item) => item.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function collectColumnText(
    rows: Array<{ items: Array<{ text: string; x: number }> }>,
    minX: number,
    maxX = Number.POSITIVE_INFINITY
) {
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

function detectSplitX(items: PrevioPdfExtract['pages'][number]['items']) {
    const byLabel = (label: string) => items
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

function detectRoomColumnMaxX(items: PrevioPdfExtract['pages'][number]['items'], splitX: number) {
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

function findRoomInRow(items: Array<{ text: string; x: number }>, roomColumnMaxX: number) {
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

function extractStateColumnBlocks(page: PrevioPdfExtract['pages'][number]): StateColumnBlock[] {
    if (!page?.items?.length) return []

    const splitX = detectSplitX(page.items)
    const roomColumnMaxX = detectRoomColumnMaxX(page.items, splitX)
    const sideSplitPadding = 12

    const rowMap = new Map<number, Array<{ text: string; x: number }>>()
    page.items.forEach((item) => {
        const bucket = Math.round(item.y)
        if (!rowMap.has(bucket)) rowMap.set(bucket, [])
        rowMap.get(bucket)?.push({ text: item.text, x: item.x })
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

    const starts: Array<{ index: number; room: string; y: number }> = []
    rows.forEach((row, index) => {
        const room = findRoomInRow(row.items, roomColumnMaxX)
        if (room) starts.push({ index, room, y: row.y })
    })

    if (starts.length === 0) return []

    const rowsByStartIndex = new Map<number, typeof rows>()
    starts.forEach((start) => rowsByStartIndex.set(start.index, []))

    rows.forEach((row) => {
        let nearest = starts[0]
        let nearestDistance = Math.abs(row.y - nearest.y)

        for (let i = 1; i < starts.length; i++) {
            const candidate = starts[i]
            const candidateDistance = Math.abs(row.y - candidate.y)
            if (candidateDistance < nearestDistance) {
                nearest = candidate
                nearestDistance = candidateDistance
                continue
            }

            // In tie distance, prefer the lower marker (next room in visual flow)
            // to avoid bleeding a boundary row into the previous room block.
            if (candidateDistance === nearestDistance && candidate.y < nearest.y) {
                nearest = candidate
            }
        }

        rowsByStartIndex.get(nearest.index)?.push(row)
    })

    return starts.map((start) => {
        const blockRows = [...(rowsByStartIndex.get(start.index) || [])].sort((a, b) => b.y - a.y)
        const departureText = collectColumnText(blockRows, roomColumnMaxX + 1, splitX + sideSplitPadding)
        const arrivalText = collectColumnText(blockRows, splitX + sideSplitPadding)
        const rawText = blockRows.map((row) => row.text).join('\n')

        return {
            room: start.room,
            departureText,
            arrivalText,
            rawText
        }
    })
}

function extractSideNotes(sideText: string) {
    const noteSource = sideText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => isNoteLine(line))
        .join(' ')

    return splitNoteGroups(noteSource)
}

function extractSideTimeAndCount(sideText: string, side: 'departure' | 'arrival') {
    const entries = detectTimedEntries(sideText)
    const times = detectTimes(sideText)
    const standaloneCounts = extractStandaloneGuestCounts(sideText)

    let combined = entries.slice()

    // If no timed entries found but plain times exist, create lightweight entries
    if (combined.length === 0 && times.length > 0) {
        combined = times.map((t, idx) => ({ time: t, guestCount: undefined as number | undefined, index: idx }))
    }

    if (combined.length === 0) {
        return {
            time: undefined,
            guestCount: undefined,
            hadAmPm: /\b(?:AM|PM)\b/i.test(sideText)
        }
    }

    const ordered = [...combined].sort((a, b) => {
        const minuteDiff = toMinutes(a.time) - toMinutes(b.time)
        if (minuteDiff !== 0) return minuteDiff
        return a.index - b.index
    })

    const selected = side === 'departure' ? ordered[0] : ordered[ordered.length - 1]

    // If selected entry doesn't carry a guestCount, try to infer from standalone counts
    let inferredCount = selected?.guestCount
    if (typeof inferredCount === 'undefined' && standaloneCounts.length > 0) {
        if (standaloneCounts.length === 1) {
            inferredCount = standaloneCounts[0]
        } else if (times.length === standaloneCounts.length) {
            // Map counts by order of appearance to times
            const selIdx = ordered.findIndex((e) => e.time === selected?.time && e.index === selected?.index)
            inferredCount = standaloneCounts[selIdx] ?? standaloneCounts[0]
        } else {
            // Fallback to nearest: prefer first for departure, last for arrival
            inferredCount = side === 'departure' ? standaloneCounts[0] : standaloneCounts[standaloneCounts.length - 1]
        }
    }

    return {
        time: selected?.time,
        guestCount: inferredCount,
        hadAmPm: /\b(?:AM|PM)\b/i.test(sideText)
    }
}

function isSuspiciousNightTurnover(time?: string) {
    if (!time) return false
    const [hoursRaw] = time.split(':')
    const hours = Number(hoursRaw)
    if (!Number.isFinite(hours)) return false
    return hours >= 1 && hours <= 7
}

function detectTimes(blockText: string) {
    const detected: string[] = []
    const source = stripAlfredWindowSegments(blockText)
    const matches = source.matchAll(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(AM|PM)?\b/gi)
    for (const match of matches) {
        detected.push(normalizeTimeWithMeridiem(match[1], match[2], match[3]))
    }
    return detected
}

function detectTimedEntries(blockText: string) {
    const entries: Array<{ time: string; guestCount?: number; index: number }> = []
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

function chooseTimes(detectedTimes: string[], noteGroupsCount: number) {
    if (detectedTimes.length >= 2) {
        const ordered = [...detectedTimes].sort((a, b) => toMinutes(a) - toMinutes(b))
        const first = ordered[0]
        const last = ordered[ordered.length - 1]

        return {
            departureTime: first,
            arrivalTime: last
        }
    }

    if (detectedTimes.length === 1) {
        const only = detectedTimes[0]
        if (noteGroupsCount >= 2) {
            return { departureTime: only, arrivalTime: only }
        }
        if (toMinutes(only) <= 12 * 60) {
            return { departureTime: only, arrivalTime: undefined }
        }
        return { departureTime: undefined, arrivalTime: only }
    }

    return { departureTime: undefined, arrivalTime: undefined }
}

function chooseGuestCounts(
    timedEntries: Array<{ time: string; guestCount?: number; index: number }>,
    departureTime?: string,
    arrivalTime?: string,
    noteGroupsCount = 0
) {
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

    const guestCountForTime = (time: string, useLast: boolean) => {
        const matches = ordered.filter((entry) => entry.time === time)
        if (matches.length === 0) return undefined
        const selected = useLast ? matches[matches.length - 1] : matches[0]
        return selected?.guestCount
    }

    if (departureTime && arrivalTime) {
        if (ordered.length >= 2) {
            return {
                departureGuestCount: ordered[0]?.guestCount,
                arrivalGuestCount: ordered[ordered.length - 1]?.guestCount
            }
        }

        const singleCount = ordered[0]?.guestCount
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
        arrivalGuestCount: guestCountForTime(arrivalTime as string, true)
    }
}

function extractStandaloneGuestCounts(blockText: string) {
    const source = stripAlfredWindowSegments(String(blockText || ''))
    const parenthesis = [...source.matchAll(/\((\d{1,2})\)/g)].map((m) => Number(m[1]))
    const suffixCounts = [...source.matchAll(/\b(\d{1,2})\s*(?:p|os|host|pax)\b/gi)].map((m) => Number(m[1]))
    const all = [...parenthesis, ...suffixCounts].filter((value) => Number.isFinite(value) && value >= 0)
    // preserve order but remove duplicates
    return Array.from(new Set(all))
}

function chooseStayoverGuestCount(roomNumber: string, ...texts: string[]) {
    const allCounts = texts.flatMap((text) => extractStandaloneGuestCounts(text))
    if (allCounts.length === 0) return undefined

    const roomCapacity = ROOM_CAPACITY_BY_NUMBER[normalizeRoomKey(roomNumber)]
    const filteredCounts = typeof roomCapacity === 'number'
        ? allCounts.filter((count) => count <= roomCapacity)
        : allCounts

    if (filteredCounts.length === 0) return undefined
    return filteredCounts.sort((a, b) => a - b)[0]
}

function assignNotesBySide(noteGroups: string[], departureTime?: string, arrivalTime?: string) {
    const departureNotes: string[] = []
    const arrivalNotes: string[] = []
    const sideWarnings: string[] = []

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

function extractNameCandidates(blockLines: string[]) {
    const candidates: string[] = []
    const singleTokenLines: string[] = []
    const forbiddenTokens = new Set([
        'odjezd', 'prijezd', 'datum', 'pokoj', 'poznamka',
        'recepce', 'box', 'studio', 'alfred', 'chill', 'apartments'
    ])

    function normalizeCandidateCase(value: string) {
        return value
            .split(' ')
            .map((token) => {
                if (!/^\p{Ll}[\p{L}'’-]+$/u.test(token)) return token
                return `${token[0].toUpperCase()}${token.slice(1)}`
            })
            .join(' ')
    }

    function pushCandidate(value: string) {
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
        const trimmed = line.trim()
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
            if ((firstUpper && secondUpper) || (firstLower && secondUpper)) {
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

function parseTotalsLine(line: string) {
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

export function parsePrevioStatePdfText(source: PrevioStatePdfSource, referenceDate = new Date()): PrevioStateParseResult {
    const parsedSource = typeof source === 'string'
        ? { rawText: source, pages: [] as PrevioPdfExtract['pages'] }
        : source

    const rawText = parsedSource.rawText
    const allLines = rawText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

    const warnings: string[] = []
    const rows: PrevioStateParsedRow[] = []
    const parsedDates: string[] = []
    const completeDates = new Set<string>()
    let amPmEvidence = false
    const dayTotals: Record<string, { arrivals?: number; departures?: number; stayovers?: number }> = {}

    const pages = rawText
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

        const geometryPage = parsedSource.pages?.[pageIndex]
        const columnBlocks = geometryPage ? extractStateColumnBlocks(geometryPage) : []
        if (columnBlocks.length > 0) {
            let pendingGhostArrivalTransfer: {
                time?: string
                guestCount?: number
                note?: string
            } | null = null

            columnBlocks.forEach((block) => {
                const departureInfo = extractSideTimeAndCount(block.departureText, 'departure')
                const arrivalInfo = extractSideTimeAndCount(block.arrivalText, 'arrival')

                let departureTime = departureInfo.time
                let arrivalTime = arrivalInfo.time
                let departureGuestCount = departureInfo.guestCount
                let arrivalGuestCount = arrivalInfo.guestCount
                let stayoverGuestCount = !departureTime && !arrivalTime
                    ? chooseStayoverGuestCount(block.room, block.departureText, block.arrivalText, block.rawText)
                    : undefined

                let departureNotes = extractSideNotes(block.departureText)
                let arrivalNotes = extractSideNotes(block.arrivalText)

                if (departureNotes.length === 0 && arrivalNotes.length >= 2 && departureTime && arrivalTime) {
                    departureNotes = [arrivalNotes[0]]
                    arrivalNotes = [arrivalNotes[1], ...arrivalNotes.slice(2)]
                }

                let departureGuestName = extractNameCandidates(block.departureText.split(/\r?\n/))[0]
                let arrivalGuestName = extractNameCandidates(block.arrivalText.split(/\r?\n/))[0]
                let stayoverGuestName = !departureTime && !arrivalTime
                    ? (departureGuestName || arrivalGuestName || extractNameCandidates(block.rawText.split(/\r?\n/))[0])
                    : undefined

                if (
                    pendingGhostArrivalTransfer
                    && !departureTime
                    && !arrivalTime
                    && (stayoverGuestName || departureGuestName || arrivalGuestName)
                ) {
                    arrivalTime = pendingGhostArrivalTransfer.time || '11:00'
                    if (typeof pendingGhostArrivalTransfer.guestCount === 'number') {
                        arrivalGuestCount = pendingGhostArrivalTransfer.guestCount
                    }
                    if (!arrivalGuestName) {
                        arrivalGuestName = stayoverGuestName || departureGuestName || arrivalGuestName
                    }
                    if (pendingGhostArrivalTransfer.note) {
                        arrivalNotes = [...arrivalNotes, pendingGhostArrivalTransfer.note]
                            .filter((note, index, all) => all.indexOf(note) === index)
                    }
                    stayoverGuestName = undefined
                    stayoverGuestCount = undefined
                    pendingGhostArrivalTransfer = null
                }

                const roomCapacity = ROOM_CAPACITY_BY_NUMBER[normalizeRoomKey(block.room)]
                const inferredStayoverCount = chooseStayoverGuestCount(block.room, block.departureText, block.arrivalText, block.rawText)
                const hasGhostArrivalBleed = (
                    !departureTime
                    && Boolean(arrivalTime)
                    && !arrivalGuestName
                    && Boolean(departureGuestName)
                    && typeof arrivalGuestCount === 'number'
                    && typeof roomCapacity === 'number'
                    && arrivalGuestCount > roomCapacity
                    && typeof inferredStayoverCount === 'number'
                )

                if (hasGhostArrivalBleed) {
                    const leakedArrivalTime = arrivalTime
                    const leakedArrivalGuestCount = arrivalGuestCount
                    const leakedArrivalNote = arrivalNotes.length > 1 ? arrivalNotes[arrivalNotes.length - 1] : undefined

                    arrivalTime = undefined
                    arrivalGuestCount = undefined
                    stayoverGuestName = departureGuestName
                    stayoverGuestCount = inferredStayoverCount

                    const primaryStayoverNote = departureNotes[0] || arrivalNotes[0]
                    departureNotes = primaryStayoverNote ? [primaryStayoverNote] : []
                    arrivalNotes = []

                    pendingGhostArrivalTransfer = {
                        time: leakedArrivalTime,
                        guestCount: leakedArrivalGuestCount,
                        note: leakedArrivalNote
                    }
                } else {
                    pendingGhostArrivalTransfer = null
                }

                const dateTokens = extractDateTokens(block.rawText)
                const stayoverUntilRaw = (() => {
                    if (dateTokens.length === 0) return undefined
                    const parsed = dateTokens
                        .map((token) => parseDateToken(token, pageDate.getFullYear()))
                        .filter((dt): dt is Date => dt !== null)
                        .sort((a, b) => a.getTime() - b.getTime())
                    const last = parsed[parsed.length - 1]
                    if (!last) return undefined
                    return formatLocalDate(last)
                })()
                const stayoverUntil = !departureTime && !arrivalTime ? stayoverUntilRaw : undefined

                const blockWarnings: string[] = []
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
                if (arrivalGuestName && typeof arrivalGuestCount !== 'number') {
                    try {
                        const raw = String(block.rawText || '')
                        const re = /\((\d{1,2})\)|\b(\d{1,2})\s*(?:p|os|host|pax)\b/gi
                        const matches = [...raw.matchAll(re)].map((m) => ({ index: typeof m.index === 'number' ? m.index : 0, value: Number(m[1] || m[2]) }))
                        if (matches.length > 0) {
                            const nameIdx = raw.toLowerCase().indexOf(arrivalGuestName.toLowerCase())
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

        function roomFromBlock(lines: string[]) {
            for (let i = 0; i < lines.length; i++) {
                const room = detectRoomToken(lines[i])
                if (room) return { room, markerOffset: i }
            }
            return null
        }

        let pendingGhostArrivalTransfer: {
            time?: string
            guestCount?: number
            note?: string
        } | null = null

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
            const timedEntries = detectTimedEntries(timeSource)
            const detectedTimes = detectTimes(timeSource)
            let { departureTime, arrivalTime } = chooseTimes(detectedTimes, noteGroups.length)
            let { departureGuestCount, arrivalGuestCount } = chooseGuestCounts(timedEntries, departureTime, arrivalTime, noteGroups.length)
            let stayoverGuestCount = !departureTime && !arrivalTime
                ? chooseStayoverGuestCount(roomInfo.room, rawBlock)
                : undefined

            let { departureNotes, arrivalNotes, sideWarnings } = assignNotesBySide(noteGroups, departureTime, arrivalTime)
            const guestCandidates = extractNameCandidates(blockLines)

            let departureGuestName: string | undefined
            let arrivalGuestName: string | undefined
            let stayoverGuestName: string | undefined

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

            if (
                pendingGhostArrivalTransfer
                && !departureTime
                && !arrivalTime
                && (stayoverGuestName || departureGuestName || arrivalGuestName)
            ) {
                arrivalTime = pendingGhostArrivalTransfer.time || '11:00'
                if (typeof pendingGhostArrivalTransfer.guestCount === 'number') {
                    arrivalGuestCount = pendingGhostArrivalTransfer.guestCount
                }
                if (!arrivalGuestName) {
                    arrivalGuestName = stayoverGuestName || departureGuestName || arrivalGuestName
                }
                if (pendingGhostArrivalTransfer.note) {
                    arrivalNotes = [...arrivalNotes, pendingGhostArrivalTransfer.note]
                        .filter((note, index, all) => all.indexOf(note) === index)
                }
                stayoverGuestName = undefined
                stayoverGuestCount = undefined
                pendingGhostArrivalTransfer = null
            }

            const roomCapacity = ROOM_CAPACITY_BY_NUMBER[normalizeRoomKey(roomInfo.room)]
            const inferredStayoverCount = chooseStayoverGuestCount(roomInfo.room, rawBlock)
            const hasGhostArrivalBleed = (
                !departureTime
                && Boolean(arrivalTime)
                && !arrivalGuestName
                && Boolean(departureGuestName)
                && typeof arrivalGuestCount === 'number'
                && typeof roomCapacity === 'number'
                && arrivalGuestCount > roomCapacity
                && typeof inferredStayoverCount === 'number'
            )

            if (hasGhostArrivalBleed) {
                const leakedArrivalTime = arrivalTime
                const leakedArrivalGuestCount = arrivalGuestCount
                const leakedArrivalNote = arrivalNotes.length > 1 ? arrivalNotes[arrivalNotes.length - 1] : undefined

                arrivalTime = undefined
                arrivalGuestCount = undefined
                stayoverGuestName = departureGuestName
                stayoverGuestCount = inferredStayoverCount

                const primaryStayoverNote = departureNotes[0] || arrivalNotes[0]
                departureNotes = primaryStayoverNote ? [primaryStayoverNote] : []
                arrivalNotes = []

                pendingGhostArrivalTransfer = {
                    time: leakedArrivalTime,
                    guestCount: leakedArrivalGuestCount,
                    note: leakedArrivalNote
                }
            } else {
                pendingGhostArrivalTransfer = null
            }

            const dateTokens = extractDateTokens(afterMarker.join(' '))
            const stayoverUntilRaw = (() => {
                if (dateTokens.length === 0) return undefined
                const parsed = dateTokens
                    .map((token) => parseDateToken(token, pageDate.getFullYear()))
                    .filter((dt): dt is Date => dt !== null)
                    .sort((a, b) => a.getTime() - b.getTime())
                const last = parsed[parsed.length - 1]
                if (!last) return undefined
                return formatLocalDate(last)
            })()
            const stayoverUntil = !departureTime && !arrivalTime ? stayoverUntilRaw : undefined

            const blockWarnings: string[] = [...sideWarnings]
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
                if (arrivalGuestName && typeof arrivalGuestCount !== 'number') {
                    try {
                        const raw = String(rawBlock || '')
                        const re = /\((\d{1,2})\)|\b(\d{1,2})\s*(?:p|os|host|pax)\b/gi
                        const matches = [...raw.matchAll(re)].map((m) => ({ index: typeof m.index === 'number' ? m.index : 0, value: Number(m[1] || m[2]) }))
                        if (matches.length > 0) {
                            const nameIdx = raw.toLowerCase().indexOf(arrivalGuestName.toLowerCase())
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

            if (DEV_LOG && rawBlock.length === 0) {
                // no-op placeholder to keep linter happy in case DEV logging is added
            }
        })
    })

    const sortedRows = [...rows].sort((a, b) => {
        if (a.dateIso !== b.dateIso) return a.dateIso.localeCompare(b.dateIso)
        return normalizeRoomKey(a.roomNumber).localeCompare(normalizeRoomKey(b.roomNumber))
    })

    const lastKnownGuestByRoom = new Map<string, string>()
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

    return {
        rows: sortedRows,
        warnings,
        parsedDates: parsedDates.sort(),
        rawTextLength: rawText.length,
        lineCount: allLines.length,
        completeDates: Array.from(completeDates).sort(),
        amPmEvidence,
        dayTotals
    }
}

const DEV_LOG = false

function dayDiff(baseDate: Date, comparedDate: Date) {
    const start = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate())
    const end = new Date(comparedDate.getFullYear(), comparedDate.getMonth(), comparedDate.getDate())
    return Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000))
}

export async function extractStateTextFromPdfFile(file: File) {
    return extractTextFromPdfFile(file)
}

export function buildPrevioStateImportPreview(
    parsed: PrevioStateParseResult,
    roomCatalog: RoomCatalogItem[],
    referenceDate = new Date()
): PrevioStateImportPreview {
    const warnings = [...parsed.warnings]
    const catalogRooms = roomCatalog.map((room) => normalizeRoomKey(room.roomNumber))
    const masterRooms = Array.from(new Set([...MASTER_ROOM_NUMBERS, ...catalogRooms])).sort((a, b) => Number(a) - Number(b))

    const rowsByDate = new Map<string, Map<string, PrevioStateParsedRow>>()
    const unknownRooms = new Set<string>()

    parsed.rows.forEach((row) => {
        const room = normalizeRoomKey(row.roomNumber)
        if (!masterRooms.includes(room)) {
            unknownRooms.add(room)
        }

        if (!rowsByDate.has(row.dateIso)) rowsByDate.set(row.dateIso, new Map())
        const dayMap = rowsByDate.get(row.dateIso) as Map<string, PrevioStateParsedRow>
        const prev = dayMap.get(room)

        if (!prev) {
            dayMap.set(room, { ...row, roomNumber: room })
            return
        }

        const prevScore = Number(Boolean(prev.departureTime)) + Number(Boolean(prev.arrivalTime))
        const nextScore = Number(Boolean(row.departureTime)) + Number(Boolean(row.arrivalTime))
        if (nextScore >= prevScore) {
            dayMap.set(room, { ...row, roomNumber: room })
        }
    })

    const days: PrevioStateDayPreview[] = Array.from(rowsByDate.keys())
        .sort()
        .map((dateIso) => {
            const dayMap = rowsByDate.get(dateIso) as Map<string, PrevioStateParsedRow>
            const rows = Array.from(dayMap.values()).sort((a, b) => Number(a.roomNumber) - Number(b.roomNumber))
            const presentRooms = rows.map((row) => normalizeRoomKey(row.roomNumber))
            const complete = parsed.completeDates.includes(dateIso)
            const derivedFreeRooms = complete
                ? masterRooms.filter((room) => !presentRooms.includes(room))
                : []

            if (!complete) {
                warnings.push(`Den ${dateIso}: stránka není kompletní, volné pokoje neodvozuji.`)
            }

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

    const parsedTabDates: Partial<Record<OpsTab, string>> = {}
    days.forEach((day) => {
        const offset = dayDiff(referenceDate, new Date(day.dateIso))
        if (offset === 0) parsedTabDates.Dnes = day.dateIso
        if (offset === 1) parsedTabDates.Zitra = day.dateIso
        if (offset === 2) parsedTabDates.Pozitri = day.dateIso
    })

    const suspiciousAmPmRows = days.flatMap((day) => day.rows)
        .filter((row) => row.warnings.some((warning) => warning.includes('AM/PM: podezřelý noční čas')))

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
        amPmEvidence: parsed.amPmEvidence,
        parsedDateCount: parsed.parsedDates.length,
        completeDateCount: parsed.completeDates.length,
        dayTotals: parsed.dayTotals,
        parserVersion: PREVIO_STAV_PARSER_VERSION,
        parsedTabDates
    }
}

export function evaluatePrevioStateImportSafety(input: PrevioStateImportSafetyInput): ImportJobSafetySummary {
    const preview = input.preview
    const missingDateLabels = input.missingDateLabels || []
    const parserVersion = String(input.parserVersion || '').trim()
    const parserVersionMissing = !parserVersion
    const parserVersionOutdated = parserVersionMissing || parserVersion !== PREVIO_STAV_PARSER_VERSION
    const checkedAt = (input.checkedAt || new Date()).toISOString()

    const blocks: string[] = []
    const warnings: string[] = []

    const rows = preview.days.flatMap((day) => day.rows)
    const turnoverRows = rows.filter((row) => Boolean(row.departureTime || row.arrivalTime))
    const arrivals = rows.filter((row) => Boolean(row.arrivalTime))
    const departures = rows.filter((row) => Boolean(row.departureTime))

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

        const issues: string[] = []
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

    if (preview.parsedDateCount > preview.days.length) {
        blocks.push('Počet dnů v náhledu je nižší než počet dnů detekovaných v PDF.')
    }

    const minimumExpectedRows = Math.max(12, preview.days.length * 6)
    if (preview.parsedRows < minimumExpectedRows) {
        blocks.push(`Počet parsovaných řádků je nečekaně nízký (${preview.parsedRows}).`)
    }

    if (missingDateLabels.length > 0) {
        blocks.push(`V náhledu chybí dny uprostřed rozsahu: ${missingDateLabels.join(', ')}`)
    }

    if (preview.confidenceLow) {
        blocks.push('Import není bezpečný podle confidenceLow parseru.')
    }

    let totalsMismatchDetected = false
    const totalsMismatchDetails: string[] = []
    const dayByIso = new Map(preview.days.map((day) => [day.dateIso, day]))
    Object.entries(preview.dayTotals || {}).forEach(([dateIso, totals]) => {
        const day = dayByIso.get(dateIso)
        if (!day) return

        const arrivalsCount = day.rows.filter((row) => Boolean(row.arrivalTime)).length
        const departuresCount = day.rows.filter((row) => Boolean(row.departureTime)).length
        const stayoversCount = day.rows.filter((row) => !row.departureTime && !row.arrivalTime).length
        const arrivalGuests = day.rows.reduce((sum, row) => sum + (typeof row.arrivalGuestCount === 'number' ? row.arrivalGuestCount : 0), 0)
        const departureGuests = day.rows.reduce((sum, row) => sum + (typeof row.departureGuestCount === 'number' ? row.departureGuestCount : 0), 0)
        const stayoverGuests = day.rows.reduce((sum, row) => sum + (typeof row.stayoverGuestCount === 'number' ? row.stayoverGuestCount : 0), 0)

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

            const detailParts: string[] = []
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
    const status: ImportJobSafetySummary['status'] = blocked ? 'blocked' : 'ok'

    return {
        status,
        blocked,
        warnings,
        blocks,
        checkedAt,
        parserVersion: parserVersion || PREVIO_STAV_PARSER_VERSION,
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
            parsedRows: preview.parsedRows,
            parsedDayCount: preview.parsedDateCount,
            previewDayCount: preview.days.length
        }
    }
}
