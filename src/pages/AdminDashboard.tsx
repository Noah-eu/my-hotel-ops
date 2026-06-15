import React from 'react'
import { RoomPlan, SupplyRequest, Task } from '../types'

function statusText(status: SupplyRequest['status']) {
    if (status === 'new') return 'Nové'
    if (status === 'approved') return 'Schválené'
    if (status === 'ordered') return 'Objednáno'
    if (status === 'delivered') return 'Doručeno'
    if (status === 'handed_over') return 'Předáno'
    return 'Zrušeno'
}

export default function AdminDashboard({
    rooms,
    tasks,
    supplyRequests,
    canManageSupplies,
    onSetSupplyGroupStatus
}: {
    rooms: RoomPlan[]
    tasks: Task[]
    supplyRequests: SupplyRequest[]
    canManageSupplies: boolean
    onSetSupplyGroupStatus: (itemName: string, status: SupplyRequest['status']) => void
}) {
    const hotove = rooms.filter(r => r.status === 'hotovo')
    const ceka = rooms.filter(r => r.status === 'ceka' || r.status === 'prevzato' || r.status === 'probihá')
    const problemy = rooms.filter(r => r.status === 'problem')
    const odhad = rooms.filter(r => r.status === 'odhad')
    const noveUkoly = tasks.filter((t) => t.status === 'new' || t.status === 'read')
    const urgentniUkoly = tasks.filter((t) => t.priority === 'urgent' && t.status !== 'done' && t.status !== 'cancelled')
    const udrzbaUkoly = tasks.filter((t) => t.assignedToRole === 'maintenance' && t.status !== 'done' && t.status !== 'cancelled')
    const uklidUkoly = tasks.filter((t) => (t.assignedToRole === 'cleaner' || t.assignedToRole === 'lead') && t.status !== 'done' && t.status !== 'cancelled')
    const supplyOpen = supplyRequests.filter((s) => s.status !== 'cancelled' && s.status !== 'handed_over')

    const grouped = Object.values(
        supplyOpen.reduce<Record<string, {
            itemName: string
            count: number
            hasUrgent: boolean
            requestedBy: string[]
            statuses: SupplyRequest['status'][]
            categories: SupplyRequest['category'][]
        }>>((acc, request) => {
            const key = request.itemName.toLowerCase()
            if (!acc[key]) {
                acc[key] = {
                    itemName: request.itemName,
                    count: 0,
                    hasUrgent: false,
                    requestedBy: [],
                    statuses: [],
                    categories: []
                }
            }
            acc[key].count += 1
            acc[key].hasUrgent = acc[key].hasUrgent || request.priority === 'urgent'
            if (!acc[key].requestedBy.includes(request.requestedBy)) {
                acc[key].requestedBy.push(request.requestedBy)
            }
            acc[key].statuses.push(request.status)
            if (!acc[key].categories.includes(request.category)) {
                acc[key].categories.push(request.category)
            }
            return acc
        }, {})
    )

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
                <h3>Nákupní seznam</h3>
                <div className="room-list">
                    {grouped.length === 0 && <div className="room-card">Žádné aktivní požadavky</div>}
                    {grouped.map((group) => (
                        <div key={group.itemName} className="room-card" style={{ alignItems: 'flex-start', borderLeft: group.hasUrgent ? '6px solid #dc2626' : '6px solid #0ea5a4' }}>
                            <div style={{ flex: 1 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                    <div style={{ fontWeight: 800 }}>{group.itemName}</div>
                                    <div className="mini-badge">{group.count}×</div>
                                    {group.hasUrgent && <div className="status red">URGENT</div>}
                                </div>
                                <div className="room-meta">Žádali: {group.requestedBy.join(', ')}</div>
                                <div className="room-meta">Stavy: {Array.from(new Set(group.statuses.map(statusText))).join(', ')}</div>
                            </div>
                            {canManageSupplies && (
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, width: 170 }}>
                                    <button className="btn" onClick={() => onSetSupplyGroupStatus(group.itemName, 'approved')}>Schválit</button>
                                    <button className="btn" onClick={() => onSetSupplyGroupStatus(group.itemName, 'ordered')}>Objednáno</button>
                                    <button className="btn" onClick={() => onSetSupplyGroupStatus(group.itemName, 'delivered')}>Doručeno</button>
                                    <button className="btn" onClick={() => onSetSupplyGroupStatus(group.itemName, 'handed_over')}>Předáno</button>
                                    <button className="btn danger" style={{ gridColumn: '1 / span 2' }} onClick={() => onSetSupplyGroupStatus(group.itemName, 'cancelled')}>Zrušit</button>
                                </div>
                            )}
                        </div>
                    ))}
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
