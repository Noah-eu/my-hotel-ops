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

export type ImportJobType = 'previo-state-pdf'
export type ImportJobSource = 'email' | 'manual'
export type ImportJobStatus = 'received' | 'parsed' | 'needs_review' | 'confirmed' | 'failed' | 'cancelled'

export type ImportSafetyStatus = 'ok' | 'blocked'

export interface ImportJobSafetySummary {
    status: ImportSafetyStatus
    blocked: boolean
    warnings: string[]
    blocks: string[]
    checkedAt: string
    parserVersion: string
    parserVersionMissing: boolean
    parserVersionOutdated: boolean
    metrics?: {
        turnoverRows?: number
        suspiciousNightRows?: number
        arrivalsAtEleven?: number
        departuresBeforeEight?: number
        turnoverRowsMissingGuestName?: number
        arrivalsMissingIdentity?: number
        departuresMissingIdentity?: number
        parsedRows?: number
        parsedDayCount?: number
        previewDayCount?: number
    }
}

export type RoomPlanScheduleSnapshot = {
    situation?: RoomSituation
    departure?: DepartureInfo | null
    arrival?: ArrivalInfo | null
    nextArrivalPreview?: NextArrivalPreview | null
    departureTime?: string
    arrivalTime?: string
    guestCount?: number
    box?: string
    notes?: string[]
    occupiedConfirmed?: boolean
    freeConfirmed?: boolean
    stateSource?: 'previo-state-pdf'
    stateImportedAt?: string
    planDateIso?: string
    stayoverGuestName?: string
    stayoverUntil?: string
}

export interface ImportBackupRoomSnapshot {
    roomId: string
    roomNumber: string
    schedule: RoomPlanScheduleSnapshot
}

export interface ImportJobBackupPayload {
    jobId: string
    createdAt: string
    createdBy?: string
    affectedDates: string[]
    affectedRoomCount: number
    snapshotByDate: Record<string, ImportBackupRoomSnapshot[]>
}

export interface ImportJobBackupSummary {
    backupId: string
    createdAt: string
    createdBy?: string
    affectedDates: string[]
    affectedRoomCount: number
    rolledBackAt?: string
    rolledBackBy?: string
}

export interface ImportJobPreviewSummary {
    parsedTabDates?: Partial<Record<'Dnes' | 'Zitra' | 'Pozitri', string>>
    byDate?: Record<string, RoomPlan[]>
    missingDateLabels?: string[]
    parserVersion?: string
    safety?: ImportJobSafetySummary
    preview?: {
        days: Array<{
            dateIso: string
            dateLabel: string
            rows: Array<{
                dateIso: string
                roomNumber: string
                departureTime?: string
                arrivalTime?: string
                departureGuestName?: string
                departureGuestCount?: number
                arrivalGuestName?: string
                arrivalGuestCount?: number
                stayoverGuestName?: string
                stayoverUntil?: string
                departureNotes: string[]
                arrivalNotes: string[]
                isStayover: boolean
                warnings: string[]
            }>
            turnoverCount: number
            stayoverCount: number
            presentRooms: string[]
            derivedFreeRooms: string[]
            complete: boolean
            warnings: string[]
        }>
        warnings: string[]
        unknownRooms: string[]
        parsedRows: number
        turnoverCount: number
        stayoverCount: number
        derivedFreeCount: number
        confidenceLow: boolean
        amPmEvidence?: boolean
        parsedDateCount?: number
        completeDateCount?: number
        dayTotals?: Record<string, { arrivals?: number; departures?: number; stayovers?: number }>
        parserVersion?: string
        parsedTabDates: Partial<Record<'Dnes' | 'Zitra' | 'Pozitri', string>>
    }
}

export interface ImportJob {
    id: string
    type: ImportJobType
    source: ImportJobSource
    status: ImportJobStatus
    fileName: string
    contentType?: string
    sizeBytes?: number
    receivedAt: string
    parsedAt?: string
    confirmedAt?: string
    confirmedBy?: string
    detectedDaysCount?: number
    turnoverCount?: number
    stayoverCount?: number
    freeCount?: number
    warnings: string[]
    error?: string
    storagePath?: string
    previewSummary?: ImportJobPreviewSummary
    parserVersion?: string
    backupSummary?: ImportJobBackupSummary
    backupPayload?: ImportJobBackupPayload
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
    taskDateIso?: string
    attentionRequired?: boolean
    attentionReason?: 'late_today_room_task'
    acknowledgedAt?: string
    acknowledgedBy?: string
    maintenanceAcknowledgedAt?: string
    maintenanceAcknowledgedBy?: string
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
    category: 'water' | 'drain' | 'electricity' | 'lock' | 'safe' | 'tv_wifi' | 'heating' | 'furniture' | 'appliance' | 'room_issue' | 'other'
    priority: 'normal' | 'urgent'
    status: 'new' | 'accepted' | 'in_progress' | 'waiting_material' | 'done' | 'cannot_today' | 'cancelled'
    note?: string
    reportedBy: string
    assignedTo?: string
    createdAt: string
    updatedAt?: string
    materialNeeded?: string
    maintenanceAcknowledgedAt?: string
    maintenanceAcknowledgedBy?: string
}
