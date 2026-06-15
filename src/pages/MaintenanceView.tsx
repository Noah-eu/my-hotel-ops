import React, { useState } from 'react'
import { Task, MaintenanceItem, UserRole } from '../types'

function statusLabel(status: MaintenanceItem['status']) {
    switch (status) {
        case 'new':
            return 'Nový'
        case 'accepted':
            return 'Převzato'
        case 'in_progress':
            return 'Probíhá'
        case 'done':
            return 'Hotovo'
        case 'waiting_material':
            return 'Čeká na materiál'
        case 'cannot_today':
            return 'Nelze dnes'
        case 'cancelled':
            return 'Zrušeno'
        default:
            return status
    }
}

function statusColor(item: MaintenanceItem) {
    if (item.status === 'done') return '#16a34a'
    if (item.status === 'waiting_material') return '#7e22ce'
    if (item.status === 'in_progress') return '#ea580c'
    if (item.status === 'cannot_today' || item.status === 'cancelled') return '#64748b'
    if (item.priority === 'urgent' || item.status === 'new') return '#dc2626'
    return '#0ea5a4'
}
export default function MaintenanceView({
    maintenanceItems,
    tasks,
    currentUserId,
    role,
    onCreateMaintenance,
    onUpdateMaintenance,
    onMaterialNeeded
}: {
    maintenanceItems: MaintenanceItem[]
    tasks: Task[]
    currentUserId: string
    role: UserRole
    onCreateMaintenance: (input: { roomNumber?: string; title: string; category: MaintenanceItem['category']; priority: MaintenanceItem['priority']; note?: string }) => void
    onUpdateMaintenance: (itemId: string, patch: Partial<MaintenanceItem>) => void
    onMaterialNeeded: (itemId: string, materialText: string) => void
}) {
    const [creating, setCreating] = useState(false)
    const [newRoom, setNewRoom] = useState('')
    const [newTitle, setNewTitle] = useState('')
    const [newCategory, setNewCategory] = useState<MaintenanceItem['category']>('other')
    const [newPriority, setNewPriority] = useState<MaintenanceItem['priority']>('normal')
    const [newNote, setNewNote] = useState('')
    const [materialInput, setMaterialInput] = useState<Record<string, string>>({})

    const isAdmin = role === 'admin'
    const isLead = role === 'lead'
    const isMaintenance = role === 'maintenance'

    const visibleItems = maintenanceItems.filter(i => i.status !== 'cancelled')

    const adminCounts = {
        nove: maintenanceItems.filter(i => i.status === 'new').length,
        urgent: maintenanceItems.filter(i => i.priority === 'urgent' && i.status !== 'cancelled').length,
        waiting: maintenanceItems.filter(i => i.status === 'waiting_material').length,
        done: maintenanceItems.filter(i => i.status === 'done').length
    }

    function handleCreate() {
        if (!newTitle.trim()) return
        onCreateMaintenance({ roomNumber: newRoom.trim() || undefined, title: newTitle, category: newCategory, priority: newPriority, note: newNote })
        setNewRoom('')
        setNewTitle('')
        setNewNote('')
        setNewPriority('normal')
        setNewCategory('other')
        setCreating(false)
    }

    const maintenanceVisibleToUser = isAdmin ? visibleItems : isLead ? visibleItems.filter(i => i) /* lead sees all cleaners? keep full list for now */ : isMaintenance ? visibleItems.filter(i => !i.assignedTo || i.assignedTo === currentUserId || i.priority === 'urgent') : visibleItems

    // For maintenance role, order urgent first then new then waiting
    const sortedForMaintenance = [...maintenanceVisibleToUser].sort((a, b) => {
        const pa = a.priority === 'urgent' ? 0 : 1
        const pb = b.priority === 'urgent' ? 0 : 1
        if (pa !== pb) return pa - pb
        return a.createdAt.localeCompare(b.createdAt)
    })

    return (
        <div>
            <div className="section">
                <h3>Údržba</h3>

                {(isAdmin || isLead) && (
                    <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                        <div style={{ fontSize: 13 }}>Nové: <strong>{adminCounts.nove}</strong></div>
                        <div style={{ fontSize: 13 }}>Urgentní: <strong>{adminCounts.urgent}</strong></div>
                        <div style={{ fontSize: 13 }}>Čeká na materiál: <strong>{adminCounts.waiting}</strong></div>
                        <div style={{ fontSize: 13 }}>Hotovo: <strong>{adminCounts.done}</strong></div>
                    </div>
                )}

                {(isAdmin || isLead) && (
                    <div style={{ marginBottom: 8 }}>
                        {!creating ? (
                            <button className="action-large" onClick={() => setCreating(true)}>Nová závada</button>
                        ) : (
                            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                <input placeholder="Pokoj nebo místo" value={newRoom} onChange={(e) => setNewRoom(e.target.value)} />
                                <input placeholder="Co je za problém" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <select value={newCategory} onChange={(e) => setNewCategory(e.target.value as MaintenanceItem['category'])}>
                                        <option value="water">Voda</option>
                                        <option value="drain">Odpad</option>
                                        <option value="electricity">Elektrika</option>
                                        <option value="lock">Zámek</option>
                                        <option value="safe">Sejf</option>
                                        <option value="tv_wifi">TV / WiFi</option>
                                        <option value="heating">Topení</option>
                                        <option value="furniture">Nábytek</option>
                                        <option value="appliance">Spotřebič</option>
                                        <option value="other">Jiné</option>
                                    </select>
                                    <div style={{ display: 'flex', gap: 6 }}>
                                        <button className={`btn ${newPriority === 'normal' ? 'active' : ''}`} onClick={() => setNewPriority('normal')}>Normální</button>
                                        <button className={`btn ${newPriority === 'urgent' ? 'active' : ''}`} onClick={() => setNewPriority('urgent')}>Urgentní</button>
                                    </div>
                                </div>
                                <input placeholder="Poznámka (volitelné)" value={newNote} onChange={(e) => setNewNote(e.target.value)} />
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <button className="action-large" onClick={handleCreate}>Vytvořit závadu</button>
                                    <button className="btn" onClick={() => setCreating(false)}>Zrušit</button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                <h4 style={{ margin: '8px 0' }}>Závady</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {isMaintenance ? sortedForMaintenance.map((m) => (
                        <div key={m.id} className="room-card" style={{ borderLeft: `6px solid ${statusColor(m)}` }}>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontWeight: 700 }}>{m.roomNumber ? `Pokoj ${m.roomNumber}` : 'Místo'} – {m.title}</div>
                                <div style={{ fontSize: 13, color: '#64748b' }}>{m.category} • {m.priority === 'urgent' ? 'Urgentní' : 'Normální'} • {statusLabel(m.status)}</div>
                                {m.note && <div style={{ fontSize: 12, marginTop: 4, color: '#475569' }}>{m.note}</div>}
                                {m.materialNeeded && <div style={{ fontSize: 12, marginTop: 4, color: '#6b21a8' }}>Materiál: {m.materialNeeded}</div>}
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                {!m.assignedTo && <button className="action-large" onClick={() => onUpdateMaintenance(m.id, { status: 'accepted', assignedTo: currentUserId })}>Převzít</button>}
                                {m.assignedTo === currentUserId && m.status !== 'in_progress' && <button className="action-large" onClick={() => onUpdateMaintenance(m.id, { status: 'in_progress' })}>Probíhá</button>}
                                {m.assignedTo === currentUserId && <button className="action-large" onClick={() => onUpdateMaintenance(m.id, { status: 'done' })}>Hotovo</button>}
                                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                                    <input placeholder="Např. silikon, sifon, žárovka..." value={materialInput[m.id] || ''} onChange={(e) => setMaterialInput((prev) => ({ ...prev, [m.id]: e.target.value }))} style={{ minWidth: 140, flex: 1 }} />
                                    <button className="btn" onClick={() => { onMaterialNeeded(m.id, materialInput[m.id] || ''); setMaterialInput((prev) => ({ ...prev, [m.id]: '' })); }}>Uložit materiál</button>
                                </div>
                                <button className="chip" onClick={() => onUpdateMaintenance(m.id, { status: 'cannot_today' })}>Nelze dnes</button>
                            </div>
                        </div>
                    )) : (
                        // Admin / Lead view: show all items grouped, and also room tasks separate
                        maintenanceItems && maintenanceItems.filter(i => i.status !== 'cancelled').map((m) => (
                            <div key={m.id} className="room-card" style={{ borderLeft: `6px solid ${statusColor(m)}` }}>
                                <div style={{ flex: 1 }}>
                                    <div style={{ fontWeight: 700 }}>{m.roomNumber ? `Pokoj ${m.roomNumber}` : 'Místo'} – {m.title}</div>
                                    <div style={{ fontSize: 13, color: '#64748b' }}>{m.category} • {m.priority === 'urgent' ? 'Urgentní' : 'Normální'} • {statusLabel(m.status)}</div>
                                    {m.note && <div style={{ fontSize: 12, marginTop: 4, color: '#475569' }}>{m.note}</div>}
                                    {m.materialNeeded && <div style={{ fontSize: 12, marginTop: 4, color: '#6b21a8' }}>Materiál: {m.materialNeeded}</div>}
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    <button className="chip" onClick={() => onUpdateMaintenance(m.id, { status: 'accepted' })}>Převzato</button>
                                    <button className="chip" onClick={() => onUpdateMaintenance(m.id, { status: 'in_progress' })}>Probíhá</button>
                                    <button className="chip" onClick={() => onUpdateMaintenance(m.id, { status: 'done' })}>Hotovo</button>
                                    <button className="chip" onClick={() => onUpdateMaintenance(m.id, { status: 'waiting_material' })}>Čeká na materiál</button>
                                    <button className="chip" onClick={() => onUpdateMaintenance(m.id, { status: 'cannot_today' })}>Nelze dnes</button>
                                    {isAdmin && <button className="chip" onClick={() => onUpdateMaintenance(m.id, { status: 'cancelled' })}>Zrušit</button>}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {tasks.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                        <h4>Úkoly z pokojů</h4>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {tasks.map(t => (
                                <div key={t.id} className="room-card">
                                    <div style={{ fontWeight: 700 }}>{t.roomNumber} – {t.title}</div>
                                    <div style={{ fontSize: 13, color: '#64748b' }}>{t.priority === 'urgent' ? 'Urgentní' : 'Normální'} • {t.status}</div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
