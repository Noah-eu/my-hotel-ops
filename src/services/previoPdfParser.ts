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
    '303',
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
    departureGuestName?: string
    arrivalGuestName?: string
    guestLabel?: string
    guestCount?: number
    box?: string
    departureNotes: string[]
    arrivalNotes: string[]
    generalNotes: string[]
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
        page: number
        pageDate?: string
        room?: string
        previousRoom?: string
        nextRoom?: string
        blockStartLine: number
        blockEndLine: number
        yStart: number
        yEnd: number
        rawBlock: string
        roomColumnText: string
        departureColumnText: string
        arrivalColumnText: string
        departureNoteColumnText: string
        arrivalNoteColumnText: string
        detectedTimes: string[]
        noteGroups: string[]
        departureTime?: string
        arrivalTime?: string
        departureGuestLabel?: string
        arrivalGuestLabel?: string
        departureNotes: string[]
        arrivalNotes: string[]
        generalNotes: string[]
        warnings: string[]
    }>
}

export type PrevioPdfTextItem = {
    page: number
    x: number
    y: number
    text: string
}

export type PrevioPdfPageExtract = {
    page: number
    items: PrevioPdfTextItem[]
    mergedLines: string[]
}

export type PrevioPdfExtract = {
    rawText: string
    pages: PrevioPdfPageExtract[]
}

export type ParsedTurnover = {
    departureTime?: string
    arrivalTime?: string
    departureGuestName?: string
    arrivalGuestName?: string
    guestLabel?: string
    guestCount?: number
    box?: string
    departureNotes: string[]
    arrivalNotes: string[]
    generalNotes: string[]
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
        departureGuestName?: string
        arrivalGuestName?: string
        departureNotesLabel: string
        arrivalNotesLabel: string
        generalNotesLabel: string
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

export async function extractTextFromPdfFile(file: File): Promise<PrevioPdfExtract> {
    const [{ getDocument, GlobalWorkerOptions }, workerModule] = await Promise.all([
        import('pdfjs-dist/legacy/build/pdf.mjs'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    ])

    GlobalWorkerOptions.workerSrc = workerModule.default

    const data = await file.arrayBuffer()
    const loadingTask = getDocument({ data })
    const pdf = await loadingTask.promise

    const pageTexts: string[] = []
    const pages: PrevioPdfPageExtract[] = []
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i)
        const text = await page.getTextContent()
        const rawItems: PrevioPdfTextItem[] = text.items
            .map((item: any) => ({
                text: typeof item?.str === 'string' ? item.str.trim() : '',
                x: Array.isArray(item?.transform) ? Number(item.transform[4]) : 0,
                y: Array.isArray(item?.transform) ? Number(item.transform[5]) : 0,
                page: i
            }))
            .filter((item) => item.text)

        const rows = new Map<number, Array<{ str: string; x: number }>>()
        rawItems.forEach((item) => {
            const yBucket = Math.round(item.y)
            if (!rows.has(yBucket)) rows.set(yBucket, [])
            rows.get(yBucket)?.push({ str: item.text, x: item.x })
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

export function parsePrevioPdfText(source: string | PrevioPdfExtract, referenceDate = new Date()): PrevioParseResult {
    const rawText = typeof source === 'string' ? source : source.rawText
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
        if (!exact) return undefined
        const room = normalizeRoomNumber(exact[1])
        return KNOWN_ROOM_NUMBERS.has(room) ? room : undefined
    }

    function detectRoomToken(line: string) {
        const collapsed = line.replace(/\s+/g, ' ').trim()
        const start = collapsed.match(/^(\d{3})(?:\s+studio)?\b/i)
        if (start) {
            const room = normalizeRoomNumber(start[1])
            if (KNOWN_ROOM_NUMBERS.has(room)) return room
        }

        const matches = collapsed.matchAll(/\b(\d{3})\b/g)
        for (const match of matches) {
            const room = normalizeRoomNumber(match[1])
            if (KNOWN_ROOM_NUMBERS.has(room)) return room
        }

        return undefined
    }

    function isCapacityLine(line: string) {
        return /^\[\s*\d{1,2}\s*\+\s*\d{1,2}\s*\]$/.test(line.trim())
    }

    function isDateSpanLine(line: string) {
        return /^\d{1,2}\.\s*\d{1,2}\.\s+\d{1,2}\.\s*\d{1,2}\.$/.test(line.trim())
    }

    function isNoteLine(line: string) {
        const normalized = normalizeForMatch(line)
        return normalized.includes('recepce') || /\bbox\b/i.test(line) || /\bb\s*ox\b/i.test(line)
    }

    function isAlfredWindow(line: string) {
        return /\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*-\s*([01]?\d|2[0-3])[:.]([0-5]\d)\b/i.test(line) && /alfred/i.test(line)
    }

    function isMostlyGuestLine(line: string) {
        const trimmed = line.trim()
        if (!trimmed) return false
        if (detectRoomToken(trimmed)) return false
        if (isCapacityLine(trimmed) || /\[\s*\d{1,2}\s*\+\s*\d{1,2}\s*\]/.test(trimmed)) return false
        if (isDateSpanLine(trimmed) || /\d{1,2}\.\s*\d{1,2}\./.test(trimmed)) return false
        if (isNoteLine(trimmed)) return false
        if (isAlfredWindow(trimmed)) return false
        if (/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/.test(trimmed)) return false
        return /[A-Za-zÀ-ž]/.test(trimmed)
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

    function assignNotesBySide(
        noteGroups: string[],
        departureTime?: string,
        arrivalTime?: string
    ) {
        const departureNotes: string[] = []
        const arrivalNotes: string[] = []
        const generalNotes: string[] = []
        const sideWarnings: string[] = []

        if (noteGroups.length === 0) {
            return { departureNotes, arrivalNotes, generalNotes, sideWarnings }
        }

        if (departureTime && arrivalTime) {
            if (noteGroups[0]) departureNotes.push(noteGroups[0])
            if (noteGroups[1]) arrivalNotes.push(noteGroups[1])
            if (noteGroups.length > 2) {
                generalNotes.push(...noteGroups.slice(2))
                sideWarnings.push('Více než dvě poznámkové skupiny v bloku, zbytek přesunut do obecných poznámek')
            }
            return { departureNotes, arrivalNotes, generalNotes, sideWarnings }
        }

        if (arrivalTime && !departureTime) {
            if (noteGroups.length === 1) {
                arrivalNotes.push(noteGroups[0])
            } else {
                arrivalNotes.push(noteGroups[0])
                generalNotes.push(...noteGroups.slice(1))
                sideWarnings.push('Pouze příjezdový čas, více skupin poznámek - další skupiny přesunuty do obecných poznámek')
            }
            return { departureNotes, arrivalNotes, generalNotes, sideWarnings }
        }

        if (departureTime && !arrivalTime) {
            if (noteGroups.length === 1) {
                departureNotes.push(noteGroups[0])
            } else {
                departureNotes.push(noteGroups[0])
                generalNotes.push(...noteGroups.slice(1))
                sideWarnings.push('Pouze odjezdový čas, více skupin poznámek - další skupiny přesunuty do obecných poznámek')
            }
            return { departureNotes, arrivalNotes, generalNotes, sideWarnings }
        }

        generalNotes.push(...noteGroups)
        sideWarnings.push('Nelze jednoznačně přiřadit poznámky k odjezdu/příjezdu')
        return { departureNotes, arrivalNotes, generalNotes, sideWarnings }
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

    function extractNameCandidates(blockLines: string[]) {
        const candidates: string[] = []

        function pushCandidate(value: string) {
            const normalized = normalizeForMatch(value)
            if (!normalized || candidates.some((item) => normalizeForMatch(item) === normalized)) return
            candidates.push(value)
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
                .replace(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g, ' ')
                .replace(/\[\s*\d{1,2}\s*\+\s*\d{1,2}\s*\]/g, ' ')
                .replace(/[()]/g, ' ')
                .replace(/\b(?:recepce|box|alfred|studio)\b/gi, ' ')
                .replace(/\s+/g, ' ')
                .trim()

            if (!cleaned || !/[A-Za-zÀ-ž]/.test(cleaned)) return

            const pairMatches = [...cleaned.matchAll(/\b([A-ZÀ-Ž][A-Za-zÀ-ž'’-]+\s+[A-ZÀ-Ž][A-Za-zÀ-ž'’-]+)\b/g)]
                .map((match) => match[1].trim())
            if (pairMatches.length > 0) {
                pairMatches.forEach(pushCandidate)
                return
            }

            const tokens = cleaned
                .split(' ')
                .map((token) => token.trim())
                .filter(Boolean)

            for (let i = 0; i + 1 < tokens.length; i++) {
                const first = tokens[i]
                const second = tokens[i + 1]
                if (/^[A-ZÀ-Ž][A-Za-zÀ-ž'’-]+$/.test(first) && /^[A-ZÀ-Ž][A-Za-zÀ-ž'’-]+$/.test(second)) {
                    pushCandidate(`${first} ${second}`)
                }
            }
        })

        return candidates
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
        const blockStarts = contentLines
            .map((line, index) => ({ index, isNote: isNoteLine(line) }))
            .filter((entry) => entry.isNote)
            .map((entry) => entry.index)

        if (blockStarts.length === 0) {
            warnings.push(`Strana ${pageIndex + 1}: nenašel jsem žádné poznámkové bloky pokojů.`)
            return
        }

        function roomFromBlock(lines: string[]) {
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

            const previousRoom = blockIndex > 0
                ? roomFromBlock(contentLines.slice(blockStarts[blockIndex - 1], startIndex))?.room
                : undefined
            const nextRoom = blockIndex + 1 < blockStarts.length
                ? roomFromBlock(contentLines.slice(blockStarts[blockIndex + 1], blockIndex + 2 < blockStarts.length ? blockStarts[blockIndex + 2] : contentLines.length))?.room
                : undefined

            const markerInBlock = roomInfo.markerOffset
            const beforeMarker = markerInBlock >= 0 ? blockLines.slice(0, markerInBlock) : blockLines
            const afterMarker = markerInBlock >= 0 ? blockLines.slice(markerInBlock + 1) : []
            const rawBlock = blockLines.join('\n')

            const timeSource = blockLines.filter((line) => !isAlfredWindow(line)).join('\n')
            const detectedTimes = detectTimes(timeSource)
            let { departureTime, arrivalTime } = chooseTimes(detectedTimes)

            const noteLineSource = beforeMarker.filter((line) => isNoteLine(line)).join(' ')
            const noteGroups = splitNoteGroups(noteLineSource || beforeMarker.join(' '))

            if (departureTime && arrivalTime && noteGroups.length === 1) {
                arrivalTime = undefined
            }

            const {
                departureNotes,
                arrivalNotes,
                generalNotes,
                sideWarnings
            } = assignNotesBySide(noteGroups, departureTime, arrivalTime)

            const noteKeywordMatches = keywordNotes(normalizeForMatch(rawBlock))
            const allGeneralNotes = Array.from(new Set([...generalNotes, ...noteKeywordMatches]))
            const guestCandidates = extractNameCandidates(blockLines)
            let departureGuestName: string | undefined
            let arrivalGuestName: string | undefined
            if (departureTime && arrivalTime) {
                departureGuestName = guestCandidates[0]
                arrivalGuestName = guestCandidates[1] || guestCandidates[0]
            } else if (departureTime) {
                departureGuestName = guestCandidates[0]
            } else if (arrivalTime) {
                arrivalGuestName = guestCandidates[0]
            } else {
                departureGuestName = guestCandidates[0]
                arrivalGuestName = guestCandidates[1]
            }

            const departureGuestLabel = departureGuestName
            const arrivalGuestLabel = arrivalGuestName
            const guestCount = extractGuestCount(rawBlock)
            const box = arrivalTime ? extractBox(arrivalNotes.join(' ') || rawBlock) : undefined
            const contextDates = extractDateTokens(afterMarker.join(' '))

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
            if (departureTime && !arrivalTime && detectedTimes.length > 1) {
                blockWarnings.push('Více časů v bloku bez druhé poznámkové skupiny - zachován pouze odjezd')
            }
            blockWarnings.push(...sideWarnings)

            const operationalDate = pageDate
                ? formatLocalDate(pageDate)
                : formatLocalDate(new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate() + pageIndex))

            rows.push({
                dateIso: operationalDate,
                roomNumber: roomInfo.room,
                departureTime,
                arrivalTime,
                departureGuestName,
                arrivalGuestName,
                guestLabel: arrivalGuestLabel || departureGuestLabel,
                guestCount,
                box,
                departureNotes,
                arrivalNotes,
                generalNotes: allGeneralNotes,
                warnings: blockWarnings
            })

            if (blockWarnings.length > 0) {
                warnings.push(`Blok ${blockIndex + 1} (pokoj ${roomInfo.room}): ${blockWarnings.join(', ')}`)
            }

            lineDebug.push({
                index: lineDebug.length + 1,
                page: pageIndex + 1,
                pageDate: pageDate ? formatLocalDate(pageDate) : undefined,
                room: roomInfo.room,
                previousRoom,
                nextRoom,
                blockStartLine: startIndex + 1,
                blockEndLine: endIndex + 1,
                yStart: startIndex + 1,
                yEnd: endIndex + 1,
                rawBlock,
                roomColumnText: blockLines[markerInBlock] || roomInfo.room,
                departureColumnText: departureGuestLabel || '',
                arrivalColumnText: arrivalGuestLabel || '',
                departureNoteColumnText: departureNotes.join(', '),
                arrivalNoteColumnText: arrivalNotes.join(', '),
                detectedTimes,
                noteGroups,
                departureTime,
                arrivalTime,
                departureGuestLabel,
                arrivalGuestLabel,
                departureNotes,
                arrivalNotes,
                generalNotes: allGeneralNotes,
                warnings: blockWarnings
            })
        })
    })

    if (DEV) {
        // Regression reference for uploaded 16.6-18.6 sample PDF (room 103 boundaries).
        // Expected:
        // 16.6 room 103 => departure empty, arrival 14:00, arrival notes include BOX 5
        // 17.6 room 103 => departure 11:00 (BOX 5), arrival 21:30 (BOX 8)
        const normalizedRaw = normalizeForMatch(rawText)
        const looksLikeRegressionSample = normalizedRaw.includes('anna trankell') || normalizedRaw.includes('ole jorling')
        if (looksLikeRegressionSample) {
            const room103Rows = rows.filter((row) => row.roomNumber === '103')
            console.info('[PrevioParser] room 103 regression snapshot', room103Rows)
        }
    }

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
    const tooFewRows = parsed.rows.length < 25
    const tooManyWithoutTimes = parsed.rows.length > 0 ? (rowsWithoutTimes / parsed.rows.length) > 0.3 : true
    const confidenceLow = tooFewRows || tooManyWithoutTimes

    if (tooFewRows) {
        warnings.push('Import není bezpečný – parser našel málo pokojů.')
    }

    const activeRooms = roomCatalog
        .filter((room) => room.active)
        .sort((a, b) => a.sortOrder - b.sortOrder)

    const activeSet = new Set(activeRooms.map((room) => normalizeRoomKey(room.roomNumber)))
    const unknownRooms = Array.from(
        new Set(
            parsed.rows
                .map((row) => normalizeRoomKey(row.roomNumber))
                .filter((room) => !activeSet.has(room))
        )
    )

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

        const normalizedRoom = normalizeRoomKey(row.roomNumber)
        const prev = byTab[tab].get(normalizedRoom) || {
            departureGuestName: undefined,
            arrivalGuestName: undefined,
            departureNotes: [],
            arrivalNotes: [],
            generalNotes: []
        }
        byTab[tab].set(normalizedRoom, {
            departureTime: row.departureTime || prev.departureTime,
            arrivalTime: row.arrivalTime || prev.arrivalTime,
            departureGuestName: row.departureGuestName || prev.departureGuestName,
            arrivalGuestName: row.arrivalGuestName || prev.arrivalGuestName,
            guestLabel: row.guestLabel || prev.guestLabel,
            guestCount: row.guestCount ?? prev.guestCount,
            box: row.box || prev.box,
            departureNotes: Array.from(new Set([...(prev.departureNotes || []), ...row.departureNotes])),
            arrivalNotes: Array.from(new Set([...(prev.arrivalNotes || []), ...row.arrivalNotes])),
            generalNotes: Array.from(new Set([...(prev.generalNotes || []), ...row.generalNotes]))
        })
    })

    const noTurnoverRooms: string[] = []
        ; (['Dnes', 'Zitra', 'Pozitri'] as OpsTab[]).forEach((tab) => {
            activeRooms.forEach((room) => {
                const row = byTab[tab].get(normalizeRoomKey(room.roomNumber))
                if (!row || (!row.arrivalTime && !row.departureTime)) {
                    noTurnoverRooms.push(`${tab}: ${normalizeRoomKey(room.roomNumber)}`)
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
                    departureGuestName: row.departureGuestName,
                    arrivalGuestName: row.arrivalGuestName,
                    departureNotesLabel: row.departureNotes.join(', '),
                    arrivalNotesLabel: row.arrivalNotes.join(', '),
                    generalNotesLabel: row.generalNotes.join(', ')
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
