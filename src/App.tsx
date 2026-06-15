import React, { useState } from 'react'
import { RoleSwitch } from './components/RoleSwitch'
import DashboardToday from './pages/DashboardToday'
import AdminDashboard from './pages/AdminDashboard'
import MaintenanceView from './pages/MaintenanceView'
import SuppliesView from './pages/SuppliesView'
import { roomPlans, users } from './mockData'

export default function App() {
    const [userId, setUserId] = useState('david')
    const [tab, setTab] = useState<'Dnes' | 'Zitra' | 'Pozitri'>('Dnes')
    const [view, setView] = useState<'today' | 'admin' | 'maintenance' | 'supplies'>('today')
    const [rooms, setRooms] = useState(roomPlans)

    const currentUser = users.find(u => u.id === userId)

    function handleAction(id: string, action: string) {
        setRooms(rs => rs.map(r => r.id === id ? ({ ...r, status: action === 'hotovo' ? 'hotovo' : (action === 'prevzit' ? 'prevzato' : r.status) }) : r))
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
                    {view === 'today' && <DashboardToday rooms={rooms} onAction={handleAction} role={currentUser?.role || 'cleaner'} currentUserId={currentUser?.id} />}
                    {view === 'admin' && <AdminDashboard />}
                    {view === 'maintenance' && <MaintenanceView />}
                    {view === 'supplies' && <SuppliesView />}
                </div>
            </div>

            <div className="footer">
                <div>Role: {currentUser?.name || userId}</div>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn" onClick={() => setUserId('david')}>Switch Demo</button>
                </div>
            </div>
        </div>
    )
}
