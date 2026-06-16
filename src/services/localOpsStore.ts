import { MaintenanceItem, SupplyRequest, Task } from '../types'
import {
    CreateMaintenanceItemInput,
    CreateSupplyRequestInput,
    CreateTaskInput,
    OpsPersistedState,
    OpsStore,
    OpsTab
} from './opsStore'

const STORAGE_KEY = 'mho_demo_state_v1'

function readState(): OpsPersistedState | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return null
        return JSON.parse(raw) as OpsPersistedState
    } catch (e) {
        console.warn('Failed to read local demo state', e)
        return null
    }
}

function writeState(state: OpsPersistedState) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch (e) {
        console.warn('Failed to write local demo state', e)
    }
}

function withState(mutator: (state: OpsPersistedState) => OpsPersistedState) {
    const state = readState()
    if (!state) return
    writeState(mutator(state))
}

export function createLocalOpsStore(): OpsStore {
    return {
        mode: 'demo',
        loadInitialState() {
            return readState()
        },
        async initializeState(_defaultState) {
            // Demo mode uses local storage and does not require bootstrap.
        },
        subscribeState(_onState, _onError) {
            // Demo mode is local-only; no realtime cross-device listener.
            return null
        },
        saveState(state) {
            writeState(state)
        },
        updateRoomPlan(day: OpsTab, roomId: string, patch) {
            withState((state) => ({
                ...state,
                roomsByDay: {
                    ...state.roomsByDay,
                    [day]: state.roomsByDay[day].map((room) => (room.id === roomId ? { ...room, ...patch } : room))
                }
            }))
        },
        replaceRoomPlan(day: OpsTab, room) {
            withState((state) => ({
                ...state,
                roomsByDay: {
                    ...state.roomsByDay,
                    [day]: state.roomsByDay[day].map((item) => (item.id === room.id ? room : item))
                }
            }))
        },
        createTask(input: CreateTaskInput) {
            const task: Task = {
                id: input.id || `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                roomNumber: input.roomNumber,
                title: input.title,
                category: input.category,
                priority: input.priority,
                assignedToRole: input.assignedToRole,
                status: 'new',
                note: input.note,
                createdBy: input.createdBy,
                createdAt: input.createdAt
            }
            withState((state) => ({ ...state, tasks: [task, ...state.tasks] }))
            return task
        },
        updateTaskStatus(taskId: string, status: Task['status']) {
            withState((state) => ({
                ...state,
                tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, status } : task))
            }))
        },
        createSupplyRequest(input: CreateSupplyRequestInput) {
            const request: SupplyRequest = {
                id: input.id || `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                itemName: input.itemName,
                category: input.category,
                quantityLevel: input.quantityLevel,
                customQuantity: input.customQuantity,
                roomNumber: input.roomNumber,
                note: input.note,
                requestedBy: input.requestedBy,
                requestedByRole: input.requestedByRole,
                createdAt: input.createdAt,
                status: 'new',
                priority: input.priority
            }
            withState((state) => ({ ...state, supplyRequests: [request, ...state.supplyRequests] }))
            return request
        },
        cancelSupplyRequest(requestId: string) {
            withState((state) => ({
                ...state,
                supplyRequests: state.supplyRequests.filter((request) => request.id !== requestId)
            }))
        },
        updateSupplyStatus(requestId: string, status: SupplyRequest['status']) {
            withState((state) => ({
                ...state,
                supplyRequests: state.supplyRequests.map((request) => (request.id === requestId ? { ...request, status } : request))
            }))
        },
        createMaintenanceItem(input: CreateMaintenanceItemInput) {
            const item: MaintenanceItem = {
                id: input.id || `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                roomNumber: input.roomNumber,
                title: input.title,
                category: input.category,
                priority: input.priority,
                status: 'new',
                note: input.note,
                reportedBy: input.reportedBy,
                createdAt: input.createdAt
            }
            withState((state) => ({ ...state, maintenanceItems: [item, ...state.maintenanceItems] }))
            return item
        },
        updateMaintenanceItem(itemId: string, patch: Partial<MaintenanceItem>) {
            withState((state) => ({
                ...state,
                maintenanceItems: state.maintenanceItems.map((item) => (item.id === itemId ? { ...item, ...patch } : item))
            }))
        },
        setStaffAvailability(id: string, availability) {
            withState((state) => ({
                ...state,
                staff: state.staff.map((person) => (person.id === id ? { ...person, availability } : person))
            }))
        },
        resetDemoState(_defaultState) {
            try {
                localStorage.removeItem(STORAGE_KEY)
            } catch (e) {
                console.warn('Failed to clear local demo state', e)
            }
        }
    }
}
