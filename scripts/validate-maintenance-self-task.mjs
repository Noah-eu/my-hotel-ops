import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

async function transpileModuleTree(relativePaths) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hotel-ops-maint-self-'))

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
        'src/lib/maintenanceSelfTask.ts',
        'src/lib/roles.ts',
        'src/types.ts',
        'src/i18n/cs.ts',
        'src/i18n/uk.ts',
        'src/i18n/index.ts'
    ])

    try {
        const helpers = require(path.join(tempRoot, 'src/lib/maintenanceSelfTask.js'))
        const i18n = require(path.join(tempRoot, 'src/i18n/index.js'))
        await run({ helpers, i18n })
    } finally {
        await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => { })
    }
}

async function main() {
    await withTranspiledModules(async ({ helpers, i18n }) => {
        const { canCreateMaintenanceSelfTask, createMaintenanceSelfTask, applyMaintenanceTaskStatus } = helpers
        const { createTranslator } = i18n

        assert(canCreateMaintenanceSelfTask('maintenance') === true, 'Maintenance role must be allowed to create self-task')
        assert(canCreateMaintenanceSelfTask('admin') === true, 'Admin role can create maintenance self-task')
        assert(canCreateMaintenanceSelfTask('cleaner') === false, 'Cleaner must not create maintenance self-task')
        assert(canCreateMaintenanceSelfTask('lead') === false, 'Lead must not create maintenance self-task by default')

        const selfTask = createMaintenanceSelfTask({
            title: 'Oprava kliky',
            roomNumber: '203',
            note: 'Skřípe při zavírání',
            priority: 'urgent',
            taskDateIso: '2026-06-25',
            createdAt: '10:11',
            createdByUid: 'uid-serhii',
            createdByName: 'Serhii',
            createdByRole: 'maintenance'
        })

        assert(selfTask.assignedToRole === 'maintenance', 'Self-task must be maintenance-assigned')
        assert(selfTask.assignedToUid === 'uid-serhii', 'Self-task must be assigned to the same maintenance user UID')
        assert(selfTask.createdSource === 'maintenance_self', 'Self-task must store maintenance_self source')
        assert(selfTask.status === 'new', 'Self-task must start active/new')
        assert(selfTask.title === 'Oprava kliky', 'User title must remain unchanged')
        assert(selfTask.note === 'Skřípe při zavírání', 'User note must remain unchanged')

        const tasks = [selfTask]
        const maintenanceVisible = tasks.filter((task) => task.assignedToRole === 'maintenance' || task.category === 'maintenance')
        const adminVisible = tasks.filter((task) => task.assignedToRole === 'maintenance' || task.category === 'maintenance')
        assert(maintenanceVisible.length === 1, 'Maintenance user should see self-task')
        assert(adminVisible.length === 1, 'Admin should see maintenance self-task')

        const doneTask = applyMaintenanceTaskStatus(selfTask, 'done', { uid: 'uid-serhii', name: 'Serhii' }, '2026-06-25T12:00:00.000Z')
        assert(doneTask.status === 'done', 'Marking task done should set status done')
        assert(doneTask.completedAt === '2026-06-25T12:00:00.000Z', 'Done task must store completedAt')
        assert(doneTask.completedByUid === 'uid-serhii', 'Done task must store completedByUid')
        assert(doneTask.completedByName === 'Serhii', 'Done task must store completedByName')

        const activeList = tasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled')
        const doneList = [doneTask].filter((task) => task.status === 'done')
        assert(activeList.length === 1, 'Task should appear in active list after creation')
        assert(doneList.length === 1, 'Done task should appear in maintenance Hotovo list')

        const csT = createTranslator('cs')
        const ukT = createTranslator('uk')
        assert(csT('maintenance.addSelfTask') === 'Přidat vlastní úkol', 'Czech self-task label must resolve')
        assert(ukT('maintenance.addSelfTask') === 'Додати власне завдання', 'Ukrainian self-task label must resolve')
    })

    console.info('[validate:maintenance-self-task] PASS')
    console.info('- Maintenance/admin can create maintenance self-tasks while cleaner/lead cannot by default')
    console.info('- Self-task stays visible in active maintenance list and moves to Hotovo when done with completion metadata')
    console.info('- User-entered title/note remain unchanged and labels resolve in Czech/Ukrainian')
}

main().catch((error) => {
    console.error('[validate:maintenance-self-task] FAIL')
    console.error(error instanceof Error ? error.stack || error.message : error)
    process.exitCode = 1
})