import {
    collection,
    doc,
    getDocs,
    limit,
    query,
    setDoc,
    updateDoc
} from 'firebase/firestore'
import { firestoreDb } from '../lib/firebase'
import { MaintenanceItem, SupplyRequest, Task } from '../types'
import {
    CreateMaintenanceItemInput,
    CreateSupplyRequestInput,
    CreateTaskInput,
    OpsPersistedState,
    OpsStore,
    OpsTab
} from './opsStore'

const DEFAULT_HOTEL_ID = 'demo-hotel'

export function createFirebaseOpsStore(): OpsStore {
    return {
        mode: 'online',
        loadInitialState() {
            // Online mode bootstrap is intentionally minimal for now.
            return null
        },
        saveState(_state: OpsPersistedState) {
            // Intentionally no-op until full online state sync is introduced.
        },
        updateRoomPlan(day: OpsTab, roomId: string, patch) {
            if (!firestoreDb) return
            const ref = doc(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'roomPlans', `${day}-${roomId}`)
            updateDoc(ref, patch as Record<string, unknown>).catch(() => {
                // Safe no-op in skeleton mode.
            })
        },
        createTask(input: CreateTaskInput) {
            if (!firestoreDb) return null
            const task: Task = {
                id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
            setDoc(doc(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'tasks', task.id), task).catch(() => {
                // Safe no-op in skeleton mode.
            })
            return task
        },
        updateTaskStatus(taskId: string, status: Task['status']) {
            if (!firestoreDb) return
            updateDoc(doc(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'tasks', taskId), { status }).catch(() => {
                // Safe no-op in skeleton mode.
            })
        },
        createSupplyRequest(input: CreateSupplyRequestInput) {
            if (!firestoreDb) return null
            const request: SupplyRequest = {
                id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
            setDoc(doc(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'supplyRequests', request.id), request).catch(() => {
                // Safe no-op in skeleton mode.
            })
            return request
        },
        cancelSupplyRequest(requestId: string) {
            if (!firestoreDb) return
            updateDoc(doc(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'supplyRequests', requestId), { status: 'cancelled' }).catch(() => {
                // Safe no-op in skeleton mode.
            })
        },
        updateSupplyStatus(requestId: string, status: SupplyRequest['status']) {
            if (!firestoreDb) return
            updateDoc(doc(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'supplyRequests', requestId), { status }).catch(() => {
                // Safe no-op in skeleton mode.
            })
        },
        createMaintenanceItem(input: CreateMaintenanceItemInput) {
            if (!firestoreDb) return null
            const item: MaintenanceItem = {
                id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                roomNumber: input.roomNumber,
                title: input.title,
                category: input.category,
                priority: input.priority,
                status: 'new',
                note: input.note,
                reportedBy: input.reportedBy,
                createdAt: input.createdAt
            }
            setDoc(doc(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'maintenanceItems', item.id), item).catch(() => {
                // Safe no-op in skeleton mode.
            })
            return item
        },
        updateMaintenanceItem(itemId: string, patch: Partial<MaintenanceItem>) {
            if (!firestoreDb) return
            updateDoc(doc(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'maintenanceItems', itemId), patch as Record<string, unknown>).catch(() => {
                // Safe no-op in skeleton mode.
            })
        },
        setStaffAvailability(id: string, availability) {
            if (!firestoreDb) return
            updateDoc(doc(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'dailyAvailability', id), { availability }).catch(() => {
                // Safe no-op in skeleton mode.
            })
        },
        resetDemoState() {
            // In online mode we intentionally do not delete cloud data from client reset button.
        }
    }
}

export async function probeFirebaseConnection(): Promise<boolean> {
    if (!firestoreDb) return false
    try {
        const snap = await getDocs(query(collection(firestoreDb, 'hotels'), limit(1)))
        return !snap.empty || snap.empty
    } catch {
        return false
    }
}
