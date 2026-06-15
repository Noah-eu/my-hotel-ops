import { MaintenanceItem, RoomPlan, SupplyRequest, Task, UserRole } from '../types'

export type OpsTab = 'Dnes' | 'Zitra' | 'Pozitri'
export type OpsView = 'today' | 'admin' | 'maintenance' | 'supplies'

export interface OpsPersistedState {
    userId: string
    tab: OpsTab
    view: OpsView
    roomsByDay: Record<OpsTab, RoomPlan[]>
    tasks: Task[]
    supplyRequests: SupplyRequest[]
    maintenanceItems: MaintenanceItem[]
    customSupplyChips: string[]
    staff: { id: string; name: string; role: UserRole; availability?: 'dnes_pracuji' | 'dnes_nepracuji' | 'jen_urgentni' }[]
}

export interface CreateTaskInput {
    id?: string
    roomNumber: string
    title: string
    category: Task['category']
    priority: Task['priority']
    assignedToRole: Extract<UserRole, 'lead' | 'cleaner' | 'maintenance'>
    note?: string
    createdBy: string
    createdAt: string
}

export interface CreateSupplyRequestInput {
    id?: string
    itemName: string
    category: SupplyRequest['category']
    quantityLevel: SupplyRequest['quantityLevel']
    customQuantity?: string
    roomNumber?: string
    note?: string
    priority: SupplyRequest['priority']
    requestedBy: string
    requestedByRole: UserRole
    createdAt: string
}

export interface CreateMaintenanceItemInput {
    id?: string
    roomNumber?: string
    title: string
    category: MaintenanceItem['category']
    priority: MaintenanceItem['priority']
    note?: string
    reportedBy: string
    createdAt: string
}

export interface OpsStore {
    mode: 'demo' | 'online'
    loadInitialState(): OpsPersistedState | null
    initializeState(defaultState: OpsPersistedState): Promise<void>
    subscribeState(onState: (state: Partial<OpsPersistedState>) => void, onError: (message: string) => void): (() => void) | null
    saveState(state: OpsPersistedState): void
    updateRoomPlan(day: OpsTab, roomId: string, patch: Partial<RoomPlan>): void
    createTask(input: CreateTaskInput): Task | null
    updateTaskStatus(taskId: string, status: Task['status']): void
    createSupplyRequest(input: CreateSupplyRequestInput): SupplyRequest | null
    cancelSupplyRequest(requestId: string): void
    updateSupplyStatus(requestId: string, status: SupplyRequest['status']): void
    createMaintenanceItem(input: CreateMaintenanceItemInput): MaintenanceItem | null
    updateMaintenanceItem(itemId: string, patch: Partial<MaintenanceItem>): void
    setStaffAvailability(id: string, availability: 'dnes_pracuji' | 'dnes_nepracuji' | 'jen_urgentni'): void
    resetDemoState(defaultState: OpsPersistedState): Promise<void> | void
}
