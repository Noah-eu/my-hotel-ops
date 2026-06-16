import { roomPlansByDay } from '../mockData'
import type { OpsTab } from './opsStore'

const DEV = import.meta.env.DEV

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
        line: string
        detectedDate?: string
        detectedRoom?: string
        departureTime?: string
        arrivalTime?: string
        notes: string[]
        warning?: string
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

    return pageTexts.join('\n')
}

export function parsePrevioPdfText(rawText: string, referenceDate = new Date()): PrevioParseResult {
    const lines = rawText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

    const warnings: string[] = []
    const rows: PrevioParsedRow[] = []
    const parsedDateHeadings: string[] = []
    const lineDebug: PrevioParseResult['lineDebug'] = []

    let currentDate: Date | null = null
    const fallbackYear = referenceDate.getFullYear()

    function inferTimes(text: string) {
        const normalized = normalizeForMatch(text)
        const times = [...text.matchAll(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g)].map((m) => normalizeTime(`${m[1]}:${m[2]}`))

        let departureTime: string | undefined
        let arrivalTime: string | undefined

        const departureKeyword = /odjezd|departure|check\s*-?\s*out|checkout|odchod/.test(normalized)
        const arrivalKeyword = /prijezd|arrival|check\s*-?\s*in|checkin|prichod/.test(normalized)

        if (times.length >= 2) {
            if (departureKeyword && arrivalKeyword) {
                departureTime = times[0]
                arrivalTime = times[1]
            } else {
                departureTime = times[0]
                arrivalTime = times[1]
            }
        } else if (times.length === 1) {
            if (departureKeyword && !arrivalKeyword) departureTime = times[0]
            else if (arrivalKeyword && !departureKeyword) arrivalTime = times[0]
            else arrivalTime = times[0]
        }

        return { departureTime, arrivalTime }
    }

    function detectNotes(text: string) {
        const lower = normalizeForMatch(text)
        const notes = keywordNotes(lower)
        const boxMatch = text.match(/\bbox\s*([a-z0-9-]+)/i)
        const box = boxMatch ? `BOX ${boxMatch[1].toUpperCase()}` : undefined
        return { notes, box }
    }

    function detectRoom(line: string) {
        const roomMatch = line.match(/(?:pokoj\s*)?\b(\d{3})\b/i)
        return roomMatch ? normalizeRoomNumber(roomMatch[1]) : undefined
    }

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex]

        const maybeDate = parseLineDate(line, fallbackYear)
        if (maybeDate) {
            currentDate = maybeDate
            parsedDateHeadings.push(formatLocalDate(maybeDate))
        }

        const roomNumber = detectRoom(line)
        if (!roomNumber) {
            lineDebug.push({
                index: lineIndex + 1,
                line,
                detectedDate: maybeDate ? formatLocalDate(maybeDate) : undefined,
                notes: [],
                warning: 'Bez čísla pokoje'
            })
            continue
        }

        const lookahead: string[] = [line]
        for (let j = lineIndex + 1; j < Math.min(lines.length, lineIndex + 4); j++) {
            const nextLine = lines[j]
            if (detectRoom(nextLine) || parseLineDate(nextLine, fallbackYear)) break
            lookahead.push(nextLine)
        }
        const combinedLine = lookahead.join(' ')

        const { departureTime, arrivalTime } = inferTimes(combinedLine)
        const { notes, box } = detectNotes(combinedLine)

        const guestCountMatch = combinedLine.match(/\b(\d{1,2})\s*(?:p|os|host|pax)\b/i)
        const guestCount = guestCountMatch ? Number(guestCountMatch[1]) : undefined
        const rowWarnings: string[] = []

        if (!currentDate) {
            rowWarnings.push('Řádek bez rozpoznaného data, přiřazuji k dnešku')
        }
        if (!departureTime && !arrivalTime) {
            rowWarnings.push('Řádek bez času příjezdu/odjezdu')
        }

        rows.push({
            dateIso: formatLocalDate(currentDate || referenceDate),
            roomNumber,
            departureTime,
            arrivalTime,
            guestCount,
            box,
            notes,
            warnings: rowWarnings
        })

        if (rowWarnings.length > 0) {
            warnings.push(`Řádek ${lineIndex + 1}: ${rowWarnings.join(', ')}`)
        }

        lineDebug.push({
            index: lineIndex + 1,
            line,
            detectedDate: currentDate ? formatLocalDate(currentDate) : undefined,
            detectedRoom: roomNumber,
            departureTime,
            arrivalTime,
            notes,
            warning: rowWarnings.length ? rowWarnings.join(', ') : undefined
        })
    }

    if (rows.length === 0) {
        warnings.push('V PDF nebyly rozpoznány žádné řádky s číslem pokoje.')
    }

    if (DEV) {
        console.info('[PrevioParser] parsed rows', { count: rows.length, rawTextLength: rawText.length })
    }

    return {
        rows,
        warnings,
        parsedDateHeadings,
        rawTextLength: rawText.length,
        lineCount: lines.length,
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
