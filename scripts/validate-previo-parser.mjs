import fs from 'node:fs/promises'
import path from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const PDF_PAGE_BREAK = '[[[PREVIO_PAGE_BREAK]]]'
const KNOWN_ROOM_NUMBERS = new Set([
    '001', '101', '102', '103', '104', '105', '201', '202', '203', '204', '205', '301', '302', '304', '305'
])

const root = process.cwd()
const pdfPath = path.join(root, 'private-sources/previo/previo-2026-06-16.pdf')
const debugPath = path.join(root, 'private-sources/previo/previo-debug-text-2026-06-16.txt')

function normalizeForMatch(value) {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
}

function normalizeRoomNumber(raw) {
    return raw.trim().replace(/^0+/, '').padStart(3, '0')
}

function normalizeTime(raw) {
    const normalized = raw.replace('.', ':')
    const [h, m] = normalized.split(':')
    if (!h || !m) return raw
    return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
}

function formatLocalDate(date) {
    const y = date.getFullYear()
    const m = `${date.getMonth() + 1}`.padStart(2, '0')
    const d = `${date.getDate()}`.padStart(2, '0')
    return `${y}-${m}-${d}`
}

function parsePageDateHeader(line) {
    const match = line.match(/\b(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\s*-\s*(po|ut|út|st|ct|čt|pa|so|ne)\b/i)
    if (!match) return null

    const day = Number(match[1])
    const month = Number(match[2])
    const year = Number(match[3])
    const date = new Date(year, month - 1, day)
    return Number.isNaN(date.getTime()) ? null : date
}

function isPageDateHeader(line) {
    return parsePageDateHeader(line) !== null
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
    if (normalized === 'prijizdejici' || normalized === 'odjizdejici' || normalized === 'probihajici') return true
    if (normalized === 'pokoj datum odjezd prijezd poznamka celkem') return true
    if (/prijizdejici\s*:\s*\d+/.test(normalized)) return true
    if (/odjizdejici\s*:\s*\d+/.test(normalized)) return true
    if (/probihajici\s*:\s*\d+/.test(normalized)) return true
    if (normalized === '(prijezd)' || normalized === '(odjezd)') return true
    if (normalized === 'datum datum') return true
    if (normalized === 'odjezd prijezd odjezd prijezd') return true

    return false
}

function keywordNotes(textLower) {
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

function detectRoomToken(line) {
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

function isNoteLine(line) {
    const normalized = normalizeForMatch(line)
    return normalized.includes('recepce') && (normalized.includes('box') || /\bb\s*ox\b/i.test(line))
}

function isAlfredWindow(line) {
    return /\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*-\s*([01]?\d|2[0-3])[:.]([0-5]\d)\b/i.test(line) && /alfred/i.test(line)
}

function isCapacityLine(line) {
    return /^\[\s*\d{1,2}\s*\+\s*\d{1,2}\s*\]$/.test(line.trim())
}

function isDateSpanLine(line) {
    return /^\d{1,2}\.\s*\d{1,2}\.\s+\d{1,2}\.\s*\d{1,2}\.$/.test(line.trim())
}

function isMostlyGuestLine(line) {
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

function toMinutes(hhmm) {
    const [h, m] = hhmm.split(':').map(Number)
    return h * 60 + m
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

function assignNotesBySide(noteGroups, departureTime, arrivalTime) {
    const departureNotes = []
    const arrivalNotes = []
    const generalNotes = []
    const sideWarnings = []

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

function extractGuestCount(blockText) {
    const match = blockText.match(/\[(\d{1,2})\s*\+\s*\d{1,2}\]/)
    if (match) return Number(match[1])

    const fallback = blockText.match(/\b(\d{1,2})\s*(?:p|os|host|pax)\b/i)
    return fallback ? Number(fallback[1]) : undefined
}

function extractBox(blockText) {
    const boxMatch = blockText.match(/\bbox\s*([a-z0-9-]+)/i)
    return boxMatch ? `BOX ${boxMatch[1].toUpperCase()}` : undefined
}

function extractDateTokens(text) {
    const tokens = new Set()
    const matches = text.matchAll(/\b(\d{1,2})\.\s*(\d{1,2})\.?\b/g)
    for (const match of matches) {
        tokens.add(`${Number(match[1])}. ${Number(match[2])}.`)
    }
    return Array.from(tokens)
}

function parseRawPrevio(rawText) {
    const allLines = rawText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

    const warnings = []
    const rows = []
    const parsedDateHeadings = []

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
        }

        const contentLines = pageLines.filter((line) => !isPageDateHeader(line) && !shouldIgnoreLine(line))
        const blockStarts = contentLines
            .map((line, index) => ({ index, isNote: isNoteLine(line) }))
            .filter((entry) => entry.isNote)
            .map((entry) => entry.index)

        blockStarts.forEach((startIndex, blockIndex) => {
            const endIndex = blockIndex + 1 < blockStarts.length ? blockStarts[blockIndex + 1] - 1 : contentLines.length - 1
            const blockLines = contentLines.slice(startIndex, endIndex + 1)

            let room = undefined
            let markerOffset = -1
            for (let i = 0; i < blockLines.length; i++) {
                const detected = detectRoomToken(blockLines[i])
                if (detected) {
                    room = detected
                    markerOffset = i
                    break
                }
            }
            if (!room) return

            const beforeMarker = markerOffset >= 0 ? blockLines.slice(0, markerOffset) : blockLines
            const afterMarker = markerOffset >= 0 ? blockLines.slice(markerOffset + 1) : []
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
            const guestLines = blockLines.filter((line) => isMostlyGuestLine(line))
            const departureGuestLabel = guestLines[0]
            const arrivalGuestLabel = guestLines[guestLines.length - 1] || departureGuestLabel
            const guestCount = extractGuestCount(rawBlock)
            const box = arrivalTime ? extractBox(arrivalNotes.join(' ') || rawBlock) : undefined
            const contextDates = extractDateTokens(afterMarker.join(' '))

            const rowWarnings = []
            if (!departureTime && !arrivalTime) {
                rowWarnings.push('Blok bez rozpoznaného času příjezdu/odjezdu')
            }
            if (contextDates.length > 0) {
                rowWarnings.push(`Kontekstová data: ${contextDates.join(', ')}`)
            }
            if (departureTime && !arrivalTime && detectedTimes.length > 1) {
                rowWarnings.push('Více časů v bloku bez druhé poznámkové skupiny - zachován pouze odjezd')
            }
            rowWarnings.push(...sideWarnings)

            const operationalDate = pageDate
                ? formatLocalDate(pageDate)
                : formatLocalDate(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + pageIndex))

            rows.push({
                dateIso: operationalDate,
                roomNumber: room,
                departureTime,
                arrivalTime,
                guestLabel: arrivalGuestLabel || departureGuestLabel,
                departureGuestLabel,
                arrivalGuestLabel,
                guestCount,
                box,
                departureNotes,
                arrivalNotes,
                generalNotes: allGeneralNotes,
                warnings: rowWarnings
            })
        })
    })

    return {
        rows,
        warnings,
        parsedDateHeadings,
        rawTextLength: rawText.length,
        lineCount: allLines.length
    }
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
                str: typeof item?.str === 'string' ? item.str.trim() : '',
                x: Array.isArray(item?.transform) ? Number(item.transform[4]) : 0,
                y: Array.isArray(item?.transform) ? Number(item.transform[5]) : 0
            }))
            .filter((item) => item.str)

        const rows = new Map()
        rawItems.forEach((item) => {
            const yBucket = Math.round(item.y)
            if (!rows.has(yBucket)) rows.set(yBucket, [])
            rows.get(yBucket).push({ str: item.str, x: item.x })
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

function noteContains(notes, token) {
    const nToken = normalizeForMatch(token)
    return notes.some((note) => normalizeForMatch(note).includes(nToken))
}

function printRows(rows) {
    const sorted = [...rows].sort((a, b) => {
        if (a.dateIso !== b.dateIso) return a.dateIso.localeCompare(b.dateIso)
        return a.roomNumber.localeCompare(b.roomNumber)
    })

    const header = 'date       | room | dep   | arr   | departureNotes                          | arrivalNotes'
    console.log(header)
    console.log('-'.repeat(header.length))
    sorted.forEach((row) => {
        const dep = (row.departureTime || '').padEnd(5, ' ')
        const arr = (row.arrivalTime || '').padEnd(5, ' ')
        const dNotes = row.departureNotes.join(' ; ').slice(0, 40).padEnd(40, ' ')
        const aNotes = row.arrivalNotes.join(' ; ').slice(0, 40)
        console.log(`${row.dateIso} | ${row.roomNumber} | ${dep} | ${arr} | ${dNotes} | ${aNotes}`)
    })
}

function assertRow(rows, failures, dateIso, roomNumber) {
    const matching = rows.filter((row) => row.dateIso === dateIso && row.roomNumber === roomNumber)
    if (matching.length === 0) {
        failures.push(`Chybí řádek ${dateIso} / ${roomNumber}`)
        return null
    }
    if (matching.length > 1) {
        failures.push(`Duplicitní řádky ${dateIso} / ${roomNumber}: ${matching.length}`)
    }
    return matching[0]
}

function expectEqual(failures, label, actual, expected) {
    if ((actual || '') !== (expected || '')) {
        failures.push(`${label}: expected "${expected}", got "${actual || ''}"`)
    }
}

function expectNoteContains(failures, label, notes, token) {
    if (!noteContains(notes, token)) {
        failures.push(`${label}: missing note containing "${token}" in [${notes.join(' | ')}]`)
    }
}

function runGoldenChecks(parsed) {
    const failures = []
    const rows = parsed.rows

    const rowsWithoutTimes = rows.filter((row) => !row.departureTime && !row.arrivalTime).length
    if (rows.length < 25) {
        failures.push(`Parser našel málo pokojů: ${rows.length} (< 25)`)
    }
    if (rows.length > 0 && (rowsWithoutTimes / rows.length) > 0.3) {
        failures.push(`Příliš mnoho řádků bez časů: ${rowsWithoutTimes}/${rows.length}`)
    }

    const byDate = new Map()
    rows.forEach((row) => {
        byDate.set(row.dateIso, (byDate.get(row.dateIso) || 0) + 1)
    })
    const c16 = byDate.get('2026-06-16') || 0
    const c17 = byDate.get('2026-06-17') || 0
    const c18 = byDate.get('2026-06-18') || 0
    if (c16 < 9 || c16 > 13) failures.push(`Neočekávaný počet řádků pro 16.6: ${c16}`)
    if (c17 < 9 || c17 > 13) failures.push(`Neočekávaný počet řádků pro 17.6: ${c17}`)
    if (c18 < 6 || c18 > 10) failures.push(`Neočekávaný počet řádků pro 18.6: ${c18}`)

    const r16001 = assertRow(rows, failures, '2026-06-16', '001')
    if (r16001) {
        expectEqual(failures, '16.6/001 departure', r16001.departureTime, '11:00')
        expectEqual(failures, '16.6/001 arrival', r16001.arrivalTime, '17:00')
        expectNoteContains(failures, '16.6/001 depNotes', r16001.departureNotes, 'BOX 10')
        expectNoteContains(failures, '16.6/001 arrNotes', r16001.arrivalNotes, 'BOX 4')
    }

    const r16101 = assertRow(rows, failures, '2026-06-16', '101')
    if (r16101) {
        expectEqual(failures, '16.6/101 departure', r16101.departureTime, '11:00')
        expectEqual(failures, '16.6/101 arrival', r16101.arrivalTime, '14:00')
        expectNoteContains(failures, '16.6/101 depNotes', r16101.departureNotes, 'BOX 9')
        expectNoteContains(failures, '16.6/101 arrNotes', r16101.arrivalNotes, 'BOX 2')
    }

    const r16102 = assertRow(rows, failures, '2026-06-16', '102')
    if (r16102) {
        expectEqual(failures, '16.6/102 departure', r16102.departureTime, '11:00')
        expectEqual(failures, '16.6/102 arrival', r16102.arrivalTime, '15:00')
        expectNoteContains(failures, '16.6/102 depNotes', r16102.departureNotes, 'BOX 1')
        expectNoteContains(failures, '16.6/102 arrNotes', r16102.arrivalNotes, 'BOX 11')
    }

    const r16103 = assertRow(rows, failures, '2026-06-16', '103')
    if (r16103) {
        expectEqual(failures, '16.6/103 departure', r16103.departureTime, '')
        expectEqual(failures, '16.6/103 arrival', r16103.arrivalTime, '14:00')
        expectNoteContains(failures, '16.6/103 arrNotes', r16103.arrivalNotes, 'BOX 5')
        if (r16103.arrivalGuestLabel && !normalizeForMatch(r16103.arrivalGuestLabel).includes('anna trankell')) {
            failures.push(`16.6/103 arrival guest expected Anna Trankell, got "${r16103.arrivalGuestLabel}"`)
        }
    }

    const r16302 = assertRow(rows, failures, '2026-06-16', '302')
    if (r16302) {
        expectEqual(failures, '16.6/302 departure', r16302.departureTime, '11:00')
        expectEqual(failures, '16.6/302 arrival', r16302.arrivalTime, '14:30')
        expectNoteContains(failures, '16.6/302 depNotes BOX 4', r16302.departureNotes, 'BOX 4')
        expectNoteContains(failures, '16.6/302 depNotes postylka', r16302.departureNotes, 'dětská postýlka')
        expectNoteContains(failures, '16.6/302 arrNotes', r16302.arrivalNotes, 'BOX 9')
        if (noteContains(r16302.arrivalNotes, 'dětská postýlka')) {
            failures.push('16.6/302: dětská postýlka nesmí být v arrivalNotes')
        }
    }

    const r17001 = assertRow(rows, failures, '2026-06-17', '001')
    if (r17001) {
        expectEqual(failures, '17.6/001 departure', r17001.departureTime, '11:00')
        expectEqual(failures, '17.6/001 arrival', r17001.arrivalTime, '18:30')
        expectNoteContains(failures, '17.6/001 depNotes', r17001.departureNotes, 'BOX 4')
        expectNoteContains(failures, '17.6/001 arrNotes', r17001.arrivalNotes, 'BOX 2')
    }

    const r17101 = assertRow(rows, failures, '2026-06-17', '101')
    if (r17101) {
        expectEqual(failures, '17.6/101 departure', r17101.departureTime, '11:00')
        expectEqual(failures, '17.6/101 arrival', r17101.arrivalTime, '14:00')
        expectNoteContains(failures, '17.6/101 depNotes', r17101.departureNotes, 'BOX 2')
        expectNoteContains(failures, '17.6/101 arrNotes', r17101.arrivalNotes, 'BOX 6')
    }

    const r17103 = assertRow(rows, failures, '2026-06-17', '103')
    if (r17103) {
        expectEqual(failures, '17.6/103 departure', r17103.departureTime, '11:00')
        expectEqual(failures, '17.6/103 arrival', r17103.arrivalTime, '21:30')
        expectNoteContains(failures, '17.6/103 depNotes', r17103.departureNotes, 'BOX 5')
        expectNoteContains(failures, '17.6/103 arrNotes', r17103.arrivalNotes, 'BOX 8')
        if (r17103.departureGuestLabel && !normalizeForMatch(r17103.departureGuestLabel).includes('anna trankell')) {
            failures.push(`17.6/103 departure guest expected Anna Trankell, got "${r17103.departureGuestLabel}"`)
        }
        if (r17103.arrivalGuestLabel && !normalizeForMatch(r17103.arrivalGuestLabel).includes('ole jorling')) {
            failures.push(`17.6/103 arrival guest expected Ole Jorling, got "${r17103.arrivalGuestLabel}"`)
        }
    }

    const r17204 = assertRow(rows, failures, '2026-06-17', '204')
    if (r17204) {
        expectEqual(failures, '17.6/204 departure', r17204.departureTime, '11:00')
        expectEqual(failures, '17.6/204 arrival', r17204.arrivalTime, '')
        expectNoteContains(failures, '17.6/204 depNotes', r17204.departureNotes, 'BOX 7')
    }

    const r18101 = assertRow(rows, failures, '2026-06-18', '101')
    if (r18101) {
        expectEqual(failures, '18.6/101 departure', r18101.departureTime, '11:00')
        expectEqual(failures, '18.6/101 arrival', r18101.arrivalTime, '19:00')
        expectNoteContains(failures, '18.6/101 depNotes', r18101.departureNotes, 'BOX 6')
        expectNoteContains(failures, '18.6/101 arrNotes', r18101.arrivalNotes, 'BOX 7')
    }

    const r18103 = assertRow(rows, failures, '2026-06-18', '103')
    if (r18103) {
        expectEqual(failures, '18.6/103 departure', r18103.departureTime, '11:00')
        expectEqual(failures, '18.6/103 arrival', r18103.arrivalTime, '13:30')
        expectNoteContains(failures, '18.6/103 depNotes', r18103.departureNotes, 'BOX 8')
        expectNoteContains(failures, '18.6/103 arrNotes', r18103.arrivalNotes, 'BOX 8')
    }

    const r18203 = assertRow(rows, failures, '2026-06-18', '203')
    if (r18203) {
        expectEqual(failures, '18.6/203 departure', r18203.departureTime, '11:00')
        expectEqual(failures, '18.6/203 arrival', r18203.arrivalTime, '14:00')
        expectNoteContains(failures, '18.6/203 depNotes', r18203.departureNotes, 'BOX 3')
        expectNoteContains(failures, '18.6/203 arrNotes', r18203.arrivalNotes, 'BOX 6')
    }

    const r18302 = assertRow(rows, failures, '2026-06-18', '302')
    if (r18302) {
        expectEqual(failures, '18.6/302 departure', r18302.departureTime, '11:00')
        expectEqual(failures, '18.6/302 arrival', r18302.arrivalTime, '14:30')
        expectNoteContains(failures, '18.6/302 depNotes', r18302.departureNotes, 'BOX 9')
        expectNoteContains(failures, '18.6/302 arrNotes', r18302.arrivalNotes, 'BOX 2')
    }

    return failures
}

async function main() {
    const [pdfRaw, debugRaw] = await Promise.all([
        extractRawTextFromPdf(pdfPath),
        fs.readFile(debugPath, 'utf8')
    ])

    const pdfRawTrim = pdfRaw.trim()
    const debugRawTrim = debugRaw.trim()

    if (pdfRawTrim !== debugRawTrim) {
        console.error('PDF extraction mismatch against provided debug text.')
        console.error('Validation aborted to avoid non-deterministic parser tuning.')
        process.exit(1)
        return
    }

    const parsed = parseRawPrevio(pdfRawTrim)
    printRows(parsed.rows)

    const failures = runGoldenChecks(parsed)
    if (failures.length > 0) {
        console.error('\nValidation FAILED:')
        failures.forEach((f) => console.error(`- ${f}`))
        process.exit(1)
        return
    }

    console.log('\nValidation OK: all golden checks passed.')
    console.log(`Rows: ${parsed.rows.length}, rows without times: ${parsed.rows.filter((r) => !r.departureTime && !r.arrivalTime).length}`)
}

main().catch((error) => {
    console.error('Validation script error:', error)
    process.exit(1)
})
