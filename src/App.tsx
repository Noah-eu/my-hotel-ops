import React, { useMemo, useState } from 'react'
import { RoleSwitch } from './components/RoleSwitch'
import DashboardToday from './pages/DashboardToday'
import AdminDashboard from './pages/AdminDashboard'
import MaintenanceView from './pages/MaintenanceView'
import SuppliesView from './pages/SuppliesView'
import { roomPlansByDay, users } from './mockData'
import { Task, UserRole } from './types'

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
    const [userId, setUserId] = useState('david')
    const [tab, setTab] = useState<'Dnes' | 'Zitra' | 'Pozitri'>('Dnes')
    const [view, setView] = useState<'today' | 'admin' | 'maintenance' | 'supplies'>('today')
    const [roomsByDay, setRoomsByDay] = useState(roomPlansByDay)
    const [tasks, setTasks] = useState<Task[]>([])

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
                    {view === 'admin' && <AdminDashboard rooms={roomsByDay[tab]} tasks={tasks} />}
                    {view === 'maintenance' && (
                        <MaintenanceView tasks={maintenanceTasks} onTaskAction={handleMaintenanceTaskAction} />
                    )}
                    {view === 'supplies' && <SuppliesView />}
                </div>
            </div>
        </div>
    )
}
