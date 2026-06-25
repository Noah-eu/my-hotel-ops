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
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hotel-ops-date-tabs-'))

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

async function withTranspiledDateHelpers(run) {
    const tempRoot = await transpileModuleTree([
        'src/lib/dateTabs.ts',
        'src/services/opsStore.ts',
        'src/types.ts'
    ])

    try {
        const helpers = require(path.join(tempRoot, 'src/lib/dateTabs.js'))
        await run(helpers)
    } finally {
        await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => { })
    }
}

async function main() {
    await withTranspiledDateHelpers(async ({ buildDateSelectorItems, getPrimaryTabDateIso, resolveEffectiveDateIso }) => {
        const importedTabDates = {
            Dnes: '2026-06-24',
            Zitra: '2026-06-25',
            Pozitri: '2026-06-26'
        }
        const importedRoomsByDate = {
            '2026-06-24': [{ id: 'r24' }],
            '2026-06-25': [{ id: 'r25' }],
            '2026-06-26': [{ id: 'r26' }],
            '2026-06-27': [{ id: 'r27' }],
            '2026-06-28': [{ id: 'r28' }]
        }
        const now = new Date('2026-06-25T09:00:00')

        const csItems = buildDateSelectorItems({
            importedTabDates,
            importedRoomsByDate,
            selectedImportedDateIso: null,
            activeTab: 'Dnes',
            primaryLabels: {
                Dnes: 'Dnes',
                Zitra: 'Zítra',
                Pozitri: 'Pozítří'
            },
            locale: 'cs-CZ',
            now
        })

        const ukItems = buildDateSelectorItems({
            importedTabDates,
            importedRoomsByDate,
            selectedImportedDateIso: '2026-06-27',
            activeTab: 'Dnes',
            primaryLabels: {
                Dnes: 'Сьогодні',
                Zitra: 'Завтра',
                Pozitri: 'Післязавтра'
            },
            locale: 'uk-UA',
            now
        })

        assert(getPrimaryTabDateIso('Dnes', importedTabDates, now) === '2026-06-24', 'Primary Dnes tab must preserve imported ISO date')
        assert(getPrimaryTabDateIso('Zitra', importedTabDates, now) === '2026-06-25', 'Primary Zitra tab must preserve imported ISO date')
        assert(getPrimaryTabDateIso('Pozitri', importedTabDates, now) === '2026-06-26', 'Primary Pozitri tab must preserve imported ISO date')

        const csDateIsos = csItems.map((item) => item.dateIso)
        const ukDateIsos = ukItems.map((item) => item.dateIso)
        assert(csDateIsos.join('|') === '2026-06-24|2026-06-25|2026-06-26|2026-06-27|2026-06-28', 'Czech selector must contain all five dates in stable order')
        assert(ukDateIsos.join('|') === csDateIsos.join('|'), 'Translated labels must not change ISO order')
        assert(csItems[3]?.dateIso === '2026-06-27', '2026-06-27 must not be skipped from extra imported dates')
        assert(csItems[0]?.label === 'Dnes' && csItems[1]?.label === 'Zítra' && csItems[2]?.label === 'Pozítří', 'First three tabs must keep relative day labels in Czech')
        assert(ukItems[0]?.label === 'Сьогодні' && ukItems[1]?.label === 'Завтра' && ukItems[2]?.label === 'Післязавтра', 'First three tabs must keep relative day labels in Ukrainian')
        assert(ukItems[3]?.active === true, 'Selecting the 27 June extra tab must mark that ISO date as active')

        const effectiveDateIso = resolveEffectiveDateIso({
            tab: 'Dnes',
            importedTabDates,
            importedRoomsByDate,
            selectedImportedDateIso: '2026-06-27',
            now
        })
        assert(effectiveDateIso === '2026-06-27', 'Selecting 27 June must resolve the effective operational ISO date to 2026-06-27')
    })

    console.info('[validate:date-tabs] PASS')
    console.info('- Imported operational dates remain continuous after the first three relative tabs')
    console.info('- Relative labels stay display-only in Czech and Ukrainian')
    console.info('- Selecting 27 June resolves the 2026-06-27 operational data slice')
}

main().catch((error) => {
    console.error('[validate:date-tabs] FAIL')
    console.error(error instanceof Error ? error.stack || error.message : error)
    process.exitCode = 1
})