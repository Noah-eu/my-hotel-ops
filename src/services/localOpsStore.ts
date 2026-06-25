import { ImportJob, MaintenanceItem, RoomPlan, StaffAvailabilityRecord, SupplyRequest, Task } from '../types'
import {
    CreateImportJobInput,
    CreateMaintenanceItemInput,
    CreateSupplyRequestInput,
    CreateTaskInput,
    OpsTab,
    OpsPersistedState,
    OpsStore
} from './opsStore'
import { buildStaffAvailabilityRecordId, upsertStaffAvailabilityRecord } from '../lib/teamAvailability'

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
        replaceRoomPlan(day: string, room: RoomPlan) {
            if (day !== 'Dnes' && day !== 'Zitra' && day !== 'Pozitri') return
            withState((state) => ({
                ...state,
                roomsByDay: {
                    ...state.roomsByDay,
                    [day]: state.roomsByDay[day].map((item) => (item.id === room.id ? room : item))
                }
            }))
        },
        createImportJob(input: CreateImportJobInput) {
            const job: ImportJob = {
                id: input.id || `ij-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                type: input.type,
                source: input.source,
                status: input.status,
                fileName: input.fileName,
                contentType: input.contentType,
                sizeBytes: input.sizeBytes,
                receivedAt: input.receivedAt,
                parsedAt: input.parsedAt,
                confirmedAt: input.confirmedAt,
                confirmedBy: input.confirmedBy,
                detectedDaysCount: input.detectedDaysCount,
                turnoverCount: input.turnoverCount,
                stayoverCount: input.stayoverCount,
                freeCount: input.freeCount,
                warnings: input.warnings,
                error: input.error,
                storagePath: input.storagePath,
                previewSummary: input.previewSummary,
                parserVersion: input.parserVersion,
                automation: input.automation
            }
            withState((state) => ({
                ...state,
                importJobs: [job, ...(state.importJobs || [])]
            }))
            return job
        },
        updateImportJob(jobId: string, patch: Partial<ImportJob>) {
            withState((state) => ({
                ...state,
                importJobs: (state.importJobs || []).map((job) => (job.id === jobId ? { ...job, ...patch } : job))
            }))
        },
        deleteImportJob(jobId: string) {
            withState((state) => ({
                ...state,
                importJobs: (state.importJobs || []).filter((job) => job.id !== jobId)
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
                assignedToUid: input.assignedToUid,
                assignedToName: input.assignedToName,
                status: 'new',
                note: input.note,
                createdBy: input.createdBy,
                createdAt: input.createdAt,
                taskDateIso: input.taskDateIso,
                attentionRequired: input.attentionRequired,
                attentionReason: input.attentionReason,
                acknowledgedAt: input.acknowledgedAt,
                acknowledgedBy: input.acknowledgedBy,
                maintenanceAcknowledgedAt: input.maintenanceAcknowledgedAt,
                maintenanceAcknowledgedBy: input.maintenanceAcknowledgedBy,
                source: input.source,
                createdByUid: input.createdByUid,
                createdByName: input.createdByName,
                createdByRole: input.createdByRole,
                importJobId: input.importJobId,
                importedAt: input.importedAt,
                createdSource: input.createdSource,
                completedAt: input.completedAt,
                completedByUid: input.completedByUid,
                completedByName: input.completedByName
            }
            withState((state) => ({ ...state, tasks: [task, ...state.tasks] }))
            return task
        },
        updateTask(taskId: string, patch: Partial<Task>) {
            withState((state) => ({
                ...state,
                tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task))
            }))
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
                linkedTaskId: input.linkedTaskId,
                requestedBy: input.requestedBy,
                requestedByRole: input.requestedByRole,
                createdAt: input.createdAt,
                completedAt: input.completedAt,
                updatedAt: input.updatedAt,
                boughtAt: input.boughtAt,
                status: 'new',
                priority: input.priority,
                source: input.source,
                createdByUid: input.createdByUid,
                createdByName: input.createdByName,
                createdByRole: input.createdByRole,
                importJobId: input.importJobId,
                importedAt: input.importedAt
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
        updateSupplyStatus(requestId: string, status: SupplyRequest['status'], patch?: Partial<SupplyRequest>) {
            withState((state) => ({
                ...state,
                supplyRequests: state.supplyRequests.map((request) => (request.id === requestId ? { ...request, status, ...patch } : request))
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
                createdAt: input.createdAt,
                maintenanceAcknowledgedAt: input.maintenanceAcknowledgedAt,
                maintenanceAcknowledgedBy: input.maintenanceAcknowledgedBy,
                source: input.source,
                createdByUid: input.createdByUid,
                createdByName: input.createdByName,
                createdByRole: input.createdByRole,
                importJobId: input.importJobId,
                importedAt: input.importedAt
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
        setStaffAvailability(dateIso: string, id: string, availability) {
            withState((state) => ({
                ...state,
                dailyAvailabilityRecords: upsertStaffAvailabilityRecord(state.dailyAvailabilityRecords || [], {
                    id: buildStaffAvailabilityRecordId(dateIso, id),
                    dateIso,
                    staffId: id,
                    availability,
                    updatedAt: new Date().toISOString()
                } as StaffAvailabilityRecord)
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
