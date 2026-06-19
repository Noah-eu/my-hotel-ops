import {
    deleteField,
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
import { ensureAuthenticatedUser, firebaseAuth, firestoreDb } from '../lib/firebase'
import { ImportJob, MaintenanceItem, RoomPlan, SupplyRequest, Task } from '../types'
import {
    CreateImportJobInput,
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

// Sanitize objects for Firestore: remove undefined values recursively.
function sanitizeForFirestore<T>(input: T, rootPath = ''): { cleaned: T; removedPaths: string[] } {
    const removed: string[] = []

    function inner(value: any, path: string): any {
        if (value === undefined) {
            removed.push(path || '<root>')
            return undefined
        }
        if (value === null) return null
        if (Array.isArray(value)) {
            const arr: any[] = []
            value.forEach((item, idx) => {
                const cleaned = inner(item, `${path}[${idx}]`)
                if (cleaned !== undefined) arr.push(cleaned)
            })
            return arr
        }
        if (typeof value === 'object') {
            const out: Record<string, any> = {}
            Object.keys(value).forEach((k) => {
                const childPath = path ? `${path}.${k}` : k
                const cleaned = inner(value[k], childPath)
                if (cleaned !== undefined) out[k] = cleaned
            })
            return out
        }
        return value
    }

    const cleaned = inner(input, rootPath)

    if (DEV && removed.length > 0) {
        console.warn(`[FirestoreSanitizer] removed undefined fields:`, { removed })
    }

    return { cleaned, removedPaths: removed }
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
        await ensureAuthenticatedUser({ allowAnonymous: false })
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
    importJobs: `hotels/${ONLINE_HOTEL_ID}/importJobs`,
    staff: `hotels/${ONLINE_HOTEL_ID}/staff`,
    dailyAvailability: `hotels/${ONLINE_HOTEL_ID}/dailyAvailability`
}

function roomPlanId(day: string, roomId: string) {
    return `${day}-${roomId}`
}

function isIsoDateKey(value: string) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value)
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
                const { cleaned } = sanitizeForFirestore({ ...room, day }, `roomPlans.${roomPlanId(day, room.id)}`)
                batch.set(ref, cleaned)
            })
        })

    defaultState.tasks.forEach((task) => {
        const ref = doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'tasks', task.id)
        const { cleaned } = sanitizeForFirestore(task, `tasks.${task.id}`)
        batch.set(ref, cleaned)
    })

    defaultState.supplyRequests.forEach((request) => {
        const ref = doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'supplyRequests', request.id)
        const { cleaned } = sanitizeForFirestore(request, `supplyRequests.${request.id}`)
        batch.set(ref, cleaned)
    })

    defaultState.maintenanceItems.forEach((item) => {
        const ref = doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'maintenanceItems', item.id)
        const { cleaned } = sanitizeForFirestore(item, `maintenanceItems.${item.id}`)
        batch.set(ref, cleaned)
    })

    // Online mode uses Firebase Auth UID keyed staff profiles; do not seed demo identities.

    const { cleaned: cleanedMeta } = sanitizeForFirestore({ seeded: true, seededAt: serverTimestamp() }, 'meta.appState')
    batch.set(metaRef, cleanedMeta)

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

function toRoomPlansState(docs: Array<Record<string, any>>) {
    const grouped: OpsPersistedState['roomsByDay'] = { Dnes: [], Zitra: [], Pozitri: [] }
    const importedRoomsByDate: Record<string, RoomPlan[]> = {}
    const importedTabDates: Partial<Record<OpsTab, string>> = {}

    docs.forEach((item) => {
        const day = typeof item.day === 'string' ? item.day : ''
        const planDateIso = typeof item.planDateIso === 'string' ? item.planDateIso : undefined
        const { day: _day, ...room } = item

        if (day === 'Dnes' || day === 'Zitra' || day === 'Pozitri') {
            grouped[day].push(room as RoomPlan)
            if (planDateIso && isIsoDateKey(planDateIso)) {
                importedTabDates[day] = planDateIso
            }
            return
        }

        const importedDateIso = isIsoDateKey(day)
            ? day
            : (typeof item.dateIso === 'string' && isIsoDateKey(item.dateIso) ? item.dateIso : undefined)
        if (!importedDateIso) return

        if (!importedRoomsByDate[importedDateIso]) importedRoomsByDate[importedDateIso] = []
        importedRoomsByDate[importedDateIso].push(room as RoomPlan)
    })

    return { grouped, importedRoomsByDate, importedTabDates }
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
            const authUser = await ensureAuthenticatedUser({ allowAnonymous: false })
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
            let importedRoomsByDate: Record<string, RoomPlan[]> = {}
            let importedTabDates: Partial<Record<OpsTab, string>> = {}
            let importJobs: ImportJob[] = []
            let tasks: Task[] = []
            let supplyRequests: SupplyRequest[] = []
            let maintenanceItems: MaintenanceItem[] = []
            let staffDocs: any[] = []
            let availabilityDocs: any[] = []
            let metaDoc: Record<string, any> = {}

            function emitState() {
                if (roomPlansByDay.Dnes.length === 0 && roomPlansByDay.Zitra.length === 0 && roomPlansByDay.Pozitri.length === 0) return
                const availabilityMap = new Map(availabilityDocs.map((d) => [d.staffId || d.id, d.availability]))
                const staff = staffDocs.map((member) => ({
                    ...member,
                    availability: availabilityMap.get(member.id) || member.availability
                }))
                onState({
                    roomsByDay: roomPlansByDay,
                    importedRoomsByDate,
                    importedTabDates,
                    importJobs,
                    tasks,
                    supplyRequests,
                    maintenanceItems,
                    staff,
                    // include persisted meta like custom supply chips
                    customSupplyChips: Array.isArray(metaDoc?.customSupplyChips) ? metaDoc.customSupplyChips : []
                } as any)
            }

            unsubs.push(onSnapshot(
                collection(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'roomPlans'),
                (snap) => {
                    const docs = snap.docs.map((d) => d.data() as Record<string, any>)
                    const { grouped, importedRoomsByDate: byDate, importedTabDates: tabDates } = toRoomPlansState(docs)
                    roomPlansByDay.Dnes = grouped.Dnes
                    roomPlansByDay.Zitra = grouped.Zitra
                    roomPlansByDay.Pozitri = grouped.Pozitri
                    importedRoomsByDate = byDate
                    importedTabDates = tabDates
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
                collection(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'importJobs'),
                (snap) => {
                    importJobs = snap.docs
                        .map((d) => ({ id: d.id, ...(d.data() as Record<string, any>) } as ImportJob))
                        .sort((a, b) => (b.receivedAt || '').localeCompare(a.receivedAt || ''))
                    emitState()
                },
                (err) => {
                    if (err.code === 'permission-denied') {
                        importJobs = []
                        devLog('Listener denied: importJobs (non-admin role), continuing without import jobs')
                        emitState()
                        return
                    }
                    const fullError = buildListenerError(err, PATHS.importJobs)
                    devLog('Listener error: importJobs', fullError)
                    onError(fullError)
                }
            ))
            devLog('Listener attached: importJobs')

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
                    if (DEV) {
                        console.info('Firestore supply snapshot', {
                            path: PATHS.supplyRequests,
                            count: supplyRequests.length,
                            ids: supplyRequests.map((s) => s.id)
                        })
                    }
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
                    staffDocs = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
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

            // listen to meta/appState document for persisted UI meta like custom chips
            try {
                const metaRef = doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'meta', 'appState')
                unsubs.push(onSnapshot(
                    metaRef,
                    (snap) => {
                        metaDoc = snap.exists() ? (snap.data() as Record<string, any>) : {}
                        emitState()
                    },
                    (err) => {
                        const fullError = buildListenerError(err, PATHS.meta)
                        devLog('Listener error: meta/appState', fullError)
                        onError(fullError)
                    }
                ))
                devLog('Listener attached: meta/appState')
            } catch (e) {
                devLog('Meta listener attach failed', e)
            }

            return () => {
                unsubs.forEach((u) => u())
            }
        },
        saveState(_state: OpsPersistedState) {
            // Realtime listeners are source of truth in online mode.
        },
        // persist meta/appState for global UI settings like customSupplyChips
        async persistMetaState(meta: { customSupplyChips?: string[] }) {
            if (!firestoreDb) return
            const ref = doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'meta', 'appState')
            const { cleaned } = sanitizeForFirestore(meta, 'meta.appState')
            await runWrite('persistMetaState', () => setDoc(ref, cleaned, { merge: true }))
        },
        updateRoomPlan(day: OpsTab, roomId: string, patch) {
            if (!firestoreDb) return
            const ref = doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'roomPlans', `${day}-${roomId}`)
            const { cleaned } = sanitizeForFirestore(patch, `roomPlans.${day}-${roomId}.patch`)
            const deletePatch = Object.entries(patch).reduce<Record<string, unknown>>((acc, [key, value]) => {
                if (typeof value !== 'undefined') return acc
                acc[key] = deleteField()
                return acc
            }, {})

            const updatePatch = {
                ...(cleaned as Record<string, unknown>),
                ...deletePatch
            }

            if (Object.keys(updatePatch).length === 0) return
            void runWrite('updateRoomPlan', () => updateDoc(ref, updatePatch))
        },
        replaceRoomPlan(day: string, room: RoomPlan) {
            if (!firestoreDb) return
            const ref = doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'roomPlans', `${day}-${room.id}`)
            const { cleaned } = sanitizeForFirestore({ ...room, day }, `roomPlans.${day}-${room.id}.replace`)
            void runWrite('replaceRoomPlan', () => setDoc(ref, cleaned))
        },
        createImportJob(input: CreateImportJobInput) {
            if (!firestoreDb) return null
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
                parserVersion: input.parserVersion
            }
            const { cleaned } = sanitizeForFirestore({ ...job }, `importJobs.${job.id}`)
            void runWrite('createImportJob', () => setDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'importJobs', job.id), cleaned))
            return job
        },
        updateImportJob(jobId: string, patch: Partial<ImportJob>) {
            if (!firestoreDb) return
            const { cleaned } = sanitizeForFirestore(patch, `importJobs.${jobId}.patch`)
            const deletePatch = Object.entries(patch).reduce<Record<string, unknown>>((acc, [key, value]) => {
                if (typeof value !== 'undefined') return acc
                acc[key] = deleteField()
                return acc
            }, {})

            const updatePatch = {
                ...(cleaned as Record<string, unknown>),
                ...deletePatch
            }
            if (Object.keys(updatePatch).length === 0) return
            void runWrite('updateImportJob', () => updateDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'importJobs', jobId), updatePatch))
        },
        deleteImportJob(jobId: string) {
            if (!firestoreDb) return
            void runWrite('deleteImportJob', () => deleteDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'importJobs', jobId)))
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
                importedAt: input.importedAt
            }
            const { cleaned } = sanitizeForFirestore(task, `tasks.${task.id}`)
            void runWrite('createTask', () => setDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'tasks', task.id), cleaned))
            return task
        },
        updateTask(taskId: string, patch: Partial<Task>) {
            if (!firestoreDb) return
            const { cleaned } = sanitizeForFirestore(patch, `tasks.${taskId}.patch`)
            const deletePatch = Object.entries(patch).reduce<Record<string, unknown>>((acc, [key, value]) => {
                if (typeof value !== 'undefined') return acc
                acc[key] = deleteField()
                return acc
            }, {})

            const updatePatch = {
                ...(cleaned as Record<string, unknown>),
                ...deletePatch
            }
            if (Object.keys(updatePatch).length === 0) return
            void runWrite('updateTask', () => updateDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'tasks', taskId), updatePatch))
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
                priority: input.priority,
                source: input.source,
                createdByUid: input.createdByUid,
                createdByName: input.createdByName,
                createdByRole: input.createdByRole,
                importJobId: input.importJobId,
                importedAt: input.importedAt
            }
            const { cleaned } = sanitizeForFirestore(request, `supplyRequests.${request.id}`)
            void runWrite('createSupplyRequest', async () => {
                await setDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'supplyRequests', request.id), cleaned)
                if (DEV) {
                    console.info('Firestore supply write success', {
                        id: request.id,
                        path: `${PATHS.supplyRequests}/${request.id}`,
                        itemName: request.itemName
                    })
                }
            })
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
            const { cleaned } = sanitizeForFirestore(item, `maintenanceItems.${item.id}`)
            void runWrite('createMaintenanceItem', () => setDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'maintenanceItems', item.id), cleaned))
            return item
        },
        updateMaintenanceItem(itemId: string, patch: Partial<MaintenanceItem>) {
            if (!firestoreDb) return
            const { cleaned } = sanitizeForFirestore(patch, `maintenanceItems.${itemId}.patch`)
            void runWrite('updateMaintenanceItem', () => updateDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'maintenanceItems', itemId), cleaned as Record<string, unknown>))
        },
        setStaffAvailability(id: string, availability) {
            if (!firestoreDb) return
            void runWrite('setStaffAvailability', async () => {
                const availObj = { staffId: id, availability, updatedAt: serverTimestamp() }
                const { cleaned: cleanedAvail } = sanitizeForFirestore(availObj, `dailyAvailability.${id}`)
                await setDoc(
                    doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'dailyAvailability', id),
                    cleanedAvail,
                    { merge: true }
                )
                const { cleaned: cleanedStaff } = sanitizeForFirestore({ availability }, `staff.${id}.availability`)
                await updateDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'staff', id), cleanedStaff)
            })
        },
        async resetDemoState(defaultState) {
            if (!firestoreDb) return
            await ensureAuthenticatedUser({ allowAnonymous: false })
            await clearCollection(['hotels', ONLINE_HOTEL_ID, 'roomPlans'])
            await clearCollection(['hotels', ONLINE_HOTEL_ID, 'tasks'])
            await clearCollection(['hotels', ONLINE_HOTEL_ID, 'supplyRequests'])
            await clearCollection(['hotels', ONLINE_HOTEL_ID, 'maintenanceItems'])
            await setDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'meta', 'appState'), {
                seeded: false,
                resetAt: serverTimestamp()
            }, { merge: true })
            await ensureSeeded(defaultState)
        }
    }
}
