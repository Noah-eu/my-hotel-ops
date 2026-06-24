import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

function baseRoom(overrides = {}) {
    return {
        id: 'room-103',
        number: '103',
        situation: 'volny',
        status: 'ceka',
        ...overrides
    }
}

function baseSupplyRequest(overrides = {}) {
    return {
        id: 's-1',
        itemName: 'Ručníky',
        category: 'equipment',
        quantityLevel: 'medium',
        requestedBy: 'Lead',
        requestedByRole: 'lead',
        createdAt: '09:00',
        priority: 'normal',
        status: 'new',
        ...overrides
    }
}

async function transpileModuleTree(relativePaths) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hotel-ops-ui-visible-'))

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

async function withTranspiledUiHelpers(run) {
    const tempRoot = await transpileModuleTree([
        'src/lib/opsUiInvariants.ts',
        'src/lib/roles.ts',
        'src/lib/roomHelpers.ts',
        'src/types.ts',
        'src/services/opsStore.ts'
    ])

    try {
        const helpers = require(path.join(tempRoot, 'src/lib/opsUiInvariants.js'))
        await run(helpers)
    } finally {
        await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => { })
    }
}

async function main() {
    const suppliesViewSource = await fs.readFile(path.join(process.cwd(), 'src/pages/SuppliesView.tsx'), 'utf8')

    await withTranspiledUiHelpers(async ({
        applySupplyStatusUpdate,
        applyCarryOverResolution,
        buildBoughtArchiveModel,
        buildCarryOverResolutionPatch,
        buildRoomSheetCellModel,
        buildSheetRoomsByDate,
        getCustomSupplyChipsForSection,
        getPreferredSupplyChipSection,
        getSupplyRequestArchiveDate,
        buildSupplyRequestUiBuckets,
        canManageSupplyLifecycle,
        canSetSupplyStatus,
        getCarryOverBadgeLabel
    }) => {
        const dateIso = '2026-06-24'

        const roomsByDay = {
            Dnes: [baseRoom({ freeConfirmed: true, occupiedConfirmed: false, stayoverGuestName: undefined })],
            Zitra: [],
            Pozitri: []
        }
        const importedRoomsByDate = {
            [dateIso]: [baseRoom({ occupiedConfirmed: true, stayoverGuestName: 'Stale Guest', freeConfirmed: false })]
        }

        const resolvedByDate = buildSheetRoomsByDate(
            [{ tab: 'Dnes', dateIso }],
            roomsByDay,
            importedRoomsByDate
        )
        const resolvedRoom = resolvedByDate[dateIso][0]
        const resolvedCell = buildRoomSheetCellModel(resolvedRoom)

        assert(Boolean(resolvedRoom), 'Resolved primary-day room is missing')
        assert(resolvedRoom.freeConfirmed === true, 'Primary-day Plachta source must preserve operational free state')
        assert(!resolvedRoom.stayoverGuestName, 'Primary-day Plachta source must not preserve stale imported stayover guest')
        assert(resolvedCell.state === 'free', 'Room 103 style Plachta cell must render free state')
        assert(resolvedCell.main === 'Volné', 'Room 103 style Plachta cell must render Volné')
        assert(!resolvedCell.detail, 'Room 103 style Plachta cell must not render stale stayover detail')

        const unresolvedCarryOverRoom = baseRoom({ freeConfirmed: true, carryOverResolvedAt: undefined })
        const carryOverLabel = getCarryOverBadgeLabel(unresolvedCarryOverRoom, '2026-06-19')
        assert(carryOverLabel === 'Nedokončeno z 19.6.', 'Carry-over label should appear for eligible free room')

        const resolvedAt = '2026-06-24T08:15:00.000Z'
        const carryOverPatch = buildCarryOverResolutionPatch(resolvedAt)
        assert(carryOverPatch.carryOverResolvedAt === resolvedAt, 'Carry-over resolve patch must set carryOverResolvedAt')

        const resolvedCarryOverRoom = applyCarryOverResolution(unresolvedCarryOverRoom, resolvedAt)
        assert(resolvedCarryOverRoom.carryOverResolvedAt === resolvedAt, 'Carry-over resolve action must persist resolved timestamp')
        assert(getCarryOverBadgeLabel(resolvedCarryOverRoom, '2026-06-19') === null, 'Carry-over alert must disappear after resolution')

        const pendingRequest = baseSupplyRequest({ status: 'new' })
        assert(canManageSupplyLifecycle('admin') === true, 'Admin should be able to manage supply lifecycle')
        assert(canSetSupplyStatus(pendingRequest.status, 'ordered') === true, 'Pending supply must expose Objednáno transition')
        assert(canSetSupplyStatus(pendingRequest.status, 'delivered') === true, 'Pending supply must expose Koupeno transition')
        assert(!suppliesViewSource.includes('>Vlastní<') && !suppliesViewSource.includes('Vlastní:'), 'Supplies UI must no longer render the Vlastní label')
        assert(suppliesViewSource.includes('role="dialog"'), 'Bought archive must open as a separate modal/panel')
        assert(!suppliesViewSource.includes('Bez data</h3>'), 'Bought archive must not render a visible Bez data section')

        const customChips = [
            'uklid::Test úklid',
            'vybaveni::Test vybavení',
            'ostatni::Test ostatní',
            'Legacy chip',
            'uklid::Legacy chip',
            'ostatni::Sklenice na víno',
            'ostatni::Cif na podlahy 5l',
            'vybaveni::Jar 5l'
        ]

        const uklidChipNames = getCustomSupplyChipsForSection(customChips, 'uklid').map((chip) => chip.name)
        const vybaveniChipNames = getCustomSupplyChipsForSection(customChips, 'vybaveni').map((chip) => chip.name)
        const ostatniChipNames = getCustomSupplyChipsForSection(customChips, 'ostatni').map((chip) => chip.name)

        assert(uklidChipNames.includes('Test úklid') && uklidChipNames.includes('Legacy chip'), 'Úklid custom chips must keep Úklid-created entries')
        assert(vybaveniChipNames.includes('Test vybavení'), 'Vybavení custom chips must remain scoped to Vybavení')
        assert(ostatniChipNames.join('|') === 'Test ostatní', 'Ostatní custom chips must remain scoped to Ostatní and legacy duplicates must not leak in')
        assert(getPreferredSupplyChipSection('Sklenice na víno') === 'vybaveni', 'Sklenice na víno must resolve to Vybavení')
        assert(getPreferredSupplyChipSection('Cif na podlahy 5l') === 'uklid', 'Cif-related chips must resolve to Úklid')
        assert(getPreferredSupplyChipSection('Jar 5l') === 'uklid', 'Jar-related chips must resolve to Úklid')
        assert(getCustomSupplyChipsForSection(customChips, 'vybaveni').some((chip) => chip.name === 'Sklenice na víno'), 'Sklenice na víno must appear only in Vybavení')
        assert(!getCustomSupplyChipsForSection(customChips, 'ostatni').some((chip) => chip.name === 'Sklenice na víno'), 'Sklenice na víno must not appear in Ostatní')
        assert(getCustomSupplyChipsForSection(customChips, 'uklid').some((chip) => chip.name === 'Cif na podlahy 5l'), 'Cif na podlahy 5l must appear only in Úklid')
        assert(getCustomSupplyChipsForSection(customChips, 'uklid').some((chip) => chip.name === 'Jar 5l'), 'Jar 5l must appear only in Úklid')
        assert(!getCustomSupplyChipsForSection(customChips, 'vybaveni').some((chip) => chip.name === 'Jar 5l'), 'Jar 5l must not remain in Vybavení after reclassification')

        const pendingBuckets = buildSupplyRequestUiBuckets([pendingRequest])
        assert(pendingBuckets.newRequests.some((request) => request.id === pendingRequest.id), 'Pending supply must appear in active Čeká list')
        assert(pendingBuckets.normalNewRequests.some((request) => request.id === pendingRequest.id), 'Pending supply must appear in active normal Čeká list')
        assert(pendingBuckets.orderedRequests.length === 0, 'Pending supply must not appear in Objednáno')
        assert(pendingBuckets.completedRequests.length === 0, 'Pending supply must not appear in Koupeno')

        const orderedRequest = applySupplyStatusUpdate(pendingRequest, 'ordered', '2026-06-24T09:00:00.000Z')
        const orderedBuckets = buildSupplyRequestUiBuckets([orderedRequest])
        assert(!orderedBuckets.newRequests.some((request) => request.id === orderedRequest.id), 'Ordered supply must leave active Čeká list')
        assert(orderedBuckets.orderedRequests.some((request) => request.id === orderedRequest.id), 'Ordered supply must move to Objednáno')
        assert(canSetSupplyStatus(orderedRequest.status, 'delivered') === true, 'Ordered supply must expose Koupeno transition')

        const boughtRequest = applySupplyStatusUpdate(orderedRequest, 'delivered', '2026-06-24T09:30:00.000Z')
        const boughtBuckets = buildSupplyRequestUiBuckets([boughtRequest])
        assert(!boughtBuckets.newRequests.some((request) => request.id === boughtRequest.id), 'Bought supply must not appear in active Čeká list')
        assert(!boughtBuckets.normalNewRequests.some((request) => request.id === boughtRequest.id), 'Bought supply must not appear in active normal Čeká list')
        assert(!boughtBuckets.orderedRequests.some((request) => request.id === boughtRequest.id), 'Bought supply must leave Objednáno')
        assert(boughtBuckets.completedRequests.some((request) => request.id === boughtRequest.id), 'Bought supply must move to Koupeno')

        const olderBoughtWithoutBoughtAt = {
            ...baseSupplyRequest({
                id: 's-older',
                itemName: 'Older item',
                status: 'delivered',
                completedAt: '2025-11-05T10:00:00.000Z',
                updatedAt: '2025-11-04T08:00:00.000Z',
                boughtAt: undefined
            })
        }

        const legacyBoughtWithoutDates = {
            ...baseSupplyRequest({
                id: 's-legacy',
                itemName: 'Legacy item',
                status: 'delivered',
                createdAt: '',
                updatedAt: undefined,
                boughtAt: undefined,
                completedAt: undefined
            })
        }

        const archiveFallbackDate = new Date('2026-06-01T00:00:00.000Z')
        const archiveModel = buildBoughtArchiveModel([boughtRequest, olderBoughtWithoutBoughtAt, legacyBoughtWithoutDates], archiveFallbackDate)
        assert(getSupplyRequestArchiveDate(olderBoughtWithoutBoughtAt, archiveFallbackDate)?.toISOString() === '2025-11-05T10:00:00.000Z', 'Older bought item without boughtAt must fall back to completedAt before updatedAt')
        assert(getSupplyRequestArchiveDate(legacyBoughtWithoutDates, archiveFallbackDate)?.toISOString() === archiveFallbackDate.toISOString(), 'Legacy bought item without any date must fall back to the provided safe archive month')
        assert(archiveModel.totalCount === 3, 'Bought archive count must include bought items only')
        assert(archiveModel.years[0]?.year === 2026, 'Bought archive must sort years newest first')
        assert(archiveModel.years[0]?.months[0]?.key === '2026-06', 'Newest bought item must appear under current year/month archive')
        assert(archiveModel.years[0]?.months[0]?.requests.some((request) => request.id === boughtRequest.id), 'Newest bought item must appear in selected month archive')
        assert(archiveModel.years[0]?.months[0]?.requests.some((request) => request.id === legacyBoughtWithoutDates.id), 'Legacy bought item without any date must still appear in a safe fallback month archive')
        assert(archiveModel.years[1]?.year === 2025, 'Fallback-dated bought items must appear under their fallback year')
        assert(archiveModel.years[1]?.months[0]?.key === '2025-11', 'Fallback-dated bought items must appear under their fallback month archive')
    })

    console.log('[validate:ui-visible-flows] PASS')
    console.log('- Plachta follows primary-day operational free state over stale imported stayover data')
    console.log('- Carry-over resolution sets carryOverResolvedAt and hides the alert')
    console.log('- Supplies lifecycle transitions move requests between Čeká, Objednáno, and Koupeno archive buckets')
}

main().catch((error) => {
    console.error('[validate:ui-visible-flows] FAIL')
    console.error(error?.stack || String(error))
    process.exit(1)
})
