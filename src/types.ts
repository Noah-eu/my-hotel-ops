export type UserRole = 'admin' | 'lead' | 'cleaner' | 'maintenance'

export type RoomSituation = 'odjezd' | 'prijezd' | 'odjezd_prijezd' | 'volny'

export type RoomStatus = 'ceka' | 'problem' | 'prevzato' | 'probihá' | 'odhad' | 'hotovo' | 'neni'

export type PlanDay = 'Dnes' | 'Zitra' | 'Pozitri'

export interface DepartureInfo {
    time: string
    guestCount?: number
    guestLabel?: string
    notes?: string[]
}

export interface ArrivalInfo {
    time: string
    guestCount?: number
    guestLabel?: string
    box?: string
    notes?: string[]
}

export interface NextArrivalPreview {
    day: 'zitra' | 'pozitri'
    time: string
}

export interface RoomPlan {
    id: string
    number: string
    situation: RoomSituation
    departure?: DepartureInfo
    arrival?: ArrivalInfo
    nextArrivalPreview?: NextArrivalPreview
    departureTime?: string // HH:MM
    arrivalTime?: string
    guestCount?: number
    box?: string
    notes?: string[]
    status: RoomStatus
    assigned?: string // user id
    estimatedReady?: string // HH:MM concrete time
    estimateSetAt?: string // HH:MM when estimate was set
    statusNote?: string
    checkoutException?: boolean
    occupiedConfirmed?: boolean
    freeConfirmed?: boolean
    stateSource?: 'previo-state-pdf'
    stateImportedAt?: string
    planDateIso?: string
    stayoverGuestName?: string
    stayoverUntil?: string
}

export interface Task {
    id: string
    roomNumber: string
    title: string
    category: 'cleaning' | 'maintenance' | 'guest_request' | 'supplies' | 'other'
    priority: 'normal' | 'urgent'
    assignedToRole: UserRole
    assignedToName?: string
    status: 'new' | 'read' | 'accepted' | 'in_progress' | 'done' | 'problem' | 'cancelled'
    note?: string
    createdBy: string
    createdAt: string
}

export type Availability = 'dnes_pracuji' | 'dnes_nepracuji' | 'jen_urgentni'

export interface SupplyRequest {
    id: string
    itemName: string
    category: 'cleaning' | 'laundry' | 'bathroom' | 'kitchen' | 'maintenance' | 'other'
    quantityLevel: 'low' | 'medium' | 'high' | 'custom'
    customQuantity?: string
    roomNumber?: string
    note?: string
    requestedBy: string
    requestedByRole: UserRole
    createdAt: string
    status: 'new' | 'approved' | 'ordered' | 'delivered' | 'handed_over' | 'cancelled'
    priority: 'normal' | 'urgent'
}

export interface MaintenanceItem {
    id: string
    roomNumber?: string
    title: string
    category: 'water' | 'drain' | 'electricity' | 'lock' | 'safe' | 'tv_wifi' | 'heating' | 'furniture' | 'appliance' | 'other'
    priority: 'normal' | 'urgent'
    status: 'new' | 'accepted' | 'in_progress' | 'waiting_material' | 'done' | 'cannot_today' | 'cancelled'
    note?: string
    reportedBy: string
    assignedTo?: string
    createdAt: string
    updatedAt?: string
    materialNeeded?: string
}
