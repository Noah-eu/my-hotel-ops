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
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hotel-ops-auto-confirm-'))

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

function makeJob(overrides = {}) {
    return {
        id: 'job-1',
        fileName: 'stav-2026-06-24.xlsx',
        type: 'previo-state-pdf',
        source: 'email',
        status: 'needs_review',
        parserVersion: 'previo-state-v2026-06-24',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        previewSummary: {
            parserVersion: 'previo-state-v2026-06-24',
            preview: { days: [{ dateIso: '2026-06-24', dateLabel: '24.6', rows: [] }] },
            diagnostics: {
                processingPath: 'email-import',
                parserVersion: 'previo-state-v2026-06-24',
                primary: { importKind: 'xlsx' },
                arrivalOverlay: { auditMismatches: 0 }
            },
            arrivalOverlayMismatchRows: []
        },
        ...overrides
    }
}

async function main() {
    const tempRoot = await transpileModuleTree([
        'src/lib/importAutoConfirm.ts',
        'src/lib/importOperationalMerge.ts',
        'src/types.ts'
    ])

    try {
        const { evaluateImportAutoConfirm, resolveImportAutoConfirmConfig } = require(path.join(tempRoot, 'src/lib/importAutoConfirm.js'))
        const merge = require(path.join(tempRoot, 'src/lib/importOperationalMerge.js'))
        const appSource = await fs.readFile(path.join(process.cwd(), 'src/App.tsx'), 'utf8')

        const config = resolveImportAutoConfirmConfig({
            explicitEnabledValue: 'true',
            legacyEnabledValue: 'false',
            legacyDryRunValue: 'true'
        })
        assert(config.mode === 'enabled', 'Explicit VITE_PREVIO_AUTO_CONFIRM=true must win over legacy dry-run')

        const baseInput = {
            mode: 'enabled',
            isNewestPrevioStateJob: true,
            isSupersededPrevioStateJob: false,
            hasByDate: true,
            hasParsedTabDates: true,
            safety: { status: 'ok', blocked: false, warnings: [], blocks: [] }
        }

        const ok = evaluateImportAutoConfirm({ ...baseInput, job: makeJob() })
        assert(ok.eligible, 'Newest safe email XLS/XLSX import should be auto-confirm eligible')

        const manual = evaluateImportAutoConfirm({ ...baseInput, job: makeJob({ source: 'manual' }) })
        assert(!manual.eligible && manual.blockedReasons.some((reason) => reason.includes('e-mailové importy')), 'Manual uploads must be blocked')

        const notNewest = evaluateImportAutoConfirm({ ...baseInput, isNewestPrevioStateJob: false, job: makeJob() })
        assert(!notNewest.eligible && notNewest.blockedReasons.some((reason) => reason.includes('nejnovější')), 'Non-newest import must be blocked')

        const missingPreview = evaluateImportAutoConfirm({
            ...baseInput,
            job: makeJob({ previewSummary: { parserVersion: 'v1', diagnostics: { processingPath: 'email-import', primary: { importKind: 'xlsx' } } } })
        })
        assert(!missingPreview.eligible && missingPreview.blockedReasons.some((reason) => reason.includes('Náhled importu')), 'Missing preview must block auto-confirm')

        const blockedSafety = evaluateImportAutoConfirm({
            ...baseInput,
            safety: { status: 'blocked', blocked: true, warnings: [], blocks: ['confidenceLow'] },
            job: makeJob()
        })
        assert(!blockedSafety.eligible && blockedSafety.blockedReasons.some((reason) => reason.includes('Bezpečnostní kontrola')), 'Safety blocked import must not auto-confirm')

        const overlayMismatch = evaluateImportAutoConfirm({
            ...baseInput,
            job: makeJob({ previewSummary: { ...makeJob().previewSummary, arrivalOverlayMismatchRows: [{ dateIso: '2026-06-24', roomNumber: '101' }] } })
        })
        assert(!overlayMismatch.eligible && overlayMismatch.blockedReasons.some((reason) => reason.includes('Overlay mismatch')), 'Arrival overlay mismatches must block auto-confirm')

        const parserMissing = evaluateImportAutoConfirm({
            ...baseInput,
            job: makeJob({ previewSummary: { ...makeJob().previewSummary, diagnostics: { primary: { importKind: 'xlsx' } } } })
        })
        assert(!parserMissing.eligible && parserMissing.blockedReasons.some((reason) => reason.includes('Diagnostika parseru')), 'Incomplete parser diagnostics must block auto-confirm')

        const testLike = evaluateImportAutoConfirm({ ...baseInput, likelyTestImport: true, job: makeJob({ fileName: 'test-import.xlsx' }) })
        assert(!testLike.eligible && testLike.blockedReasons.some((reason) => reason.includes('testovací')), 'Likely test imports must be blocked')

        assert(appSource.includes('handleConfirmImportJob(candidate.id, { autoConfirmReason: \u0027newest-safe-import\u0027 })'), 'Auto-confirm must use shared handleConfirmImportJob path')
        assert(appSource.includes('onClick={() => void handleConfirmImportJob(job.id)}'), 'Manual confirm path must remain available')
        assert(!appSource.includes('Dry-run'), 'Admin UI must not render Dry-run text in the current bundle')
        assert(!appSource.includes('Tento import by byl automaticky potvrzen'), 'Admin UI must not render would-confirm dry-run text')
        assert(!appSource.includes('if (autoDecision === \'blocked\' && candidate.automation?.autoConfirm?.mode === \'enabled\') return'), 'Auto-confirm must not trust stale blocked metadata over live reevaluation')

        const { mergeImportedRoomDayWithExistingOperationalState } = merge
        const importedWaiting = { id: 'r101', number: '101', status: 'ceka', planDateIso: '2026-06-24' }

        const sameDayDone = {
            id: 'r101',
            number: '101',
            status: 'hotovo',
            planDateIso: '2026-06-24',
            operationalStatusDateIso: '2026-06-24',
            operationalStatusUpdatedAt: '2026-06-24T09:30:00.000Z'
        }
        const sameDayMerge = mergeImportedRoomDayWithExistingOperationalState({
            dateIso: '2026-06-24',
            importedRoom: importedWaiting,
            existingRoom: sameDayDone
        })
        assert(sameDayMerge.room.status === 'hotovo', 'Same-day Hotovo must survive import confirm merge')

        const previousDayDone = {
            ...sameDayDone,
            planDateIso: '2026-06-23',
            operationalStatusDateIso: '2026-06-23'
        }
        const staleMerge = mergeImportedRoomDayWithExistingOperationalState({
            dateIso: '2026-06-24',
            importedRoom: importedWaiting,
            existingRoom: previousDayDone
        })
        assert(staleMerge.room.status === 'ceka', 'Previous-day Hotovo must not carry to current import day')

        console.info('[validate:import-auto-confirm-guarded] PASS')
        console.info('- Guarded auto-confirm allows only safe newest email XLS/XLSX jobs')
        console.info('- Overlay/parser/safety/test/manual guards block risky jobs')
        console.info('- Auto and manual confirm paths both use the shared confirmation flow')
        console.info('- Import merge keeps same-day completion and rejects stale completion carry-over')
    } finally {
        await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => { })
    }
}

main().catch((error) => {
    console.error('[validate:import-auto-confirm-guarded] FAIL')
    console.error(error instanceof Error ? error.stack || error.message : error)
    process.exitCode = 1
})
