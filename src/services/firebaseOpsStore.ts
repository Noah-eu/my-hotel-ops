import {
    deleteDoc,
    collection,
    doc,
    getDocs,
    getDoc,
    onSnapshot,
    type FirestoreError,
    serverTimestamp,
    setDoc,
    updateDoc,
    writeBatch
} from 'firebase/firestore'
import { ensureAnonymousAuth, firebaseAuth, firestoreDb } from '../lib/firebase'
import { MaintenanceItem, SupplyRequest, Task } from '../types'
import {
    CreateMaintenanceItemInput,
    CreateSupplyRequestInput,
    CreateTaskInput,
    OpsStoreError,
    OpsPersistedState,
    OpsStore,
    OpsTab
} from './opsStore'

const DEV = import.meta.env.DEV

function devLog(message: string, payload?: unknown) {
    if (!DEV) return
    if (typeof payload === 'undefined') {
        console.info(`[FirestoreStore] ${message}`)
        return
    }
    console.info(`[FirestoreStore] ${message}`, payload)
}

function toStoreError(error: any, fallbackMessage: string): OpsStoreError {
    return {
        code: error?.code,
        message: error?.message || fallbackMessage
    }
}

function formatAuthContext() {
    const hasAuthUser = Boolean(firebaseAuth?.currentUser)
    const uid = firebaseAuth?.currentUser?.uid || 'none'
    return { hasAuthUser, uid }
}

function buildListenerError(error: FirestoreError, path: string): OpsStoreError {
    const authCtx = formatAuthContext()
    return {
        code: error.code,
        message: `${path} listener failed: ${error.message} (authUser=${authCtx.hasAuthUser}, uid=${authCtx.uid})`
    }
}

function buildFirestoreOperationError(error: any, path: string, operation: string): Error {
    const authCtx = formatAuthContext()
    const code = error?.code
    const message = `${path} ${operation} failed: ${error?.message || 'Unknown Firestore error'} (authUser=${authCtx.hasAuthUser}, uid=${authCtx.uid})`
    const wrapped = new Error(message) as Error & { code?: string }
    wrapped.code = code
    return wrapped
}

async function runWrite(label: string, operation: () => Promise<void>) {
    try {
        await ensureAnonymousAuth()
        await operation()
        devLog(`write success: ${label}`)
    } catch (error: any) {
        devLog(`write failure: ${label}`, {
            code: error?.code || null,
            message: error?.message || 'Unknown write error'
        })
    }
}

export const ONLINE_HOTEL_ID = 'chill-apartments'
const PATHS = {
    meta: `hotels/${ONLINE_HOTEL_ID}/meta/appState`,
    roomPlans: `hotels/${ONLINE_HOTEL_ID}/roomPlans`,
    tasks: `hotels/${ONLINE_HOTEL_ID}/tasks`,
    supplyRequests: `hotels/${ONLINE_HOTEL_ID}/supplyRequests`,
    maintenanceItems: `hotels/${ONLINE_HOTEL_ID}/maintenanceItems`,
    staff: `hotels/${ONLINE_HOTEL_ID}/staff`,
    dailyAvailability: `hotels/${ONLINE_HOTEL_ID}/dailyAvailability`
}

function roomPlanId(day: OpsTab, roomId: string) {
    return `${day}-${roomId}`
}

async function ensureSeeded(defaultState: OpsPersistedState) {
    if (!firestoreDb) return

    const metaRef = doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'meta', 'appState')
    const metaSnap = await getDoc(metaRef)
    if (metaSnap.exists() && metaSnap.data()?.seeded) {
        devLog('Seed skipped - already seeded')
        return
    }

    devLog('Seed started')
    devLog('Path audit', PATHS)

    const batch = writeBatch(firestoreDb)

        ; (['Dnes', 'Zitra', 'Pozitri'] as OpsTab[]).forEach((day) => {
            defaultState.roomsByDay[day].forEach((room) => {
                const ref = doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'roomPlans', roomPlanId(day, room.id))
                batch.set(ref, { ...room, day })
            })
        })

    defaultState.tasks.forEach((task) => {
        const ref = doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'tasks', task.id)
        batch.set(ref, task)
    })

    defaultState.supplyRequests.forEach((request) => {
        const ref = doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'supplyRequests', request.id)
        batch.set(ref, request)
    })

    defaultState.maintenanceItems.forEach((item) => {
        const ref = doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'maintenanceItems', item.id)
        batch.set(ref, item)
    })

    defaultState.staff.forEach((member) => {
        const staffRef = doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'staff', member.id)
        const availabilityRef = doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'dailyAvailability', member.id)
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
    devLog('Seed completed')
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
    let authReadyUid: string | null = null

    return {
        mode: 'online',
        loadInitialState() {
            return null
        },
        async initializeState(defaultState) {
            if (!firestoreDb) return
            const authUser = await ensureAnonymousAuth()
            authReadyUid = authUser?.uid || null
            devLog('Auth ready before seed/listeners', { uid: authReadyUid })
            try {
                await ensureSeeded(defaultState)
            } catch (error: any) {
                throw buildFirestoreOperationError(error, PATHS.meta, 'seed/check')
            }
        },
        subscribeState(onState, onError) {
            if (!firestoreDb) return null
            if (!firebaseAuth?.currentUser || !authReadyUid) {
                const authCtx = formatAuthContext()
                const authError: OpsStoreError = {
                    code: 'auth/not-ready',
                    message: `Refusing to attach listeners before auth is ready (authUser=${authCtx.hasAuthUser}, uid=${authCtx.uid})`
                }
                onError(authError)
                return null
            }

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
                collection(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'roomPlans'),
                (snap) => {
                    const docs = snap.docs.map((d) => d.data() as Record<string, any>)
                    const grouped = toRoomPlansByDay(docs)
                    roomPlansByDay.Dnes = grouped.Dnes
                    roomPlansByDay.Zitra = grouped.Zitra
                    roomPlansByDay.Pozitri = grouped.Pozitri
                    emitState()
                },
                (err) => {
                    const fullError = buildListenerError(err, PATHS.roomPlans)
                    devLog('Listener error: roomPlans', fullError)
                    onError(fullError)
                }
            ))
            devLog('Listener attached: roomPlans')

            unsubs.push(onSnapshot(
                collection(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'tasks'),
                (snap) => {
                    tasks = snap.docs.map((d) => d.data() as Task)
                    emitState()
                },
                (err) => {
                    const fullError = buildListenerError(err, PATHS.tasks)
                    devLog('Listener error: tasks', fullError)
                    onError(fullError)
                }
            ))
            devLog('Listener attached: tasks')

            unsubs.push(onSnapshot(
                collection(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'supplyRequests'),
                (snap) => {
                    supplyRequests = snap.docs.map((d) => d.data() as SupplyRequest)
                    emitState()
                },
                (err) => {
                    const fullError = buildListenerError(err, PATHS.supplyRequests)
                    devLog('Listener error: supplyRequests', fullError)
                    onError(fullError)
                }
            ))
            devLog('Listener attached: supplyRequests')

            unsubs.push(onSnapshot(
                collection(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'maintenanceItems'),
                (snap) => {
                    maintenanceItems = snap.docs.map((d) => d.data() as MaintenanceItem)
                    emitState()
                },
                (err) => {
                    const fullError = buildListenerError(err, PATHS.maintenanceItems)
                    devLog('Listener error: maintenanceItems', fullError)
                    onError(fullError)
                }
            ))
            devLog('Listener attached: maintenanceItems')

            unsubs.push(onSnapshot(
                collection(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'staff'),
                (snap) => {
                    staffDocs = snap.docs.map((d) => d.data())
                    emitState()
                },
                (err) => {
                    const fullError = buildListenerError(err, PATHS.staff)
                    devLog('Listener error: staff', fullError)
                    onError(fullError)
                }
            ))
            devLog('Listener attached: staff')

            unsubs.push(onSnapshot(
                collection(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'dailyAvailability'),
                (snap) => {
                    availabilityDocs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
                    emitState()
                },
                (err) => {
                    const fullError = buildListenerError(err, PATHS.dailyAvailability)
                    devLog('Listener error: dailyAvailability', fullError)
                    onError(fullError)
                }
            ))
            devLog('Listener attached: dailyAvailability')

            return () => {
                unsubs.forEach((u) => u())
            }
        },
        saveState(_state: OpsPersistedState) {
            // Realtime listeners are source of truth in online mode.
        },
        updateRoomPlan(day: OpsTab, roomId: string, patch) {
            if (!firestoreDb) return
            const ref = doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'roomPlans', `${day}-${roomId}`)
            void runWrite('updateRoomPlan', () => updateDoc(ref, patch as Record<string, unknown>))
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
            void runWrite('createTask', () => setDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'tasks', task.id), task))
            return task
        },
        updateTaskStatus(taskId: string, status: Task['status']) {
            if (!firestoreDb) return
            void runWrite('updateTaskStatus', () => updateDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'tasks', taskId), { status }))
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
            void runWrite('createSupplyRequest', () => setDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'supplyRequests', request.id), request))
            return request
        },
        cancelSupplyRequest(requestId: string) {
            if (!firestoreDb) return
            void runWrite('cancelSupplyRequest', () => deleteDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'supplyRequests', requestId)))
        },
        updateSupplyStatus(requestId: string, status: SupplyRequest['status']) {
            if (!firestoreDb) return
            void runWrite('updateSupplyStatus', () => updateDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'supplyRequests', requestId), { status }))
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
            void runWrite('createMaintenanceItem', () => setDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'maintenanceItems', item.id), item))
            return item
        },
        updateMaintenanceItem(itemId: string, patch: Partial<MaintenanceItem>) {
            if (!firestoreDb) return
            void runWrite('updateMaintenanceItem', () => updateDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'maintenanceItems', itemId), patch as Record<string, unknown>))
        },
        setStaffAvailability(id: string, availability) {
            if (!firestoreDb) return
            void runWrite('setStaffAvailability', async () => {
                await setDoc(
                    doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'dailyAvailability', id),
                    { staffId: id, availability, updatedAt: serverTimestamp() },
                    { merge: true }
                )
                await updateDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'staff', id), { availability })
            })
        },
        async resetDemoState(defaultState) {
            if (!firestoreDb) return
            await ensureAnonymousAuth()
            await clearCollection(['hotels', ONLINE_HOTEL_ID, 'roomPlans'])
            await clearCollection(['hotels', ONLINE_HOTEL_ID, 'tasks'])
            await clearCollection(['hotels', ONLINE_HOTEL_ID, 'supplyRequests'])
            await clearCollection(['hotels', ONLINE_HOTEL_ID, 'maintenanceItems'])
            await clearCollection(['hotels', ONLINE_HOTEL_ID, 'dailyAvailability'])
            await clearCollection(['hotels', ONLINE_HOTEL_ID, 'staff'])
            await setDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'meta', 'appState'), {
                seeded: false,
                resetAt: serverTimestamp()
            }, { merge: true })
            await ensureSeeded(defaultState)
        }
    }
}
