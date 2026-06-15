import {
    deleteDoc,
    collection,
    doc,
    getDocs,
    getDoc,
    onSnapshot,
    serverTimestamp,
    setDoc,
    updateDoc,
    writeBatch
} from 'firebase/firestore'
import { ensureAnonymousAuth, firestoreDb } from '../lib/firebase'
import { MaintenanceItem, SupplyRequest, Task } from '../types'
import {
    CreateMaintenanceItemInput,
    CreateSupplyRequestInput,
    CreateTaskInput,
    OpsPersistedState,
    OpsStore,
    OpsTab
} from './opsStore'

const DEFAULT_HOTEL_ID = 'chill-apartments'

function roomPlanId(day: OpsTab, roomId: string) {
    return `${day}-${roomId}`
}

async function ensureSeeded(defaultState: OpsPersistedState) {
    if (!firestoreDb) return

    const metaRef = doc(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'meta', 'appState')
    const metaSnap = await getDoc(metaRef)
    if (metaSnap.exists() && metaSnap.data()?.seeded) return

    const batch = writeBatch(firestoreDb)

    ;(['Dnes', 'Zitra', 'Pozitri'] as OpsTab[]).forEach((day) => {
        defaultState.roomsByDay[day].forEach((room) => {
            const ref = doc(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'roomPlans', roomPlanId(day, room.id))
            batch.set(ref, { ...room, day })
        })
    })

    defaultState.tasks.forEach((task) => {
        const ref = doc(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'tasks', task.id)
        batch.set(ref, task)
    })

    defaultState.supplyRequests.forEach((request) => {
        const ref = doc(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'supplyRequests', request.id)
        batch.set(ref, request)
    })

    defaultState.maintenanceItems.forEach((item) => {
        const ref = doc(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'maintenanceItems', item.id)
        batch.set(ref, item)
    })

    defaultState.staff.forEach((member) => {
        const staffRef = doc(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'staff', member.id)
        const availabilityRef = doc(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'dailyAvailability', member.id)
        batch.set(staffRef, member)
        batch.set(availabilityRef, {
            staffId: member.id,
            availability: member.availability || 'dnes_nepracuji',
            updatedAt: serverTimestamp()
        })
    })

    batch.set(metaRef, {
        seeded: true,
        seededAt: serverTimestamp()
    })

    await batch.commit()
}

async function clearCollection(path: string[]) {
    if (!firestoreDb) return
    const snap = await getDocs(collection(firestoreDb, ...path))
    if (snap.empty) return
    const batch = writeBatch(firestoreDb)
    snap.docs.forEach((d) => batch.delete(d.ref))
    await batch.commit()
}

function toRoomPlansByDay(docs: Array<Record<string, any>>) {
    const grouped: OpsPersistedState['roomsByDay'] = { Dnes: [], Zitra: [], Pozitri: [] }
    docs.forEach((item) => {
        const day = item.day as OpsTab
        if (!day || !grouped[day]) return
        const { day: _day, ...room } = item
        grouped[day].push(room)
    })
    return grouped
}

export function createFirebaseOpsStore(): OpsStore {
    return {
        mode: 'online',
        loadInitialState() {
            return null
        },
        async initializeState(defaultState) {
            if (!firestoreDb) return
            await ensureAnonymousAuth()
            await ensureSeeded(defaultState)
        },
        subscribeState(onState, onError) {
            if (!firestoreDb) return null

            const unsubs: Array<() => void> = []
            const roomPlansByDay: OpsPersistedState['roomsByDay'] = { Dnes: [], Zitra: [], Pozitri: [] }
            let tasks: Task[] = []
            let supplyRequests: SupplyRequest[] = []
            let maintenanceItems: MaintenanceItem[] = []
            let staffDocs: any[] = []
            let availabilityDocs: any[] = []

            function emitState() {
                if (roomPlansByDay.Dnes.length === 0 && roomPlansByDay.Zitra.length === 0 && roomPlansByDay.Pozitri.length === 0) return
                const availabilityMap = new Map(availabilityDocs.map((d) => [d.staffId || d.id, d.availability]))
                const staff = staffDocs.map((member) => ({
                    ...member,
                    availability: availabilityMap.get(member.id) || member.availability
                }))
                onState({
                    roomsByDay,
                    tasks,
                    supplyRequests,
                    maintenanceItems,
                    staff
                })
            }

            unsubs.push(onSnapshot(
                collection(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'roomPlans'),
                (snap) => {
                    const docs = snap.docs.map((d) => d.data() as Record<string, any>)
                    const grouped = toRoomPlansByDay(docs)
                    roomPlansByDay.Dnes = grouped.Dnes
                    roomPlansByDay.Zitra = grouped.Zitra
                    roomPlansByDay.Pozitri = grouped.Pozitri
                    emitState()
                },
                (err) => onError(`Firestore roomPlans listener failed: ${err.message}`)
            ))

            unsubs.push(onSnapshot(
                collection(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'tasks'),
                (snap) => {
                    tasks = snap.docs.map((d) => d.data() as Task)
                    emitState()
                },
                (err) => onError(`Firestore tasks listener failed: ${err.message}`)
            ))

            unsubs.push(onSnapshot(
                collection(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'supplyRequests'),
                (snap) => {
                    supplyRequests = snap.docs.map((d) => d.data() as SupplyRequest)
                    emitState()
                },
                (err) => onError(`Firestore supplyRequests listener failed: ${err.message}`)
            ))

            unsubs.push(onSnapshot(
                collection(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'maintenanceItems'),
                (snap) => {
                    maintenanceItems = snap.docs.map((d) => d.data() as MaintenanceItem)
                    emitState()
                },
                (err) => onError(`Firestore maintenanceItems listener failed: ${err.message}`)
            ))

            unsubs.push(onSnapshot(
                collection(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'staff'),
                (snap) => {
                    staffDocs = snap.docs.map((d) => d.data())
                    emitState()
                },
                (err) => onError(`Firestore staff listener failed: ${err.message}`)
            ))

            unsubs.push(onSnapshot(
                collection(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'dailyAvailability'),
                (snap) => {
                    availabilityDocs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
                    emitState()
                },
                (err) => onError(`Firestore dailyAvailability listener failed: ${err.message}`)
            ))

            return () => {
                unsubs.forEach((u) => u())
            }
        },
        saveState(_state: OpsPersistedState) {
            // Realtime listeners are source of truth in online mode.
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
            setDoc(doc(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'supplyRequests', request.id), request).catch(() => {
                // Safe no-op in skeleton mode.
            })
            return request
        },
        cancelSupplyRequest(requestId: string) {
            if (!firestoreDb) return
            deleteDoc(doc(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'supplyRequests', requestId)).catch(() => {
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
            setDoc(
                doc(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'dailyAvailability', id),
                { staffId: id, availability, updatedAt: serverTimestamp() },
                { merge: true }
            ).catch(() => {
                // Safe no-op in skeleton mode.
            })
            updateDoc(doc(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'staff', id), { availability }).catch(() => {
                // Staff doc may not be writable in some environments.
            })
        },
        async resetDemoState(defaultState) {
            if (!firestoreDb) return
            await clearCollection(['hotels', DEFAULT_HOTEL_ID, 'roomPlans'])
            await clearCollection(['hotels', DEFAULT_HOTEL_ID, 'tasks'])
            await clearCollection(['hotels', DEFAULT_HOTEL_ID, 'supplyRequests'])
            await clearCollection(['hotels', DEFAULT_HOTEL_ID, 'maintenanceItems'])
            await clearCollection(['hotels', DEFAULT_HOTEL_ID, 'dailyAvailability'])
            await clearCollection(['hotels', DEFAULT_HOTEL_ID, 'staff'])
            await setDoc(doc(firestoreDb, 'hotels', DEFAULT_HOTEL_ID, 'meta', 'appState'), {
                seeded: false,
                resetAt: serverTimestamp()
            }, { merge: true })
            await ensureSeeded(defaultState)
        }
    }
}
