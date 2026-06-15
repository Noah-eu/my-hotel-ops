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
    const [materialOpenItemId, setMaterialOpenItemId] = useState<string | null>(null)

    const isAdmin = role === 'admin'
    const isLead = role === 'lead'
    const isMaintenance = role === 'maintenance'

    function categoryLabel(category: MaintenanceItem['category']) {
        switch (category) {
            case 'water':
                return 'Voda'
            case 'drain':
                return 'Odpad'
            case 'electricity':
                return 'Elektrika'
            case 'lock':
                return 'Zámek'
            case 'safe':
                return 'Sejf'
            case 'tv_wifi':
                return 'TV / WiFi'
            case 'heating':
                return 'Topení'
            case 'furniture':
                return 'Nábytek'
            case 'appliance':
                return 'Spotřebič'
            default:
                return 'Jiné'
        }
    }

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

    const maintenanceVisibleToUser = isAdmin ? visibleItems : isLead ? visibleItems : isMaintenance ? visibleItems.filter(i => !i.assignedTo || i.assignedTo === currentUserId || i.priority === 'urgent') : visibleItems

    const sortedItems = [...maintenanceVisibleToUser].sort((a, b) => {
        const pa = a.priority === 'urgent' ? 0 : 1
        const pb = b.priority === 'urgent' ? 0 : 1
        if (pa !== pb) return pa - pb
        return a.createdAt.localeCompare(b.createdAt)
    })

    function renderItemCard(m: MaintenanceItem) {
        const canActAsMaintenance = isMaintenance && (!m.assignedTo || m.assignedTo === currentUserId)
        const cardStatusColor = statusColor(m)

        return (
            <div key={m.id} className="room-card" style={{ borderLeft: `6px solid ${cardStatusColor}`, padding: 12 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                        <div style={{ fontWeight: 800, fontSize: 17, color: '#0f172a' }}>{m.roomNumber ? `Pokoj ${m.roomNumber}` : 'Místo'}</div>
                        <div style={{ padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 700, background: m.priority === 'urgent' ? '#fee2e2' : '#ecfeff', color: m.priority === 'urgent' ? '#991b1b' : '#0f766e' }}>
                            {m.priority === 'urgent' ? 'Urgentní' : 'Normální'}
                        </div>
                        <div style={{ padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 700, background: '#f1f5f9', color: cardStatusColor }}>
                            {statusLabel(m.status)}
                        </div>
                        <div style={{ fontSize: 12, color: '#475569' }}>{categoryLabel(m.category)}</div>
                    </div>

                    <div style={{ fontWeight: 800, fontSize: 18, lineHeight: 1.2, color: '#0f172a' }}>{m.title}</div>

                    {m.note && <div style={{ fontSize: 14, color: '#334155' }}>{m.note}</div>}
                    {m.materialNeeded && <div style={{ fontSize: 14, color: '#6b21a8', fontWeight: 600 }}>Materiál: {m.materialNeeded}</div>}

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {canActAsMaintenance && !m.assignedTo && (
                            <button className="chip" style={{ padding: '8px 10px' }} onClick={() => onUpdateMaintenance(m.id, { status: 'accepted', assignedTo: currentUserId })}>Převzít</button>
                        )}
                        {canActAsMaintenance && m.status !== 'in_progress' && (
                            <button className="chip" style={{ padding: '8px 10px' }} onClick={() => onUpdateMaintenance(m.id, { status: 'in_progress' })}>Probíhá</button>
                        )}
                        {canActAsMaintenance && (
                            <button className="chip" style={{ padding: '8px 10px' }} onClick={() => onUpdateMaintenance(m.id, { status: 'done' })}>Hotovo</button>
                        )}

                        {(isAdmin || isLead || canActAsMaintenance) && (
                            <button className="chip" style={{ padding: '8px 10px' }} onClick={() => setMaterialOpenItemId(materialOpenItemId === m.id ? null : m.id)}>Potřebuji materiál</button>
                        )}

                        {(isAdmin || isLead || canActAsMaintenance) && (
                            <button className="chip" style={{ padding: '8px 10px' }} onClick={() => onUpdateMaintenance(m.id, { status: 'cannot_today' })}>Nelze dnes</button>
                        )}

                        {isAdmin && (
                            <button className="chip" style={{ padding: '8px 10px', color: '#b91c1c', borderColor: '#fecaca', background: '#fff1f2' }} onClick={() => onUpdateMaintenance(m.id, { status: 'cancelled' })}>Zrušit</button>
                        )}
                    </div>

                    {materialOpenItemId === m.id && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: 8, border: '1px solid #e2e8f0', borderRadius: 8, background: '#faf5ff' }}>
                            <input
                                placeholder="Např. silikon, sifon, žárovka…"
                                value={materialInput[m.id] || ''}
                                onChange={(e) => setMaterialInput((prev) => ({ ...prev, [m.id]: e.target.value }))}
                                style={{ minWidth: 160, flex: 1 }}
                            />
                            <button
                                className="btn"
                                onClick={() => {
                                    onMaterialNeeded(m.id, materialInput[m.id] || '')
                                    setMaterialInput((prev) => ({ ...prev, [m.id]: '' }))
                                    setMaterialOpenItemId(null)
                                }}
                            >
                                Uložit materiál
                            </button>
                            <button className="btn" onClick={() => setMaterialOpenItemId(null)}>Zavřít</button>
                        </div>
                    )}
                </div>
            </div>
        )
    }

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
                    {sortedItems.map(renderItemCard)}
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
