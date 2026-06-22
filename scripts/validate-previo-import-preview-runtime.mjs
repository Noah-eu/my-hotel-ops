import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const previewFunction = require('../netlify/functions/previo-import-preview.js')
const {
    buildPrevioStateImportPreview,
    buildByDateFromPreview
} = require('../netlify/functions/lib/previo-state-preview.js')

const root = process.cwd()

async function resolveExistingPath(candidates) {
    for (const rel of candidates) {
        const full = path.isAbsolute(rel) ? rel : path.join(root, rel)
        try {
            await fs.access(full)
            return full
        } catch {
            // try next path
        }
    }
    return null
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message)
    }
}

async function loadPreviewFromSource(filePath, referenceDate) {
    const buffer = await fs.readFile(filePath)
    const fileName = path.basename(filePath)
    const parsed = await previewFunction._test.parseImportBuffer({
        buffer,
        fileName,
        contentType: '',
        storagePath: `hotels/chill-apartments/importJobs/test/source.${fileName.split('.').pop()}`,
        referenceDate
    })

    const preview = buildPrevioStateImportPreview(parsed, [], referenceDate)
    const byDate = buildByDateFromPreview(preview, [], '22.06.2026 19:01')
    return { parsed, preview, byDate }
}

async function main() {
    assert(previewFunction && previewFunction._test, 'previo-import-preview test hooks are not available')

    const xlsxPath = await resolveExistingPath([
        'private-sources/previo/denni_prehled - Stav - 22. 6. - 27. 6..xlsx',
        'private-sources/previo/Stav.xlsx'
    ])
    const pdfPath = await resolveExistingPath([
        'private-sources/previo/stav-2026-06-22-1901.pdf',
        'private-sources/previo/stav-2026-06-22-0702.pdf'
    ])

    if (!xlsxPath || !pdfPath) {
        console.log('[validate:previo-import-preview-runtime] SKIP')
        console.log(`- Missing local fixtures. xlsx: ${xlsxPath ? 'ok' : 'missing'}, pdf: ${pdfPath ? 'ok' : 'missing'}`)
        process.exit(0)
    }

    const referenceDate = new Date('2026-06-22T00:00:00')

    const xlsxResult = await loadPreviewFromSource(xlsxPath, referenceDate)
    const pdfResult = await loadPreviewFromSource(pdfPath, referenceDate)

    assert(previewFunction._test.resolveImportKind(path.basename(xlsxPath), '', 'source.xlsx') === 'xlsx', 'XLSX source was not detected as xlsx')
    assert(previewFunction._test.resolveImportKind(path.basename(pdfPath), '', 'source.pdf') === 'pdf', 'PDF source was not detected as pdf')
    assert(Object.keys(xlsxResult.byDate).length > 0, 'XLS preview byDate is empty')
    assert(Object.keys(pdfResult.byDate).length > 0, 'PDF preview byDate is empty')
    assert(Array.isArray(xlsxResult.preview.days) && xlsxResult.preview.days.length > 0, 'XLS preview days are empty')
    assert(Array.isArray(pdfResult.preview.days) && pdfResult.preview.days.length > 0, 'PDF preview days are empty')

    console.log('[validate:previo-import-preview-runtime] PASS')
    console.log(`- XLS fixture: ${path.basename(xlsxPath)}`)
    console.log(`- PDF fixture: ${path.basename(pdfPath)}`)
    console.log(`- XLS preview days: ${xlsxResult.preview.days.length}`)
    console.log(`- PDF preview days: ${pdfResult.preview.days.length}`)
}

main().catch((error) => {
    console.error('[validate:previo-import-preview-runtime] FAIL')
    console.error(error && error.stack ? error.stack : String(error))
    process.exit(1)
})