import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
    buildPrevioStateImportPreview,
    buildByDateFromPreview
} = require('../netlify/functions/lib/previo-state-preview.js')
const {
    overlayArrivalTimesFromPdf,
    annotatePreviewWithArrivalOverlay,
    annotateByDateWithArrivalOverlay
} = require('../netlify/functions/lib/previo-arrival-overlay.js')

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

function findRoom(byDate, dateIso, roomNumber) {
    const target = String(roomNumber).padStart(3, '0')
    const rows = Array.isArray(byDate?.[dateIso]) ? byDate[dateIso] : []
    return rows.find((room) => String(room.number || '').padStart(3, '0') === target) || null
}

function toComparableRoom(room) {
    if (!room) return null
    return {
        number: room.number,
        situation: room.situation,
        status: room.status,
        departure: room.departure || null,
        arrival: room.arrival
            ? {
                ...room.arrival,
                time: undefined,
                timeSource: undefined
            }
            : null,
        departureTime: room.departureTime || null,
        arrivalTime: null,
        guestCount: room.guestCount ?? null,
        box: room.box ?? null,
        notes: room.notes || [],
        occupiedConfirmed: Boolean(room.occupiedConfirmed),
        freeConfirmed: Boolean(room.freeConfirmed),
        stayoverGuestName: room.stayoverGuestName || null,
        stayoverUntil: room.stayoverUntil || null,
        stateSource: room.stateSource || null
    }
}

function findOverlayAuditEntry(overlaySummary, dateIso, roomNumber) {
    const targetDate = String(dateIso || '').trim()
    const targetRoom = String(roomNumber || '').trim().padStart(3, '0')
    const rows = Array.isArray(overlaySummary?.audit) ? overlaySummary.audit : []
    return rows.find((entry) => (
        String(entry?.dateIso || '').trim() === targetDate
        && String(entry?.roomNumber || '').trim().padStart(3, '0') === targetRoom
    )) || null
}

async function main() {
    const fixturePath = path.join(process.cwd(), 'scripts/fixtures/previo-state-arrival-overlay.golden.json')
    const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'))

    const referenceDate = new Date(fixture.referenceDate)
    const importedAt = String(fixture.importedAt || '22.06.2026 19:01')

    const primaryParsed = fixture.primaryParsed
    const overlayParsed = fixture.overlayParsed

    const basePreview = buildPrevioStateImportPreview(primaryParsed, [], referenceDate)
    const baseByDate = buildByDateFromPreview(basePreview, [], importedAt)

    const overlayResult = overlayArrivalTimesFromPdf({
        primaryParsed,
        overlayParsed,
        primaryKind: 'xlsx'
    })

    let hybridPreview = buildPrevioStateImportPreview(overlayResult.parsed, [], referenceDate)
    if ((overlayResult.overlay?.appliedRows || 0) > 0) {
        hybridPreview = annotatePreviewWithArrivalOverlay(hybridPreview, overlayResult.overlay.applied)
    }

    let hybridByDate = buildByDateFromPreview(hybridPreview, [], importedAt)
    if ((overlayResult.overlay?.appliedRows || 0) > 0) {
        hybridByDate = annotateByDateWithArrivalOverlay(hybridByDate, overlayResult.overlay.applied)
    }

    assert(
        overlayResult.overlay?.appliedRows === fixture.expected.appliedRows,
        `Expected ${fixture.expected.appliedRows} overlaid rows, got ${overlayResult.overlay?.appliedRows || 0}`
    )
    assert(
        (overlayResult.overlay?.auditCheckedRows || 0) === (fixture.expected.auditCheckedRows || 0),
        `Expected ${fixture.expected.auditCheckedRows || 0} audited overlay rows, got ${overlayResult.overlay?.auditCheckedRows || 0}`
    )
    assert(
        (overlayResult.overlay?.auditMismatches || 0) === (fixture.expected.auditMismatches || 0),
        `Expected ${fixture.expected.auditMismatches || 0} overlay audit mismatches, got ${overlayResult.overlay?.auditMismatches || 0}`
    )

    for (const changed of fixture.expected.changed || []) {
        const baseRoom = findRoom(baseByDate, changed.dateIso, changed.roomNumber)
        const hybridRoom = findRoom(hybridByDate, changed.dateIso, changed.roomNumber)

        assert(Boolean(baseRoom), `Missing base room ${changed.dateIso}/${changed.roomNumber}`)
        assert(Boolean(hybridRoom), `Missing hybrid room ${changed.dateIso}/${changed.roomNumber}`)
        assert(hybridRoom.arrivalTime === changed.arrivalTime, `${changed.dateIso}/${changed.roomNumber}: arrival time was not overlaid`)
        assert(baseRoom.arrivalTime !== hybridRoom.arrivalTime, `${changed.dateIso}/${changed.roomNumber}: arrival time should differ after overlay`)
        assert(hybridRoom.arrivalTimeSource === 'pdf_overlay', `${changed.dateIso}/${changed.roomNumber}: arrivalTimeSource marker missing`)
        assert(hybridRoom.arrival?.timeSource === 'pdf_overlay', `${changed.dateIso}/${changed.roomNumber}: nested arrival timeSource marker missing`)

        const auditEntry = findOverlayAuditEntry(overlayResult.overlay, changed.dateIso, changed.roomNumber)
        assert(Boolean(auditEntry), `${changed.dateIso}/${changed.roomNumber}: missing overlay audit entry`)
        assert(auditEntry.reason === 'ok', `${changed.dateIso}/${changed.roomNumber}: overlay audit reason must be ok`) 
        assert(auditEntry.finalTime === changed.arrivalTime, `${changed.dateIso}/${changed.roomNumber}: overlay audit final time mismatch`)

        const comparableBase = toComparableRoom(baseRoom)
        const comparableHybrid = toComparableRoom(hybridRoom)
        assert(
            JSON.stringify(comparableBase) === JSON.stringify(comparableHybrid),
            `${changed.dateIso}/${changed.roomNumber}: fields other than arrival time changed after overlay`
        )
    }

    for (const unchanged of fixture.expected.unchanged || []) {
        const baseRoom = findRoom(baseByDate, unchanged.dateIso, unchanged.roomNumber)
        const hybridRoom = findRoom(hybridByDate, unchanged.dateIso, unchanged.roomNumber)
        assert(Boolean(baseRoom), `Missing base room ${unchanged.dateIso}/${unchanged.roomNumber}`)
        assert(Boolean(hybridRoom), `Missing hybrid room ${unchanged.dateIso}/${unchanged.roomNumber}`)
        assert(
            JSON.stringify(baseRoom) === JSON.stringify(hybridRoom),
            `${unchanged.dateIso}/${unchanged.roomNumber}: room changed even though no overlay should apply`
        )
    }

    const freeRoomCfg = fixture.expected.freeRoom
    if (freeRoomCfg) {
        const baseFreeRoom = findRoom(baseByDate, freeRoomCfg.dateIso, freeRoomCfg.roomNumber)
        const hybridFreeRoom = findRoom(hybridByDate, freeRoomCfg.dateIso, freeRoomCfg.roomNumber)
        assert(Boolean(baseFreeRoom?.freeConfirmed), `${freeRoomCfg.dateIso}/${freeRoomCfg.roomNumber}: free room should be derived from XLS baseline`)
        assert(Boolean(hybridFreeRoom?.freeConfirmed), `${freeRoomCfg.dateIso}/${freeRoomCfg.roomNumber}: free room should stay derived after PDF overlay`)
    }

    const mainVsAlfred = findOverlayAuditEntry(overlayResult.overlay, '2026-06-22', '204')
    assert(Boolean(mainVsAlfred), 'Missing audit row for 2026-06-22/204')
    assert(mainVsAlfred.pdfMainTime === '11:00', '2026-06-22/204: expected main PDF time 11:00')
    assert(mainVsAlfred.alfredWindow === '14:00 - 15:00', '2026-06-22/204: expected Alfred window metadata')
    assert(mainVsAlfred.finalTime === '11:00', '2026-06-22/204: final time must prefer main PDF time over Alfred window')

    const baseDay = basePreview.days.find((day) => day.dateIso === '2026-06-22')
    const hybridDay = hybridPreview.days.find((day) => day.dateIso === '2026-06-22')
    assert(Boolean(baseDay && hybridDay), 'Expected day 2026-06-22 in both previews')
    assert(
        JSON.stringify(baseDay.derivedFreeRooms || []) === JSON.stringify(hybridDay.derivedFreeRooms || []),
        'Derived free rooms changed after arrival-time overlay'
    )

    console.log('[validate:previo-state-arrival-overlay] PASS')
    console.log(`- Applied overlay rows: ${overlayResult.overlay?.appliedRows || 0}`)
    console.log(`- Overlay audit rows: ${overlayResult.overlay?.auditCheckedRows || 0}`)
    console.log(`- Changed room: ${fixture.expected.changed?.[0]?.dateIso}/${fixture.expected.changed?.[0]?.roomNumber}`)
}

main().catch((error) => {
    console.error('[validate:previo-state-arrival-overlay] FAIL')
    console.error(error && error.stack ? error.stack : String(error))
    process.exit(1)
})
