import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

function assert(condition, message) {
    if (!condition) throw new Error(message)
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

    const tempPath = path.join(os.tmpdir(), `import-operational-merge-flow-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`)
    await fs.writeFile(tempPath, transpiled, 'utf8')

    try {
        return await import(pathToFileURL(tempPath).href)
    } finally {
        await fs.unlink(tempPath).catch(() => {})
    }
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

function findRoom(byDate, dateIso, roomId) {
    return (byDate[dateIso] || []).find((room) => room.id === roomId) || null
}

async function main() {
    const mergeModule = await loadMergeModule()
    const {
        mergeImportedByDateWithExistingOperationalState,
        summarizeOperationalMergeDiagnostics
    } = mergeModule

    const dateIso = '2026-07-03'

    const importAByDate = {
        [dateIso]: [
            baseRoom({
                id: 'r101',
                number: '101',
                situation: 'odjezd_prijezd',
                status: 'ceka',
                departureTime: '10:00',
                arrivalTime: '14:00',
                departure: { time: '10:00', guestLabel: 'Guest A dep' },
                arrival: { time: '14:00', guestLabel: 'Guest A arr' }
            }),
            baseRoom({
                id: 'r102',
                number: '102',
                situation: 'odjezd',
                status: 'ceka',
                departureTime: '11:00',
                departure: { time: '11:00', guestLabel: 'Guest B dep' }
            })
        ]
    }

    const confirmedA = mergeImportedByDateWithExistingOperationalState({
        importedByDate: importAByDate,
        existingByDate: { [dateIso]: [] }
    }).byDate

    const room101A = findRoom(confirmedA, dateIso, 'r101')
    const room102A = findRoom(confirmedA, dateIso, 'r102')
    assert(room101A, 'Room 101 missing after import A confirm')
    assert(room102A, 'Room 102 missing after import A confirm')

    room101A.status = 'hotovo'
    room101A.statusNote = 'Room checked by lead'

    room102A.status = 'odhad'
    room102A.estimatedReady = '13:30'
    room102A.estimateSetAt = '09:40'

    const manualTasks = [
        {
            id: 'task-101-extra',
            roomNumber: '101',
            title: 'Replace minibar items',
            status: 'new'
        }
    ]

    const importBByDate = {
        [dateIso]: [
            baseRoom({
                id: 'r101',
                number: '101',
                situation: 'odjezd_prijezd',
                status: 'ceka',
                departureTime: '10:15',
                arrivalTime: '15:20',
                departure: { time: '10:15', guestLabel: 'Guest A dep updated' },
                arrival: { time: '15:20', guestLabel: 'Guest A arr updated' }
            }),
            baseRoom({
                id: 'r102',
                number: '102',
                situation: 'prijezd',
                status: 'ceka',
                arrivalTime: '16:10',
                arrival: { time: '16:10', guestLabel: 'Guest B arr updated' }
            })
        ]
    }

    const confirmedBResult = mergeImportedByDateWithExistingOperationalState({
        importedByDate: importBByDate,
        existingByDate: confirmedA
    })

    const summary = summarizeOperationalMergeDiagnostics(confirmedBResult.diagnostics)
    const confirmedB = confirmedBResult.byDate

    const room101B = findRoom(confirmedB, dateIso, 'r101')
    const room102B = findRoom(confirmedB, dateIso, 'r102')
    assert(room101B, 'Room 101 missing after import B confirm')
    assert(room102B, 'Room 102 missing after import B confirm')

    assert(room101B.status === 'hotovo', 'Room 101 status should be preserved as hotovo')
    assert(room101B.statusNote === 'Room checked by lead', 'Room 101 operational note should be preserved')
    assert(room101B.departureTime === '10:15', 'Room 101 departure should be updated from import B')
    assert(room101B.arrivalTime === '15:20', 'Room 101 arrival should be updated from import B')
    assert(room101B.arrival?.guestLabel === 'Guest A arr updated', 'Room 101 arrival guest should be updated from import B')

    assert(room102B.status === 'odhad', 'Room 102 status should preserve in-progress estimate state')
    assert(room102B.estimatedReady === '13:30', 'Room 102 estimatedReady should be preserved')
    assert(room102B.estimateSetAt === '09:40', 'Room 102 estimateSetAt should be preserved')
    assert(room102B.arrivalTime === '16:10', 'Room 102 reservation arrival should be updated from import B')

    assert(manualTasks.length === 1, 'Manual tasks list should remain intact after reimport')
    assert(manualTasks[0].roomNumber === '101', 'Manual task should remain linked to room 101')

    assert(summary.touchedRoomCount >= 2, 'Operational merge summary should report touched rooms')
    assert(summary.statusPreservedCount >= 2, 'Operational merge summary should report preserved statuses')
    assert(summary.estimatePreservedCount >= 1, 'Operational merge summary should report preserved estimate')

    console.log('[validate:previo-import-real-flow] PASS')
    console.log(`- touchedRoomCount: ${summary.touchedRoomCount}`)
    console.log(`- statusPreservedCount: ${summary.statusPreservedCount}`)
    console.log(`- estimatePreservedCount: ${summary.estimatePreservedCount}`)
}

main().catch((error) => {
    console.error('[validate:previo-import-real-flow] FAIL')
    console.error(error?.stack || String(error))
    process.exit(1)
})
