import fs from 'node:fs/promises'
import path from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const PDF_PAGE_BREAK = '[[[PREVIO_PAGE_BREAK]]]'
const MASTER_ROOM_NUMBERS = [
    '001', '101', '102', '103', '104', '105', '201', '202', '203', '204', '205', '301', '302', '303', '304', '305'
]
const MASTER_ROOM_SET = new Set(MASTER_ROOM_NUMBERS)

const root = process.cwd()
const pdfPath = path.join(root, 'private-sources/previo/previo-state-2026-06-16-20.pdf')

function normalizeForMatch(value) {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
}

function normalizeRoomNumber(raw) {
    return raw.trim().replace(/^0+/, '').padStart(3, '0')
}

function normalizeRoomKey(raw) {
    const match = raw.match(/\b(\d{3})\b/)
    if (match) return normalizeRoomNumber(match[1])

    const compactDigits = raw.replace(/\D/g, '')
    if (compactDigits.length >= 3) return normalizeRoomNumber(compactDigits.slice(-3))
    return raw.trim()
}

function normalizeTime(raw) {
    const normalized = raw.replace('.', ':')
    const [h, m] = normalized.split(':')
    if (!h || !m) return raw
    return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
}

function toMinutes(hhmm) {
    const [h, m] = hhmm.split(':').map(Number)
    return h * 60 + m
}

function formatLocalDate(date) {
    const y = date.getFullYear()
    const m = `${date.getMonth() + 1}`.padStart(2, '0')
    const d = `${date.getDate()}`.padStart(2, '0')
    return `${y}-${m}-${d}`
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
    const match = token.match(/\b(\d{1,2})\.\s*(\d{1,2})\.?\b/)
    if (!match) return null
    const day = Number(match[1])
    const month = Number(match[2])
    const date = new Date(fallbackYear, month - 1, day)
    return Number.isNaN(date.getTime()) ? null : date
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

function normalizeBoxText(text) {
    let normalized = text
        .replace(/\bB\s*OX\b/gi, 'BOX')
        .replace(/\bbox\b/gi, 'BOX')
        .replace(/\s+/g, ' ')
        .trim()

    normalized = normalized.replace(/Recepce\s*:\s*BOX/gi, 'Recepce: BOX')
    normalized = normalized.replace(/\bBOX\s*([a-z0-9-]+)/gi, (_, value) => `BOX ${value.toUpperCase()}`)

    return normalized
}

function splitNoteGroups(rawText) {
    return rawText
        .split(/\.\.\.+|…+/)
        .map((part) => normalizeBoxText(part))
        .map((part) => part.trim())
        .filter(Boolean)
}

function isNoteLine(line) {
    const normalized = normalizeForMatch(line)
    return normalized.includes('recepce') || /\bbox\b/i.test(line) || /\bb\s*ox\b/i.test(line)
}

function isCapacityLine(line) {
    return /^\[\s*\d{1,2}\s*\+\s*\d{1,2}\s*\]$/.test(line.trim())
}

function isAlfredWindow(line) {
    return /\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*-\s*([01]?\d|2[0-3])[:.]([0-5]\d)\b/i.test(line) && /alfred/i.test(line)
}

function stripAlfredWindowSegments(line) {
    return line
        .replace(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*-\s*([01]?\d|2[0-3])[:.]([0-5]\d)\s*\(alfred\)/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function detectRoomToken(line) {
    const collapsed = line.replace(/\s+/g, ' ').trim()
    const start = collapsed.match(/^(\d{3})(?:\s+studio)?\b/i)
    if (start) {
        const room = normalizeRoomNumber(start[1])
        if (MASTER_ROOM_SET.has(room)) return room
    }

    return undefined
}

function detectTimes(blockText) {
    const detected = []
    const matches = blockText.matchAll(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g)
    for (const match of matches) {
        detected.push(normalizeTime(`${match[1]}:${match[2]}`))
    }
    return detected
}

function detectTimedEntries(blockText) {
    const entries = []
    const source = String(blockText || '')
    const matches = source.matchAll(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g)

    for (const match of matches) {
        const index = typeof match.index === 'number' ? match.index : 0
        const prefix = source.slice(Math.max(0, index - 16), index)
        const countMatch = prefix.match(/\((\d{1,2})\)\s*$/)

        entries.push({
            time: normalizeTime(`${match[1]}:${match[2]}`),
            guestCount: countMatch ? Number(countMatch[1]) : undefined,
            index
        })
    }

    return entries
}

function chooseTimes(detectedTimes, noteGroupsCount) {
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

function assignNotesBySide(noteGroups, departureTime, arrivalTime) {
    const departureNotes = []
    const arrivalNotes = []

    if (noteGroups.length === 0) return { departureNotes, arrivalNotes }

    if (departureTime && arrivalTime) {
        if (noteGroups[0]) departureNotes.push(noteGroups[0])
        if (noteGroups[1]) arrivalNotes.push(noteGroups[1])
        return { departureNotes, arrivalNotes }
    }

    if (departureTime) {
        departureNotes.push(noteGroups[0])
        return { departureNotes, arrivalNotes }
    }

    if (arrivalTime) {
        arrivalNotes.push(noteGroups[0])
        return { departureNotes, arrivalNotes }
    }

    departureNotes.push(noteGroups[0])
    return { departureNotes, arrivalNotes }
}

function extractNameCandidates(blockLines) {
    const candidates = []

    function pushCandidate(value) {
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

        const tokens = cleaned.split(' ').map((token) => token.trim()).filter(Boolean)
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

function extractDateTokens(text) {
    const tokens = new Set()
    const matches = text.matchAll(/\b(\d{1,2})\.\s*(\d{1,2})\.?\b/g)
    for (const match of matches) {
        tokens.add(`${Number(match[1])}. ${Number(match[2])}.`)
    }
    return Array.from(tokens)
}

async function extractRawTextFromPdf(pdfFilePath) {
    const data = new Uint8Array(await fs.readFile(pdfFilePath))
    const loadingTask = getDocument({ data, disableWorker: true })
    const pdf = await loadingTask.promise

    const pageTexts = []
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i)
        const text = await page.getTextContent()

        const rawItems = text.items
            .map((item) => ({
                text: typeof item?.str === 'string' ? item.str.trim() : '',
                x: Array.isArray(item?.transform) ? Number(item.transform[4]) : 0,
                y: Array.isArray(item?.transform) ? Number(item.transform[5]) : 0
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
    }

    return pageTexts.join(`\n${PDF_PAGE_BREAK}\n`)
}

function parseRawState(rawText) {
    const rows = []
    const warnings = []
    const completeDates = new Set()
    const days = new Map()

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
            warnings.push(`Page ${pageIndex + 1}: missing date header`)
            return
        }

        const dateIso = formatLocalDate(pageDate)
        if (!days.has(dateIso)) days.set(dateIso, { rows: [], complete: false })

        const totalsLine = pageLines.find((line) => parseTotalsLine(line) !== null)
        if (totalsLine) {
            completeDates.add(dateIso)
            days.get(dateIso).complete = true
        }

        const contentLines = pageLines.filter((line) => !shouldIgnoreLine(line) && parsePageDateHeader(line) === null)
        const blockStarts = contentLines
            .map((line, index) => ({ index, isNote: isNoteLine(line) }))
            .filter((entry) => entry.isNote)
            .map((entry) => entry.index)

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
            if (!roomInfo) return

            const markerInBlock = roomInfo.markerOffset
            const beforeMarker = markerInBlock >= 0 ? blockLines.slice(0, markerInBlock) : blockLines
            const afterMarker = markerInBlock >= 0 ? blockLines.slice(markerInBlock + 1) : []

            const noteLineSource = beforeMarker.filter((line) => isNoteLine(line)).join(' ')
            const noteGroups = splitNoteGroups(noteLineSource || beforeMarker.join(' '))
            const timeSource = blockLines.map((line) => stripAlfredWindowSegments(line)).filter(Boolean).join('\n')
            const timedEntries = detectTimedEntries(timeSource)
            const detectedTimes = detectTimes(timeSource)
            const { departureTime, arrivalTime } = chooseTimes(detectedTimes, noteGroups.length)
            const { departureGuestCount, arrivalGuestCount } = chooseGuestCounts(timedEntries, departureTime, arrivalTime, noteGroups.length)

            const { departureNotes, arrivalNotes } = assignNotesBySide(noteGroups, departureTime, arrivalTime)
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

            const dateTokens = extractDateTokens(afterMarker.join(' '))
            const parsedDates = dateTokens
                .map((token) => parseDateToken(token, pageDate.getFullYear()))
                .filter((v) => v)
                .sort((a, b) => a.getTime() - b.getTime())

            const stayoverUntil = parsedDates.length ? formatLocalDate(parsedDates[parsedDates.length - 1]) : undefined

            const row = {
                dateIso,
                roomNumber: roomInfo.room,
                departureTime,
                arrivalTime,
                departureGuestCount,
                arrivalGuestCount,
                departureGuestName,
                arrivalGuestName,
                stayoverGuestName,
                stayoverUntil,
                departureNotes,
                arrivalNotes,
                isStayover: !departureTime && !arrivalTime
            }

            rows.push(row)
            days.get(dateIso).rows.push(row)
        })
    })

    const dedupRows = []
    const perDayRoom = new Map()
    rows.forEach((row) => {
        const key = `${row.dateIso}|${normalizeRoomKey(row.roomNumber)}`
        const prev = perDayRoom.get(key)
        if (!prev) {
            perDayRoom.set(key, row)
            return
        }
        const prevScore = Number(Boolean(prev.departureTime)) + Number(Boolean(prev.arrivalTime))
        const nextScore = Number(Boolean(row.departureTime)) + Number(Boolean(row.arrivalTime))
        if (nextScore >= prevScore) {
            perDayRoom.set(key, row)
        }
    })
    dedupRows.push(...perDayRoom.values())

    dedupRows.sort((a, b) => {
        if (a.dateIso !== b.dateIso) return a.dateIso.localeCompare(b.dateIso)
        return normalizeRoomKey(a.roomNumber).localeCompare(normalizeRoomKey(b.roomNumber))
    })

    const lastKnownGuestByRoom = new Map()
    dedupRows.forEach((row) => {
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

    const daySummaries = Array.from(days.entries()).map(([dateIso, value]) => {
        const dayRows = dedupRows.filter((r) => r.dateIso === dateIso)
        const presentRooms = Array.from(new Set(dayRows.map((r) => normalizeRoomKey(r.roomNumber)))).sort()
        const complete = value.complete
        const derivedFreeRooms = complete ? MASTER_ROOM_NUMBERS.filter((room) => !presentRooms.includes(room)) : []
        return {
            dateIso,
            rows: dayRows,
            presentRooms,
            complete,
            derivedFreeRooms,
            turnoverCount: dayRows.filter((r) => r.departureTime || r.arrivalTime).length,
            stayoverCount: dayRows.filter((r) => r.isStayover).length
        }
    }).sort((a, b) => a.dateIso.localeCompare(b.dateIso))

    return {
        rows: dedupRows,
        warnings,
        completeDates: Array.from(completeDates).sort(),
        daySummaries
    }
}

function noteContains(notes, token) {
    const nToken = normalizeForMatch(token)
    return notes.some((note) => normalizeForMatch(note).includes(nToken))
}

function guestContains(guest, token) {
    return Boolean(guest && normalizeForMatch(guest).includes(normalizeForMatch(token)))
}

function assertRow(rows, failures, dateIso, roomNumber) {
    const row = rows.find((item) => item.dateIso === dateIso && normalizeRoomKey(item.roomNumber) === roomNumber)
    if (!row) {
        failures.push(`Missing row ${dateIso}/${roomNumber}`)
        return null
    }
    return row
}

function expectEqual(failures, label, actual, expected) {
    if ((actual || '') !== (expected || '')) {
        failures.push(`${label}: expected "${expected}", got "${actual || ''}"`)
    }
}

function expectNoteContains(failures, label, notes, token) {
    if (!noteContains(notes, token)) {
        failures.push(`${label}: expected note containing "${token}"`)
    }
}

function expectGuestContains(failures, label, guest, token) {
    if (!guestContains(guest, token)) {
        failures.push(`${label}: expected guest containing "${token}", got "${guest || ''}"`)
    }
}

function expectNumber(failures, label, actual, expected) {
    if (actual !== expected) {
        failures.push(`${label}: expected ${expected}, got ${typeof actual === 'number' ? actual : 'undefined'}`)
    }
}

function printRows(rows) {
    const sorted = [...rows].sort((a, b) => {
        if (a.dateIso !== b.dateIso) return a.dateIso.localeCompare(b.dateIso)
        return normalizeRoomKey(a.roomNumber).localeCompare(normalizeRoomKey(b.roomNumber))
    })

    const header = 'date       | room | status    | dep   | arr   | depGuest            | arrGuest            | depNotes                       | arrNotes'
    console.log(header)
    console.log('-'.repeat(header.length))

    sorted.forEach((row) => {
        const dep = (row.departureTime || '').padEnd(5, ' ')
        const arr = (row.arrivalTime || '').padEnd(5, ' ')
        const status = (row.isStayover ? 'stayover' : 'turnover').padEnd(9, ' ')
        const depGuest = (row.departureGuestName || row.stayoverGuestName || '').slice(0, 18).padEnd(18, ' ')
        const arrGuest = (row.arrivalGuestName || '').slice(0, 18).padEnd(18, ' ')
        const depNotes = row.departureNotes.join(' ; ').slice(0, 30).padEnd(30, ' ')
        const arrNotes = row.arrivalNotes.join(' ; ').slice(0, 30)

        console.log(`${row.dateIso} | ${normalizeRoomKey(row.roomNumber)} | ${status} | ${dep} | ${arr} | ${depGuest} | ${arrGuest} | ${depNotes} | ${arrNotes}`)
    })
}

function extractArrivalBoxFromNotes(notes) {
    if (!notes || notes.length === 0) return undefined
    const match = notes.join(' ').match(/\bbox\s*([a-z0-9-]+)/i)
    if (!match) return undefined
    return `BOX ${match[1].toUpperCase()}`
}

function buildMergedPlansForValidation(parsed) {
    const staleSeedByDate = {
        '2026-06-16': {
            '305': {
                id: 'r305',
                number: '305',
                situation: 'prijezd',
                status: 'odhad',
                arrival: { time: '14:00', guestLabel: 'Host L.', box: 'BOX Z', notes: ['dětská postýlka'] },
                arrivalTime: '14:00',
                box: 'BOX Z',
                notes: ['dětská postýlka'],
                estimatedReady: '12:30'
            }
        },
        '2026-06-17': {
            '301': {
                id: 'r301',
                number: '301',
                situation: 'odjezd',
                status: 'problem',
                departure: { time: '11:00', guestLabel: 'Host J.' },
                departureTime: '11:00'
            },
            '302': {
                id: 'r302',
                number: '302',
                situation: 'prijezd',
                status: 'ceka',
                arrival: { time: '20:00', guestLabel: 'Host K.', box: 'BOX X', notes: ['dětská postýlka'] },
                arrivalTime: '20:00',
                box: 'BOX X',
                notes: ['dětská postýlka']
            },
            '305': {
                id: 'r305',
                number: '305',
                situation: 'prijezd',
                status: 'ceka',
                arrival: { time: '14:00', guestLabel: 'Host L.', box: 'BOX Z', notes: ['dětská postýlka'] },
                arrivalTime: '14:00',
                box: 'BOX Z',
                notes: ['dětská postýlka']
            }
        }
    }

    const mergedByDate = {}

    parsed.daySummaries.forEach((day) => {
        const parsedByRoom = new Map(day.rows.map((row) => [normalizeRoomKey(row.roomNumber), row]))

        mergedByDate[day.dateIso] = MASTER_ROOM_NUMBERS.map((roomNumber) => {
            const stale = staleSeedByDate[day.dateIso]?.[roomNumber]
            const parsedRow = parsedByRoom.get(roomNumber)

            const next = {
                id: stale?.id || `r${roomNumber}`,
                number: stale?.number || roomNumber,
                roomNumber,
                situation: 'volny',
                status: 'neni',
                departure: undefined,
                arrival: undefined,
                departureTime: undefined,
                arrivalTime: undefined,
                nextArrivalPreview: undefined,
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
                stateImportedAt: 'validation-import',
                stayoverGuestName: undefined,
                stayoverUntil: undefined
            }

            if (!parsedRow) {
                next.freeConfirmed = Boolean(day.complete && day.derivedFreeRooms.includes(roomNumber))
                return next
            }

            const hasDeparture = Boolean(parsedRow.departureTime)
            const hasArrival = Boolean(parsedRow.arrivalTime)
            if (!hasDeparture && !hasArrival) {
                next.occupiedConfirmed = true
                next.stayoverGuestName = parsedRow.stayoverGuestName || parsedRow.departureGuestName || parsedRow.arrivalGuestName
                next.stayoverUntil = parsedRow.stayoverUntil
                return next
            }

            const departureNotes = parsedRow.departureNotes.length ? parsedRow.departureNotes : undefined
            const arrivalNotes = parsedRow.arrivalNotes.length ? parsedRow.arrivalNotes : undefined
            next.situation = hasDeparture && hasArrival ? 'odjezd_prijezd' : hasDeparture ? 'odjezd' : 'prijezd'
            next.status = 'ceka'
            next.departureTime = parsedRow.departureTime
            next.arrivalTime = parsedRow.arrivalTime
            next.departure = hasDeparture ? {
                time: parsedRow.departureTime,
                guestLabel: parsedRow.departureGuestName,
                guestCount: parsedRow.departureGuestCount,
                notes: departureNotes
            } : undefined
            next.arrival = hasArrival ? {
                time: parsedRow.arrivalTime,
                guestLabel: parsedRow.arrivalGuestName,
                guestCount: parsedRow.arrivalGuestCount,
                box: extractArrivalBoxFromNotes(arrivalNotes),
                notes: arrivalNotes
            } : undefined
            next.guestCount = parsedRow.arrivalGuestCount ?? parsedRow.departureGuestCount
            next.box = extractArrivalBoxFromNotes(arrivalNotes)
            return next
        })
    })

    return mergedByDate
}

function runGoldenChecks(parsed) {
    const failures = []

    if (MASTER_ROOM_NUMBERS.length !== 16) {
        failures.push(`Master room list length expected 16, got ${MASTER_ROOM_NUMBERS.length}`)
    }

    const day16 = parsed.daySummaries.find((d) => d.dateIso === '2026-06-16')
    const day17 = parsed.daySummaries.find((d) => d.dateIso === '2026-06-17')
    const day18 = parsed.daySummaries.find((d) => d.dateIso === '2026-06-18')
    const day19 = parsed.daySummaries.find((d) => d.dateIso === '2026-06-19')
    const day20 = parsed.daySummaries.find((d) => d.dateIso === '2026-06-20')

    if (parsed.daySummaries.length < 5) failures.push(`Expected at least 5 parsed days, got ${parsed.daySummaries.length}`)
    if (!day16 || day16.rows.length < 14) failures.push('16.6: expected multi-page day with >=14 parsed rooms')
    if (!day17 || day17.rows.length < 14) failures.push('17.6: expected multi-page day with >=14 parsed rooms')
    if (!day18 || day18.rows.length < 14) failures.push('18.6: expected multi-page day with >=14 parsed rooms')
    if (!day19 || day19.rows.length < 14) failures.push('19.6: expected multi-page day with >=14 parsed rooms')

    const r16001 = assertRow(parsed.rows, failures, '2026-06-16', '001')
    if (r16001) {
        expectEqual(failures, '16.6/001 departure', r16001.departureTime, '11:00')
        expectEqual(failures, '16.6/001 arrival', r16001.arrivalTime, '17:00')
        expectGuestContains(failures, '16.6/001 dep guest', r16001.departureGuestName, 'Tomas Malukas')
        expectNumber(failures, '16.6/001 dep count', r16001.departureGuestCount, 4)
        expectGuestContains(failures, '16.6/001 arr guest', r16001.arrivalGuestName, 'Markéta Šách')
        expectNumber(failures, '16.6/001 arr count', r16001.arrivalGuestCount, 4)
        expectNoteContains(failures, '16.6/001 dep notes', r16001.departureNotes, 'BOX 10')
        expectNoteContains(failures, '16.6/001 arr notes', r16001.arrivalNotes, 'BOX 4')
    }

    const r16103 = assertRow(parsed.rows, failures, '2026-06-16', '103')
    if (r16103) {
        expectEqual(failures, '16.6/103 departure', r16103.departureTime, '')
        expectEqual(failures, '16.6/103 arrival', r16103.arrivalTime, '14:00')
        expectGuestContains(failures, '16.6/103 arr guest', r16103.arrivalGuestName, 'Anna Trankell')
        expectNoteContains(failures, '16.6/103 arr notes', r16103.arrivalNotes, 'BOX 5')
    }

    const r16201 = assertRow(parsed.rows, failures, '2026-06-16', '201')
    if (r16201) {
        expectEqual(failures, '16.6/201 departure', r16201.departureTime, '11:00')
        expectEqual(failures, '16.6/201 arrival', r16201.arrivalTime, '11:00')
        expectGuestContains(failures, '16.6/201 dep guest', r16201.departureGuestName, 'Leon Hergt')
        expectGuestContains(failures, '16.6/201 arr guest', r16201.arrivalGuestName, 'Marek Witkowski')
        expectNoteContains(failures, '16.6/201 dep notes', r16201.departureNotes, 'BOX 2')
        expectNoteContains(failures, '16.6/201 arr notes', r16201.arrivalNotes, 'BOX 3')
    }

    const r16301 = assertRow(parsed.rows, failures, '2026-06-16', '301')
    if (r16301) {
        expectEqual(failures, '16.6/301 departure', r16301.departureTime, '11:00')
        expectEqual(failures, '16.6/301 arrival', r16301.arrivalTime, '14:30')
        expectNoteContains(failures, '16.6/301 dep notes', r16301.departureNotes, 'BOX 2')
        expectNoteContains(failures, '16.6/301 arr notes', r16301.arrivalNotes, 'BOX 1')
    }

    const r17103 = assertRow(parsed.rows, failures, '2026-06-17', '103')
    if (r17103) {
        expectEqual(failures, '17.6/103 departure', r17103.departureTime, '11:00')
        expectEqual(failures, '17.6/103 arrival', r17103.arrivalTime, '21:30')
        expectGuestContains(failures, '17.6/103 dep guest', r17103.departureGuestName, 'Anna Trankell')
        expectGuestContains(failures, '17.6/103 arr guest', r17103.arrivalGuestName, 'Ole Jorling')
        expectNumber(failures, '17.6/103 arr count', r17103.arrivalGuestCount, 4)
        expectNoteContains(failures, '17.6/103 dep notes', r17103.departureNotes, 'BOX 5')
        expectNoteContains(failures, '17.6/103 arr notes', r17103.arrivalNotes, 'BOX 8')
    }

    const r17001 = assertRow(parsed.rows, failures, '2026-06-17', '001')
    if (r17001) {
        expectGuestContains(failures, '17.6/001 arr guest', r17001.arrivalGuestName, 'Estreicher Nesya')
        expectNumber(failures, '17.6/001 arr count', r17001.arrivalGuestCount, 4)
    }

    const r18203 = assertRow(parsed.rows, failures, '2026-06-18', '203')
    if (r18203) {
        expectEqual(failures, '18.6/203 departure', r18203.departureTime, '11:00')
        expectEqual(failures, '18.6/203 arrival', r18203.arrivalTime, '14:00')
        expectGuestContains(failures, '18.6/203 dep guest', r18203.departureGuestName, 'Nona Abada')
        expectGuestContains(failures, '18.6/203 arr guest', r18203.arrivalGuestName, 'Lucie Flanderkov')
        expectNoteContains(failures, '18.6/203 dep notes', r18203.departureNotes, 'BOX 3')
        expectNoteContains(failures, '18.6/203 arr notes', r18203.arrivalNotes, 'BOX 6')
    }

    const r17301 = assertRow(parsed.rows, failures, '2026-06-17', '301')
    if (r17301) {
        if (!r17301.isStayover) failures.push('17.6/301 expected stayover row')
        expectEqual(failures, '17.6/301 departure', r17301.departureTime, '')
        expectEqual(failures, '17.6/301 arrival', r17301.arrivalTime, '')
    }

    const mergedByDate = buildMergedPlansForValidation(parsed)
    const mergedRow = (dateIso, roomNumber) => {
        const dayRows = mergedByDate[dateIso] || []
        return dayRows.find((row) => row.roomNumber === roomNumber)
    }

    const m16305 = mergedRow('2026-06-16', '305')
    if (!m16305) {
        failures.push('Merged plan missing 16.6/305')
    } else {
        expectEqual(failures, 'merged 16.6/305 departure', m16305.departureTime, '')
        expectEqual(failures, 'merged 16.6/305 arrival', m16305.arrivalTime, '')
        if (!m16305.occupiedConfirmed) failures.push('merged 16.6/305 expected occupiedConfirmed=true')
        expectGuestContains(failures, 'merged 16.6/305 stayover guest', m16305.stayoverGuestName, 'DANIEL')
        if (guestContains(m16305.arrival?.guestLabel, 'Host L') || guestContains(m16305.departure?.guestLabel, 'Host L') || guestContains(m16305.stayoverGuestName, 'Host L')) {
            failures.push('merged 16.6/305 still contains stale guest Host L')
        }
        if (normalizeForMatch(m16305.box || '').includes('box z')) {
            failures.push('merged 16.6/305 still contains stale BOX Z')
        }
    }

    const m17301 = mergedRow('2026-06-17', '301')
    if (!m17301) {
        failures.push('Merged plan missing 17.6/301')
    } else {
        expectEqual(failures, 'merged 17.6/301 departure', m17301.departureTime, '')
        expectEqual(failures, 'merged 17.6/301 arrival', m17301.arrivalTime, '')
        if (!m17301.occupiedConfirmed) failures.push('merged 17.6/301 expected occupiedConfirmed=true')
    }

    const m17302 = mergedRow('2026-06-17', '302')
    if (!m17302) {
        failures.push('Merged plan missing 17.6/302')
    } else {
        expectEqual(failures, 'merged 17.6/302 departure', m17302.departureTime, '')
        expectEqual(failures, 'merged 17.6/302 arrival', m17302.arrivalTime, '')
        if (!m17302.occupiedConfirmed) failures.push('merged 17.6/302 expected occupiedConfirmed=true')
        if (guestContains(m17302.arrival?.guestLabel, 'Host K') || guestContains(m17302.departure?.guestLabel, 'Host K') || guestContains(m17302.stayoverGuestName, 'Host K')) {
            failures.push('merged 17.6/302 still contains stale guest Host K')
        }
        if (normalizeForMatch(m17302.box || '').includes('box x')) {
            failures.push('merged 17.6/302 still contains stale BOX X')
        }
    }

    const m17305 = mergedRow('2026-06-17', '305')
    if (!m17305) {
        failures.push('Merged plan missing 17.6/305')
    } else {
        if (!m17305.occupiedConfirmed) failures.push('merged 17.6/305 expected occupiedConfirmed=true')
        if (guestContains(m17305.arrival?.guestLabel, 'Host L') || guestContains(m17305.departure?.guestLabel, 'Host L') || guestContains(m17305.stayoverGuestName, 'Host L')) {
            failures.push('merged 17.6/305 still contains stale guest Host L')
        }
        if (normalizeForMatch(m17305.box || '').includes('box z')) {
            failures.push('merged 17.6/305 still contains stale BOX Z')
        }
    }

    const m16201 = mergedRow('2026-06-16', '201')
    if (!m16201) {
        failures.push('Merged plan missing 16.6/201')
    } else {
        expectEqual(failures, 'merged 16.6/201 departure', m16201.departureTime, '11:00')
        expectEqual(failures, 'merged 16.6/201 arrival', m16201.arrivalTime, '11:00')
        expectGuestContains(failures, 'merged 16.6/201 dep guest', m16201.departure?.guestLabel, 'Leon Hergt')
        expectGuestContains(failures, 'merged 16.6/201 arr guest', m16201.arrival?.guestLabel, 'Marek Witkowski')
        expectNoteContains(failures, 'merged 16.6/201 dep notes', m16201.departure?.notes || [], 'BOX 2')
        expectNoteContains(failures, 'merged 16.6/201 arr notes', m16201.arrival?.notes || [], 'BOX 3')
    }

    const m16301 = mergedRow('2026-06-16', '301')
    if (!m16301) {
        failures.push('Merged plan missing 16.6/301')
    } else {
        expectEqual(failures, 'merged 16.6/301 departure', m16301.departureTime, '11:00')
        expectEqual(failures, 'merged 16.6/301 arrival', m16301.arrivalTime, '14:30')
        if (guestContains(m16301.departure?.guestLabel, 'Host J') || guestContains(m16301.arrival?.guestLabel, 'Host J') || guestContains(m16301.stayoverGuestName, 'Host J')) {
            failures.push('merged 16.6/301 still contains stale guest Host J')
        }
        expectNoteContains(failures, 'merged 16.6/301 dep notes', m16301.departure?.notes || [], 'BOX 2')
        expectNoteContains(failures, 'merged 16.6/301 arr notes', m16301.arrival?.notes || [], 'BOX 1')
    }

    const m16001 = mergedRow('2026-06-16', '001')
    if (!m16001) {
        failures.push('Merged plan missing 16.6/001')
    } else {
        expectEqual(failures, 'merged 16.6/001 departure', m16001.departureTime, '11:00')
        expectEqual(failures, 'merged 16.6/001 arrival', m16001.arrivalTime, '17:00')
        expectGuestContains(failures, 'merged 16.6/001 dep guest', m16001.departure?.guestLabel, 'Tomas Malukas')
        expectNumber(failures, 'merged 16.6/001 dep count', m16001.departure?.guestCount, 4)
        expectGuestContains(failures, 'merged 16.6/001 arr guest', m16001.arrival?.guestLabel, 'Markéta Šách')
        expectNumber(failures, 'merged 16.6/001 arr count', m16001.arrival?.guestCount, 4)
        expectNoteContains(failures, 'merged 16.6/001 dep notes', m16001.departure?.notes || [], 'BOX 10')
        expectNoteContains(failures, 'merged 16.6/001 arr notes', m16001.arrival?.notes || [], 'BOX 4')
    }

    const m17103 = mergedRow('2026-06-17', '103')
    if (!m17103) {
        failures.push('Merged plan missing 17.6/103')
    } else {
        expectEqual(failures, 'merged 17.6/103 departure', m17103.departureTime, '11:00')
        expectEqual(failures, 'merged 17.6/103 arrival', m17103.arrivalTime, '21:30')
        expectGuestContains(failures, 'merged 17.6/103 dep guest', m17103.departure?.guestLabel, 'Anna Trankell')
        expectGuestContains(failures, 'merged 17.6/103 arr guest', m17103.arrival?.guestLabel, 'Ole Jorling')
        expectNumber(failures, 'merged 17.6/103 arr count', m17103.arrival?.guestCount, 4)
    }

    const m17001 = mergedRow('2026-06-17', '001')
    if (!m17001) {
        failures.push('Merged plan missing 17.6/001')
    } else {
        expectGuestContains(failures, 'merged 17.6/001 arr guest', m17001.arrival?.guestLabel, 'Estreicher Nesya')
        expectNumber(failures, 'merged 17.6/001 arr count', m17001.arrival?.guestCount, 4)
    }

    if (!day20) {
        failures.push('20.6 day summary missing')
    } else {
        if (!day20.complete) {
            failures.push('20.6 should be marked complete before deriving free rooms')
        }
        if (!day20.derivedFreeRooms.includes('001')) failures.push('20.6 expected derived free room 001')
        if (!day20.derivedFreeRooms.includes('103')) failures.push('20.6 expected derived free room 103')
        if (day20.derivedFreeRooms.includes('301')) failures.push('20.6 room 301 is present and must not be derived free')

        const mergedDay20 = mergedByDate['2026-06-20'] || []
        const merged20001 = mergedDay20.find((row) => row.roomNumber === '001')
        const merged20103 = mergedDay20.find((row) => row.roomNumber === '103')
        const merged20301 = mergedDay20.find((row) => row.roomNumber === '301')

        if (day20.complete) {
            if (!merged20001?.freeConfirmed) failures.push('merged 20.6/001 expected freeConfirmed=true for complete day')
            if (!merged20103?.freeConfirmed) failures.push('merged 20.6/103 expected freeConfirmed=true for complete day')
            if (merged20301?.freeConfirmed) failures.push('merged 20.6/301 must not be freeConfirmed when room is present')

            const invalidFree = mergedDay20
                .filter((row) => row.freeConfirmed)
                .map((row) => row.roomNumber)
                .filter((roomNumber) => !day20.derivedFreeRooms.includes(roomNumber))
            if (invalidFree.length > 0) {
                failures.push(`merged 20.6 has freeConfirmed outside derived list: ${invalidFree.join(', ')}`)
            }
        } else if (mergedDay20.some((row) => row.freeConfirmed)) {
            failures.push('merged 20.6 should not set freeConfirmed when day is incomplete')
        }
    }

    return failures
}

async function main() {
    const rawText = await extractRawTextFromPdf(pdfPath)
    const parsed = parseRawState(rawText)
    printRows(parsed.rows)

    const failures = runGoldenChecks(parsed)
    if (failures.length > 0) {
        console.error('\nValidation FAILED:')
        failures.forEach((item) => console.error(`- ${item}`))
        process.exit(1)
        return
    }

    console.log('\nValidation OK: Stav parser golden checks passed.')
    console.log(`Rows: ${parsed.rows.length}, days: ${parsed.daySummaries.length}, complete days: ${parsed.completeDates.length}`)
}

main().catch((error) => {
    console.error('Validation script error:', error)
    process.exit(1)
})
