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
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hotel-ops-admin-import-card-'))

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
        type: 'previo-state-pdf',
        source: 'email',
        status: 'needs_review',
        fileName: 'stav.xlsx',
        receivedAt: '2026-06-25T10:00:00.000Z',
        warnings: ['warning-a'],
        ...overrides
    }
}

async function main() {
    const tempRoot = await transpileModuleTree([
        'src/lib/importAutoConfirm.ts',
        'src/lib/importJobAdminDiagnostics.ts',
        'src/types.ts'
    ])

    try {
        const { isLikelyTestImportJob } = require(path.join(tempRoot, 'src/lib/importAutoConfirm.js'))
        const { buildImportJobAdminRenderState } = require(path.join(tempRoot, 'src/lib/importJobAdminDiagnostics.js'))
        const appSource = await fs.readFile(path.join(process.cwd(), 'src/App.tsx'), 'utf8')

        const newJob = buildImportJobAdminRenderState(makeJob({
            automation: {
                autoConfirm: { mode: 'enabled', decision: 'confirmed' },
                autoConfirmedAt: '2026-06-25T10:05:00.000Z',
                autoConfirmReason: 'newest-safe-import'
            },
            backupSummary: { createdAt: '2026-06-25T10:05:00.000Z', affectedDates: ['2026-06-25'], affectedRoomCount: 1 }
        }))
        assert(newJob.warnings.length === 1, 'New import job warnings should render normally')
        assert(newJob.autoConfirmMode === 'enabled', 'New import job should expose auto-confirm mode')

        const oldJob = buildImportJobAdminRenderState(makeJob({ automation: undefined }))
        assert(oldJob.autoConfirmMode === '', 'Old import job without automation must not throw and should have empty auto-confirm mode')
        assert(!oldJob.hasRenderIssues, 'Old import job without automation should not be treated as malformed by itself')

        const noPreviewSummaryJob = buildImportJobAdminRenderState(makeJob({ previewSummary: undefined }))
        assert(Array.isArray(noPreviewSummaryJob.warnings), 'Job without previewSummary must still render warning list safely')

        const noWarningsJob = buildImportJobAdminRenderState(makeJob({ warnings: undefined }))
        assert(noWarningsJob.warnings.length === 0, 'Job without warnings array must fall back to empty warnings')
        assert(noWarningsJob.hasRenderIssues, 'Missing warnings array should be flagged as degraded render data')

        const oldDryRunJob = buildImportJobAdminRenderState(makeJob({
            automation: {
                autoConfirm: { mode: 'dry-run', decision: 'would_confirm' }
            }
        }))
        assert(oldDryRunJob.autoConfirmMode === 'dry-run', 'Legacy dry-run metadata must still render safely')

        const testLikeJob = makeJob({ fileName: 'demo-test-import.xlsx', parserVersion: 'sample-build' })
        assert(isLikelyTestImportJob(testLikeJob), 'Shared test-import helper must classify obvious test/demo imports safely')

        const malformedBackupJob = buildImportJobAdminRenderState(makeJob({
            backupSummary: { createdAt: '2026-06-25T10:05:00.000Z', affectedDates: undefined, affectedRoomCount: 1 }
        }))
        assert(malformedBackupJob.backupAffectedDates.length === 0, 'Malformed backup dates must fall back to empty list')
        assert(malformedBackupJob.hasRenderIssues, 'Malformed backup dates should be flagged as degraded render data')

        assert(!appSource.includes('job.warnings.length'), 'Admin UI should no longer dereference warnings length directly')
        assert(!appSource.includes('job.backupSummary.affectedDates.join'), 'Admin UI should no longer join backup dates directly')
        assert(!appSource.includes('likelyTestImportJob('), 'App must not reference the old component-scoped likelyTestImportJob identifier')
        assert(appSource.includes('isLikelyTestImportJob(job)'), 'App must use the shared test-import helper in Admin/import code paths')

        console.info('[validate:admin-import-card-runtime] PASS')
        console.info('- New import jobs with auto-confirm metadata render safely')
        console.info('- Old jobs without automation or preview data render safely')
        console.info('- Missing warnings or backup dates degrade safely instead of crashing Admin')
        console.info('- Legacy dry-run metadata renders safely without breaking Admin')
        console.info('- Shared test-import helper is defined and App no longer references the old local identifier')
    } finally {
        await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => { })
    }
}

main().catch((error) => {
    console.error('[validate:admin-import-card-runtime] FAIL')
    console.error(error instanceof Error ? error.stack || error.message : error)
    process.exitCode = 1
})
