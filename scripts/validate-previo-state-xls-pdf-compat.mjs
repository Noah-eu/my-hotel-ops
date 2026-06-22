import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
    extractStateTextFromPdfBuffer,
    parsePrevioStatePdfText,
    extractStateDataFromXlsxBuffer,
    parsePrevioStateXlsxData,
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

function findPlanRow(byDate, dateIso, roomNumber) {
    const rows = Array.isArray(byDate?.[dateIso]) ? byDate[dateIso] : []
    const targetRoom = String(roomNumber).padStart(3, '0')
    return rows.find((row) => String(row.number || '').padStart(3, '0') === targetRoom)
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message)
    }
}

async function main() {
    const xlsxPath = await resolveExistingPath([
        'private-sources/previo/denni_prehled - Stav - 22. 6. - 27. 6..xlsx',
        'private-sources/previo/Stav.xlsx'
    ])
    const pdfPath = await resolveExistingPath([
        'private-sources/previo/stav-2026-06-22-1901.pdf',
        'private-sources/previo/stav-2026-06-22-0702.pdf'
    ])

    if (!xlsxPath || !pdfPath) {
        console.log('[validate:previo-state-xls-pdf-compat] SKIP')
        console.log(`- Missing local fixtures. xlsx: ${xlsxPath ? 'ok' : 'missing'}, pdf: ${pdfPath ? 'ok' : 'missing'}`)
        process.exit(0)
    }

    const [xlsxBuffer, pdfBuffer] = await Promise.all([
        fs.readFile(xlsxPath),
        fs.readFile(pdfPath)
    ])

    const xlsxExtracted = extractStateDataFromXlsxBuffer(xlsxBuffer)
    const xlsxParsed = parsePrevioStateXlsxData(xlsxExtracted, new Date('2026-06-22T00:00:00'))
    const xlsxPreview = buildPrevioStateImportPreview(xlsxParsed, [], new Date('2026-06-22T00:00:00'))
    const xlsxByDate = buildByDateFromPreview(xlsxPreview, [], '22.06.2026 19:01')

    const pdfExtracted = await extractStateTextFromPdfBuffer(pdfBuffer)
    const pdfParsed = parsePrevioStatePdfText(pdfExtracted, new Date('2026-06-22T00:00:00'))
    const pdfPreview = buildPrevioStateImportPreview(pdfParsed, [], new Date('2026-06-22T00:00:00'))
    const pdfByDate = buildByDateFromPreview(pdfPreview, [], '22.06.2026 19:01')

    const overlapDates = Object.keys(xlsxByDate).filter((dateIso) => Object.prototype.hasOwnProperty.call(pdfByDate, dateIso)).sort()
    assert(overlapDates.length > 0, 'No overlapping dates between XLS and PDF byDate previews')

    overlapDates.forEach((dateIso) => {
        const xRows = Array.isArray(xlsxByDate[dateIso]) ? xlsxByDate[dateIso] : []
        const pRows = Array.isArray(pdfByDate[dateIso]) ? pdfByDate[dateIso] : []
        assert(xRows.length === pRows.length, `${dateIso}: room row count mismatch between XLS (${xRows.length}) and PDF (${pRows.length})`)
        xRows.forEach((xRow) => {
            const pRow = pRows.find((candidate) => String(candidate.number || '') === String(xRow.number || ''))
            assert(Boolean(pRow), `${dateIso}/${xRow.number}: missing room in PDF byDate`) 
            assert(typeof xRow.stateSource === 'string' && xRow.stateSource === 'previo-state-pdf', `${dateIso}/${xRow.number}: XLS row has incompatible stateSource`)
            assert(typeof pRow.stateSource === 'string' && pRow.stateSource === 'previo-state-pdf', `${dateIso}/${xRow.number}: PDF row has incompatible stateSource`)
        })
    })

    const x26301 = findPlanRow(xlsxByDate, '2026-06-26', '301')
    const p26301 = findPlanRow(pdfByDate, '2026-06-26', '301')
    if (x26301 && p26301) {
        assert(Boolean(x26301.occupiedConfirmed), 'XLS 2026-06-26/301 should resolve as occupied/stayover')
        assert(Boolean(p26301.occupiedConfirmed), 'PDF 2026-06-26/301 should resolve as occupied/stayover')
        assert(!x26301.departure?.time, 'XLS 2026-06-26/301 must not have departure time')
        assert(!p26301.departure?.time, 'PDF 2026-06-26/301 must not have departure time')
    }

    console.log('[validate:previo-state-xls-pdf-compat] PASS')
    console.log(`- XLS fixture: ${path.basename(xlsxPath)}`)
    console.log(`- PDF fixture: ${path.basename(pdfPath)}`)
    console.log(`- Overlap days: ${overlapDates.length}`)
}

main().catch((error) => {
    console.error('[validate:previo-state-xls-pdf-compat] FAIL')
    console.error(error && error.stack ? error.stack : String(error))
    process.exit(1)
})
