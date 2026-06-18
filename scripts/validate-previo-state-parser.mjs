import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
    PREVIO_STAV_PARSER_VERSION,
    extractStateTextFromPdfBuffer,
    parsePrevioStatePdfText,
    buildPrevioStateImportPreview,
    evaluatePrevioStateImportSafety,
    detectMissingDatesInRange
} = require('../netlify/functions/lib/previo-state-preview.js')

const root = process.cwd()
const requiredFixtureRelativePath = 'private-sources/previo/Stav-2026-06-18-0700.pdf'
const requiredFixturePath = path.join(root, requiredFixtureRelativePath)

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
    try {
        await fs.access(requiredFixturePath)
        return requiredFixturePath
    } catch {
        throw new Error(
            '[validate:previo-state] Missing required fixture ' +
            `${requiredFixtureRelativePath}. Place the exact uploaded Stav PDF at this path and rerun validation.`
        )
    }
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
    expect(failures, Boolean(r19001), 'Missing row 2026-06-19/001 for Manasawan regression check')
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

        expect(failures, r22105.isStayover === true, '22.6/105 should be parsed as stayover row')
        expectEqual(failures, '22.6/105 departure time', r22105.departureTime, '')
        expectEqual(failures, '22.6/105 arrival time', r22105.arrivalTime, '')
        expectTextContains(failures, '22.6/105 guest context', guestContext, 'Tina Safran')
        expectNumber(failures, '22.6/105 stayover pax', observedGuestCount, 1)
        expect(failures, r22105.arrivalGuestCount !== 5, '22.6/105 must never show fake 5p arrival')
        expect(failures, r22105.departureGuestCount !== 5, '22.6/105 must never show fake 5p departure')
        expect(failures, r22105.stayoverGuestCount !== 5, '22.6/105 must never show fake 5p stayover')
    }

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

    const allowedFixtureBlocks = new Set([
        'Počty v náhledu nesedí s řádkem Celkem v PDF.'
    ])
    const unexpectedBlocks = (safety.blocks || []).filter((block) => !allowedFixtureBlocks.has(block))
    expect(
        failures,
        unexpectedBlocks.length === 0,
        `Current Stav fixture preview has unexpected safety blocks: ${unexpectedBlocks.join(' | ')}`
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

async function main() {
    const fixturePath = await requireStavFixture()
    const pdfBuffer = await fs.readFile(fixturePath)

    const extracted = await extractStateTextFromPdfBuffer(pdfBuffer)
    const parsed = parsePrevioStatePdfText(extracted, new Date())
    const preview = buildPrevioStateImportPreview(parsed, [], new Date())

    const failures = []
    failures.push(...runSafetyChecks(preview))
    failures.push(...runConcreteRegressionChecks(parsed))
    if (failures.length > 0) {
        console.error('[validate:previo-state] FAIL')
        failures.forEach((failure) => console.error(`- ${failure}`))
        process.exit(1)
    }

    const fixtureName = path.basename(fixturePath)

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
