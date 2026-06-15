import React from 'react'
import { RoomPlan, Task } from '../types'
import { supplyRequests } from '../mockData'

export default function AdminDashboard({ rooms, tasks }: { rooms: RoomPlan[]; tasks: Task[] }) {
    const hotove = rooms.filter(r => r.status === 'hotovo')
    const ceka = rooms.filter(r => r.status === 'ceka' || r.status === 'prevzato' || r.status === 'probihá')
    const problemy = rooms.filter(r => r.status === 'problem')
    const odhad = rooms.filter(r => r.status === 'odhad')
    const noveUkoly = tasks.filter((t) => t.status === 'new' || t.status === 'read')
    const urgentniUkoly = tasks.filter((t) => t.priority === 'urgent' && t.status !== 'done' && t.status !== 'cancelled')
    const udrzbaUkoly = tasks.filter((t) => t.assignedToRole === 'maintenance' && t.status !== 'done' && t.status !== 'cancelled')
    const uklidUkoly = tasks.filter((t) => (t.assignedToRole === 'cleaner' || t.assignedToRole === 'lead') && t.status !== 'done' && t.status !== 'cancelled')
    const nakupy = supplyRequests.filter(s => s.status === 'open')

    return (
        <div>
            <div className="section">
                <h3>Rychlý přehled</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div className="room-card"><div className="room-number">Hotové pokoje</div><div className="room-meta">{hotove.length}</div></div>
                    <div className="room-card"><div className="room-number">Čeká na úklid</div><div className="room-meta">{ceka.length}</div></div>
                    <div className="room-card"><div className="room-number">Problémy</div><div className="room-meta">{problemy.length}</div></div>
                    <div className="room-card"><div className="room-number">Odhad</div><div className="room-meta">{odhad.length}</div></div>
                </div>
            </div>
            <div className="section">
                <h3>Úkoly</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div className="room-card"><div className="room-number">Nové úkoly</div><div className="room-meta">{noveUkoly.length}</div></div>
                    <div className="room-card"><div className="room-number">Urgentní úkoly</div><div className="room-meta">{urgentniUkoly.length}</div></div>
                    <div className="room-card"><div className="room-number">Údržba</div><div className="room-meta">{udrzbaUkoly.length}</div></div>
                    <div className="room-card"><div className="room-number">Úklid</div><div className="room-meta">{uklidUkoly.length}</div></div>
                </div>
            </div>
            <div className="section">
                <h3>Pokoje připravené pro hosty</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {hotove.map(r => (
                        <div key={r.id} className="room-card" style={{ borderLeft: '6px solid #10b981' }}>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontWeight: 800 }}>{r.number}</div>
                                <div className="room-meta">Připraveno pro hosty</div>
                            </div>
                            <div style={{ fontWeight: 700, color: '#10b981' }}>{r.estimatedReady || 'Hotovo'}</div>
                        </div>
                    ))}
                </div>
            </div>
            <div className="section">
                <h3>Kdo je dnes v práci</h3>
                <div className="room-list">
                    <div className="room-card">David - Admin</div>
                    <div className="room-card">Iryna - Vedoucí úklidu</div>
                    <div className="room-card">Karla - Uklízečka</div>
                    <div className="room-card">Petr - Údržbář</div>
                </div>
            </div>
        </div>
    )
}
