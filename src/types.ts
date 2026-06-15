export type UserRole = 'admin' | 'lead' | 'cleaner' | 'maintenance'

export type RoomSituation = 'odjezd' | 'prijezd' | 'odjezd_prijezd' | 'volny'

export type RoomStatus = 'ceka' | 'prevzato' | 'probihá' | 'odhad' | 'hotovo' | 'neni'

export interface RoomPlan {
    id: string
    number: string
    situation: RoomSituation
    departureTime?: string // HH:MM
    arrivalTime?: string
    guestCount?: number
    box?: string
    notes?: string[]
    status: RoomStatus
    assigned?: string // user id
    estimatedReady?: string // HH:MM concrete time
}

export interface Task {
    id: string
    title: string
    roomId?: string
    assignedTo?: string
}

export type Availability = 'dnes_pracuji' | 'dnes_nepracuji' | 'jen_urgentni'

export interface SupplyRequest {
    id: string
    item: string
    qty: number
    note?: string
    status: 'open' | 'fulfilled'
}
