import React, { useState } from 'react'
import { RoleSwitch } from './components/RoleSwitch'
import DashboardToday from './pages/DashboardToday'
import AdminDashboard from './pages/AdminDashboard'
import MaintenanceView from './pages/MaintenanceView'
import SuppliesView from './pages/SuppliesView'
import { roomPlansByDay, users } from './mockData'

export default function App() {
    const [userId, setUserId] = useState('david')
    const [tab, setTab] = useState<'Dnes' | 'Zitra' | 'Pozitri'>('Dnes')
    const [view, setView] = useState<'today' | 'admin' | 'maintenance' | 'supplies'>('today')
    const [roomsByDay, setRoomsByDay] = useState(roomPlansByDay)

    const currentUser = users.find(u => u.id === userId)

    const dayTitle = tab === 'Dnes' ? 'Dnes' : tab === 'Zitra' ? 'Zítra' : 'Pozítří'
    const dayLabel = `${dayTitle} • ${new Date().toLocaleDateString('cs-CZ', { weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric' })}`

    function handleAction(id: string, action: string) {
        setRoomsByDay(prev => ({
            ...prev,
            [tab]: prev[tab].map(r => {
                if (r.id !== id) return r

                if (action === 'hotovo') return { ...r, status: 'hotovo' }
                if (action === 'prevzit') return { ...r, status: 'prevzato' }
                if (action === 'odhad') return { ...r, status: 'odhad', estimatedReady: r.estimatedReady || '12:30' }
                if (action === 'problem') return { ...r, status: 'ceka' }
                return r
            })
        }))
    }

    return (
        <div className="app">
            <div className="topbar">
                <div className="title">My Hotel Ops</div>
                <RoleSwitch current={userId} onChange={setUserId} />
            </div>

            <div style={{ padding: 12 }}>
                <div className="tabs">
                    <div className={`tab ${tab === 'Dnes' ? 'active' : ''}`} onClick={() => setTab('Dnes')}>Dnes</div>
                    <div className={`tab ${tab === 'Zitra' ? 'active' : ''}`} onClick={() => setTab('Zitra')}>Zítra</div>
                    <div className={`tab ${tab === 'Pozitri' ? 'active' : ''}`} onClick={() => setTab('Pozitri')}>Pozítří</div>
                </div>

                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button className="btn" onClick={() => setView('today')}>Dnes</button>
                    <button className="btn" onClick={() => setView('admin')}>Admin</button>
                    <button className="btn" onClick={() => setView('maintenance')}>Údržba</button>
                    <button className="btn" onClick={() => setView('supplies')}>Nákupy</button>
                </div>

                {tab !== 'Dnes' && (
                    <div style={{ marginTop: 10, padding: 10, background: '#fff', borderRadius: 10 }}>Orientační plán – může se změnit novou rezervací.</div>
                )}

                <div style={{ marginTop: 12 }}>
                    {view === 'today' && <DashboardToday rooms={roomsByDay[tab]} onAction={handleAction} role={currentUser?.role || 'cleaner'} dayLabel={dayLabel} />}
                    {view === 'admin' && <AdminDashboard />}
                    {view === 'maintenance' && <MaintenanceView />}
                    {view === 'supplies' && <SuppliesView />}
                </div>
            </div>

            {/* Footer removed to save vertical space on mobile */}
        </div>
    )
}
