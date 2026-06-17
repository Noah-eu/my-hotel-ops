import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
    extractStateTextFromPdfBuffer,
    parsePrevioStatePdfText,
    buildPrevioStateImportPreview
} = require('../netlify/functions/lib/previo-state-preview.js')

const root = process.cwd()
const stavFixturePath = path.join(root, 'private-sources/previo/Stav.pdf')
const fallbackFixturePath = path.join(root, 'private-sources/previo/previo-state-2026-06-16-20.pdf')

function normalizeRoomNumber(raw) {
    return String(raw || '').trim().replace(/^0+/, '').padStart(3, '0')
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

async function resolveFixture() {
    try {
        await fs.access(stavFixturePath)
        return { filePath: stavFixturePath, isStavFixture: true }
    } catch {
        await fs.access(fallbackFixturePath)
        return { filePath: fallbackFixturePath, isStavFixture: false }
    }
}

function runChecks(parsed, fixtureInfo) {
    const failures = []

    expect(failures, parsed.rows.length > 0, 'Parser returned no rows')
    expect(failures, parsed.parsedDates.length > 0, 'Parser returned no parsed dates')

    if (fixtureInfo.isStavFixture) {
        const r17001 = findRow(parsed.rows, '2026-06-17', '001')
        const r17101 = findRow(parsed.rows, '2026-06-17', '101')
        const r17103 = findRow(parsed.rows, '2026-06-17', '103')
        const r18001 = findRow(parsed.rows, '2026-06-18', '001')
        const r20101 = findRow(parsed.rows, '2026-06-20', '101')
        const r20301 = findRow(parsed.rows, '2026-06-20', '301')
        const r21202 = findRow(parsed.rows, '2026-06-21', '202')

        expect(failures, Boolean(r17001), 'Missing row 2026-06-17/001')
        expect(failures, Boolean(r17101), 'Missing row 2026-06-17/101')
        expect(failures, Boolean(r17103), 'Missing row 2026-06-17/103')
        expect(failures, Boolean(r18001), 'Missing row 2026-06-18/001')
        expect(failures, Boolean(r20101), 'Missing row 2026-06-20/101')
        expect(failures, Boolean(r20301), 'Missing row 2026-06-20/301')
        expect(failures, Boolean(r21202), 'Missing row 2026-06-21/202')

        if (r18001) {
            expectEqual(failures, '18.6/001 departure', r18001.departureTime, '')
            expectEqual(failures, '18.6/001 arrival', r18001.arrivalTime, '')
            expect(failures, r18001.isStayover === true, '18.6/001 should be stayover row')
        }

        if (r21202) {
            expectEqual(failures, '21.6/202 arrival', r21202.arrivalTime, '22:00')
        }
    } else {
        const r16001 = findRow(parsed.rows, '2026-06-16', '001')
        expect(failures, Boolean(r16001), 'Missing fallback fixture row 2026-06-16/001')
        if (r16001) {
            expectEqual(failures, '16.6/001 departure', r16001.departureTime, '11:00')
            expect(failures, Boolean(r16001.arrivalTime), '16.6/001 arrival time should be present in fallback fixture')
        }
    }

    return failures
}

async function main() {
    const fixtureInfo = await resolveFixture()
    const pdfBuffer = await fs.readFile(fixtureInfo.filePath)

    const extracted = await extractStateTextFromPdfBuffer(pdfBuffer)
    const parsed = parsePrevioStatePdfText(extracted, new Date())
    const preview = buildPrevioStateImportPreview(parsed, [], new Date())

    const failures = runChecks(parsed, fixtureInfo)
    if (failures.length > 0) {
        console.error('[validate:previo-state] FAIL')
        failures.forEach((failure) => console.error(`- ${failure}`))
        process.exit(1)
    }

    const fixtureName = path.basename(fixtureInfo.filePath)
    if (!fixtureInfo.isStavFixture) {
        console.warn(`[validate:previo-state] Stav.pdf not found, used fallback fixture ${fixtureName}`)
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
