import React, { useState } from 'react'
import { RoleSwitch } from './components/RoleSwitch'
import DashboardToday from './pages/DashboardToday'
import AdminDashboard from './pages/AdminDashboard'
import MaintenanceView from './pages/MaintenanceView'
import SuppliesView from './pages/SuppliesView'
import { roomPlansByDay, users } from './mockData'

type RoomAction = 'prevzit' | 'odhad' | 'hotovo' | 'problem' | 'host_zustava' | 'add_task'

type ActionPayload = {
    estimateTime?: string
    relativeMinutes?: number
}

export default function App() {
    const [userId, setUserId] = useState('david')
    const [tab, setTab] = useState<'Dnes' | 'Zitra' | 'Pozitri'>('Dnes')
    const [view, setView] = useState<'today' | 'admin' | 'maintenance' | 'supplies'>('today')
    const [roomsByDay, setRoomsByDay] = useState(roomPlansByDay)

    const currentUser = users.find(u => u.id === userId)

    const dayTitle = tab === 'Dnes' ? 'Dnes' : tab === 'Zitra' ? 'Zítra' : 'Pozítří'
    const dayLabel = `${dayTitle} • ${new Date().toLocaleDateString('cs-CZ', { weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric' })}`

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

    function handleAction(id: string, action: RoomAction, payload?: ActionPayload) {
        const assignedName = currentUser?.name
        const now = new Date()
        const setAt = formatNowHHmm(now)
        const computedEstimate = payload?.estimateTime
            ? payload.estimateTime
            : typeof payload?.relativeMinutes === 'number'
                ? addMinutes(now, payload.relativeMinutes)
                : undefined

        setRoomsByDay(prev => ({
            ...prev,
            [tab]: prev[tab].map(r => {
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
                    {view === 'today' && <DashboardToday rooms={roomsByDay[tab]} onAction={handleAction} role={currentUser?.role || 'cleaner'} dayLabel={dayLabel} />}
                    {view === 'admin' && <AdminDashboard rooms={roomsByDay[tab]} />}
                    {view === 'maintenance' && <MaintenanceView />}
                    {view === 'supplies' && <SuppliesView />}
                </div>
            </div>

            {/* Footer removed to save vertical space on mobile */}
        </div>
    )
}
