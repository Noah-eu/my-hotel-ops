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

function countOverlayMarkers(byDate) {
    return Object.values(byDate || {}).reduce((sum, dayRooms) => {
        const dayCount = (dayRooms || []).filter((room) => room.arrivalTimeSource === 'pdf_overlay').length
        return sum + dayCount
    }, 0)
}

function findByDateRoom(byDate, dateIso, roomNumber) {
    const targetRoom = String(roomNumber || '').trim().padStart(3, '0')
    const rooms = Array.isArray(byDate?.[dateIso]) ? byDate[dateIso] : []
    return rooms.find((room) => String(room?.number || '').trim().padStart(3, '0') === targetRoom) || null
}

function collectOverlayMainTimeMismatches(overlaySummary, byDate) {
    const mismatches = []
    const auditRows = Array.isArray(overlaySummary?.audit) ? overlaySummary.audit : []

    auditRows.forEach((entry) => {
        const pdfMainTime = String(entry?.pdfMainTime || '').trim()
        if (!pdfMainTime) return

        const dateIso = String(entry?.dateIso || '').trim()
        const roomNumber = String(entry?.roomNumber || '').trim().padStart(3, '0')
        const finalRoom = findByDateRoom(byDate, dateIso, roomNumber)
        const finalTime = String(finalRoom?.arrivalTime || '').trim()

        if (finalTime !== pdfMainTime) {
            mismatches.push({
                dateIso,
                roomNumber,
                pdfMainTime,
                alfredWindow: entry?.alfredWindow || null,
                xlsTime: entry?.xlsTime || null,
                finalTime: finalTime || null,
                reason: entry?.reason || 'final_time_differs'
            })
        }
    })

    return mismatches
}

async function main() {
    assert(previewFunction && previewFunction._test, 'previo-import-preview test hooks are not available')

    const localFunctionWorkerPath = path.join(root, 'netlify/functions/pdf.worker.mjs')
    let hasLocalFunctionWorker = false
    try {
        await fs.access(localFunctionWorkerPath)
        hasLocalFunctionWorker = true
    } catch {
        hasLocalFunctionWorker = false
    }
    assert(!hasLocalFunctionWorker, 'Validation expects no local netlify/functions/pdf.worker.mjs file')

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

    const originalDOMMatrix = globalThis.DOMMatrix
    const originalPdfjsWorker = globalThis.pdfjsWorker
    let hybridParsed
    try {
        globalThis.DOMMatrix = undefined
        delete globalThis.pdfjsWorker
        hybridParsed = await previewFunction._test.parseImportSources({
            primary: {
                buffer: await fs.readFile(xlsxPath),
                fileName: path.basename(xlsxPath),
                contentType: '',
                storagePath: 'hotels/chill-apartments/importJobs/test/source.xlsx'
            },
            overlay: {
                buffer: await fs.readFile(pdfPath),
                fileName: path.basename(pdfPath),
                contentType: 'application/pdf',
                storagePath: 'hotels/chill-apartments/importJobs/test/overlay.pdf'
            },
            referenceDate
        })
    } finally {
        if (typeof originalDOMMatrix === 'undefined') {
            delete globalThis.DOMMatrix
        } else {
            globalThis.DOMMatrix = originalDOMMatrix
        }

        if (typeof originalPdfjsWorker === 'undefined') {
            delete globalThis.pdfjsWorker
        } else {
            globalThis.pdfjsWorker = originalPdfjsWorker
        }
    }
    const hybridPreview = buildPrevioStateImportPreview(hybridParsed.parsed, [], referenceDate)
    const hybridByDate = buildByDateFromPreview(hybridPreview, [], '22.06.2026 19:01')

    assert(previewFunction._test.resolveImportKind(path.basename(xlsxPath), '', 'source.xlsx') === 'xlsx', 'XLSX source was not detected as xlsx')
    assert(previewFunction._test.resolveImportKind(path.basename(pdfPath), '', 'source.pdf') === 'pdf', 'PDF source was not detected as pdf')
    assert(Object.keys(xlsxResult.byDate).length > 0, 'XLS preview byDate is empty')
    assert(Object.keys(pdfResult.byDate).length > 0, 'PDF preview byDate is empty')
    assert(Object.keys(hybridByDate).length > 0, 'Hybrid preview byDate is empty')
    assert(Array.isArray(xlsxResult.preview.days) && xlsxResult.preview.days.length > 0, 'XLS preview days are empty')
    assert(Array.isArray(pdfResult.preview.days) && pdfResult.preview.days.length > 0, 'PDF preview days are empty')
    assert(Array.isArray(hybridPreview.days) && hybridPreview.days.length > 0, 'Hybrid preview days are empty')
    assert(typeof hybridParsed.arrivalOverlay?.appliedRows === 'number', 'Hybrid parse did not return arrival overlay summary')
    if (hybridParsed.arrivalOverlay?.appliedRows > 0) {
        assert(countOverlayMarkers(hybridByDate) >= 0, 'Hybrid byDate overlay marker counting failed')
    }
    const overlayAuditMismatches = collectOverlayMainTimeMismatches(hybridParsed.arrivalOverlay, hybridByDate)
    assert((hybridParsed.arrivalOverlay?.auditMismatches || 0) === 0, 'Overlay audit reported mismatches in parser output')
    assert(
        overlayAuditMismatches.length === 0,
        `Final byDate arrival time mismatches PDF main time: ${JSON.stringify(overlayAuditMismatches.slice(0, 5))}`
    )

    console.log('[validate:previo-import-preview-runtime] PASS')
    console.log(`- XLS fixture: ${path.basename(xlsxPath)}`)
    console.log(`- PDF fixture: ${path.basename(pdfPath)}`)
    console.log(`- XLS preview days: ${xlsxResult.preview.days.length}`)
    console.log(`- PDF preview days: ${pdfResult.preview.days.length}`)
    console.log(`- Hybrid overlay applied rows: ${hybridParsed.arrivalOverlay?.appliedRows || 0}`)
    console.log(`- Hybrid overlay audit rows: ${hybridParsed.arrivalOverlay?.auditCheckedRows || 0}`)
}

main().catch((error) => {
    console.error('[validate:previo-import-preview-runtime] FAIL')
    console.error(error && error.stack ? error.stack : String(error))
    process.exit(1)
})