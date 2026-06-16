const PDF_PAGE_BREAK = '[[[PREVIO_PAGE_BREAK]]]'

const MASTER_ROOM_NUMBERS = [
    '001', '101', '102', '103', '104', '105', '201', '202', '203', '204', '205', '301', '302', '303', '304', '305'
]

const MASTER_ROOM_SET = new Set(MASTER_ROOM_NUMBERS)

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

function toMinutes(hhmm) {
    const [h, m] = String(hhmm || '').split(':').map(Number)
    return h * 60 + m
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

function isNoteLine(line) {
    const normalized = normalizeForMatch(line)
    return normalized.includes('recepce') || /\bbox\b/i.test(line) || /\bb\s*ox\b/i.test(line)
}

function isCapacityLine(line) {
    return /^\[\s*\d{1,2}\s*\+\s*\d{1,2}\s*\]$/.test(String(line || '').trim())
}

function isAlfredWindow(line) {
    return /\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*-\s*([01]?\d|2[0-3])[:.]([0-5]\d)\b/i.test(line) && /alfred/i.test(line)
}

function stripAlfredWindowSegments(line) {
    return String(line || '')
        .replace(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*-\s*([01]?\d|2[0-3])[:.]([0-5]\d)\s*\(alfred\)/gi, ' ')
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
    const matches = String(blockText || '').matchAll(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g)
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

    function pushCandidate(value) {
        const normalized = normalizeForMatch(value)
        if (!normalized || candidates.some((item) => normalizeForMatch(item) === normalized)) return
        candidates.push(value)
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
    const matches = String(text || '').matchAll(/\b(\d{1,2})\.\s*(\d{1,2})\.?\b/g)
    for (const match of matches) {
        tokens.add(`${Number(match[1])}. ${Number(match[2])}.`)
    }
    return Array.from(tokens)
}

async function extractStateTextFromPdfBuffer(pdfBuffer) {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const data = new Uint8Array(pdfBuffer)
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

function parsePrevioStatePdfText(rawText, referenceDate = new Date()) {
    const allLines = String(rawText || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

    const warnings = []
    const rows = []
    const parsedDates = []
    const completeDates = new Set()
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

            const noteLineSource = beforeMarker.filter((line) => isNoteLine(line)).join(' ')
            const noteGroups = splitNoteGroups(noteLineSource || beforeMarker.join(' '))
            const timeSource = blockLines.map((line) => stripAlfredWindowSegments(line)).filter(Boolean).join('\n')
            const timedEntries = detectTimedEntries(timeSource)
            const detectedTimes = detectTimes(timeSource)
            const { departureTime, arrivalTime } = chooseTimes(detectedTimes, noteGroups.length)
            const { departureGuestCount, arrivalGuestCount } = chooseGuestCounts(timedEntries, departureTime, arrivalTime, noteGroups.length)

            const { departureNotes, arrivalNotes, sideWarnings } = assignNotesBySide(noteGroups, departureTime, arrivalTime)
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
            const stayoverUntil = (() => {
                if (dateTokens.length === 0) return undefined
                const parsed = dateTokens
                    .map((token) => parseDateToken(token, pageDate.getFullYear()))
                    .filter((dt) => dt !== null)
                    .sort((a, b) => a.getTime() - b.getTime())
                const last = parsed[parsed.length - 1]
                if (!last) return undefined
                return formatLocalDate(last)
            })()

            const blockWarnings = [...sideWarnings]
            if (!departureTime && !arrivalTime) {
                blockWarnings.push('Bez času odjezdu/příjezdu - označeno jako probíhající pobyt')
            }
            if (!MASTER_ROOM_SET.has(roomInfo.room)) {
                blockWarnings.push('Pokoj není v master seznamu')
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

    return {
        rows: sortedRows,
        warnings,
        parsedDates: parsedDates.sort(),
        rawTextLength: String(rawText || '').length,
        lineCount: allLines.length,
        completeDates: Array.from(completeDates).sort(),
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

    const confidenceLow = days.length === 0 || days.every((day) => day.turnoverCount === 0 && day.stayoverCount === 0)

    return {
        days,
        warnings,
        unknownRooms: Array.from(unknownRooms).sort((a, b) => Number(a) - Number(b)),
        parsedRows: parsed.rows.length,
        turnoverCount,
        stayoverCount,
        derivedFreeCount,
        confidenceLow,
        parsedTabDates
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
                return {
                    ...baseRow,
                    occupiedConfirmed: true,
                    stayoverGuestName: parsed.stayoverGuestName || parsed.departureGuestName || parsed.arrivalGuestName,
                    stayoverUntil: parsed.stayoverUntil
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
    MASTER_ROOM_NUMBERS,
    extractStateTextFromPdfBuffer,
    parsePrevioStatePdfText,
    buildPrevioStateImportPreview,
    detectMissingDatesInRange,
    buildByDateFromPreview,
    formatImportTimestamp
}
