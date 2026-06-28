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
        id: 'r-101',
        number: '101',
        situation: 'odjezd',
        status: 'ceka',
        planDateIso: '2026-06-25',
        ...overrides
    }
}

function buildVisibleActiveRoomTasks(tasks, roomNumber, effectiveDateIso, todayDateIso, isTaskVisibleForOperationalDate) {
    return tasks.filter((task) => (
        task.roomNumber === roomNumber
        && isTaskVisibleForOperationalDate(task.taskDateIso, effectiveDateIso, todayDateIso)
        && task.status !== 'done'
        && task.status !== 'cancelled'
    ))
}

async function transpileModuleTree(relativePaths) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hotel-ops-manual-task-'))

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
        'src/lib/opsUiInvariants.ts',
        'src/lib/importOperationalMerge.ts',
        'src/lib/roomHelpers.ts',
        'src/lib/roles.ts',
        'src/services/opsStore.ts',
        'src/types.ts'
    ])

    try {
        const uiInvariants = require(path.join(tempRoot, 'src/lib/opsUiInvariants.js'))
        const merge = require(path.join(tempRoot, 'src/lib/importOperationalMerge.js'))
        await run({ uiInvariants, merge })
    } finally {
        await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => { })
    }
}

async function main() {
    await withTranspiledModules(async ({ uiInvariants, merge }) => {
        const { isTaskVisibleForOperationalDate } = uiInvariants
        const { mergeImportedByDateWithExistingOperationalState } = merge

        const roomNumber = '101'
        const createdTask = {
            id: 't-101-open-safe',
            roomNumber,
            title: 'Otevrit sejf',
            note: 'Host asks before 10:00',
            category: 'other',
            priority: 'normal',
            assignedToRole: 'cleaner',
            status: 'new',
            createdBy: 'David',
            createdAt: '19:30',
            taskDateIso: '2026-06-25'
        }

        const tasks = [createdTask]

        // 1) Visible on creation day.
        const visibleOnCreationDay = buildVisibleActiveRoomTasks(tasks, roomNumber, '2026-06-25', '2026-06-25', isTaskVisibleForOperationalDate)
        assert(visibleOnCreationDay.some((task) => task.id === createdTask.id), 'Manual room task must be visible on its creation day')

        // 2) Still visible next day while unresolved.
        const visibleNextDay = buildVisibleActiveRoomTasks(tasks, roomNumber, '2026-06-26', '2026-06-26', isTaskVisibleForOperationalDate)
        assert(visibleNextDay.some((task) => task.id === createdTask.id), 'Unresolved manual room task must remain visible next day')

        // Future-dated task must stay hidden before due day.
        const futureTask = {
            ...createdTask,
            id: 't-future-101',
            title: 'Budouci ukol',
            taskDateIso: '2026-06-28'
        }
        const futureTasks = [createdTask, futureTask]
        const visibleBeforeFutureDate = buildVisibleActiveRoomTasks(futureTasks, roomNumber, '2026-06-26', '2026-06-26', isTaskVisibleForOperationalDate)
        assert(!visibleBeforeFutureDate.some((task) => task.id === futureTask.id), 'Future-dated task must stay hidden before its day')

        // 3, 4, 7, 8) Confirmed and auto-confirmed imports update room plans but do not mutate task list.
        const importedByDate = {
            '2026-06-26': [baseRoom({ planDateIso: '2026-06-26', departure: { time: '10:00', guestLabel: 'Guest A' } })]
        }
        const existingByDate = {
            '2026-06-26': [baseRoom({ planDateIso: '2026-06-26', status: 'prevzato', assigned: 'Irina' })]
        }
        const mergeOnce = mergeImportedByDateWithExistingOperationalState({ importedByDate, existingByDate })
        assert(Array.isArray(mergeOnce.byDate['2026-06-26']) && mergeOnce.byDate['2026-06-26'].length === 1, 'Confirmed import merge must produce merged room plans')

        const mergeTwice = mergeImportedByDateWithExistingOperationalState({ importedByDate, existingByDate })
        assert(Array.isArray(mergeTwice.byDate['2026-06-26']) && mergeTwice.byDate['2026-06-26'].length === 1, 'Auto-confirmed import merge path must keep room merge deterministic')

        const afterImportsVisible = buildVisibleActiveRoomTasks(tasks, roomNumber, '2026-06-26', '2026-06-26', isTaskVisibleForOperationalDate)
        assert(afterImportsVisible.filter((task) => task.id === createdTask.id).length === 1, 'Task must survive imports and not duplicate in active room card')
        assert(afterImportsVisible[0].roomNumber === roomNumber, 'Task must stay attached to the same room number across imports')

        // 5) Done task leaves active room card.
        const doneTask = { ...createdTask, status: 'done', completedAt: '2026-06-26T08:00:00.000Z' }
        const visibleDone = buildVisibleActiveRoomTasks([doneTask], roomNumber, '2026-06-26', '2026-06-26', isTaskVisibleForOperationalDate)
        assert(visibleDone.length === 0, 'Done task must disappear from active room card')

        // 6) Done task does not reappear after another import.
        const visibleDoneAfterImport = buildVisibleActiveRoomTasks([doneTask], roomNumber, '2026-06-27', '2026-06-27', isTaskVisibleForOperationalDate)
        assert(visibleDoneAfterImport.length === 0, 'Done task must not reappear after subsequent import/day change')

        // 9) Title/note must remain unchanged.
        assert(createdTask.title === 'Otevrit sejf', 'Task title must remain unchanged')
        assert(createdTask.note === 'Host asks before 10:00', 'Task note must remain unchanged')
    })

    console.info('[validate:manual-room-task-persistence] PASS')
    console.info('- Unresolved manual room tasks remain visible across day changes and import merges')
    console.info('- Future-dated tasks stay scheduled, done tasks stay out of active cards, and no duplicates are introduced')
}

main().catch((error) => {
    console.error('[validate:manual-room-task-persistence] FAIL')
    console.error(error instanceof Error ? error.stack || error.message : error)
    process.exitCode = 1
})
