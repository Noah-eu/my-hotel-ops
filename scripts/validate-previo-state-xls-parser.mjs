import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const XLSX = require('xlsx')
const {
    PREVIO_STAV_PARSER_VERSION,
    extractStateDataFromXlsxBuffer,
    parsePrevioStateXlsxData,
    buildPrevioStateImportPreview,
    buildByDateFromPreview,
    evaluatePrevioStateImportSafety,
    detectMissingDatesInRange
} = require('../netlify/functions/lib/previo-state-preview.js')

function expect(failures, condition, message) {
    if (!condition) failures.push(message)
}

function expectEqual(failures, label, actual, expected) {
    if ((actual || '') !== (expected || '')) {
        failures.push(`${label}: expected "${expected}", got "${actual || ''}"`)
    }
}

function findRow(rows, dateIso, roomNumber) {
    const normalizedRoom = String(roomNumber).padStart(3, '0')
    return rows.find((row) => String(row.dateIso || '') === dateIso && String(row.roomNumber || '').padStart(3, '0') === normalizedRoom)
}

function findPlanRow(byDate, dateIso, roomNumber) {
    const normalizedRoom = String(roomNumber).padStart(3, '0')
    const rows = Array.isArray(byDate?.[dateIso]) ? byDate[dateIso] : []
    return rows.find((row) => String(row.number || '').padStart(3, '0') === normalizedRoom)
}

function buildSheetRows(dayLabel) {
    const roomNumbers = ['001', '101', '102', '103', '104', '105', '201', '202', '203', '204', '205', '301']

    const rows = roomNumbers.map((room, index) => {
        const boxNumber = (index % 11) + 1
        return [
            '20. 6.',
            room === '102' ? '102 Studio' : `${room} `,
            '',
            '',
            `(2) Guest Stay ${room} ${dayLabel}`,
            '24. 6.',
            '',
            '',
            `Recepce: BOX ${boxNumber}...`
        ]
    })

    rows[0] = [
        '20. 6.',
        '001 ',
        '(2) Guest Out 001',
        `(3) Guest In 001 ${dayLabel}\n15:00 - 16:00 (Alfred)`,
        '',
        '24. 6.',
        'Recepce: BOX 1...',
        'Recepce: BOX 5...',
        ''
    ]

    rows[2] = [
        '20. 6.',
        '102 Studio',
        '(1) Guest Out 102',
        '',
        '',
        '24. 6.',
        'Recepce: BOX 3...',
        '',
        ''
    ]

    rows[5] = [
        '20. 6.',
        '105 ',
        '',
        `(2) Guest In 105 ${dayLabel}`,
        '',
        '24. 6.',
        '',
        'Recepce: BOX 4...',
        ''
    ]

    return rows
}

function buildAnonymizedWorkbookBuffer() {
    const wb = XLSX.utils.book_new()

    const headerRows = [
        ['', '', '', '', '', '', 'Poznámky', '', '', '', '', ''],
        ['Datum (příjezd)', 'Pokoj', 'Odjezd', 'Příjezd', 'Probíhající', 'Datum (odjezd)', 'Odjezd', 'Příjezd', 'Probíhající', '', '', '']
    ]

    const day22 = [...headerRows, ...buildSheetRows('D1')]
    const day23 = [...headerRows, ...buildSheetRows('D2')]

    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(day22), '2026-06-22')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(day23), '2026-06-23')

    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
}

function run() {
    const failures = []
    const workbookBuffer = buildAnonymizedWorkbookBuffer()

    const extracted = extractStateDataFromXlsxBuffer(workbookBuffer)
    const parsed = parsePrevioStateXlsxData(extracted, new Date('2026-06-22T00:00:00'))
    const preview = buildPrevioStateImportPreview(parsed, [], new Date('2026-06-22T00:00:00'))
    const byDate = buildByDateFromPreview(preview, [], '22.06.2026 07:00')

    expect(failures, parsed.rows.length >= 20, `Expected >=20 parsed rows, got ${parsed.rows.length}`)
    expectEqual(failures, 'Parsed dates count', String(parsed.parsedDates.length), '2')
    expectEqual(failures, 'Preview days count', String(preview.days.length), '2')

    const r22001 = findRow(parsed.rows, '2026-06-22', '001')
    expect(failures, Boolean(r22001), 'Missing parsed row 2026-06-22/001')
    if (r22001) {
        expectEqual(failures, '22.6/001 departure time', r22001.departureTime, '11:00')
        expectEqual(failures, '22.6/001 arrival time', r22001.arrivalTime, '15:00')
        expectEqual(failures, '22.6/001 arrival guest count', String(r22001.arrivalGuestCount), '3')
    }

    const r22101 = findRow(parsed.rows, '2026-06-22', '101')
    expect(failures, Boolean(r22101), 'Missing parsed row 2026-06-22/101')
    if (r22101) {
        expect(failures, r22101.isStayover === true, '22.6/101 should be stayover')
        expectEqual(failures, '22.6/101 stayover count', String(r22101.stayoverGuestCount), '2')
        expectEqual(failures, '22.6/101 stayover until', r22101.stayoverUntil, '2026-06-24')
    }

    const p22001 = findPlanRow(byDate, '2026-06-22', '001')
    expect(failures, Boolean(p22001), 'Missing byDate row 2026-06-22/001')
    if (p22001) {
        expectEqual(failures, '22.6/001 byDate departure time', p22001.departureTime, '11:00')
        expectEqual(failures, '22.6/001 byDate arrival time', p22001.arrivalTime, '15:00')
        expect(failures, p22001.stateSource === 'previo-state-pdf', 'byDate row must use existing stateSource marker')
    }

    const p22101 = findPlanRow(byDate, '2026-06-22', '101')
    expect(failures, Boolean(p22101), 'Missing byDate row 2026-06-22/101')
    if (p22101) {
        expect(failures, p22101.occupiedConfirmed === true, '22.6/101 should be occupiedConfirmed in byDate')
        expectEqual(failures, '22.6/101 stayover guest', p22101.stayoverGuestName, 'Guest Stay 101 D1')
    }

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
        checkedAt: new Date('2026-06-22T07:00:00')
    })

    expect(failures, safety.blocked === false, `XLS anonymized preview is unexpectedly blocked: ${(safety.blocks || []).join(' | ')}`)

    if (failures.length > 0) {
        console.error('[validate:previo-state-xls] FAIL')
        failures.forEach((failure) => console.error(`- ${failure}`))
        process.exit(1)
    }

    console.log('[validate:previo-state-xls] PASS')
    console.log(`- Parsed rows: ${parsed.rows.length}`)
    console.log(`- Days: ${preview.days.length}`)
    console.log(`- Safety: ${safety.status}`)
}

run()
