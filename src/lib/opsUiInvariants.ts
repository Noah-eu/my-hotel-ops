import { OpsTab } from '../services/opsStore'
import { RoomPlan, SupplyRequest, UserRole } from '../types'
import { isCleanerRole, isCleaningLeadRole, isAdminRole, isMaintenanceRole } from './roles'
import { isTodayRoomEligibleForCarryOver } from './roomHelpers'

type TabDateEntry = {
    tab: OpsTab
    dateIso: string
}

export type SheetCellState = 'turnover' | 'turnover-incomplete' | 'departure' | 'departure-incomplete' | 'arrival' | 'arrival-incomplete' | 'occupied' | 'free' | 'unknown'

export type SheetCellModel = {
    state: SheetCellState
    main: string
    detail?: string
    stayoverKey?: string
}

type SupplyRequestUiBuckets = {
    newRequests: SupplyRequest[]
    maintenanceRequests: SupplyRequest[]
    normalNewRequests: SupplyRequest[]
    orderedRequests: SupplyRequest[]
    completedRequests: SupplyRequest[]
    cancelledRequests: SupplyRequest[]
}

export type SupplyChipSection = 'uklid' | 'vybaveni' | 'ostatni'

export type ParsedCustomSupplyChip = {
    name: string
    section: SupplyChipSection
}

export type BoughtArchiveMonth = {
    key: string
    year: number
    month: number
    label: string
    count: number
    requests: SupplyRequest[]
}

export type BoughtArchiveYear = {
    year: number
    count: number
    months: BoughtArchiveMonth[]
}

export type BoughtArchiveModel = {
    years: BoughtArchiveYear[]
    totalCount: number
}

function shortGuestName(value?: string) {
    if (!value) return ''
    const compact = value.replace(/\s+/g, ' ').trim()
    if (!compact) return ''

    const parts = compact.split(' ')
    const merged = parts.slice(0, 2).join(' ')
    if (merged.length <= 20) return merged
    return `${merged.slice(0, 19)}…`
}

function normalizeGuestKey(value?: string) {
    if (!value) return ''
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
}

function formatGuestCount(value?: number) {
    if (typeof value !== 'number') return ''
    return `${value}p`
}

function extractBoxLabel(raw?: string, notes?: string[]) {
    const direct = String(raw || '').trim()
    if (direct) {
        const match = direct.match(/BOX\s*([A-Z0-9-]+)/i)
        if (match) return `BOX ${match[1].toUpperCase()}`
        return direct
    }

    const joined = (notes || []).join(' | ')
    const fromNotes = joined.match(/BOX\s*([A-Z0-9-]+)/i)
    if (!fromNotes) return ''
    return `BOX ${fromNotes[1].toUpperCase()}`
}

function joinDetailParts(parts: Array<string | undefined>) {
    const cleaned = parts.map((part) => String(part || '').trim()).filter(Boolean)
    if (cleaned.length === 0) return undefined
    return cleaned.join(' • ')
}

function normalizeChipLabel(value: string) {
    return String(value || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase()
}

function normalizeSupplyKeyword(value: string) {
    return normalizeChipLabel(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
}

function isSupplyChipSection(value: string): value is SupplyChipSection {
    return value === 'uklid' || value === 'vybaveni' || value === 'ostatni'
}

function parseSupplyArchiveDate(raw?: string) {
    const value = String(raw || '').trim()
    if (!value) return null

    if (/^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(value)) {
        const normalized = value.includes('T') ? value : value.replace(' ', 'T')
        const date = new Date(normalized)
        return Number.isNaN(date.getTime()) ? null : date
    }

    if (/^\d{1,2}\.\d{1,2}\.\d{4}(?:\s+\d{1,2}:\d{2})?$/.test(value)) {
        const [datePart, timePart = '00:00'] = value.split(/\s+/)
        const [day, month, year] = datePart.split('.')
        const isoLike = `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${timePart}`
        const date = new Date(isoLike)
        return Number.isNaN(date.getTime()) ? null : date
    }

    return null
}

export function buildSheetRoomsByDate(
    tabDateEntries: TabDateEntry[],
    roomsByDay: Record<OpsTab, RoomPlan[]>,
    importedRoomsByDate: Record<string, RoomPlan[]>
) {
    const next: Record<string, RoomPlan[]> = {}
    const primaryDateSet = new Set<string>()

    tabDateEntries.forEach(({ tab, dateIso }) => {
        const primaryRooms = roomsByDay[tab] || []
        const importedRooms = importedRoomsByDate[dateIso] || []
        next[dateIso] = primaryRooms.length > 0 ? primaryRooms : importedRooms
        primaryDateSet.add(dateIso)
    })

    Object.entries(importedRoomsByDate).forEach(([dateIso, rooms]) => {
        if (primaryDateSet.has(dateIso)) return
        next[dateIso] = Array.isArray(rooms) ? rooms : []
    })

    return next
}

export function buildRoomSheetCellModel(room?: RoomPlan): SheetCellModel {
    if (!room) return { state: 'unknown', main: '—' }

    const departureTime = room.departureTime || room.departure?.time
    const arrivalTime = room.arrivalTime || room.arrival?.time
    const departureGuest = shortGuestName(room.departure?.guestLabel || room.stayoverGuestName)
    const arrivalGuest = shortGuestName(room.arrival?.guestLabel)
    const departureCount = room.departure?.guestCount
    const arrivalCount = room.arrival?.guestCount
    const departureBox = extractBoxLabel(undefined, room.departure?.notes)
    const arrivalBox = extractBoxLabel(room.arrival?.box || room.box, room.arrival?.notes)

    const hasDeparture = Boolean(departureTime)
    const hasArrival = Boolean(arrivalTime)
    const hasDepartureIdentity = Boolean(departureGuest || typeof departureCount === 'number')
    const hasArrivalIdentity = Boolean(arrivalGuest || typeof arrivalCount === 'number')

    if (hasDeparture && hasArrival) {
        const departureDetail = joinDetailParts([departureGuest, formatGuestCount(departureCount), departureBox])
        const arrivalDetail = joinDetailParts([arrivalGuest, formatGuestCount(arrivalCount), arrivalBox])
        const detail = joinDetailParts([
            departureDetail ? `Odj: ${departureDetail}` : undefined,
            arrivalDetail ? `Příj: ${arrivalDetail}` : undefined
        ])

        return {
            state: hasDepartureIdentity && hasArrivalIdentity ? 'turnover' : 'turnover-incomplete',
            main: `Odj ${departureTime} / Příj ${arrivalTime}`,
            detail: detail || (hasDepartureIdentity || hasArrivalIdentity ? detail : 'Neúplná data hosta')
        }
    }

    if (hasDeparture) {
        return {
            state: hasDepartureIdentity ? 'departure' : 'departure-incomplete',
            main: `Odj ${departureTime}`,
            detail: joinDetailParts([departureGuest, formatGuestCount(departureCount), departureBox]) || 'Neúplná data hosta'
        }
    }

    if (hasArrival) {
        return {
            state: hasArrivalIdentity ? 'arrival' : 'arrival-incomplete',
            main: `Příj ${arrivalTime}`,
            detail: joinDetailParts([arrivalGuest, formatGuestCount(arrivalCount), arrivalBox]) || 'Neúplná data hosta'
        }
    }

    const stayoverRaw = room.stayoverGuestName || room.departure?.guestLabel || room.arrival?.guestLabel
    const stayoverGuest = shortGuestName(stayoverRaw)
    const occupied = Boolean(room.occupiedConfirmed || stayoverGuest)

    if (occupied) {
        return {
            state: 'occupied',
            main: 'Pobyt',
            detail: stayoverGuest || undefined,
            stayoverKey: normalizeGuestKey(stayoverRaw)
        }
    }

    if (room.freeConfirmed) {
        return {
            state: 'free',
            main: 'Volné'
        }
    }

    return { state: 'unknown', main: '—' }
}

export function getCarryOverBadgeLabel(room: RoomPlan, carryDateIso?: string) {
    if (!carryDateIso) return null
    if (room.status === 'hotovo') return null
    if (!isTodayRoomEligibleForCarryOver(room)) return null

    const date = new Date(`${carryDateIso}T00:00:00`)
    return `Nedokončeno z ${date.getDate()}.${date.getMonth() + 1}.`
}

export function buildCarryOverResolutionPatch(resolvedAt = new Date().toISOString()) {
    return {
        carryOverResolvedAt: resolvedAt
    }
}

export function applyCarryOverResolution(room: RoomPlan, resolvedAt = new Date().toISOString()): RoomPlan {
    return {
        ...room,
        ...buildCarryOverResolutionPatch(resolvedAt)
    }
}

export function canManageSupplyLifecycle(role: UserRole) {
    return isAdminRole(role) || isCleaningLeadRole(role) || isCleanerRole(role) || isMaintenanceRole(role)
}

export function buildCustomSupplyChipKey(name: string, section: SupplyChipSection) {
    return `${section}::${String(name || '').trim()}`
}

export function getPreferredSupplyChipSection(name: string): SupplyChipSection | null {
    const normalized = normalizeSupplyKeyword(name)
    if (!normalized) return null

    if (normalized.includes('sklenice na vino')) return 'vybaveni'
    if (normalized.includes('cif')) return 'uklid'
    if (normalized.includes('jar')) return 'uklid'

    return null
}

export function getSupplyCategoryForChipSection(section: SupplyChipSection): SupplyRequest['category'] {
    if (section === 'uklid') return 'cleaning'
    if (section === 'vybaveni') return 'other'
    return 'other'
}

export function parseCustomSupplyChips(customChips: string[]): ParsedCustomSupplyChip[] {
    const scopedNameSet = new Set<string>()
    const rawEntries = (customChips || []).map((chip) => {
        const raw = String(chip || '').trim()
        if (!raw) return null

        const parts = raw.split('::')
        if (parts.length === 2 && isSupplyChipSection(parts[0])) {
            const preferredSection = getPreferredSupplyChipSection(parts[1].trim())
            const scoped = {
                name: parts[1].trim(),
                section: preferredSection || parts[0]
            }
            if (scoped.name) scopedNameSet.add(normalizeChipLabel(scoped.name))
            return scoped.name ? scoped : null
        }

        return {
            name: raw,
            section: getPreferredSupplyChipSection(raw) || ('ostatni' as SupplyChipSection),
            legacy: true
        }
    }).filter(Boolean) as Array<(ParsedCustomSupplyChip & { legacy?: boolean })>

    const seenPerSection = new Set<string>()

    return rawEntries.filter((entry) => {
        const normalizedName = normalizeChipLabel(entry.name)
        if (!normalizedName) return false
        if (entry.legacy && scopedNameSet.has(normalizedName)) return false

        const sectionKey = `${entry.section}::${normalizedName}`
        if (seenPerSection.has(sectionKey)) return false
        seenPerSection.add(sectionKey)
        return true
    }).map(({ name, section }) => ({ name, section }))
}

export function getCustomSupplyChipsForSection(customChips: string[], section: SupplyChipSection) {
    return parseCustomSupplyChips(customChips).filter((chip) => chip.section === section)
}

export function canSetSupplyStatus(currentStatus: SupplyRequest['status'], nextStatus: SupplyRequest['status']) {
    if (nextStatus === 'ordered') {
        return currentStatus === 'new' || currentStatus === 'approved'
    }

    if (nextStatus === 'delivered' || nextStatus === 'handed_over') {
        return currentStatus === 'new' || currentStatus === 'approved' || currentStatus === 'ordered'
    }

    return false
}

export function isOpenSupplyStatus(status: SupplyRequest['status']) {
    return status !== 'cancelled' && status !== 'handed_over' && status !== 'delivered'
}

export function getSupplyRequestArchiveDate(request: SupplyRequest, fallbackDate = new Date()) {
    return parseSupplyArchiveDate(request.boughtAt)
    || parseSupplyArchiveDate((request as SupplyRequest & { completedAt?: string }).completedAt)
        || parseSupplyArchiveDate(request.updatedAt)
        || parseSupplyArchiveDate(request.createdAt)
    || fallbackDate
}

export function buildSupplyStatusPatch(request: SupplyRequest, status: SupplyRequest['status'], changedAt = new Date().toISOString()) {
    return {
        status,
        completedAt: status === 'delivered' || status === 'handed_over'
            ? ((request as SupplyRequest & { completedAt?: string }).completedAt || changedAt)
            : (request as SupplyRequest & { completedAt?: string }).completedAt,
        updatedAt: changedAt,
        boughtAt: status === 'delivered' || status === 'handed_over'
            ? (request.boughtAt || changedAt)
            : request.boughtAt
    }
}

export function applySupplyStatusUpdate(request: SupplyRequest, status: SupplyRequest['status'], changedAt = new Date().toISOString()): SupplyRequest {
    return {
        ...request,
        ...buildSupplyStatusPatch(request, status, changedAt)
    }
}

export function buildSupplyRequestUiBuckets(requests: SupplyRequest[]): SupplyRequestUiBuckets {
    const newRequests = requests.filter((request) => request.status === 'new' || request.status === 'approved')
    const maintenanceRequests = newRequests.filter((request) => !!request.linkedTaskId || (request.requestedByRole || '') === 'maintenance')
    const normalNewRequests = newRequests.filter((request) => !(!!request.linkedTaskId || (request.requestedByRole || '') === 'maintenance'))
    const orderedRequests = requests.filter((request) => request.status === 'ordered')
    const completedRequests = requests.filter((request) => request.status === 'delivered' || request.status === 'handed_over')
    const cancelledRequests = requests.filter((request) => request.status === 'cancelled')

    return {
        newRequests,
        maintenanceRequests,
        normalNewRequests,
        orderedRequests,
        completedRequests,
        cancelledRequests
    }
}

export function buildBoughtArchiveModel(requests: SupplyRequest[], fallbackDate = new Date()): BoughtArchiveModel {
    const completedRequests = requests
        .filter((request) => request.status === 'delivered' || request.status === 'handed_over')
        .slice()
        .sort((left, right) => {
            const leftDate = getSupplyRequestArchiveDate(left, fallbackDate)
            const rightDate = getSupplyRequestArchiveDate(right, fallbackDate)
            const leftTime = leftDate.getTime()
            const rightTime = rightDate.getTime()
            if (leftTime !== rightTime) return rightTime - leftTime
            return (right.itemName || '').localeCompare(left.itemName || '', 'cs')
        })

    const grouped = new Map<number, Map<number, SupplyRequest[]>>()

    completedRequests.forEach((request) => {
        const date = getSupplyRequestArchiveDate(request, fallbackDate)

        const year = date.getFullYear()
        const month = date.getMonth() + 1
        if (!grouped.has(year)) grouped.set(year, new Map<number, SupplyRequest[]>())
        const byMonth = grouped.get(year)!
        if (!byMonth.has(month)) byMonth.set(month, [])
        byMonth.get(month)!.push(request)
    })

    const years = Array.from(grouped.entries())
        .sort((left, right) => right[0] - left[0])
        .map(([year, months]) => {
            const monthModels = Array.from(months.entries())
                .sort((left, right) => right[0] - left[0])
                .map(([month, monthRequests]) => ({
                    key: `${year}-${String(month).padStart(2, '0')}`,
                    year,
                    month,
                    label: new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('cs-CZ', {
                        month: 'long',
                        year: 'numeric',
                        timeZone: 'UTC'
                    }),
                    count: monthRequests.length,
                    requests: monthRequests
                }))

            return {
                year,
                count: monthModels.reduce((sum, monthModel) => sum + monthModel.count, 0),
                months: monthModels
            }
        })

    return {
        years,
        totalCount: completedRequests.length
    }
}