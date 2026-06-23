import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

function baseRoom(overrides = {}) {
    return {
        id: 'r101',
        number: '101',
        situation: 'volny',
        status: 'neni',
        ...overrides
    }
}

async function loadMergeModule() {
    const sourcePath = path.join(process.cwd(), 'src/lib/importOperationalMerge.ts')
    const sourceCode = await fs.readFile(sourcePath, 'utf8')
    const transpiled = ts.transpileModule(sourceCode, {
        compilerOptions: {
            module: ts.ModuleKind.ES2022,
            target: ts.ScriptTarget.ES2022
        },
        fileName: sourcePath
    }).outputText

    const tempPath = path.join(os.tmpdir(), `importOperationalMerge-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`)
    await fs.writeFile(tempPath, transpiled, 'utf8')

    try {
        return await import(pathToFileURL(tempPath).href)
    } finally {
        await fs.unlink(tempPath).catch(() => { })
    }
}

async function main() {
    const mergeModule = await loadMergeModule()
    const {
        mergeImportedByDateWithExistingOperationalState,
        summarizeOperationalMergeDiagnostics
    } = mergeModule

    const importedByDate = {
        '2026-07-01': [
            baseRoom({
                id: 'r101',
                number: '101',
                situation: 'odjezd_prijezd',
                status: 'ceka',
                departureTime: '10:30',
                arrivalTime: '15:00',
                departure: { time: '10:30', guestLabel: 'Old guest' },
                arrival: { time: '15:00', guestLabel: 'New guest' }
            }),
            baseRoom({
                id: 'r102',
                number: '102',
                situation: 'volny',
                status: 'neni',
                freeConfirmed: true
            }),
            baseRoom({
                id: 'r103',
                number: '103',
                situation: 'odjezd',
                status: 'ceka',
                departureTime: '11:00',
                departure: { time: '11:00', guestLabel: 'Checkout guest' }
            })
        ],
        '2026-07-02': [
            baseRoom({
                id: 'r201',
                number: '201',
                situation: 'prijezd',
                status: 'ceka',
                arrivalTime: '14:00',
                arrival: { time: '14:00', guestLabel: 'Tomorrow guest' }
            })
        ]
    }

    const existingByDate = {
        '2026-07-01': [
            baseRoom({
                id: 'r101',
                number: '101',
                situation: 'odjezd_prijezd',
                status: 'hotovo',
                assigned: 'Iryna',
                estimatedReady: '12:10',
                estimateSetAt: '09:00',
                statusNote: 'Host neodešel',
                checkoutException: true,
                departureTime: '11:00',
                arrivalTime: '14:00'
            }),
            baseRoom({
                id: 'r102',
                number: '102',
                situation: 'odjezd',
                status: 'prevzato',
                assigned: 'Iryna'
            }),
            baseRoom({
                id: 'r103',
                number: '103',
                situation: 'volny',
                status: 'neni'
            })
        ]
    }

    const mergeResult = mergeImportedByDateWithExistingOperationalState({
        importedByDate,
        existingByDate
    })

    const summary = summarizeOperationalMergeDiagnostics(mergeResult.diagnostics)

    const merged101 = mergeResult.byDate['2026-07-01'].find((room) => room.id === 'r101')
    const merged102 = mergeResult.byDate['2026-07-01'].find((room) => room.id === 'r102')
    const merged103 = mergeResult.byDate['2026-07-01'].find((room) => room.id === 'r103')
    const merged201 = mergeResult.byDate['2026-07-02'].find((room) => room.id === 'r201')

    assert(Boolean(merged101), 'Missing merged room 101')
    assert(Boolean(merged102), 'Missing merged room 102')
    assert(Boolean(merged103), 'Missing merged room 103')
    assert(Boolean(merged201), 'Missing merged room 201')

    assert(merged101.status === 'hotovo', 'Room 101 should preserve status=hotovo')
    assert(merged101.assigned === 'Iryna', 'Room 101 should preserve assignment')
    assert(merged101.estimatedReady === '12:10', 'Room 101 should preserve estimatedReady')
    assert(merged101.estimateSetAt === '09:00', 'Room 101 should preserve estimateSetAt')
    assert(merged101.statusNote === 'Host neodešel', 'Room 101 should preserve statusNote')
    assert(merged101.checkoutException === true, 'Room 101 should preserve checkoutException')
    assert(merged101.departureTime === '10:30', 'Room 101 should still take imported departureTime')
    assert(merged101.arrivalTime === '15:00', 'Room 101 should still take imported arrivalTime')

    assert(merged102.status === 'prevzato', 'Room 102 should preserve in-progress status')
    assert(merged102.assigned === 'Iryna', 'Room 102 should preserve assignment')

    assert(merged103.status === 'ceka', 'Room 103 should not preserve untouched status')
    assert(!merged103.assigned, 'Room 103 should not gain assignment')

    assert(merged201.status === 'ceka', 'Room 201 should remain imported when no prior state exists')
    assert(merged201.arrivalTime === '14:00', 'Room 201 imported arrival must remain unchanged')

    assert(summary.touchedRoomCount >= 2, 'Summary should report preserved operational rooms')
    assert(summary.statusPreservedCount >= 2, 'Summary should include preserved statuses')
    assert(summary.estimatePreservedCount >= 1, 'Summary should include preserved estimates')
    assert(summary.assignmentPreservedCount >= 2, 'Summary should include preserved assignments')
    assert(summary.problemPreservedCount >= 1, 'Summary should include preserved problem flags')
    assert(summary.inconsistencyWarningCount >= 1, 'Summary should report inconsistent-state warnings')

    console.log('[validate:previo-reimport-merge] PASS')
    console.log(`- touchedRoomCount: ${summary.touchedRoomCount}`)
    console.log(`- statusPreservedCount: ${summary.statusPreservedCount}`)
    console.log(`- inconsistencyWarningCount: ${summary.inconsistencyWarningCount}`)
}

main().catch((error) => {
    console.error('[validate:previo-reimport-merge] FAIL')
    console.error(error?.stack || String(error))
    process.exit(1)
})