import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
    PREVIO_STAV_PARSER_VERSION,
    extractStateTextFromPdfBuffer,
    parsePrevioStatePdfText,
    buildPrevioStateImportPreview,
    buildByDateFromPreview,
    evaluatePrevioStateImportSafety,
    repairSameGuestNextDayBoxContinuity,
    detectMissingDatesInRange
} = require('../netlify/functions/lib/previo-state-preview.js')

const root = process.cwd()
const DEFAULT_REPO_FIXTURE = 'private-sources/previo/Stav-2026-06-18-0900.pdf'

function normalizeRoomNumber(raw) {
    return String(raw || '').trim().replace(/^0+/, '').padStart(3, '0')
}

function normalizeForMatch(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
}

function findRow(rows, dateIso, roomNumber) {
    const room = normalizeRoomNumber(roomNumber)
    return rows.find((row) => row.dateIso === dateIso && normalizeRoomNumber(row.roomNumber) === room)
}

function findPlanRow(byDate, dateIso, roomNumber) {
    const room = normalizeRoomNumber(roomNumber)
    const rows = Array.isArray(byDate?.[dateIso]) ? byDate[dateIso] : []
    return rows.find((row) => normalizeRoomNumber(row.number) === room)
}

function hasParsedDate(parsed, dateIso) {
    return Array.isArray(parsed?.parsedDates) && parsed.parsedDates.includes(dateIso)
}

function expect(failures, condition, message) {
    if (!condition) failures.push(message)
}

function expectEqual(failures, label, actual, expected) {
    if ((actual || '') !== (expected || '')) {
        failures.push(`${label}: expected "${expected}", got "${actual || ''}"`)
    }
}

function expectNumber(failures, label, actual, expected) {
    if (actual !== expected) {
        failures.push(`${label}: expected ${expected}, got ${actual ?? 'undefined'}`)
    }
}

function expectTextContains(failures, label, haystack, needle) {
    const normalizedHaystack = normalizeForMatch(haystack)
    const normalizedNeedle = normalizeForMatch(needle)
    if (!normalizedHaystack.includes(normalizedNeedle)) {
        failures.push(`${label}: expected to contain "${needle}", got "${haystack || ''}"`)
    }
}

function notesToString(notes) {
    return Array.isArray(notes) ? notes.join(' | ') : ''
}

async function requireStavFixture() {
    const cliArg = process.argv[2]
    const envPath = process.env.PREVIO_STATE_FIXTURE

    const candidates = []
    if (cliArg) candidates.push(cliArg)
    if (envPath) candidates.push(envPath)
    candidates.push(DEFAULT_REPO_FIXTURE)

    for (const rel of candidates) {
        if (!rel) continue
        const full = path.isAbsolute(rel) ? rel : path.join(root, rel)
        try {
            await fs.access(full)
            return full
        } catch {
            // continue to next candidate
        }
    }

    console.error('[validate:previo-state] Missing required fixture PDF.')
    console.error('Provide a local fixture via the PREVIO_STATE_FIXTURE env var or as first CLI argument.')
    console.error('Examples:')
    console.error('  PREVIO_STATE_FIXTURE=private-sources/previo/stav-2026-06-18-1656.pdf node scripts/validate-previo-state-parser.mjs')
    console.error('  node scripts/validate-previo-state-parser.mjs private-sources/previo/stav-2026-06-18-1656.pdf')
    process.exit(1)
}

function runChecks(parsed) {
    const failures = []

    expect(failures, parsed.rows.length > 0, 'Parser returned no rows')
    expect(failures, parsed.parsedDates.length > 0, 'Parser returned no parsed dates')

    const r17001 = findRow(parsed.rows, '2026-06-17', '001')
    const r17101 = findRow(parsed.rows, '2026-06-17', '101')
    const r17102 = findRow(parsed.rows, '2026-06-17', '102')
    const r17103 = findRow(parsed.rows, '2026-06-17', '103')
    const r18001 = findRow(parsed.rows, '2026-06-18', '001')
    const r20101 = findRow(parsed.rows, '2026-06-20', '101')
    const r20301 = findRow(parsed.rows, '2026-06-20', '301')
    const r21001 = findRow(parsed.rows, '2026-06-21', '001')
    const r21202 = findRow(parsed.rows, '2026-06-21', '202')

    expect(failures, Boolean(r17001), 'Missing row 2026-06-17/001')
    expect(failures, Boolean(r17101), 'Missing row 2026-06-17/101')
    expect(failures, Boolean(r17102), 'Missing row 2026-06-17/102')
    expect(failures, Boolean(r17103), 'Missing row 2026-06-17/103')
    expect(failures, Boolean(r18001), 'Missing row 2026-06-18/001')
    expect(failures, Boolean(r20101), 'Missing row 2026-06-20/101')
    expect(failures, Boolean(r20301), 'Missing row 2026-06-20/301')
    expect(failures, Boolean(r21001), 'Missing row 2026-06-21/001')
    expect(failures, Boolean(r21202), 'Missing row 2026-06-21/202')

    if (r17001) {
        expectEqual(failures, '17.6/001 departure time', r17001.departureTime, '11:00')
        expectEqual(failures, '17.6/001 arrival time', r17001.arrivalTime, '18:30')
        expectEqual(failures, '17.6/001 departure guest', r17001.departureGuestName, 'Markéta Šáchová')
        expectEqual(failures, '17.6/001 arrival guest', r17001.arrivalGuestName, 'Estreicher Nesya')
        expectNumber(failures, '17.6/001 departure pax', r17001.departureGuestCount, 4)
        expectNumber(failures, '17.6/001 arrival pax', r17001.arrivalGuestCount, 5)
        expectTextContains(failures, '17.6/001 departure note', notesToString(r17001.departureNotes), 'BOX 4')
        expectTextContains(failures, '17.6/001 arrival note', notesToString(r17001.arrivalNotes), 'BOX 2')
    }

    if (r17101) {
        expectEqual(failures, '17.6/101 departure time', r17101.departureTime, '11:00')
        expectEqual(failures, '17.6/101 arrival time', r17101.arrivalTime, '14:00')
        expectEqual(failures, '17.6/101 departure guest', r17101.departureGuestName, 'Yigit Cevik')
        expectEqual(failures, '17.6/101 arrival guest', r17101.arrivalGuestName, 'Giulia Ciociola')
        expectNumber(failures, '17.6/101 departure pax', r17101.departureGuestCount, 3)
        expectNumber(failures, '17.6/101 arrival pax', r17101.arrivalGuestCount, 3)
        expectTextContains(failures, '17.6/101 departure note', notesToString(r17101.departureNotes), 'BOX 2')
        expectTextContains(failures, '17.6/101 arrival note', notesToString(r17101.arrivalNotes), 'BOX 6')
    }

    if (r17102) {
        expectEqual(failures, '17.6/102 departure time', r17102.departureTime, '11:00')
        expectEqual(failures, '17.6/102 arrival time', r17102.arrivalTime, '14:00')
        expectEqual(failures, '17.6/102 departure guest', r17102.departureGuestName, 'Kristina Kroslakova')
        expectEqual(failures, '17.6/102 arrival guest', r17102.arrivalGuestName, 'Madalina Visan')
        expectNumber(failures, '17.6/102 departure pax', r17102.departureGuestCount, 2)
        expectNumber(failures, '17.6/102 arrival pax', r17102.arrivalGuestCount, 2)
        expectTextContains(failures, '17.6/102 departure note', notesToString(r17102.departureNotes), 'BOX 11')
        expectTextContains(failures, '17.6/102 arrival note', notesToString(r17102.arrivalNotes), 'BOX 7')
    }

    if (r17103) {
        expectEqual(failures, '17.6/103 departure time', r17103.departureTime, '11:00')
        expectEqual(failures, '17.6/103 arrival time', r17103.arrivalTime, '21:30')
        expectEqual(failures, '17.6/103 departure guest', r17103.departureGuestName, 'Anna Trankell')
        expectEqual(failures, '17.6/103 arrival guest', r17103.arrivalGuestName, 'Ole Jorling')
        expectNumber(failures, '17.6/103 departure pax', r17103.departureGuestCount, 4)
        expectNumber(failures, '17.6/103 arrival pax', r17103.arrivalGuestCount, 4)
        expectTextContains(failures, '17.6/103 departure note', notesToString(r17103.departureNotes), 'BOX 5')
        expectTextContains(failures, '17.6/103 arrival note', notesToString(r17103.arrivalNotes), 'BOX 8')
    }

    if (r18001) {
        const combinedGuestContext = [r18001.stayoverGuestName, r18001.departureGuestName, r18001.arrivalGuestName]
            .filter(Boolean)
            .join(' | ')

        expectEqual(failures, '18.6/001 departure time', r18001.departureTime, '')
        expectEqual(failures, '18.6/001 arrival time', r18001.arrivalTime, '')
        expect(failures, r18001.isStayover === true, '18.6/001 should be stayover row')
        expectTextContains(failures, '18.6/001 stayover guest context', combinedGuestContext, 'Estreicher Nesya')

        const noInventedTimes = !['11:00', '14:00', '18:30'].includes(r18001.departureTime || '')
            && !['11:00', '14:00', '18:30'].includes(r18001.arrivalTime || '')
        expect(failures, noInventedTimes, '18.6/001 contains invented turnover time')
    }

    if (r20101) {
        expectEqual(failures, '20.6/101 departure time', r20101.departureTime, '11:00')
        expectEqual(failures, '20.6/101 arrival time', r20101.arrivalTime, '14:00')
        expectEqual(failures, '20.6/101 departure guest', r20101.departureGuestName, 'Daša Špringerová')
        expectEqual(failures, '20.6/101 arrival guest', r20101.arrivalGuestName, 'Nick Brookes')
        expectNumber(failures, '20.6/101 departure pax', r20101.departureGuestCount, 4)
        expectNumber(failures, '20.6/101 arrival pax', r20101.arrivalGuestCount, 2)
        expectTextContains(failures, '20.6/101 departure note', notesToString(r20101.departureNotes), 'BOX 3')
        expectTextContains(failures, '20.6/101 arrival note', notesToString(r20101.arrivalNotes), 'BOX 2')
    }

    if (r20301) {
        expectEqual(failures, '20.6/301 arrival time', r20301.arrivalTime, '18:15')
        expect(failures, r20301.arrivalTime !== '06:15', '20.6/301 must not parse as 06:15')
        expectEqual(failures, '20.6/301 arrival guest', r20301.arrivalGuestName, 'Pallavi Lahri')
        expectNumber(failures, '20.6/301 arrival pax', r20301.arrivalGuestCount, 5)
        expectTextContains(failures, '20.6/301 arrival note BOX', notesToString(r20301.arrivalNotes), 'BOX 1')

        const childNoteText = normalizeForMatch(notesToString(r20301.arrivalNotes))
        expect(
            failures,
            /dite|deti|detsk|child/.test(childNoteText),
            '20.6/301 arrival note should contain child-related note'
        )
    }

    if (r21001) {
        expectEqual(failures, '21.6/001 arrival time', r21001.arrivalTime, '14:00')
        expectEqual(failures, '21.6/001 arrival guest', r21001.arrivalGuestName, 'Sogol Zargarcharkh')
        expectNumber(failures, '21.6/001 arrival pax', r21001.arrivalGuestCount, 4)
        expectTextContains(failures, '21.6/001 arrival note', notesToString(r21001.arrivalNotes), 'BOX 6')
    }

    if (r21202) {
        expectEqual(failures, '21.6/202 departure time', r21202.departureTime, '11:00')
        expectEqual(failures, '21.6/202 arrival time', r21202.arrivalTime, '22:00')
        expect(failures, r21202.arrivalTime !== '10:00', '21.6/202 must not parse as 10:00')
        expectEqual(failures, '21.6/202 departure guest', r21202.departureGuestName, 'Thomas Chambon')
        expectEqual(failures, '21.6/202 arrival guest', r21202.arrivalGuestName, 'Joanna Rudziewicz')
        expectNumber(failures, '21.6/202 departure pax', r21202.departureGuestCount, 2)
        expectNumber(failures, '21.6/202 arrival pax', r21202.arrivalGuestCount, 2)
        expectTextContains(failures, '21.6/202 departure note', notesToString(r21202.departureNotes), 'BOX 3')
        expectTextContains(failures, '21.6/202 arrival note', notesToString(r21202.arrivalNotes), 'BOX 8')
    }

    return failures
}

function runConcreteRegressionChecks(parsed) {
    const failures = []
    const r19001 = findRow(parsed.rows, '2026-06-19', '001')
    if (hasParsedDate(parsed, '2026-06-19')) {
        expect(failures, Boolean(r19001), 'Missing row 2026-06-19/001 for Manasawan regression check')
    }
    if (r19001) {
        expectEqual(failures, '19.6/001 arrival time', r19001.arrivalTime, '14:00')
        expectNumber(failures, '19.6/001 arrival pax', r19001.arrivalGuestCount, 4)
        expectTextContains(failures, '19.6/001 arrival guest', r19001.arrivalGuestName, 'Manasawan Santananukarn')
        expectTextContains(failures, '19.6/001 arrival note BOX', notesToString(r19001.arrivalNotes), 'BOX 4')
        expectTextContains(failures, '19.6/001 arrival note couch prep', notesToString(r19001.arrivalNotes), 'připravit gauč')
    }

    const r22105 = findRow(parsed.rows, '2026-06-22', '105')
    expect(failures, Boolean(r22105), 'Missing row 2026-06-22/105 for Tina Safran regression check')
    if (r22105) {
        const guestContext = [r22105.stayoverGuestName, r22105.departureGuestName, r22105.arrivalGuestName]
            .filter(Boolean)
            .join(' | ')

        const observedGuestCount = r22105.stayoverGuestCount ?? r22105.departureGuestCount ?? r22105.arrivalGuestCount
        const noteText = `${notesToString(r22105.departureNotes)} | ${notesToString(r22105.arrivalNotes)}`

        expect(failures, r22105.isStayover === true, '22.6/105 should be parsed as stayover row')
        expectEqual(failures, '22.6/105 departure time', r22105.departureTime, '')
        expectEqual(failures, '22.6/105 arrival time', r22105.arrivalTime, '')
        expectTextContains(failures, '22.6/105 guest context', guestContext, 'Tina Safran')
        expectNumber(failures, '22.6/105 stayover pax', observedGuestCount, 1)
        expect(failures, r22105.arrivalGuestCount !== 5, '22.6/105 must never show fake 5p arrival')
        expect(failures, r22105.departureGuestCount !== 5, '22.6/105 must never show fake 5p departure')
        expect(failures, r22105.stayoverGuestCount !== 5, '22.6/105 must never show fake 5p stayover')
        expect(
            failures,
            !normalizeForMatch(noteText).includes(normalizeForMatch('BOX 1')),
            '22.6/105 must not leak BOX 1 note from neighboring room'
        )
    }

    return failures
}

function runCriticalFixtureCellChecks(parsed, preview) {
    const failures = []
    const byDate = buildByDateFromPreview(preview, [], '18.06.2026 20:01')

    const r19001 = findRow(parsed.rows, '2026-06-19', '001')
    if (hasParsedDate(parsed, '2026-06-19')) {
        expect(failures, Boolean(r19001), 'Missing parser row 2026-06-19/001')
    }
    if (r19001) {
        expectEqual(failures, '19.6/001 parser departure time', r19001.departureTime, '11:00')
        expectEqual(failures, '19.6/001 parser arrival time', r19001.arrivalTime, '14:00')
        expectTextContains(failures, '19.6/001 parser departure guest', r19001.departureGuestName, 'Estreicher')
        expectTextContains(failures, '19.6/001 parser arrival guest', r19001.arrivalGuestName, 'Manasawan')
        expectNumber(failures, '19.6/001 parser departure pax', r19001.departureGuestCount, 5)
        expectNumber(failures, '19.6/001 parser arrival pax', r19001.arrivalGuestCount, 4)
        expectTextContains(failures, '19.6/001 parser departure BOX', notesToString(r19001.departureNotes), 'BOX 2')
        expectTextContains(failures, '19.6/001 parser arrival BOX', notesToString(r19001.arrivalNotes), 'BOX 4')
        expectTextContains(failures, '19.6/001 parser arrival couch', notesToString(r19001.arrivalNotes), 'připravit gauč')
    }

    const r20001 = findRow(parsed.rows, '2026-06-20', '001')
    expect(failures, Boolean(r20001), 'Missing parser row 2026-06-20/001')
    if (r20001) {
        expect(failures, r20001.isStayover === true, '20.6/001 parser should be stayover')
        expectEqual(failures, '20.6/001 parser departure time', r20001.departureTime, '')
        expectEqual(failures, '20.6/001 parser arrival time', r20001.arrivalTime, '')
        expectTextContains(failures, '20.6/001 parser stayover guest', r20001.stayoverGuestName || r20001.departureGuestName, 'Manasawan')
        const stayoverNotes = notesToString([...(r20001.departureNotes || []), ...(r20001.arrivalNotes || [])])
        expectTextContains(failures, '20.6/001 parser stayover BOX', stayoverNotes, 'BOX 4')
        expectTextContains(failures, '20.6/001 parser stayover couch', stayoverNotes, 'připravit gauč')
    }

    const r21001 = findRow(parsed.rows, '2026-06-21', '001')
    expect(failures, Boolean(r21001), 'Missing parser row 2026-06-21/001')
    if (r21001) {
        expectEqual(failures, '21.6/001 parser departure time', r21001.departureTime, '11:00')
        expectEqual(failures, '21.6/001 parser arrival time', r21001.arrivalTime, '14:00')
        expectTextContains(failures, '21.6/001 parser departure guest', r21001.departureGuestName, 'Manasawan')
        expectTextContains(failures, '21.6/001 parser arrival guest', r21001.arrivalGuestName, 'Sogol')
        expectTextContains(failures, '21.6/001 parser departure BOX', notesToString(r21001.departureNotes), 'BOX 4')
        expectTextContains(failures, '21.6/001 parser arrival BOX', notesToString(r21001.arrivalNotes), 'BOX 6')
    }

    const r22201 = findRow(parsed.rows, '2026-06-22', '201')
    expect(failures, Boolean(r22201), 'Missing parser row 2026-06-22/201')
    if (r22201) {
        expectEqual(failures, '22.6/201 parser departure time', r22201.departureTime, '11:00')
        expectEqual(failures, '22.6/201 parser arrival time', r22201.arrivalTime, '11:00')
        expectNumber(failures, '22.6/201 parser departure pax', r22201.departureGuestCount, 6)
        expectNumber(failures, '22.6/201 parser arrival pax', r22201.arrivalGuestCount, 5)
        expectTextContains(failures, '22.6/201 parser departure guest', r22201.departureGuestName, 'Michaela Císařová')
        expectTextContains(failures, '22.6/201 parser arrival guest', r22201.arrivalGuestName, 'Rozewicz Wanda')
        expectTextContains(failures, '22.6/201 parser departure BOX', notesToString(r22201.departureNotes), 'BOX 10')
        expectTextContains(failures, '22.6/201 parser arrival BOX', notesToString(r22201.arrivalNotes), 'BOX 1')
    }

    const b19001 = findPlanRow(byDate, '2026-06-19', '001')
    if (hasParsedDate(parsed, '2026-06-19')) {
        expect(failures, Boolean(b19001), 'Missing byDate row 2026-06-19/001')
    }
    if (b19001) {
        expectEqual(failures, '19.6/001 byDate departure time', b19001.departureTime, '11:00')
        expectEqual(failures, '19.6/001 byDate arrival time', b19001.arrivalTime, '14:00')
        expectTextContains(failures, '19.6/001 byDate departure guest', b19001.departure?.guestLabel, 'Estreicher')
        expectTextContains(failures, '19.6/001 byDate arrival guest', b19001.arrival?.guestLabel, 'Manasawan')
        expectTextContains(failures, '19.6/001 byDate BOX', b19001.box, 'BOX 4')
    }

    const b20001 = findPlanRow(byDate, '2026-06-20', '001')
    expect(failures, Boolean(b20001), 'Missing byDate row 2026-06-20/001')
    if (b20001) {
        expect(failures, b20001.occupiedConfirmed === true, '20.6/001 byDate should be occupiedConfirmed')
        expect(failures, b20001.freeConfirmed !== true, '20.6/001 byDate must not be freeConfirmed')
        expectTextContains(failures, '20.6/001 byDate stayover guest', b20001.stayoverGuestName, 'Manasawan')
        expectTextContains(failures, '20.6/001 byDate stayover BOX', b20001.box, 'BOX 4')
        expectTextContains(failures, '20.6/001 byDate stayover notes', notesToString(b20001.notes), 'připravit gauč')
    }

    const b21001 = findPlanRow(byDate, '2026-06-21', '001')
    expect(failures, Boolean(b21001), 'Missing byDate row 2026-06-21/001')
    if (b21001) {
        expectEqual(failures, '21.6/001 byDate departure time', b21001.departureTime, '11:00')
        expectEqual(failures, '21.6/001 byDate arrival time', b21001.arrivalTime, '14:00')
        expectTextContains(failures, '21.6/001 byDate departure guest', b21001.departure?.guestLabel, 'Manasawan')
        expectTextContains(failures, '21.6/001 byDate arrival guest', b21001.arrival?.guestLabel, 'Sogol')
        expectTextContains(failures, '21.6/001 byDate BOX', b21001.box, 'BOX 6')
    }

    const b22201 = findPlanRow(byDate, '2026-06-22', '201')
    expect(failures, Boolean(b22201), 'Missing byDate row 2026-06-22/201')
    if (b22201) {
        expectEqual(failures, '22.6/201 byDate departure time', b22201.departureTime, '11:00')
        expectEqual(failures, '22.6/201 byDate arrival time', b22201.arrivalTime, '11:00')
        expectTextContains(failures, '22.6/201 byDate departure guest', b22201.departure?.guestLabel, 'Michaela Císařová')
        expectTextContains(failures, '22.6/201 byDate arrival guest', b22201.arrival?.guestLabel, 'Rozewicz Wanda')
        expectTextContains(failures, '22.6/201 byDate departure BOX', notesToString(b22201.departure?.notes), 'BOX 10')
        expectTextContains(failures, '22.6/201 byDate arrival BOX', b22201.box, 'BOX 1')
    }

    return failures
}

function runStav0702SideContaminationChecks(parsed, preview) {
    const failures = []
    const byDate = buildByDateFromPreview(preview, [], '20.06.2026 07:02')

    const expectNoArrivalSignal = (row, label) => {
        if (!row) return
        expectEqual(failures, `${label} arrival guest`, row.arrivalGuestName, '')
        expectEqual(failures, `${label} arrival time`, row.arrivalTime, '')
        expect(
            failures,
            !Array.isArray(row.arrivalNotes) || row.arrivalNotes.length === 0,
            `${label} arrival notes must be empty`
        )
    }

    const p20103 = findRow(parsed.rows, '2026-06-20', '103')
    if (hasParsedDate(parsed, '2026-06-20')) {
        expect(failures, Boolean(p20103), 'Missing parser row 2026-06-20/103')
    }
    if (p20103) {
        expectEqual(failures, '20.6/103 parser arrival guest', p20103.arrivalGuestName, 'Shivani Mishra')
        expectEqual(failures, '20.6/103 parser arrival time', p20103.arrivalTime, '14:00')
        expectNumber(failures, '20.6/103 parser arrival pax', p20103.arrivalGuestCount, 3)
        expectTextContains(failures, '20.6/103 parser arrival BOX', notesToString(p20103.arrivalNotes), 'BOX 7')
    }

    const p21105 = findRow(parsed.rows, '2026-06-21', '105')
    expect(failures, Boolean(p21105), 'Missing parser row 2026-06-21/105')
    if (p21105) {
        expectTextContains(failures, '21.6/105 parser departure guest', p21105.departureGuestName, 'Mark Paul')
        expectEqual(failures, '21.6/105 parser departure time', p21105.departureTime, '11:00')
        expectNumber(failures, '21.6/105 parser departure pax', p21105.departureGuestCount, 2)
        expectTextContains(failures, '21.6/105 parser departure BOX', notesToString(p21105.departureNotes), 'BOX 5')
        expect(
            failures,
            !normalizeForMatch(notesToString(p21105.departureNotes)).includes(normalizeForMatch('BOX 6')),
            '21.6/105 parser departure notes must not contain BOX 6'
        )

        expectEqual(failures, '21.6/105 parser arrival guest', p21105.arrivalGuestName, 'Tina Safran')
        expectEqual(failures, '21.6/105 parser arrival time', p21105.arrivalTime, '14:00')
        expectNumber(failures, '21.6/105 parser arrival pax', p21105.arrivalGuestCount, 1)
        expectTextContains(failures, '21.6/105 parser arrival BOX', notesToString(p21105.arrivalNotes), 'BOX 2')
        expect(
            failures,
            !normalizeForMatch(notesToString(p21105.arrivalNotes)).includes(normalizeForMatch('BOX 6')),
            '21.6/105 parser arrival notes must not contain BOX 6'
        )
        expect(
            failures,
            !normalizeForMatch(notesToString(p21105.arrivalNotes)).includes(normalizeForMatch('BOX 10')),
            '21.6/105 parser arrival notes must not contain BOX 10'
        )
    }

    const p21201 = findRow(parsed.rows, '2026-06-21', '201')
    expect(failures, Boolean(p21201), 'Missing parser row 2026-06-21/201')
    if (p21201) {
        expectEqual(failures, '21.6/201 parser departure guest', p21201.departureGuestName, 'Wiktoria Sobczak')
        expectEqual(failures, '21.6/201 parser departure time', p21201.departureTime, '11:00')
        expectNumber(failures, '21.6/201 parser departure pax', p21201.departureGuestCount, 4)
        expectTextContains(failures, '21.6/201 parser departure BOX', notesToString(p21201.departureNotes), 'BOX 6')
        expectEqual(failures, '21.6/201 parser arrival guest', p21201.arrivalGuestName, 'Michaela Císařová')
        expect(
            failures,
            !normalizeForMatch(p21201.arrivalGuestName || '').includes(normalizeForMatch('Wiktoria Sobczak')),
            '21.6/201 parser arrival guest must not be Wiktoria Sobczak'
        )
        expectEqual(failures, '21.6/201 parser arrival time', p21201.arrivalTime, '14:00')
        expectNumber(failures, '21.6/201 parser arrival pax', p21201.arrivalGuestCount, 6)
        expectTextContains(failures, '21.6/201 parser arrival BOX', notesToString(p21201.arrivalNotes), 'BOX 10')
    }

    const p22105 = findRow(parsed.rows, '2026-06-22', '105')
    expect(failures, Boolean(p22105), 'Missing parser row 2026-06-22/105')
    if (p22105) {
        const guestContext = [p22105.stayoverGuestName, p22105.departureGuestName, p22105.arrivalGuestName]
            .filter(Boolean)
            .join(' | ')
        const noteText = `${notesToString(p22105.departureNotes)} | ${notesToString(p22105.arrivalNotes)}`

        expect(failures, p22105.isStayover === true, '22.6/105 parser should be stayover row')
        expectTextContains(failures, '22.6/105 parser guest context', guestContext, 'Tina Safran')
        expectTextContains(failures, '22.6/105 parser BOX', noteText, 'BOX 2')
        expect(
            failures,
            !normalizeForMatch(noteText).includes(normalizeForMatch('BOX 10')),
            '22.6/105 parser notes must not contain BOX 10'
        )
    }

    const p22201 = findRow(parsed.rows, '2026-06-22', '201')
    expect(failures, Boolean(p22201), 'Missing parser row 2026-06-22/201')
    if (p22201) {
        expectEqual(failures, '22.6/201 parser departure guest', p22201.departureGuestName, 'Michaela Císařová')
        expectEqual(failures, '22.6/201 parser departure time', p22201.departureTime, '11:00')
        expectNumber(failures, '22.6/201 parser departure pax', p22201.departureGuestCount, 6)
        expectTextContains(failures, '22.6/201 parser departure BOX', notesToString(p22201.departureNotes), 'BOX 10')
        expectEqual(failures, '22.6/201 parser arrival guest', p22201.arrivalGuestName, 'Rozewicz Wanda')
        expectEqual(failures, '22.6/201 parser arrival time', p22201.arrivalTime, '11:00')
        expectNumber(failures, '22.6/201 parser arrival pax', p22201.arrivalGuestCount, 5)
        expectTextContains(failures, '22.6/201 parser arrival BOX', notesToString(p22201.arrivalNotes), 'BOX 1')
    }

    const p22202 = findRow(parsed.rows, '2026-06-22', '202')
    expect(failures, Boolean(p22202), 'Missing parser row 2026-06-22/202')
    if (p22202) {
        expectEqual(failures, '22.6/202 parser departure guest', p22202.departureGuestName, 'Joanna Rudziewicz')
        expectEqual(failures, '22.6/202 parser departure time', p22202.departureTime, '11:00')
        expectNumber(failures, '22.6/202 parser departure pax', p22202.departureGuestCount, 2)
        expectTextContains(failures, '22.6/202 parser departure BOX', notesToString(p22202.departureNotes), 'BOX 8')
        expectEqual(failures, '22.6/202 parser arrival guest', p22202.arrivalGuestName, 'Lenka Sucháňová')
        expectEqual(failures, '22.6/202 parser arrival time', p22202.arrivalTime, '14:00')
        expectNumber(failures, '22.6/202 parser arrival pax', p22202.arrivalGuestCount, 2)
        expectTextContains(failures, '22.6/202 parser arrival BOX', notesToString(p22202.arrivalNotes), 'BOX 5')
        expect(
            failures,
            !normalizeForMatch(p22202.arrivalGuestName || '').includes(normalizeForMatch('Marta Piękniewska')),
            '22.6/202 parser arrival guest must not be Marta Piękniewska'
        )
    }

    const p23104 = findRow(parsed.rows, '2026-06-23', '104')
    expect(failures, Boolean(p23104), 'Missing parser row 2026-06-23/104')
    if (p23104) {
        const depContext = [p23104.stayoverGuestName, p23104.departureGuestName].filter(Boolean).join(' | ')
        expectTextContains(failures, '23.6/104 parser departure/stayover guest', depContext, 'Michele Giovanni')
        expectEqual(failures, '23.6/104 parser departure time', p23104.departureTime, '11:00')
        expectNumber(failures, '23.6/104 parser departure pax', p23104.departureGuestCount, 2)
        expectTextContains(failures, '23.6/104 parser departure BOX', notesToString(p23104.departureNotes), 'BOX 5')
        expectTextContains(failures, '23.6/104 parser arrival guest', p23104.arrivalGuestName, 'volkan yildirim')
        expectEqual(failures, '23.6/104 parser arrival time', p23104.arrivalTime, '14:00')
        expectNumber(failures, '23.6/104 parser arrival pax', p23104.arrivalGuestCount, 2)
        expectTextContains(failures, '23.6/104 parser arrival BOX', notesToString(p23104.arrivalNotes), 'BOX 3')
        expect(
            failures,
            !normalizeForMatch(p23104.arrivalGuestName || '').includes(normalizeForMatch('Heather Jean')),
            '23.6/104 parser arrival guest must not be Heather Jean'
        )
    }

    const p24104 = findRow(parsed.rows, '2026-06-24', '104')
    expect(failures, Boolean(p24104), 'Missing parser row 2026-06-24/104')
    if (p24104) {
        expect(failures, p24104.isStayover === true, '24.6/104 parser should be stayover')
        expectTextContains(failures, '24.6/104 parser stayover guest', p24104.stayoverGuestName, 'volkan yildirim')
        expectNumber(failures, '24.6/104 parser stayover pax', p24104.stayoverGuestCount, 2)
        expectTextContains(failures, '24.6/104 parser stayover BOX', notesToString(p24104.departureNotes), 'BOX 3')
        expectNoArrivalSignal(p24104, '24.6/104 parser')
    }

    const p24205 = findRow(parsed.rows, '2026-06-24', '205')
    expect(failures, Boolean(p24205), 'Missing parser row 2026-06-24/205')
    if (p24205) {
        expectEqual(failures, '24.6/205 parser departure guest', p24205.departureGuestName, 'Notteodora Ltd')
        expectEqual(failures, '24.6/205 parser departure time', p24205.departureTime, '11:00')
        expectNumber(failures, '24.6/205 parser departure pax', p24205.departureGuestCount, 1)
        expectTextContains(failures, '24.6/205 parser departure BOX', notesToString(p24205.departureNotes), 'BOX 3')
        expectEqual(failures, '24.6/205 parser arrival guest', p24205.arrivalGuestName, 'Stepan Kuca')
        expectEqual(failures, '24.6/205 parser arrival time', p24205.arrivalTime, '14:00')
        expectNumber(failures, '24.6/205 parser arrival pax', p24205.arrivalGuestCount, 2)
        expectTextContains(failures, '24.6/205 parser arrival BOX', notesToString(p24205.arrivalNotes), 'BOX 5')
    }

    const p25205 = findRow(parsed.rows, '2026-06-25', '205')
    expect(failures, Boolean(p25205), 'Missing parser row 2026-06-25/205')
    if (p25205) {
        expectEqual(failures, '25.6/205 parser departure guest', p25205.departureGuestName, 'Stepan Kuca')
        expectNumber(failures, '25.6/205 parser departure pax', p25205.departureGuestCount, 2)
        expectTextContains(failures, '25.6/205 parser departure BOX', notesToString(p25205.departureNotes), 'BOX 5')
        expectEqual(failures, '25.6/205 parser arrival guest', p25205.arrivalGuestName, 'Nikolas Brett')
        expectNumber(failures, '25.6/205 parser arrival pax', p25205.arrivalGuestCount, 2)
        expectTextContains(failures, '25.6/205 parser arrival BOX', notesToString(p25205.arrivalNotes), 'BOX 3')
    }

    const p25301 = findRow(parsed.rows, '2026-06-25', '301')
    expect(failures, Boolean(p25301), 'Missing parser row 2026-06-25/301')
    if (p25301) {
        const departureNotes = notesToString(p25301.departureNotes)
        expectEqual(failures, '25.6/301 parser departure guest', p25301.departureGuestName, 'Pallavi Lahri')
        expectTextContains(failures, '25.6/301 parser departure BOX', departureNotes, 'BOX 1')
        expectTextContains(failures, '25.6/301 parser departure toys note', departureNotes, 'hračky')
        expectTextContains(failures, '25.6/301 parser departure highchair note', departureNotes, 'dětská židlička')
        expect(
            failures,
            normalizeForMatch(departureNotes) !== normalizeForMatch('Recepce: BOX 1, hračky, dětská'),
            '25.6/301 parser departure notes must not be truncated to only dětská'
        )
        expectTextContains(failures, '25.6/301 parser arrival BOX', notesToString(p25301.arrivalNotes), 'BOX 1')
    }

    const p24303 = findRow(parsed.rows, '2026-06-24', '303')
    expect(failures, Boolean(p24303), 'Missing parser row 2026-06-24/303')
    if (p24303) {
        expectEqual(failures, '24.6/303 parser departure guest', p24303.departureGuestName, 'Kotas Vaclav')
        expectEqual(failures, '24.6/303 parser departure time', p24303.departureTime, '11:00')
        expectNumber(failures, '24.6/303 parser departure pax', p24303.departureGuestCount, 4)
        expectTextContains(failures, '24.6/303 parser departure BOX', notesToString(p24303.departureNotes), 'BOX 1')
        expectEqual(failures, '24.6/303 parser arrival guest', p24303.arrivalGuestName, 'Lubomira Eiflerova')
        expectEqual(failures, '24.6/303 parser arrival time', p24303.arrivalTime, '14:00')
        expectNumber(failures, '24.6/303 parser arrival pax', p24303.arrivalGuestCount, 5)
        expect(
            failures,
            !Array.isArray(p24303.arrivalNotes) || p24303.arrivalNotes.length === 0,
            '24.6/303 parser arrival notes must be empty'
        )
    }

    const p24204 = findRow(parsed.rows, '2026-06-24', '204')
    expect(failures, Boolean(p24204), 'Missing parser row 2026-06-24/204')
    if (p24204) {
        expectEqual(failures, '24.6/204 parser departure guest', p24204.departureGuestName, 'Lorraine Cahalane')
        expectEqual(failures, '24.6/204 parser departure time', p24204.departureTime, '11:00')
        expectNumber(failures, '24.6/204 parser departure pax', p24204.departureGuestCount, 2)
        expectTextContains(failures, '24.6/204 parser departure BOX', notesToString(p24204.departureNotes), 'BOX 2')
        expectNoArrivalSignal(p24204, '24.6/204 parser')
    }

    const p24302 = findRow(parsed.rows, '2026-06-24', '302')
    expect(failures, Boolean(p24302), 'Missing parser row 2026-06-24/302')
    if (p24302) {
        expectEqual(failures, '24.6/302 parser departure guest', p24302.departureGuestName, 'Monika Brizova')
        expectEqual(failures, '24.6/302 parser departure time', p24302.departureTime, '11:00')
        expectNumber(failures, '24.6/302 parser departure pax', p24302.departureGuestCount, 2)
        expectTextContains(failures, '24.6/302 parser departure BOX', notesToString(p24302.departureNotes), 'BOX 4')
        expectNoArrivalSignal(p24302, '24.6/302 parser')
    }

    const p24304 = findRow(parsed.rows, '2026-06-24', '304')
    expect(failures, Boolean(p24304), 'Missing parser row 2026-06-24/304')
    if (p24304) {
        expectEqual(failures, '24.6/304 parser departure guest', p24304.departureGuestName, 'Filip Rychetský')
        expectEqual(failures, '24.6/304 parser departure time', p24304.departureTime, '11:00')
        expectNumber(failures, '24.6/304 parser departure pax', p24304.departureGuestCount, 2)
        expectTextContains(failures, '24.6/304 parser departure BOX', notesToString(p24304.departureNotes), 'BOX 2')
        expectNoArrivalSignal(p24304, '24.6/304 parser')
    }

    const b21105 = findPlanRow(byDate, '2026-06-21', '105')
    expect(failures, Boolean(b21105), 'Missing byDate row 2026-06-21/105')
    if (b21105) {
        expectTextContains(failures, '21.6/105 byDate arrival guest', b21105.arrival?.guestLabel, 'Tina Safran')
        expectNumber(failures, '21.6/105 byDate arrival pax', b21105.arrival?.guestCount, 1)
        expectTextContains(failures, '21.6/105 byDate arrival BOX', notesToString(b21105.arrival?.notes), 'BOX 2')
        const allArrivalNotes = notesToString(b21105.arrival?.notes)
        expect(
            failures,
            !normalizeForMatch(allArrivalNotes).includes(normalizeForMatch('BOX 6')),
            '21.6/105 byDate arrival notes must not contain BOX 6'
        )
        expect(
            failures,
            !normalizeForMatch(allArrivalNotes).includes(normalizeForMatch('BOX 10')),
            '21.6/105 byDate arrival notes must not contain BOX 10'
        )
    }

    const b21201 = findPlanRow(byDate, '2026-06-21', '201')
    expect(failures, Boolean(b21201), 'Missing byDate row 2026-06-21/201')
    if (b21201) {
        const byDateArrival = b21201.arrival?.guestLabel || ''
        expectEqual(failures, '21.6/201 byDate arrival guest', byDateArrival, 'Michaela Císařová')
        expect(
            failures,
            !normalizeForMatch(byDateArrival).includes(normalizeForMatch('Wiktoria Sobczak')),
            '21.6/201 byDate arrival guest must not be Wiktoria Sobczak'
        )
        expectNumber(failures, '21.6/201 byDate arrival pax', b21201.arrival?.guestCount, 6)
        expectTextContains(failures, '21.6/201 byDate arrival BOX', notesToString(b21201.arrival?.notes), 'BOX 10')
    }

    const b22201 = findPlanRow(byDate, '2026-06-22', '201')
    expect(failures, Boolean(b22201), 'Missing byDate row 2026-06-22/201')
    if (b22201) {
        expectTextContains(failures, '22.6/201 byDate arrival guest', b22201.arrival?.guestLabel, 'Rozewicz Wanda')
        expectNumber(failures, '22.6/201 byDate arrival pax', b22201.arrival?.guestCount, 5)
        expectTextContains(failures, '22.6/201 byDate arrival BOX', notesToString(b22201.arrival?.notes), 'BOX 1')
    }

    const b22202 = findPlanRow(byDate, '2026-06-22', '202')
    expect(failures, Boolean(b22202), 'Missing byDate row 2026-06-22/202')
    if (b22202) {
        expectEqual(failures, '22.6/202 byDate arrival guest', b22202.arrival?.guestLabel, 'Lenka Sucháňová')
        expectTextContains(failures, '22.6/202 byDate arrival BOX', notesToString(b22202.arrival?.notes), 'BOX 5')
    }

    const b23104 = findPlanRow(byDate, '2026-06-23', '104')
    expect(failures, Boolean(b23104), 'Missing byDate row 2026-06-23/104')
    if (b23104) {
        expectTextContains(failures, '23.6/104 byDate arrival guest', b23104.arrival?.guestLabel, 'volkan yildirim')
        expectTextContains(failures, '23.6/104 byDate arrival BOX', notesToString(b23104.arrival?.notes), 'BOX 3')
    }

    const b24104 = findPlanRow(byDate, '2026-06-24', '104')
    expect(failures, Boolean(b24104), 'Missing byDate row 2026-06-24/104')
    if (b24104) {
        expect(failures, b24104.occupiedConfirmed === true, '24.6/104 byDate should be occupiedConfirmed')
        expectTextContains(failures, '24.6/104 byDate stayover guest', b24104.stayoverGuestName, 'volkan yildirim')
        expectEqual(failures, '24.6/104 byDate arrival guest', b24104.arrival?.guestLabel || '', '')
        expect(
            failures,
            !Array.isArray(b24104.arrival?.notes) || b24104.arrival.notes.length === 0,
            '24.6/104 byDate arrival notes must be empty'
        )
    }

    const b24205 = findPlanRow(byDate, '2026-06-24', '205')
    expect(failures, Boolean(b24205), 'Missing byDate row 2026-06-24/205')
    if (b24205) {
        expectEqual(failures, '24.6/205 byDate arrival guest', b24205.arrival?.guestLabel, 'Stepan Kuca')
        expectTextContains(failures, '24.6/205 byDate arrival BOX', notesToString(b24205.arrival?.notes), 'BOX 5')
    }

    const b25205 = findPlanRow(byDate, '2026-06-25', '205')
    expect(failures, Boolean(b25205), 'Missing byDate row 2026-06-25/205')
    if (b25205) {
        expectEqual(failures, '25.6/205 byDate departure guest', b25205.departure?.guestLabel, 'Stepan Kuca')
        expectTextContains(failures, '25.6/205 byDate departure BOX', notesToString(b25205.departure?.notes), 'BOX 5')
        expectEqual(failures, '25.6/205 byDate arrival guest', b25205.arrival?.guestLabel, 'Nikolas Brett')
        expectTextContains(failures, '25.6/205 byDate arrival BOX', notesToString(b25205.arrival?.notes), 'BOX 3')
    }

    const b25301 = findPlanRow(byDate, '2026-06-25', '301')
    expect(failures, Boolean(b25301), 'Missing byDate row 2026-06-25/301')
    if (b25301) {
        const departureNotes = notesToString(b25301.departure?.notes)
        expectTextContains(failures, '25.6/301 byDate departure guest', b25301.departure?.guestLabel, 'Pallavi Lahri')
        expectTextContains(failures, '25.6/301 byDate departure BOX', departureNotes, 'BOX 1')
        expectTextContains(failures, '25.6/301 byDate departure toys note', departureNotes, 'hračky')
        expectTextContains(failures, '25.6/301 byDate departure highchair note', departureNotes, 'dětská židlička')
        expectTextContains(failures, '25.6/301 byDate arrival BOX', notesToString(b25301.arrival?.notes), 'BOX 1')
    }

    const b24303 = findPlanRow(byDate, '2026-06-24', '303')
    expect(failures, Boolean(b24303), 'Missing byDate row 2026-06-24/303')
    if (b24303) {
        expectEqual(failures, '24.6/303 byDate arrival guest', b24303.arrival?.guestLabel, 'Lubomira Eiflerova')
        expect(
            failures,
            !Array.isArray(b24303.arrival?.notes) || b24303.arrival.notes.length === 0,
            '24.6/303 byDate arrival notes must be empty'
        )
    }

    const b24204 = findPlanRow(byDate, '2026-06-24', '204')
    expect(failures, Boolean(b24204), 'Missing byDate row 2026-06-24/204')
    if (b24204) {
        expectEqual(failures, '24.6/204 byDate arrival guest', b24204.arrival?.guestLabel || '', '')
        expect(
            failures,
            !Array.isArray(b24204.arrival?.notes) || b24204.arrival.notes.length === 0,
            '24.6/204 byDate arrival notes must be empty'
        )
    }

    const b24302 = findPlanRow(byDate, '2026-06-24', '302')
    expect(failures, Boolean(b24302), 'Missing byDate row 2026-06-24/302')
    if (b24302) {
        expectEqual(failures, '24.6/302 byDate arrival guest', b24302.arrival?.guestLabel || '', '')
        expect(
            failures,
            !Array.isArray(b24302.arrival?.notes) || b24302.arrival.notes.length === 0,
            '24.6/302 byDate arrival notes must be empty'
        )
    }

    const b24304 = findPlanRow(byDate, '2026-06-24', '304')
    expect(failures, Boolean(b24304), 'Missing byDate row 2026-06-24/304')
    if (b24304) {
        expectEqual(failures, '24.6/304 byDate arrival guest', b24304.arrival?.guestLabel || '', '')
        expect(
            failures,
            !Array.isArray(b24304.arrival?.notes) || b24304.arrival.notes.length === 0,
            '24.6/304 byDate arrival notes must be empty'
        )
    }

    return failures
}

function runStav0702FirstArrivalGuestChecks(parsed, preview) {
    const failures = []
    const byDate = buildByDateFromPreview(preview, [], '20.06.2026 07:02')

    const expectedFirstArrivalGuests = [
        { dateIso: '2026-06-20', roomNumber: '101', guest: 'Nick Brookes' },
        { dateIso: '2026-06-20', roomNumber: '204', guest: 'Daniel Hagios' },
        { dateIso: '2026-06-20', roomNumber: '301', guest: 'Pallavi Lahri' },
        { dateIso: '2026-06-20', roomNumber: '303', guest: 'Dan Stuparu' },
        { dateIso: '2026-06-21', roomNumber: '104', guest: 'Michele Giovanni Miano' },
        { dateIso: '2026-06-22', roomNumber: '204', guest: 'Lorraine Cahalane' },
        { dateIso: '2026-06-22', roomNumber: '304', guest: 'Norbert Habich' },
        { dateIso: '2026-06-23', roomNumber: '304', guest: 'Filip Rychetský' },
        { dateIso: '2026-06-24', roomNumber: '001', guest: 'Chaymae Aissaoui' }
    ]

    expectedFirstArrivalGuests.forEach((target) => {
        if (!hasParsedDate(parsed, target.dateIso)) return

        const parserRow = findRow(parsed.rows, target.dateIso, target.roomNumber)
        const planRow = findPlanRow(byDate, target.dateIso, target.roomNumber)

        expect(failures, Boolean(parserRow), `Missing parser row ${target.dateIso}/${target.roomNumber} for first-arrival regression`)
        expect(failures, Boolean(planRow), `Missing byDate row ${target.dateIso}/${target.roomNumber} for first-arrival regression`)

        if (parserRow) {
            expectEqual(
                failures,
                `${target.dateIso}/${target.roomNumber} parser arrival guest`,
                parserRow.arrivalGuestName,
                target.guest
            )
        }

        if (planRow) {
            expectEqual(
                failures,
                `${target.dateIso}/${target.roomNumber} byDate arrival guest`,
                planRow.arrival?.guestLabel,
                target.guest
            )
        }
    })

    const has2406 = hasParsedDate(parsed, '2026-06-24')
    const parser24101 = findRow(parsed.rows, '2026-06-24', '101')
    const byDate24101 = findPlanRow(byDate, '2026-06-24', '101')
    if (has2406) {
        expect(failures, Boolean(parser24101), 'Missing parser row 2026-06-24/101 for arrival full-name regression')
        expect(failures, Boolean(byDate24101), 'Missing byDate row 2026-06-24/101 for arrival full-name regression')
    }

    if (parser24101) {
        expectEqual(
            failures,
            '24.6/101 parser arrival guest',
            parser24101.arrivalGuestName,
            'Anette Elvine J B Solbakken'
        )
        expectNumber(failures, '24.6/101 parser arrival pax', parser24101.arrivalGuestCount, 4)
        expectTextContains(
            failures,
            '24.6/101 parser arrival BOX',
            notesToString(parser24101.arrivalNotes),
            'BOX 2'
        )
    }

    if (byDate24101) {
        expectEqual(
            failures,
            '24.6/101 byDate arrival guest',
            byDate24101.arrival?.guestLabel,
            'Anette Elvine J B Solbakken'
        )
        expectNumber(failures, '24.6/101 byDate arrival pax', byDate24101.arrival?.guestCount, 4)
        expectTextContains(
            failures,
            '24.6/101 byDate arrival BOX note',
            notesToString(byDate24101.arrival?.notes),
            'BOX 2'
        )
        expectTextContains(
            failures,
            '24.6/101 byDate arrival BOX field',
            byDate24101.box,
            'BOX 2'
        )
    }

    return failures
}

function runTotalsChecks(parsed) {
    const failures = []
    const totalsByDate = parsed.dayTotals || {}
    const rows = Array.isArray(parsed.rows) ? parsed.rows : []

    Object.entries(totalsByDate).forEach(([dateIso, totals]) => {
        const dayRows = rows.filter((row) => row.dateIso === dateIso)
        const arrivalsCount = dayRows.filter((row) => Boolean(row.arrivalTime)).length
        const departuresCount = dayRows.filter((row) => Boolean(row.departureTime)).length
        const stayoversCount = dayRows.filter((row) => !row.departureTime && !row.arrivalTime).length

        const arrivalsGuests = dayRows.reduce((sum, row) => (
            sum + (typeof row.arrivalGuestCount === 'number' ? row.arrivalGuestCount : 0)
        ), 0)
        const departuresGuests = dayRows.reduce((sum, row) => (
            sum + (typeof row.departureGuestCount === 'number' ? row.departureGuestCount : 0)
        ), 0)
        const stayoversGuests = dayRows.reduce((sum, row) => (
            sum + (typeof row.stayoverGuestCount === 'number' ? row.stayoverGuestCount : 0)
        ), 0)

        const effectiveArrivals = arrivalsGuests > 0 ? arrivalsGuests : arrivalsCount
        const effectiveDepartures = departuresGuests > 0 ? departuresGuests : departuresCount
        const effectiveStayovers = stayoversGuests > 0 ? stayoversGuests : stayoversCount

        if (typeof totals.arrivals === 'number') {
            expectNumber(failures, `${dateIso} totals arrivals`, effectiveArrivals, totals.arrivals)
        }
        if (typeof totals.departures === 'number') {
            expectNumber(failures, `${dateIso} totals departures`, effectiveDepartures, totals.departures)
        }
        if (typeof totals.stayovers === 'number') {
            expectNumber(failures, `${dateIso} totals stayovers`, effectiveStayovers, totals.stayovers)
        }
    })

    return failures
}

function runSafetyChecks(preview) {
    const failures = []
    const missingDateLabels = detectMissingDatesInRange(preview.days.map((day) => day.dateIso))
        .map((dateIso) => new Date(`${dateIso}T00:00:00`).toLocaleDateString('cs-CZ', {
            day: 'numeric',
            month: 'numeric',
            year: 'numeric'
        }))

    const safety = evaluatePrevioStateImportSafety({
        preview,
        missingDateLabels,
        parserVersion: PREVIO_STAV_PARSER_VERSION,
        checkedAt: new Date()
    })

    expect(
        failures,
        safety.blocked === false,
        `Current Stav fixture preview is safety-blocked: ${(safety.blocks || []).join(' | ')}`
    )

    const syntheticUnsafe = {
        ...preview,
        amPmEvidence: true,
        days: preview.days.map((day, index) => {
            if (index !== 0) return day
            const updatedRows = day.rows.map((row, rowIndex) => {
                if (rowIndex >= 6) return row
                return {
                    ...row,
                    departureTime: '06:30',
                    arrivalTime: '02:00'
                }
            })
            return {
                ...day,
                rows: updatedRows
            }
        })
    }

    const syntheticSafety = evaluatePrevioStateImportSafety({
        preview: syntheticUnsafe,
        missingDateLabels: [],
        parserVersion: PREVIO_STAV_PARSER_VERSION,
        checkedAt: new Date()
    })

    expect(failures, syntheticSafety.blocked === true, 'Synthetic bad preview with 02:00/06:30 should be blocked')
    expect(
        failures,
        syntheticSafety.blocks.some((line) => line.includes('01:00-07:30')),
        'Synthetic bad preview should trigger suspicious night-time safety block'
    )

    const syntheticMissingGuest = {
        ...preview,
        days: preview.days.map((day, dayIndex) => {
            if (dayIndex !== 0) return day

            const updatedRows = day.rows.map((row, rowIndex) => {
                if (rowIndex !== 0) return row
                return {
                    ...row,
                    departureTime: '11:00',
                    arrivalTime: '14:00',
                    departureGuestName: undefined,
                    departureGuestCount: undefined,
                    arrivalGuestName: undefined,
                    arrivalGuestCount: undefined
                }
            })

            return {
                ...day,
                rows: updatedRows
            }
        })
    }

    const missingGuestSafety = evaluatePrevioStateImportSafety({
        preview: syntheticMissingGuest,
        missingDateLabels: [],
        parserVersion: PREVIO_STAV_PARSER_VERSION,
        checkedAt: new Date()
    })

    expect(failures, missingGuestSafety.blocked === true, 'Synthetic missing guest row should be blocked')
    expect(
        failures,
        missingGuestSafety.blocks.some((line) => line.includes('Příjezd má čas, ale chybí jméno hosta.')),
        'Synthetic missing guest row should trigger arrival missing guest block'
    )
    expect(
        failures,
        missingGuestSafety.blocks.some((line) => line.includes('Odjezd má čas, ale chybí jméno hosta.')),
        'Synthetic missing guest row should trigger departure missing guest block'
    )

    return failures
}

function runSameGuestNextDayBoxContinuityHelperChecks() {
    const failures = []
    const rows = [
        {
            dateIso: '2026-06-24',
            roomNumber: '104',
            arrivalTime: '14:00',
            arrivalGuestName: 'Generic Test Guest',
            arrivalGuestCount: 2,
            departureNotes: [],
            arrivalNotes: [],
            isStayover: false,
            warnings: []
        },
        {
            dateIso: '2026-06-25',
            roomNumber: '104',
            departureTime: '11:00',
            departureGuestName: 'Generic Test Guest',
            departureGuestCount: 2,
            departureNotes: ['BOX 7'],
            arrivalNotes: [],
            isStayover: false,
            warnings: []
        },
        {
            dateIso: '2026-06-25',
            roomNumber: '105',
            departureTime: '11:00',
            departureGuestName: 'Different Room Guest',
            departureGuestCount: 1,
            departureNotes: ['BOX 9'],
            arrivalNotes: [],
            isStayover: false,
            warnings: []
        }
    ]

    repairSameGuestNextDayBoxContinuity(rows)

    expectTextContains(
        failures,
        'synthetic 104 arrival BOX copied from next-day same guest departure',
        notesToString(rows[0].arrivalNotes),
        'BOX 7'
    )
    expectTextContains(
        failures,
        'synthetic 104 departure BOX remains present',
        notesToString(rows[1].departureNotes),
        'BOX 7'
    )
    expect(
        failures,
        !normalizeForMatch(notesToString(rows[0].arrivalNotes)).includes(normalizeForMatch('BOX 9')),
        'synthetic continuity must not copy BOX from another room'
    )

    return failures
}

async function main() {
    const fixturePath = await requireStavFixture()
    const fixtureName = path.basename(fixturePath)
    const fixtureLower = fixtureName.toLowerCase()
    const isStav210702Fixture = fixtureLower.includes('stav-2026-06-21-0702')

    const pdfBuffer = await fs.readFile(fixturePath)

    const extracted = await extractStateTextFromPdfBuffer(pdfBuffer)
    const parsed = parsePrevioStatePdfText(extracted, new Date())
    const preview = buildPrevioStateImportPreview(parsed, [], new Date())

    const failures = []
    failures.push(...runSameGuestNextDayBoxContinuityHelperChecks())
    failures.push(...runTotalsChecks(parsed))
    failures.push(...runSafetyChecks(preview))

    if (isStav210702Fixture) {
        failures.push(...runStav0702SideContaminationChecks(parsed, preview))
        failures.push(...runStav0702FirstArrivalGuestChecks(parsed, preview))
    } else {
        failures.push(...runConcreteRegressionChecks(parsed))
        failures.push(...runCriticalFixtureCellChecks(parsed, preview))
        failures.push(...runStav0702SideContaminationChecks(parsed, preview))
        failures.push(...runStav0702FirstArrivalGuestChecks(parsed, preview))
    }

    if (failures.length > 0) {
        console.error('[validate:previo-state] FAIL')
        failures.forEach((failure) => console.error(`- ${failure}`))
        process.exit(1)
    }

    console.log('[validate:previo-state] PASS')
    console.log(`- Fixture: ${fixtureName}`)
    console.log(`- Rows: ${parsed.rows.length}`)
    console.log(`- Days: ${preview.days.length}`)
    console.log(`- Complete days: ${parsed.completeDates.length}`)
}

main().catch((error) => {
    console.error('[validate:previo-state] ERROR')
    console.error(error && error.stack ? error.stack : String(error))
    process.exit(1)
})
