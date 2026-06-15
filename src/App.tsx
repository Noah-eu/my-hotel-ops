import React, { useMemo, useState, useEffect } from 'react'
import { RoleSwitch } from './components/RoleSwitch'
import DashboardToday from './pages/DashboardToday'
import AdminDashboard from './pages/AdminDashboard'
import MaintenanceView from './pages/MaintenanceView'
import SuppliesView from './pages/SuppliesView'
import { roomPlansByDay, users, supplyRequests as initialSupplyRequests } from './mockData'
import { SupplyRequest, Task, UserRole } from './types'

type RoomAction = 'prevzit' | 'odhad' | 'hotovo' | 'problem' | 'host_zustava'

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
    const STORAGE_KEY = 'mho_demo_state_v1'

    function loadInitialState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY)
            if (!raw) return null
            const parsed = JSON.parse(raw)
            return parsed
        } catch (e) {
            console.warn('Failed to parse saved demo state, falling back to defaults', e)
            return null
        }
    }

    const saved = typeof window !== 'undefined' ? loadInitialState() : null

    const [userId, setUserId] = useState<string>(saved?.userId ?? 'david')
    const [tab, setTab] = useState<'Dnes' | 'Zitra' | 'Pozitri'>(saved?.tab ?? 'Dnes')
    const [view, setView] = useState<'today' | 'admin' | 'maintenance' | 'supplies'>(saved?.view ?? 'today')
    const [roomsByDay, setRoomsByDay] = useState(() => saved?.roomsByDay ?? roomPlansByDay)
    const [tasks, setTasks] = useState<Task[]>(() => saved?.tasks ?? [])
    const [supplyRequests, setSupplyRequests] = useState<SupplyRequest[]>(() => saved?.supplyRequests ?? initialSupplyRequests)
    const [customSupplyChips, setCustomSupplyChips] = useState<string[]>(() => saved?.customSupplyChips ?? [])
    const [resetConfirm, setResetConfirm] = useState(false)

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

        setRoomsByDay((prev) => ({
            ...prev,
            [tab]: prev[tab].map((r) => {
                if (r.id !== id) return r

                if (action === 'hotovo') {
                    return {
                        ...r,
                        status: 'hotovo',
                        statusNote: undefined
                    }
                }
                if (action === 'prevzit') {
                    return {
                        ...r,
                        status: 'prevzato',
                        assigned: assignedName || r.assigned,
                        statusNote: undefined
                    }
                }
                if (action === 'odhad') {
                    return {
                        ...r,
                        status: 'odhad',
                        estimatedReady: computedEstimate || r.estimatedReady || '12:30',
                        estimateSetAt: setAt,
                        assigned: assignedName || r.assigned,
                        statusNote: undefined
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
                    return {
                        ...r,
                        statusNote: 'Host je ještě na pokoji'
                    }
                }
                return r
            })
        }))
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

        setTasks((prev) => [newTask, ...prev])
    }

    function handleMaintenanceTaskAction(taskId: string, action: 'accepted' | 'done' | 'problem' | 'cancelled') {
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

    function handleSetSupplyGroupStatus(itemName: string, status: SupplyRequest['status']) {
        if (!currentUser || currentUser.role !== 'admin') return
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
        setSupplyRequests((prev) =>
            prev.map((request) => {
                if (request.id !== requestId) return request
                if (!canCancelSupplyRequest(request)) return request
                return {
                    ...request,
                    status: 'cancelled'
                }
            })
        )
    }

    // save to localStorage whenever key pieces of state change
    useEffect(() => {
        try {
            const toSave = {
                userId,
                tab,
                view,
                roomsByDay,
                tasks,
                supplyRequests,
                customSupplyChips
            }
            localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave))
        } catch (e) {
            console.warn('Failed to save demo state', e)
        }
    }, [userId, tab, view, roomsByDay, tasks, supplyRequests, customSupplyChips])

    function resetDemoData() {
        // restore mock data and clear saved state
        setRoomsByDay(roomPlansByDay)
        setTasks([])
        setSupplyRequests(initialSupplyRequests)
        setCustomSupplyChips([])
        setTab('Dnes')
        setUserId('david')
        setView('today')
        try {
            localStorage.removeItem(STORAGE_KEY)
        } catch (e) {
            console.warn('Failed to clear demo state', e)
        }
        setResetConfirm(false)
    }

    return (
        <div className="app">
            <div className="topbar">
                <div className="title">My Hotel Ops</div>
                <RoleSwitch current={userId} onChange={handleRoleChange} />
            </div>

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
                            <button className="btn danger" onClick={() => setResetConfirm(true)}>Reset demo dat</button>
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
                            role={(currentUser?.role || 'cleaner') as UserRole}
                            dayLabel={dayLabel}
                        />
                    )}
                    {view === 'admin' && (
                        <AdminDashboard
                            rooms={roomsByDay[tab]}
                            tasks={tasks}
                            supplyRequests={supplyRequests}
                            canManageSupplies={currentUser?.role === 'admin'}
                            onSetSupplyGroupStatus={handleSetSupplyGroupStatus}
                        />
                    )}
                    {view === 'maintenance' && (
                        <MaintenanceView tasks={maintenanceTasks} onTaskAction={handleMaintenanceTaskAction} />
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
