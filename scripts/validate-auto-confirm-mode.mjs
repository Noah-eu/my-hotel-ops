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
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hotel-ops-auto-confirm-mode-'))

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

async function main() {
    const tempRoot = await transpileModuleTree([
        'src/lib/importAutoConfirm.ts',
        'src/types.ts'
    ])

    try {
        const { resolveImportAutoConfirmConfig } = require(path.join(tempRoot, 'src/lib/importAutoConfirm.js'))

        const explicitEnabled = resolveImportAutoConfirmConfig({
            explicitEnabledValue: 'true',
            legacyEnabledValue: 'false',
            legacyDryRunValue: 'true'
        })
        assert(explicitEnabled.mode === 'enabled', 'VITE_PREVIO_AUTO_CONFIRM=true must enable real auto-confirm')
        assert(explicitEnabled.source === 'VITE_PREVIO_AUTO_CONFIRM', 'Explicit flag must be reported as config source')

        const explicitDisabled = resolveImportAutoConfirmConfig({
            explicitEnabledValue: 'false',
            legacyEnabledValue: 'true',
            legacyDryRunValue: 'true'
        })
        assert(explicitDisabled.mode === 'off', 'VITE_PREVIO_AUTO_CONFIRM=false must disable auto-confirm even if legacy flags are true')

        const defaultOff = resolveImportAutoConfirmConfig({})
        assert(defaultOff.mode === 'off', 'Missing flags must default to disabled')

        const legacyEnabled = resolveImportAutoConfirmConfig({
            legacyEnabledValue: 'true',
            legacyDryRunValue: 'true'
        })
        assert(legacyEnabled.mode === 'enabled', 'Legacy enabled flag must still enable real auto-confirm')

        const legacyDryRunOnly = resolveImportAutoConfirmConfig({
            legacyEnabledValue: 'false',
            legacyDryRunValue: 'true'
        })
        assert(legacyDryRunOnly.mode === 'dry-run', 'Legacy dry-run should remain opt-in only when explicitly configured')

        console.info('[validate:auto-confirm-mode] PASS')
        console.info('- VITE_PREVIO_AUTO_CONFIRM=true => enabled')
        console.info('- VITE_PREVIO_AUTO_CONFIRM=false => off, even if legacy flags are true')
        console.info('- Missing flags => off')
        console.info('- Explicit legacy dry-run remains opt-in only')
    } finally {
        await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => { })
    }
}

main().catch((error) => {
    console.error('[validate:auto-confirm-mode] FAIL')
    console.error(error instanceof Error ? error.stack || error.message : error)
    process.exitCode = 1
})
