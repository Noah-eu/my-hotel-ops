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
    const match = line.match(/\b(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\s*-\s*(po|ut|út|st|ct|čt|pa|pá|so|ne)\b/i)
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
    const unique = new Set()
    const matches = blockText.matchAll(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g)
    for (const match of matches) {
        unique.add(normalizeTime(`${match[1]}:${match[2]}`))
    }
    return Array.from(unique).sort((a, b) => toMinutes(a) - toMinutes(b))
}

function chooseTimes(detectedTimes) {
    const departures = detectedTimes.filter((time) => toMinutes(time) <= 12 * 60)
    const arrivals = detectedTimes.filter((time) => toMinutes(time) >= 13 * 60)

    if (detectedTimes.length === 1) {
        const only = detectedTimes[0]
        if (toMinutes(only) <= 12 * 60) return { departureTime: only, arrivalTime: undefined }
        return { departureTime: undefined, arrivalTime: only }
    }

    return {
        departureTime: departures[0],
        arrivalTime: arrivals[0]
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

            const detectedTimes = detectTimes(blockLines.filter((line) => !isAlfredWindow(line)).join('\n'))
            let { departureTime, arrivalTime } = chooseTimes(detectedTimes)
            const noteLineSource = beforeMarker.filter((line) => isNoteLine(line)).join(' ')
            const noteGroups = splitNoteGroups(noteLineSource || beforeMarker.join(' '))
            if (departureTime && arrivalTime && noteGroups.length === 1) {
                arrivalTime = undefined
            }

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
                row.departureGuestName = row.arrivalGuestName
                row.arrivalGuestName = previousDeparture
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

function runGoldenChecks(parsed) {
    const failures = []

    if (MASTER_ROOM_NUMBERS.length !== 16) {
        failures.push(`Master room list length expected 16, got ${MASTER_ROOM_NUMBERS.length}`)
    }

    const day16 = parsed.daySummaries.find((d) => d.dateIso === '2026-06-16')
    const day17 = parsed.daySummaries.find((d) => d.dateIso === '2026-06-17')
    const day18 = parsed.daySummaries.find((d) => d.dateIso === '2026-06-18')
    const day20 = parsed.daySummaries.find((d) => d.dateIso === '2026-06-20')

    if (!day16 || day16.rows.length < 14) failures.push('16.6: expected multi-page day with >=14 parsed rooms')
    if (!day17 || day17.rows.length < 14) failures.push('17.6: expected multi-page day with >=14 parsed rooms')
    if (!day18 || day18.rows.length < 14) failures.push('18.6: expected multi-page day with >=14 parsed rooms')

    const r16001 = assertRow(parsed.rows, failures, '2026-06-16', '001')
    if (r16001) {
        expectEqual(failures, '16.6/001 departure', r16001.departureTime, '11:00')
        expectEqual(failures, '16.6/001 arrival', r16001.arrivalTime, '17:00')
        expectGuestContains(failures, '16.6/001 dep guest', r16001.departureGuestName, 'Tomas Malukas')
        expectGuestContains(failures, '16.6/001 arr guest', r16001.arrivalGuestName, 'Markéta Šách')
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

    const r17103 = assertRow(parsed.rows, failures, '2026-06-17', '103')
    if (r17103) {
        expectEqual(failures, '17.6/103 departure', r17103.departureTime, '11:00')
        expectEqual(failures, '17.6/103 arrival', r17103.arrivalTime, '21:30')
        expectGuestContains(failures, '17.6/103 dep guest', r17103.departureGuestName, 'Anna Trankell')
        expectGuestContains(failures, '17.6/103 arr guest', r17103.arrivalGuestName, 'Ole Jorling')
        expectNoteContains(failures, '17.6/103 dep notes', r17103.departureNotes, 'BOX 5')
        expectNoteContains(failures, '17.6/103 arr notes', r17103.arrivalNotes, 'BOX 8')
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

    if (!day20) {
        failures.push('20.6 day summary missing')
    } else {
        if (!day20.complete) {
            failures.push('20.6 should be marked complete before deriving free rooms')
        }
        if (!day20.derivedFreeRooms.includes('001')) failures.push('20.6 expected derived free room 001')
        if (!day20.derivedFreeRooms.includes('103')) failures.push('20.6 expected derived free room 103')
        if (day20.derivedFreeRooms.includes('301')) failures.push('20.6 room 301 is present and must not be derived free')
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
