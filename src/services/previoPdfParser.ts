import { roomPlansByDay } from '../mockData'
import type { OpsTab } from './opsStore'

const DEV = import.meta.env.DEV
const PDF_PAGE_BREAK = '[[[PREVIO_PAGE_BREAK]]]'

const KNOWN_ROOM_NUMBERS = new Set([
    '001',
    '101',
    '102',
    '103',
    '104',
    '105',
    '201',
    '202',
    '203',
    '204',
    '205',
    '301',
    '302',
    '304',
    '305'
])

export type RoomCatalogItem = {
    roomNumber: string
    displayName?: string
    active: boolean
    defaultBox?: string
    sortOrder: number
}

export type PrevioParsedRow = {
    dateIso?: string
    roomNumber: string
    departureTime?: string
    arrivalTime?: string
    guestLabel?: string
    guestCount?: number
    box?: string
    notes: string[]
    warnings: string[]
}

export type PrevioParseResult = {
    rows: PrevioParsedRow[]
    warnings: string[]
    parsedDateHeadings: string[]
    rawTextLength: number
    lineCount: number
    lineDebug: Array<{
        index: number
        pageDate?: string
        room?: string
        rawBlock: string
        detectedTimes: string[]
        departureTime?: string
        arrivalTime?: string
        notes: string[]
        warnings: string[]
    }>
}

export type ParsedTurnover = {
    departureTime?: string
    arrivalTime?: string
    guestLabel?: string
    guestCount?: number
    box?: string
    notes: string[]
}

export type PrevioImportPreview = {
    byTab: Record<OpsTab, Map<string, ParsedTurnover>>
    parsedTabDates: Partial<Record<OpsTab, string>>
    warnings: string[]
    parsedRows: number
    rowsWithoutTimes: number
    confidenceLow: boolean
    unknownRooms: string[]
    noTurnoverRooms: string[]
    previewRows: Array<{
        tab: OpsTab
        dateLabel: string
        roomNumber: string
        departureTime?: string
        arrivalTime?: string
        notes: string
    }>
}

function formatLocalDate(date: Date) {
    const y = date.getFullYear()
    const m = `${date.getMonth() + 1}`.padStart(2, '0')
    const d = `${date.getDate()}`.padStart(2, '0')
    return `${y}-${m}-${d}`
}

function normalizeForMatch(value: string) {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
}

function normalizeRoomNumber(raw: string) {
    return raw.trim().replace(/^0+/, '').padStart(3, '0')
}

function normalizeTime(raw: string) {
    const normalized = raw.replace('.', ':')
    const [h, m] = normalized.split(':')
    if (!h || !m) return raw
    return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
}

function startOfDay(date: Date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function parseLineDate(line: string, fallbackYear: number) {
    const full = line.match(/\b(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\b/)
    if (full) {
        const day = Number(full[1])
        const month = Number(full[2])
        const year = Number(full[3])
        const dt = new Date(year, month - 1, day)
        return Number.isNaN(dt.getTime()) ? null : dt
    }

    const short = line.match(/(?:\b(?:po|ut|út|st|ct|čt|pa|so|ne|pondeli|utery|streda|ctvrtek|patek|sobota|nedele)\b\s*)?(\d{1,2})\.\s*(\d{1,2})\.?\b/i)
    if (short) {
        const day = Number(short[1])
        const month = Number(short[2])
        const dt = new Date(fallbackYear, month - 1, day)
        return Number.isNaN(dt.getTime()) ? null : dt
    }

    return null
}

function parsePageDateHeader(line: string) {
    const match = line.match(/\b(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\s*-\s*(po|ut|út|st|ct|čt|pa|so|ne)\b/i)
    if (!match) return null

    const day = Number(match[1])
    const month = Number(match[2])
    const year = Number(match[3])
    const date = new Date(year, month - 1, day)
    return Number.isNaN(date.getTime()) ? null : date
}

function isPageDateHeader(line: string) {
    return parsePageDateHeader(line) !== null
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
    if (normalized === 'prijizdejici' || normalized === 'odjizdejici' || normalized === 'probihajici') return true
    if (normalized === 'pokoj datum odjezd prijezd poznamka celkem') return true
    if (/prijizdejici\s*\/\s*odjizdejici\s*\/\s*probihajici/.test(normalized)) return true

    return false
}

function keywordNotes(textLower: string) {
    const keywords = [
        'dětská postýlka',
        'postýlka',
        'gauč',
        'late arrival',
        'pozdní příjezd',
        'extra ručníky',
        'ručníky',
        'toaletní papír'
    ]
    return keywords.filter((k) => textLower.includes(k))
}

export function getDefaultRoomCatalog(): RoomCatalogItem[] {
    const unique = new Set<string>()
    roomPlansByDay.Dnes.forEach((room) => {
        const match = room.number.match(/\d{3}/)
        if (!match) return
        unique.add(normalizeRoomNumber(match[0]))
    })

    unique.add('203')

    return Array.from(unique)
        .sort((a, b) => Number(a) - Number(b))
        .map((roomNumber, index) => ({
            roomNumber,
            active: true,
            sortOrder: index + 1
        }))
}

export async function extractTextFromPdfFile(file: File): Promise<string> {
    const [{ getDocument, GlobalWorkerOptions }, workerModule] = await Promise.all([
        import('pdfjs-dist/legacy/build/pdf.mjs'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    ])

    GlobalWorkerOptions.workerSrc = workerModule.default

    const data = await file.arrayBuffer()
    const loadingTask = getDocument({ data })
    const pdf = await loadingTask.promise

    const pageTexts: string[] = []
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i)
        const text = await page.getTextContent()
        const rawItems = text.items
            .map((item: any) => ({
                str: typeof item?.str === 'string' ? item.str.trim() : '',
                x: Array.isArray(item?.transform) ? Number(item.transform[4]) : 0,
                y: Array.isArray(item?.transform) ? Number(item.transform[5]) : 0
            }))
            .filter((item) => item.str)

        const rows = new Map<number, Array<{ str: string; x: number }>>()
        rawItems.forEach((item) => {
            const yBucket = Math.round(item.y)
            if (!rows.has(yBucket)) rows.set(yBucket, [])
            rows.get(yBucket)?.push({ str: item.str, x: item.x })
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
    }

    return pageTexts.join(`\n${PDF_PAGE_BREAK}\n`)
}

export function parsePrevioPdfText(rawText: string, referenceDate = new Date()): PrevioParseResult {
    const allLines = rawText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

    const warnings: string[] = []
    const rows: PrevioParsedRow[] = []
    const parsedDateHeadings: string[] = []
    const lineDebug: PrevioParseResult['lineDebug'] = []

    function detectRoomMarker(line: string) {
        const collapsed = line.replace(/\s+/g, ' ').trim()
        const exact = collapsed.match(/^(\d{3})(?:\s+studio)?$/i)
        if (exact) {
            const room = normalizeRoomNumber(exact[1])
            return KNOWN_ROOM_NUMBERS.has(room) ? room : undefined
        }

        const roomMatch = collapsed.match(/\b(\d{3})\b/)
        if (!roomMatch) return undefined
        const room = normalizeRoomNumber(roomMatch[1])
        return KNOWN_ROOM_NUMBERS.has(room) ? room : undefined
    }

    function toMinutes(hhmm: string) {
        const [h, m] = hhmm.split(':').map(Number)
        return h * 60 + m
    }

    function detectTimes(blockText: string) {
        const unique = new Set<string>()
        const matches = blockText.matchAll(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g)
        for (const match of matches) {
            unique.add(normalizeTime(`${match[1]}:${match[2]}`))
        }
        return Array.from(unique).sort((a, b) => toMinutes(a) - toMinutes(b))
    }

    function chooseTimes(detectedTimes: string[]) {
        const departures = detectedTimes.filter((time) => toMinutes(time) <= 12 * 60)
        const arrivals = detectedTimes.filter((time) => toMinutes(time) >= 13 * 60)

        if (detectedTimes.length === 1) {
            const only = detectedTimes[0]
            if (toMinutes(only) <= 12 * 60) {
                return { departureTime: only, arrivalTime: undefined }
            }
            return { departureTime: undefined, arrivalTime: only }
        }

        return {
            departureTime: departures[0],
            arrivalTime: arrivals[0]
        }
    }

    function extractBlockNotes(blockText: string) {
        const notes: string[] = []
        const normalized = normalizeForMatch(blockText)

        const keywordEntries = [
            { key: 'detska postylka', label: 'dětská postýlka' },
            { key: 'gauc', label: 'gauč' },
            { key: 'extra rucniky', label: 'extra ručníky' },
            { key: 'late arrival', label: 'late arrival' },
            { key: 'alfred', label: 'Alfred' }
        ]
        keywordEntries.forEach((entry) => {
            if (normalized.includes(entry.key)) {
                notes.push(entry.label)
            }
        })

        const boxMentions = [...blockText.matchAll(/(?:recepce\s*:\s*)?box\s*[a-z0-9-]+/ig)]
            .map((match) => match[0].replace(/\s+/g, ' ').trim())
        notes.push(...boxMentions)

        return Array.from(new Set(notes))
    }

    function extractBox(blockText: string) {
        const boxMatch = blockText.match(/\bbox\s*([a-z0-9-]+)/i)
        return boxMatch ? `BOX ${boxMatch[1].toUpperCase()}` : undefined
    }

    function extractGuestCount(blockText: string) {
        const match = blockText.match(/\[(\d{1,2})\s*\+\s*\d{1,2}\]/)
        if (match) return Number(match[1])

        const fallback = blockText.match(/\b(\d{1,2})\s*(?:p|os|host|pax)\b/i)
        return fallback ? Number(fallback[1]) : undefined
    }

    function extractDateTokens(text: string) {
        const tokens = new Set<string>()
        const matches = text.matchAll(/\b(\d{1,2})\.\s*(\d{1,2})\.?\b/g)
        for (const match of matches) {
            tokens.add(`${Number(match[1])}. ${Number(match[2])}.`)
        }
        return Array.from(tokens)
    }

    const pages = rawText
        .split(PDF_PAGE_BREAK)
        .map((page) => page.trim())
        .filter(Boolean)

    const effectivePages = pages.length ? pages : [rawText]

    effectivePages.forEach((pageText, pageIndex) => {
        const pageLines = pageText
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)

        const pageDateLine = pageLines.find((line) => isPageDateHeader(line))
        const pageDate = pageDateLine ? parsePageDateHeader(pageDateLine) : null
        if (pageDate) {
            const pageDateIso = formatLocalDate(pageDate)
            if (!parsedDateHeadings.includes(pageDateIso)) {
                parsedDateHeadings.push(pageDateIso)
            }
        } else {
            warnings.push(`Strana ${pageIndex + 1}: nenašel jsem hlavičku data strany.`)
        }

        const contentLines = pageLines.filter((line) => !isPageDateHeader(line) && !shouldIgnoreLine(line))
        const roomMarkers = contentLines
            .map((line, index) => ({ index, room: detectRoomMarker(line) }))
            .filter((entry): entry is { index: number; room: string } => Boolean(entry.room))

        if (roomMarkers.length === 0) {
            warnings.push(`Strana ${pageIndex + 1}: nenašel jsem žádný pokojový blok.`)
            return
        }

        roomMarkers.forEach((marker, markerIndex) => {
            const prevRoomIndex = markerIndex > 0 ? roomMarkers[markerIndex - 1].index : -1
            const nextRoomIndex = markerIndex + 1 < roomMarkers.length ? roomMarkers[markerIndex + 1].index : contentLines.length

            const blockStart = prevRoomIndex + 1
            const blockEnd = nextRoomIndex - 1
            const blockLines = contentLines.slice(blockStart, blockEnd + 1)
            const blockBeforeRoom = contentLines.slice(blockStart, marker.index)
            const blockAfterRoom = contentLines.slice(marker.index + 1, blockEnd + 1)
            const rawBlock = blockLines.join('\n')
            const detectedTimes = detectTimes(rawBlock)
            const { departureTime, arrivalTime } = chooseTimes(detectedTimes)
            const notes = extractBlockNotes(rawBlock)
            const box = extractBox(rawBlock)
            const guestCount = extractGuestCount(rawBlock)
            const contextDates = extractDateTokens(blockAfterRoom.join(' '))
            const blockWarnings: string[] = []

            if (!departureTime && !arrivalTime) {
                blockWarnings.push('Blok bez rozpoznaného času příjezdu/odjezdu')
            }
            if (!pageDate) {
                blockWarnings.push('Chybí datum strany, použito referenční datum')
            }
            if (contextDates.length > 0) {
                blockWarnings.push(`Kontekstová data: ${contextDates.join(', ')}`)
            }
            if (blockBeforeRoom.length === 0) {
                blockWarnings.push('Blok nemá text před řádkem pokoje')
            }

            const operationalDate = pageDate
                ? formatLocalDate(pageDate)
                : formatLocalDate(new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate() + pageIndex))

            rows.push({
                dateIso: operationalDate,
                roomNumber: marker.room,
                departureTime,
                arrivalTime,
                guestCount,
                box,
                notes,
                warnings: blockWarnings
            })

            if (blockWarnings.length > 0) {
                warnings.push(`Blok ${markerIndex + 1} (pokoj ${marker.room}): ${blockWarnings.join(', ')}`)
            }

            lineDebug.push({
                index: lineDebug.length + 1,
                pageDate: pageDate ? formatLocalDate(pageDate) : undefined,
                room: marker.room,
                rawBlock,
                detectedTimes,
                departureTime,
                arrivalTime,
                notes,
                warnings: blockWarnings
            })
        })
    })

    if (rows.length === 0) {
        warnings.push('V PDF nebyly rozpoznány žádné pokojové bloky.')
    }

    if (DEV) {
        console.info('[PrevioParser] parsed rows', { count: rows.length, rawTextLength: rawText.length })
    }

    return {
        rows,
        warnings,
        parsedDateHeadings,
        rawTextLength: rawText.length,
        lineCount: allLines.length,
        lineDebug
    }
}

function formatDateLabel(dateIso: string) {
    const date = new Date(dateIso)
    return date.toLocaleDateString('cs-CZ', { weekday: 'short', day: 'numeric', month: 'numeric' })
}

function dayDiff(from: Date, to: Date) {
    const a = startOfDay(from).getTime()
    const b = startOfDay(to).getTime()
    return Math.round((b - a) / (24 * 60 * 60 * 1000))
}

export function buildPrevioImportPreview(
    parsed: PrevioParseResult,
    roomCatalog: RoomCatalogItem[],
    referenceDate = new Date()
): PrevioImportPreview {
    const byTab: Record<OpsTab, Map<string, ParsedTurnover>> = {
        Dnes: new Map(),
        Zitra: new Map(),
        Pozitri: new Map()
    }

    const parsedTabDates: Partial<Record<OpsTab, string>> = {}
    const warnings = [...parsed.warnings]
    const rowsWithoutTimes = parsed.rows.filter((row) => !row.departureTime && !row.arrivalTime).length
    const confidenceLow = parsed.rows.length > 0 ? (rowsWithoutTimes / parsed.rows.length) > 0.3 : true

    const activeRooms = roomCatalog
        .filter((room) => room.active)
        .sort((a, b) => a.sortOrder - b.sortOrder)

    const activeSet = new Set(activeRooms.map((room) => room.roomNumber))
    const unknownRooms = Array.from(new Set(parsed.rows.map((row) => row.roomNumber).filter((room) => !activeSet.has(room))))

    parsed.rows.forEach((row) => {
        if (!row.dateIso) return
        const parsedDate = new Date(row.dateIso)
        const offset = dayDiff(referenceDate, parsedDate)
        const tab: OpsTab | null = offset === 0 ? 'Dnes' : offset === 1 ? 'Zitra' : offset === 2 ? 'Pozitri' : null

        if (!tab) {
            warnings.push(`Ignoruji řádek pro datum mimo rozsah Dnes/Zítra/Pozítří: ${row.roomNumber} (${row.dateIso})`)
            return
        }

        parsedTabDates[tab] = row.dateIso

        const prev = byTab[tab].get(row.roomNumber) || { notes: [] }
        byTab[tab].set(row.roomNumber, {
            departureTime: row.departureTime || prev.departureTime,
            arrivalTime: row.arrivalTime || prev.arrivalTime,
            guestLabel: row.guestLabel || prev.guestLabel,
            guestCount: row.guestCount ?? prev.guestCount,
            box: row.box || prev.box,
            notes: Array.from(new Set([...(prev.notes || []), ...row.notes]))
        })
    })

    const noTurnoverRooms: string[] = []
        ; (['Dnes', 'Zitra', 'Pozitri'] as OpsTab[]).forEach((tab) => {
            activeRooms.forEach((room) => {
                const row = byTab[tab].get(room.roomNumber)
                if (!row || (!row.arrivalTime && !row.departureTime)) {
                    noTurnoverRooms.push(`${tab}: ${room.roomNumber}`)
                }
            })
        })

    const previewRows: PrevioImportPreview['previewRows'] = []
        ; (['Dnes', 'Zitra', 'Pozitri'] as OpsTab[]).forEach((tab) => {
            const dateIso = parsedTabDates[tab]
            const dateLabel = dateIso ? formatDateLabel(dateIso) : tab
            byTab[tab].forEach((row, roomNumber) => {
                previewRows.push({
                    tab,
                    dateLabel,
                    roomNumber,
                    departureTime: row.departureTime,
                    arrivalTime: row.arrivalTime,
                    notes: row.notes.join(', ')
                })
            })
        })

    return {
        byTab,
        parsedTabDates,
        warnings,
        parsedRows: parsed.rows.length,
        rowsWithoutTimes,
        confidenceLow,
        unknownRooms,
        noTurnoverRooms,
        previewRows
    }
}
