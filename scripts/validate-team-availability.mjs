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
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hotel-ops-team-availability-'))

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

async function withTranspiledTeamHelpers(run) {
    const tempRoot = await transpileModuleTree([
        'src/lib/teamAvailability.ts',
        'src/lib/roles.ts',
        'src/types.ts'
    ])

    try {
        const helpers = require(path.join(tempRoot, 'src/lib/teamAvailability.js'))
        await run(helpers)
    } finally {
        await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => { })
    }
}

async function main() {
    await withTranspiledTeamHelpers(async ({
        buildStaffAvailabilityRecordId,
        canManageStaffAvailability,
        dedupeSharedTeamMembers,
        resolveStaffAvailabilityForDate,
        summarizeTeamAvailability,
        upsertStaffAvailabilityRecord
    }) => {
        const todayIso = '2026-06-24'
        const tomorrowIso = '2026-06-25'
        const staff = [
            { id: 'legacy-david', name: 'David', role: 'admin', availability: 'dnes_nepracuji' },
            { id: 'uid-david', name: 'David', role: 'admin', availability: 'dnes_nepracuji' },
            { id: 'legacy-serhii', name: 'Serhii', role: 'maintenance', availability: 'dnes_nepracuji' },
            { id: 'uid-serhii', name: 'Serhii', role: 'maintenance', availability: 'dnes_nepracuji' }
        ]

        let records = []
        records = upsertStaffAvailabilityRecord(records, {
            id: buildStaffAvailabilityRecordId(todayIso, 'uid-david'),
            dateIso: todayIso,
            staffId: 'uid-david',
            availability: 'dnes_pracuji',
            updatedAt: '2026-06-24T08:00:00.000Z'
        })
        records = upsertStaffAvailabilityRecord(records, {
            id: buildStaffAvailabilityRecordId(todayIso, 'uid-serhii'),
            dateIso: todayIso,
            staffId: 'uid-serhii',
            availability: 'dnes_pracuji',
            updatedAt: '2026-06-24T08:01:00.000Z'
        })
        records = upsertStaffAvailabilityRecord(records, {
            id: buildStaffAvailabilityRecordId(tomorrowIso, 'uid-serhii'),
            dateIso: tomorrowIso,
            staffId: 'uid-serhii',
            availability: 'jen_urgentni',
            updatedAt: '2026-06-25T08:00:00.000Z'
        })

        const resolvedToday = dedupeSharedTeamMembers(resolveStaffAvailabilityForDate(staff, records, todayIso))
        const resolvedTomorrow = dedupeSharedTeamMembers(resolveStaffAvailabilityForDate(staff, records, tomorrowIso))
        const todaySummary = summarizeTeamAvailability(resolvedToday)
        const tomorrowSummary = summarizeTeamAvailability(resolvedTomorrow)

        assert(todaySummary.working === 2, 'Shared Team availability must count all hotel staff marked working for the selected date')
        assert(todaySummary.urgentOnly === 0, 'Shared Team availability must not leak another date into today')
        assert(todaySummary.notWorking === 0, 'Shared Team availability must not leave duplicate legacy rows as separate non-working entries')
        assert(resolvedToday.find((member) => member.name === 'David')?.availability === 'dnes_pracuji', 'David must resolve as working from shared availability state')
        assert(resolvedToday.find((member) => member.name === 'Serhii')?.availability === 'dnes_pracuji', 'Serhii must resolve as working from shared availability state')
        assert(tomorrowSummary.working === 0, 'Availability must remain date-scoped for future dates')
        assert(tomorrowSummary.urgentOnly === 1, 'Urgent-only counts must come from the selected date only')
        assert(tomorrowSummary.notWorking === 1, 'Staff without a selected-date availability record must remain not working for that date')
        assert(canManageStaffAvailability('maintenance', 'uid-serhii', 'uid-serhii') === true, 'Non-admin staff must be able to update their own availability')
        assert(canManageStaffAvailability('maintenance', 'uid-serhii', 'uid-david') === false, 'Non-admin staff must not be able to update another user availability')
        assert(canManageStaffAvailability('admin', 'uid-david', 'uid-serhii') === true, 'Admin must be able to update another staff availability')
    })

    console.info('[validate:team-availability] PASS')
    console.info('- Shared Team availability resolves hotel-wide per selected date')
    console.info('- Team counters are viewer-independent and duplicate-safe')
    console.info('- Team availability edits are limited to self unless the real user is admin')
}

main().catch((error) => {
    console.error('[validate:team-availability] FAIL')
    console.error(error instanceof Error ? error.stack || error.message : error)
    process.exitCode = 1
})