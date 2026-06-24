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