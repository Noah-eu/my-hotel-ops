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

function normalizeRoomNumber(raw: string) {
    return raw.trim().replace(/^0+/, '').padStart(3, '0')
}

function normalizeTime(raw: string) {
    const [h, m] = raw.split(':')
    if (!h || !m) return raw
    return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
}

function startOfDay(date: Date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function parseLineDate(line: string, fallbackYear: number) {
    const full = line.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/)
    if (full) {
        const day = Number(full[1])
        const month = Number(full[2])
        const year = Number(full[3])
        const dt = new Date(year, month - 1, day)
        return Number.isNaN(dt.getTime()) ? null : dt
    }

    const short = line.match(/\b(\d{1,2})\.(\d{1,2})\.?\b/)
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
        const lines = text.items
            .map((item: any) => (typeof item?.str === 'string' ? item.str : ''))
            .filter(Boolean)
        pageTexts.push(lines.join('\n'))
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

    let currentDate: Date | null = null
    const fallbackYear = referenceDate.getFullYear()

    lines.forEach((line, lineIndex) => {
        const lower = line.toLowerCase()

        const maybeDate = parseLineDate(line, fallbackYear)
        if (maybeDate) {
            currentDate = maybeDate
            parsedDateHeadings.push(maybeDate.toISOString().slice(0, 10))
        }

        const roomMatch = line.match(/\b(\d{3})\b/)
        if (!roomMatch) return

        const roomNumber = normalizeRoomNumber(roomMatch[1])
        const times = [...line.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)].map((m) => normalizeTime(`${m[1]}:${m[2]}`))

        let departureTime: string | undefined
        let arrivalTime: string | undefined
        if (times.length >= 2) {
            departureTime = times[0]
            arrivalTime = times[1]
        } else if (times.length === 1) {
            if (lower.includes('odjezd')) departureTime = times[0]
            else arrivalTime = times[0]
        }

        const guestCountMatch = line.match(/\b(\d{1,2})\s*(?:p|os|host)/i)
        const guestCount = guestCountMatch ? Number(guestCountMatch[1]) : undefined

        const boxMatch = line.match(/\bbox\s*([a-z0-9-]+)/i)
        const box = boxMatch ? `BOX ${boxMatch[1].toUpperCase()}` : undefined

        const notes = keywordNotes(lower)
        const rowWarnings: string[] = []

        if (!currentDate) {
            rowWarnings.push('Řádek bez rozpoznaného data, přiřazuji k dnešku')
        }
        if (!departureTime && !arrivalTime) {
            rowWarnings.push('Řádek bez času příjezdu/odjezdu')
        }

        rows.push({
            dateIso: (currentDate || referenceDate).toISOString().slice(0, 10),
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
    })

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
        rawTextLength: rawText.length
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
    ;(['Dnes', 'Zitra', 'Pozitri'] as OpsTab[]).forEach((tab) => {
        activeRooms.forEach((room) => {
            const row = byTab[tab].get(room.roomNumber)
            if (!row || (!row.arrivalTime && !row.departureTime)) {
                noTurnoverRooms.push(`${tab}: ${room.roomNumber}`)
            }
        })
    })

    const previewRows: PrevioImportPreview['previewRows'] = []
    ;(['Dnes', 'Zitra', 'Pozitri'] as OpsTab[]).forEach((tab) => {
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
        unknownRooms,
        noTurnoverRooms,
        previewRows
    }
}
