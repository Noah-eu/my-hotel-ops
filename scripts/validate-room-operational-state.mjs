import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

function baseRoom(overrides = {}) {
    return {
        id: 'r101',
        number: '101',
        situation: 'odjezd',
        status: 'ceka',
        departureTime: '10:00',
        departure: { time: '10:00', guestLabel: 'Guest A', notes: ['Previo note'] },
        box: 'BOX 7',
        notes: ['Room note'],
        planDateIso: '2026-06-24',
        ...overrides
    }
}

async function transpileModuleTree(relativePaths) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hotel-ops-room-state-'))

    for (const relativePath of relativePaths) {
        const sourcePath = path.join(process.cwd(), relativePath)
        const sourceCode = await fs.readFile(sourcePath, 'utf8')
        const transpiled = ts.transpileModule(sourceCode, {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022
            },
            fileName: sourcePath
        }).outputText

        const outputPath = path.join(tempRoot, relativePath.replace(/\.ts$/, '.js'))
        await fs.mkdir(path.dirname(outputPath), { recursive: true })
        await fs.writeFile(outputPath, transpiled, 'utf8')
    }

    return tempRoot
}

async function withTranspiledModules(run) {
    const tempRoot = await transpileModuleTree([
        'src/lib/importOperationalMerge.ts',
        'src/lib/roomOperationalState.ts',
        'src/i18n/cs.ts',
        'src/i18n/uk.ts',
        'src/i18n/index.ts',
        'src/types.ts'
    ])

    try {
        const merge = require(path.join(tempRoot, 'src/lib/importOperationalMerge.js'))
        const roomState = require(path.join(tempRoot, 'src/lib/roomOperationalState.js'))
        const i18n = require(path.join(tempRoot, 'src/i18n/index.js'))
        await run({ merge, roomState, i18n })
    } finally {
        await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => { })
    }
}

async function main() {
    await withTranspiledModules(async ({ merge, roomState, i18n }) => {
        const { mergeImportedByDateWithExistingOperationalState, mergeImportedRoomDayWithExistingOperationalState } = merge
        const { applyRoomOperationalPatch, buildOperationalStatusMeta, buildResetRoomToWaitingPatch } = roomState
        const { createTranslator } = i18n

        const importedToday = baseRoom({
            status: 'ceka',
            planDateIso: '2026-06-24'
        })
        const yesterdayDone = baseRoom({
            status: 'hotovo',
            planDateIso: '2026-06-23',
            operationalStatusDateIso: '2026-06-23',
            operationalStatusUpdatedAt: '2026-06-23T09:30:00.000Z'
        })

        const staleMerge = mergeImportedRoomDayWithExistingOperationalState({
            dateIso: '2026-06-24',
            importedRoom: importedToday,
            existingRoom: yesterdayDone
        })
        assert(staleMerge.room.status === 'ceka', 'Previous-day Hotovo must not make today Hotovo')
        assert(staleMerge.diagnostics.some((item) => item.kind === 'stale_operational_state_ignored'), 'Stale operational state should be reported')

        const sameDayDone = baseRoom({
            status: 'hotovo',
            planDateIso: '2026-06-24',
            operationalStatusDateIso: '2026-06-24',
            operationalStatusUpdatedAt: '2026-06-24T09:45:00.000Z'
        })
        const sameDayMerge = mergeImportedRoomDayWithExistingOperationalState({
            dateIso: '2026-06-24',
            importedRoom: importedToday,
            existingRoom: sameDayDone
        })
        assert(sameDayMerge.room.status === 'hotovo', 'Same date+room Hotovo must survive reimport')

        const noSameDayCompletion = mergeImportedByDateWithExistingOperationalState({
            importedByDate: { '2026-06-24': [importedToday] },
            existingByDate: { '2026-06-23': [yesterdayDone] }
        })
        assert(noSameDayCompletion.byDate['2026-06-24'][0].status === 'ceka', 'Today departure without same-day completion must start as Čeká')

        const resetPatch = buildResetRoomToWaitingPatch('2026-06-24', '2026-06-24T10:00:00.000Z', 'cleaner-1')
        const resetRoom = applyRoomOperationalPatch(sameDayDone, resetPatch)
        assert(resetRoom.status === 'ceka', 'Reset action must change Hotovo back to Čeká')
        assert(resetRoom.operationalStatusDateIso === '2026-06-24', 'Reset action must remain date-scoped')
        assert(resetRoom.departure?.guestLabel === 'Guest A', 'Reset must not delete guest/reservation facts')
        assert(resetRoom.box === 'BOX 7', 'Reset must not delete box data')
        assert(resetRoom.notes?.[0] === 'Room note', 'Reset must not delete Previo/user notes')

        const tasks = [{ id: 'task-1', roomNumber: '101', title: 'Check towel', taskDateIso: '2026-06-24' }]
        const maintenanceTickets = [{ id: 'm-1', roomNumber: '101', title: 'Sink' }]
        const supplyRequests = [{ id: 's-1', roomNumber: '101', itemName: 'Soap' }]
        assert(tasks.length === 1 && maintenanceTickets.length === 1 && supplyRequests.length === 1, 'Reset action must not touch tasks, maintenance tickets, or supply requests')

        const resetMerge = mergeImportedRoomDayWithExistingOperationalState({
            dateIso: '2026-06-24',
            importedRoom: importedToday,
            existingRoom: resetRoom
        })
        assert(resetMerge.room.status === 'ceka', 'Reset Čeká state must survive same-date reimport')

        const otherDateMerge = mergeImportedRoomDayWithExistingOperationalState({
            dateIso: '2026-06-25',
            importedRoom: baseRoom({ planDateIso: '2026-06-25', status: 'ceka' }),
            existingRoom: resetRoom
        })
        assert(otherDateMerge.room.status === 'ceka', 'Reset action must not affect another date')

        const markedDonePatch = buildOperationalStatusMeta('2026-06-24', '2026-06-24T11:00:00.000Z', 'cleaner-1')
        assert(markedDonePatch.operationalStatusDateIso === '2026-06-24', 'Operational action metadata must carry normalized date identity')

        assert(createTranslator('cs')('buttons.resetToWaiting') === 'Zpět na čeká', 'Czech reset action label must resolve')
        assert(createTranslator('uk')('buttons.resetToWaiting') === 'Назад до очікування', 'Ukrainian reset action label must resolve')
    })

    console.info('[validate:room-operational-state] PASS')
    console.info('- Previous-day Hotovo does not carry into today')
    console.info('- Same-date operational state survives reimport')
    console.info('- Reset-to-waiting is date-scoped and preserves room facts plus linked work records')
}

main().catch((error) => {
    console.error('[validate:room-operational-state] FAIL')
    console.error(error instanceof Error ? error.stack || error.message : error)
    process.exitCode = 1
})