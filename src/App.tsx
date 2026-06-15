import React, { useMemo, useState, useEffect } from 'react'
import { RoleSwitch } from './components/RoleSwitch'
import DashboardToday from './pages/DashboardToday'
import AdminDashboard from './pages/AdminDashboard'
import MaintenanceView from './pages/MaintenanceView'
import SuppliesView from './pages/SuppliesView'
import { roomPlansByDay, users, supplyRequests as initialSupplyRequests, maintenanceItems as initialMaintenanceItems } from './mockData'
import { MaintenanceItem, SupplyRequest, Task, UserRole } from './types'
import { appMode, ensureAnonymousAuth, firebaseEnvDiagnostics } from './lib/firebase'
import { createFirebaseOpsStore, createLocalOpsStore } from './services'
import { OpsPersistedState } from './services/opsStore'
import { ONLINE_HOTEL_ID } from './services/firebaseOpsStore'

type AppDiagnostics = {
    firebaseConfigured: boolean
    missingEnvVars: string[]
    intendedMode: 'demo' | 'online'
    activeMode: 'demo' | 'online' | 'fallback'
    authStatus: 'not_started' | 'signing_in' | 'signed_in_anonymous' | 'error'
    authUid?: string
    firestoreStatus: 'not_started' | 'seeding' | 'listening' | 'connected' | 'permission_denied' | 'error'
    hotelId: string
    lastErrorCode?: string
    lastErrorMessage?: string
}

function extractErrorInfo(error: any): { code?: string; message: string } {
    return {
        code: error?.code,
        message: error?.message || 'Neznámá chyba'
    }
}

type RoomAction = 'prevzit' | 'odhad' | 'hotovo' | 'problem' | 'host_zustava' | 'clear_exception'

type RoomActionPayload = {
    estimateTime?: string
    relativeMinutes?: number
}

type CreateTaskInput = {
    title: string
    category: Task['category']
    priority: Task['priority']
    assignedToRole: Extract<UserRole, 'lead' | 'cleaner' | 'maintenance'>
    note?: string
}

type CreateSupplyRequestInput = {
    itemName: string
    category: SupplyRequest['category']
    quantityLevel: SupplyRequest['quantityLevel']
    customQuantity?: string
    roomNumber?: string
    note?: string
    priority: SupplyRequest['priority']
}

function isCleaningDomain(category: SupplyRequest['category']) {
    return category !== 'maintenance'
}

function canViewTask(role: UserRole, task: Task) {
    if (role === 'admin') return true
    if (role === 'lead') return task.category === 'cleaning' || task.assignedToRole === 'lead'
    if (role === 'cleaner') return task.category === 'cleaning' || task.assignedToRole === 'cleaner'
    if (role === 'maintenance') return task.assignedToRole === 'maintenance'
    return false
}

function defaultAssigneeName(role: Task['assignedToRole']) {
    if (role === 'lead') return 'Iryna'
    if (role === 'cleaner') return 'Uklízečka'
    if (role === 'maintenance') return 'Údržbář'
    return undefined
}

export default function App() {
    const localStore = useMemo(() => createLocalOpsStore(), [])
    const onlineStore = useMemo(() => createFirebaseOpsStore(), [])
    const [runtimeMode, setRuntimeMode] = useState<'demo' | 'online'>(appMode)
    const [onlineLoading, setOnlineLoading] = useState(appMode === 'online')
    const [onlineError, setOnlineError] = useState<string | null>(null)
    const [diagOpen, setDiagOpen] = useState(false)
    const [diagnostics, setDiagnostics] = useState<AppDiagnostics>({
        firebaseConfigured: firebaseEnvDiagnostics.firebaseConfigured,
        missingEnvVars: firebaseEnvDiagnostics.missingEnvVars,
        intendedMode: appMode,
        activeMode: appMode,
        authStatus: appMode === 'online' ? 'not_started' : 'not_started',
        firestoreStatus: 'not_started',
        hotelId: ONLINE_HOTEL_ID
    })

    const defaultState: OpsPersistedState = useMemo(() => ({
        userId: 'david',
        tab: 'Dnes',
        view: 'today',
        roomsByDay: roomPlansByDay,
        tasks: [],
        supplyRequests: initialSupplyRequests,
        maintenanceItems: initialMaintenanceItems,
        customSupplyChips: [],
        staff: users
    }), [])

    const saved = typeof window !== 'undefined'
        ? (appMode === 'online' ? null : localStore.loadInitialState())
        : null

    const [userId, setUserId] = useState<string>(saved?.userId ?? 'david')
    const [tab, setTab] = useState<'Dnes' | 'Zitra' | 'Pozitri'>(saved?.tab ?? 'Dnes')
    const [view, setView] = useState<'today' | 'admin' | 'maintenance' | 'supplies'>(saved?.view ?? 'today')
    const [roomsByDay, setRoomsByDay] = useState(() => saved?.roomsByDay ?? roomPlansByDay)
    const [tasks, setTasks] = useState<Task[]>(() => saved?.tasks ?? [])
    const [supplyRequests, setSupplyRequests] = useState<SupplyRequest[]>(() => saved?.supplyRequests ?? initialSupplyRequests)
    const [maintenanceItems, setMaintenanceItems] = useState<MaintenanceItem[]>(() => saved?.maintenanceItems ?? initialMaintenanceItems)
    const [customSupplyChips, setCustomSupplyChips] = useState<string[]>(() => saved?.customSupplyChips ?? [])
    const [staff, setStaff] = useState(() => saved?.staff ?? users)
    const [resetConfirm, setResetConfirm] = useState(false)

    const activeStore = runtimeMode === 'online' ? onlineStore : localStore

    const currentUser = users.find((u) => u.id === userId)

    const dayTitle = tab === 'Dnes' ? 'Dnes' : tab === 'Zitra' ? 'Zítra' : 'Pozítří'
    const dayLabel = `${dayTitle} • ${new Date().toLocaleDateString('cs-CZ', { weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric' })}`

    const visibleTodayTasks = useMemo(
        () => tasks.filter((task) => canViewTask((currentUser?.role || 'cleaner') as UserRole, task)),
        [tasks, currentUser?.role]
    )

    const maintenanceTasks = useMemo(
        () => tasks.filter((task) => task.assignedToRole === 'maintenance'),
        [tasks]
    )

    const visibleSupplies = useMemo(() => {
        const role = (currentUser?.role || 'cleaner') as UserRole
        // Always hide cancelled requests from visible lists
        if (role === 'admin') return supplyRequests.filter((s) => s.status !== 'cancelled')
        if (role === 'lead' || role === 'cleaner') {
            return supplyRequests.filter((s) => s.status !== 'cancelled' && (s.category !== 'maintenance' || s.requestedByRole === role))
        }
        if (role === 'maintenance') {
            return supplyRequests.filter((s) => s.status !== 'cancelled' && (s.category === 'maintenance' || s.requestedByRole === 'maintenance'))
        }
        return supplyRequests.filter((s) => s.status !== 'cancelled')
    }, [supplyRequests, currentUser?.role])

    function handleRoleChange(nextUserId: string) {
        const nextUser = users.find((u) => u.id === nextUserId)
        setUserId(nextUserId)

        if (nextUser?.role === 'maintenance') {
            setView('maintenance')
        } else if (view === 'maintenance') {
            setView('today')
        }
    }

    function formatNowHHmm(date = new Date()) {
        return date.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false })
    }

    function addMinutes(base: Date, minutes: number) {
        const next = new Date(base.getTime() + minutes * 60 * 1000)
        return formatNowHHmm(next)
    }

    function handleAction(id: string, action: RoomAction, payload?: RoomActionPayload) {
        const assignedName = currentUser?.name
        const now = new Date()
        const setAt = formatNowHHmm(now)
        const computedEstimate = payload?.estimateTime
            ? payload.estimateTime
            : typeof payload?.relativeMinutes === 'number'
                ? addMinutes(now, payload.relativeMinutes)
                : undefined

        let patch: Partial<any> = {}
        if (action === 'hotovo') patch = { status: 'hotovo' }
        if (action === 'prevzit') patch = { status: 'prevzato', assigned: assignedName }
        if (action === 'odhad') patch = { status: 'odhad', estimatedReady: computedEstimate || '12:30', estimateSetAt: setAt, assigned: assignedName }
        if (action === 'problem') patch = { status: 'problem', statusNote: 'Problém nahlášen' }
        if (action === 'host_zustava') patch = { status: 'problem', statusNote: 'Host neodešel', checkoutException: true }
        if (action === 'clear_exception') patch = { checkoutException: false, statusNote: undefined, status: 'ceka' }
        if (runtimeMode === 'online') {
            activeStore.updateRoomPlan(tab, id, patch)
        }

        setRoomsByDay((prev) => ({
            ...prev,
            [tab]: prev[tab].map((r) => {
                if (r.id !== id) return r

                if (action === 'hotovo') {
                    return {
                        ...r,
                        status: 'hotovo',
                        statusNote: r.checkoutException ? r.statusNote : undefined
                    }
                }
                if (action === 'prevzit') {
                    return {
                        ...r,
                        status: 'prevzato',
                        assigned: assignedName || r.assigned,
                        statusNote: r.checkoutException ? r.statusNote : undefined
                    }
                }
                if (action === 'odhad') {
                    return {
                        ...r,
                        status: 'odhad',
                        estimatedReady: computedEstimate || r.estimatedReady || '12:30',
                        estimateSetAt: setAt,
                        assigned: assignedName || r.assigned,
                        statusNote: r.checkoutException ? r.statusNote : undefined
                    }
                }
                if (action === 'problem') {
                    return {
                        ...r,
                        status: 'problem',
                        statusNote: 'Problém nahlášen'
                    }
                }
                if (action === 'host_zustava') {
                    // TODO: Here we can trigger push notification to admin in future backend integration.
                    return {
                        ...r,
                        status: 'problem',
                        statusNote: 'Host neodešel',
                        checkoutException: true
                    }
                }
                if (action === 'clear_exception') {
                    return {
                        ...r,
                        checkoutException: false,
                        statusNote: r.statusNote === 'Host neodešel' ? undefined : r.statusNote,
                        status: r.status === 'problem' ? 'ceka' : r.status
                    }
                }
                return r
            })
        }))
    }

    function handleUpdateTaskStatus(taskId: string, status: Task['status']) {
        if (runtimeMode === 'online') {
            activeStore.updateTaskStatus(taskId, status)
        }
        setTasks((prev) => prev.map((task) => (task.id === taskId ? { ...task, status } : task)))
    }

    function handleCreateTask(roomId: string, input: CreateTaskInput) {
        const room = roomsByDay[tab].find((r) => r.id === roomId)
        if (!room || !currentUser) return

        const createdAt = formatNowHHmm(new Date())
        const newTask: Task = {
            id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            roomNumber: room.number,
            title: input.title,
            category: input.category,
            priority: input.priority,
            assignedToRole: input.assignedToRole,
            assignedToName: defaultAssigneeName(input.assignedToRole),
            status: 'new',
            note: input.note,
            createdBy: currentUser.name,
            createdAt
        }

        if (runtimeMode === 'online') {
            activeStore.createTask({
                id: newTask.id,
                roomNumber: newTask.roomNumber,
                title: newTask.title,
                category: newTask.category,
                priority: newTask.priority,
                assignedToRole: newTask.assignedToRole,
                note: newTask.note,
                createdBy: newTask.createdBy,
                createdAt: newTask.createdAt
            })
        }

        setTasks((prev) => [newTask, ...prev])
    }

    function handleMaintenanceTaskAction(taskId: string, action: 'accepted' | 'done' | 'problem' | 'cancelled') {
        if (runtimeMode === 'online') {
            activeStore.updateTaskStatus(taskId, action)
        }
        setTasks((prev) =>
            prev.map((task) => {
                if (task.id !== taskId) return task
                return {
                    ...task,
                    status: action,
                    assignedToName: currentUser?.name || task.assignedToName
                }
            })
        )
    }

    function handleCreateMaintenanceItem(input: { roomNumber?: string; title: string; category: MaintenanceItem['category']; priority: MaintenanceItem['priority']; note?: string }) {
        if (!currentUser) return
        const newItem: MaintenanceItem = {
            id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            roomNumber: formatRoomNumber(input.roomNumber),
            title: input.title.trim(),
            category: input.category,
            priority: input.priority,
            status: 'new',
            note: input.note?.trim() || undefined,
            reportedBy: currentUser.name,
            createdAt: formatNowHHmm(new Date())
        }
        if (runtimeMode === 'online') {
            activeStore.createMaintenanceItem({
                id: newItem.id,
                roomNumber: newItem.roomNumber,
                title: newItem.title,
                category: newItem.category,
                priority: newItem.priority,
                note: newItem.note,
                reportedBy: newItem.reportedBy,
                createdAt: newItem.createdAt
            })
        }
        setMaintenanceItems((prev) => [newItem, ...prev])
    }

    function handleUpdateMaintenanceItem(itemId: string, patch: Partial<MaintenanceItem>) {
        if (runtimeMode === 'online') {
            activeStore.updateMaintenanceItem(itemId, patch)
        }
        setMaintenanceItems((prev) => prev.map((it) => (it.id === itemId ? { ...it, ...patch, updatedAt: formatNowHHmm(new Date()) } : it)))
    }

    function handleMaterialNeeded(itemId: string, materialText: string) {
        const material = materialText.trim()
        if (!material) return
        const item = maintenanceItems.find((m) => m.id === itemId)
        if (!item) return

        // update maintenance item
        handleUpdateMaintenanceItem(itemId, { materialNeeded: material, status: 'waiting_material' })

        // create supply request
        const newRequest: SupplyRequest = {
            id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            itemName: material,
            category: 'maintenance',
            quantityLevel: 'custom',
            customQuantity: undefined,
            roomNumber: item.roomNumber ? item.roomNumber : undefined,
            note: `Závada: ${item.title}`,
            requestedBy: currentUser?.name || 'Uživatel',
            requestedByRole: currentUser?.role || 'maintenance',
            createdAt: formatNowHHmm(new Date()),
            status: 'new',
            priority: item.priority
        }

        if (runtimeMode === 'online') {
            activeStore.createSupplyRequest({
                id: newRequest.id,
                itemName: newRequest.itemName,
                category: newRequest.category,
                quantityLevel: newRequest.quantityLevel,
                customQuantity: newRequest.customQuantity,
                roomNumber: newRequest.roomNumber,
                note: newRequest.note,
                priority: newRequest.priority,
                requestedBy: newRequest.requestedBy,
                requestedByRole: newRequest.requestedByRole,
                createdAt: newRequest.createdAt
            })
        }

        setSupplyRequests((prev) => [newRequest, ...prev])
    }

    function formatRoomNumber(roomNumber?: string) {
        if (!roomNumber) return undefined
        return roomNumber.trim() || undefined
    }

    function handleCreateSupplyRequest(input: CreateSupplyRequestInput) {
        if (!currentUser) return
        const role = currentUser.role
        const canCreate = role === 'admin' || role === 'lead' || role === 'cleaner' || role === 'maintenance'
        if (!canCreate) return

        if (role === 'maintenance' && input.category !== 'maintenance') return

        const newRequest: SupplyRequest = {
            id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            itemName: input.itemName,
            category: input.category,
            quantityLevel: input.quantityLevel,
            customQuantity: input.quantityLevel === 'custom' ? input.customQuantity : undefined,
            roomNumber: formatRoomNumber(input.roomNumber),
            note: input.note,
            requestedBy: currentUser.name,
            requestedByRole: currentUser.role,
            createdAt: formatNowHHmm(new Date()),
            status: 'new',
            priority: input.priority
        }

        setSupplyRequests((prev) => [newRequest, ...prev])
    }

    function setStaffAvailability(id: string, availability: 'dnes_pracuji' | 'dnes_nepracuji' | 'jen_urgentni') {
        if (runtimeMode === 'online') {
            activeStore.setStaffAvailability(id, availability)
        }
        setStaff((prev: any) => prev.map((s: any) => (s.id === id ? { ...s, availability } : s)))
    }

    function handleSetSupplyGroupStatus(itemName: string, status: SupplyRequest['status']) {
        if (!currentUser || currentUser.role !== 'admin') return
        if (runtimeMode === 'online') {
            supplyRequests.filter((s) => s.itemName === itemName).forEach((s) => activeStore.updateSupplyStatus(s.id, status))
        }
        setSupplyRequests((prev) => prev.map((s) => (s.itemName === itemName ? { ...s, status } : s)))
    }

    function handleSaveCustomSupplyChip(name: string) {
        const cleaned = name.trim()
        if (!cleaned) return
        setCustomSupplyChips((prev) => {
            const exists = prev.some((chip) => chip.toLowerCase() === cleaned.toLowerCase())
            if (exists) return prev
            return [...prev, cleaned]
        })
    }

    function canCancelSupplyRequest(request: SupplyRequest) {
        if (!currentUser) return false
        if (currentUser.role === 'admin') return true
        if (currentUser.role === 'lead') return isCleaningDomain(request.category)
        if (currentUser.role === 'cleaner') return request.status === 'new' && request.requestedByRole === 'cleaner' && request.requestedBy === currentUser.name
        if (currentUser.role === 'maintenance') {
            return request.status === 'new' && request.category === 'maintenance' && request.requestedByRole === 'maintenance' && request.requestedBy === currentUser.name
        }
        return false
    }

    function handleCancelSupplyRequest(requestId: string) {
        if (runtimeMode === 'online') {
            activeStore.cancelSupplyRequest(requestId)
        }
        setSupplyRequests((prev) => {
            const idx = prev.findIndex((r) => r.id === requestId)
            if (idx === -1) return prev
            const target = prev[idx]
            if (!canCancelSupplyRequest(target)) return prev
            // remove the single request by id so other identical items remain
            return prev.filter((r) => r.id !== requestId)
        })
    }

    // save to localStorage whenever key pieces of state change
    useEffect(() => {
        const toSave = {
            userId,
            tab,
            view,
            roomsByDay,
            tasks,
            supplyRequests,
            maintenanceItems,
            customSupplyChips,
            staff
        }
        activeStore.saveState(toSave)
    }, [userId, tab, view, roomsByDay, tasks, supplyRequests, maintenanceItems, customSupplyChips, staff, activeStore])

    useEffect(() => {
        let unsub: (() => void) | null = null
        let cancelled = false

        function switchToDemoWithFallback(code: string | undefined, message: string) {
            setDiagnostics((prev) => ({
                ...prev,
                activeMode: 'fallback',
                lastErrorCode: code,
                lastErrorMessage: message
            }))
            setOnlineError(`Online režim se nepodařilo spustit – používám demo data. ${code ? `${code}: ` : ''}${message}`)

            const localSaved = localStore.loadInitialState()
            if (localSaved) {
                setUserId(localSaved.userId)
                setTab(localSaved.tab)
                setView(localSaved.view)
                setRoomsByDay(localSaved.roomsByDay)
                setTasks(localSaved.tasks)
                setSupplyRequests(localSaved.supplyRequests)
                setMaintenanceItems(localSaved.maintenanceItems)
                setCustomSupplyChips(localSaved.customSupplyChips)
                setStaff(localSaved.staff)
            }
            setRuntimeMode('demo')
            setOnlineLoading(false)
        }

        if (!firebaseEnvDiagnostics.firebaseConfigured) {
            setDiagnostics((prev) => ({
                ...prev,
                activeMode: 'demo',
                authStatus: 'not_started',
                firestoreStatus: 'not_started',
                lastErrorCode: undefined,
                lastErrorMessage: undefined
            }))
            setOnlineLoading(false)
            setOnlineError(null)
            return
        }

        if (runtimeMode !== 'online') {
            setOnlineLoading(false)
            return
        }

        setOnlineLoading(true)
        setOnlineError(null)
        setDiagnostics((prev) => ({
            ...prev,
            activeMode: 'online',
            authStatus: 'signing_in',
            firestoreStatus: 'not_started',
            lastErrorCode: undefined,
            lastErrorMessage: undefined
        }))

        ensureAnonymousAuth()
            .then((user) => {
                if (cancelled) return null
                setDiagnostics((prev) => ({
                    ...prev,
                    authStatus: 'signed_in_anonymous',
                    authUid: user?.uid || undefined,
                    firestoreStatus: 'seeding'
                }))
                return onlineStore.initializeState(defaultState)
            })
            .then(() => {
                if (cancelled) return
                setDiagnostics((prev) => ({
                    ...prev,
                    firestoreStatus: 'listening'
                }))

                unsub = onlineStore.subscribeState(
                    (state) => {
                        if (state.roomsByDay) setRoomsByDay(state.roomsByDay)
                        if (state.tasks) setTasks(state.tasks)
                        if (state.supplyRequests) setSupplyRequests(state.supplyRequests)
                        if (state.maintenanceItems) setMaintenanceItems(state.maintenanceItems)
                        if (state.staff) setStaff(state.staff)
                        setDiagnostics((prev) => ({
                            ...prev,
                            firestoreStatus: 'connected'
                        }))
                        setOnlineLoading(false)
                    },
                    (error) => {
                        const code = error.code
                        const message = error.message
                        const isAuthError = Boolean(code && String(code).startsWith('auth/'))
                        setDiagnostics((prev) => ({
                            ...prev,
                            authStatus: isAuthError ? 'error' : prev.authStatus,
                            firestoreStatus: isAuthError
                                ? prev.firestoreStatus
                                : (code === 'permission-denied' ? 'permission_denied' : 'error'),
                            lastErrorCode: code,
                            lastErrorMessage: message
                        }))
                        switchToDemoWithFallback(code, message)
                    }
                )
            })
            .catch((err: any) => {
                if (cancelled) return
                const errorInfo = extractErrorInfo(err)
                const isAuthError = Boolean(errorInfo.code && String(errorInfo.code).startsWith('auth/'))
                setDiagnostics((prev) => ({
                    ...prev,
                    authStatus: isAuthError ? 'error' : prev.authStatus,
                    firestoreStatus: isAuthError
                        ? prev.firestoreStatus
                        : (errorInfo.code === 'permission-denied' ? 'permission_denied' : 'error'),
                    lastErrorCode: errorInfo.code,
                    lastErrorMessage: errorInfo.message
                }))
                switchToDemoWithFallback(errorInfo.code, errorInfo.message)
            })

        return () => {
            cancelled = true
            if (unsub) unsub()
        }
    }, [runtimeMode, onlineStore, localStore, defaultState])

    async function resetDemoData() {
        // restore mock data and clear saved state
        setRoomsByDay(roomPlansByDay)
        setTasks([])
        setSupplyRequests(initialSupplyRequests)
        setMaintenanceItems(initialMaintenanceItems)
        setCustomSupplyChips([])
        setStaff(users)
        setTab('Dnes')
        setUserId('david')
        setView('today')
        await activeStore.resetDemoState(defaultState)
        setResetConfirm(false)
    }

    return (
        <div className="app">
            <div className="topbar">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div className="title">My Hotel Ops</div>
                    <div style={{ fontSize: 11, color: '#64748b', border: '1px solid #cbd5e1', borderRadius: 999, padding: '2px 8px' }}>
                        {diagnostics.activeMode === 'online' ? 'Online režim' : diagnostics.activeMode === 'fallback' ? 'Fallback režim' : 'Demo režim'}
                    </div>
                    <div style={{ position: 'relative' }}>
                        <button
                            className="btn"
                            style={{ padding: '2px 8px', fontSize: 11, minHeight: 'unset' }}
                            onClick={() => setDiagOpen((prev) => !prev)}
                        >
                            Diagnostika
                        </button>
                        {diagOpen && (
                            <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 10, width: 320, marginTop: 6, padding: 10, borderRadius: 10, border: '1px solid #cbd5e1', background: '#ffffff', boxShadow: '0 8px 24px rgba(15,23,42,0.12)', fontSize: 12, color: '#334155' }}>
                                <div><strong>Mode:</strong> intended {diagnostics.intendedMode}, active {diagnostics.activeMode}</div>
                                <div><strong>Firebase configured:</strong> {diagnostics.firebaseConfigured ? 'ano' : 'ne'}</div>
                                <div><strong>Missing env vars:</strong> {diagnostics.missingEnvVars.length ? diagnostics.missingEnvVars.join(', ') : 'žádné'}</div>
                                <div><strong>Auth status:</strong> {diagnostics.authStatus}{diagnostics.authUid ? ` (${diagnostics.authUid})` : ''}</div>
                                <div><strong>Firestore status:</strong> {diagnostics.firestoreStatus}</div>
                                <div><strong>Hotel id:</strong> {diagnostics.hotelId}</div>
                                <div><strong>Last error code:</strong> {diagnostics.lastErrorCode || '—'}</div>
                                <div><strong>Last error message:</strong> {diagnostics.lastErrorMessage || '—'}</div>
                            </div>
                        )}
                    </div>
                </div>
                <RoleSwitch current={userId} onChange={handleRoleChange} />
            </div>

            {(runtimeMode === 'online' && (onlineLoading || onlineError)) && (
                <div style={{ padding: '4px 12px', fontSize: 12, color: onlineError ? '#b91c1c' : '#475569' }}>
                    {onlineError || 'Připojuji k online datům...'}
                </div>
            )}

            {diagnostics.activeMode === 'fallback' && (
                <div style={{ padding: '4px 12px', fontSize: 12, color: '#b91c1c' }}>
                    Online režim se nepodařilo spustit – používám demo data
                    <div>{diagnostics.lastErrorCode ? `${diagnostics.lastErrorCode}: ` : ''}{diagnostics.lastErrorMessage || 'Neznámá chyba'}</div>
                </div>
            )}

            <div style={{ padding: 12 }}>
                <div className="tabs">
                    <div className={`tab ${tab === 'Dnes' ? 'active' : ''}`} onClick={() => setTab('Dnes')}>Dnes</div>
                    <div className={`tab ${tab === 'Zitra' ? 'active' : ''}`} onClick={() => setTab('Zitra')}>Zítra</div>
                    <div className={`tab ${tab === 'Pozitri' ? 'active' : ''}`} onClick={() => setTab('Pozitri')}>Pozítří</div>
                </div>

                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button className={`btn ${view === 'today' ? 'active' : ''}`} onClick={() => setView('today')}>Dnes</button>
                    <button className={`btn ${view === 'admin' ? 'active' : ''}`} onClick={() => setView('admin')}>Admin</button>
                    <button className={`btn ${view === 'maintenance' ? 'active' : ''}`} onClick={() => setView('maintenance')}>Údržba</button>
                    <button className={`btn ${view === 'supplies' ? 'active' : ''}`} onClick={() => setView('supplies')}>Nákupy</button>
                </div>

                {(currentUser?.id === 'david' || currentUser?.role === 'admin') && (
                    <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                        {!resetConfirm ? (
                            <button className="btn danger" onClick={() => setResetConfirm(true)}>{runtimeMode === 'online' ? 'Reset online dat' : 'Reset demo dat'}</button>
                        ) : (
                            <>
                                <button className="btn danger" onClick={() => resetDemoData()}>Opravdu resetovat?</button>
                                <button className="btn" onClick={() => setResetConfirm(false)}>Zrušit</button>
                            </>
                        )}
                    </div>
                )}

                {tab !== 'Dnes' && (
                    <div style={{ marginTop: 10, padding: 10, background: '#fff', borderRadius: 10 }}>Orientační plán – může se změnit novou rezervací.</div>
                )}

                <div style={{ marginTop: 12 }}>
                    {view === 'today' && (
                        <DashboardToday
                            rooms={roomsByDay[tab]}
                            tasks={visibleTodayTasks}
                            onAction={handleAction}
                            onCreateTask={handleCreateTask}
                            onUpdateTaskStatus={handleUpdateTaskStatus}
                            role={(currentUser?.role || 'cleaner') as UserRole}
                            dayLabel={dayLabel}
                            staff={staff}
                            onSetAvailability={setStaffAvailability}
                            currentUserId={userId}
                        />
                    )}
                    {view === 'admin' && (
                        <AdminDashboard
                            rooms={roomsByDay[tab]}
                            tasks={tasks}
                            supplyRequests={supplyRequests}
                            staff={staff}
                            canManageSupplies={currentUser?.role === 'admin'}
                            onSetSupplyGroupStatus={handleSetSupplyGroupStatus}
                        />
                    )}
                    {view === 'maintenance' && (
                        <MaintenanceView
                            role={(currentUser?.role || 'cleaner') as UserRole}
                            currentUserId={userId}
                            maintenanceItems={maintenanceItems}
                            tasks={maintenanceTasks}
                            onCreateMaintenance={handleCreateMaintenanceItem}
                            onUpdateMaintenance={handleUpdateMaintenanceItem}
                            onMaterialNeeded={handleMaterialNeeded}
                        />
                    )}
                    {view === 'supplies' && (
                        <SuppliesView
                            userName={currentUser?.name || 'Uživatel'}
                            role={(currentUser?.role || 'cleaner') as UserRole}
                            requests={visibleSupplies}
                            customChips={customSupplyChips}
                            onCreateRequest={handleCreateSupplyRequest}
                            onSaveCustomChip={handleSaveCustomSupplyChip}
                            onCancelRequest={handleCancelSupplyRequest}
                        />
                    )}
                </div>
            </div>
        </div>
    )
}
