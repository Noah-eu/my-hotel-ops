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
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hotel-ops-staff-i18n-'))

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

async function withTranspiledI18n(run) {
    const tempRoot = await transpileModuleTree([
        'src/i18n/cs.ts',
        'src/i18n/uk.ts',
        'src/i18n/index.ts'
    ])

    try {
        const helpers = require(path.join(tempRoot, 'src/i18n/index.js'))
        await run(helpers)
    } finally {
        await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
    }
}

async function main() {
    await withTranspiledI18n(async ({
        LANGUAGE_STORAGE_KEY,
        createTranslator,
        resolveLanguage,
        translate
    }) => {
        assert(resolveLanguage(undefined) === 'cs', 'Missing language must default to Czech')
        assert(resolveLanguage(null) === 'cs', 'Null language must default to Czech')
        assert(resolveLanguage('garbage') === 'cs', 'Unknown language values must fall back to Czech')
        assert(resolveLanguage('uk') === 'uk', 'Ukrainian must resolve explicitly')
        assert(LANGUAGE_STORAGE_KEY === 'hotelOpsLanguage', 'Staff language preference must persist under hotelOpsLanguage')

        const ukTranslator = createTranslator('uk')
        assert(ukTranslator('nav.rooms') === 'Кімнати', 'Ukrainian translator must return translated staff navigation labels')
        assert(ukTranslator('buttons.addTask') === 'Додати завдання', 'Ukrainian translator must expose staff action labels')

        const fallbackValue = translate('uk', 'validation.fallbackProbe')
        assert(fallbackValue === 'Záložní čeština', 'Missing Ukrainian keys must safely fall back to Czech')
    })

    console.info('[validate:staff-i18n] PASS')
    console.info('- Staff language defaults to Czech and persists in localStorage')
    console.info('- Ukrainian UI labels resolve for staff-facing controls')
    console.info('- Missing Ukrainian keys fall back to Czech')
}

main().catch((error) => {
    console.error('[validate:staff-i18n] FAIL')
    console.error(error instanceof Error ? error.stack || error.message : error)
    process.exitCode = 1
})
