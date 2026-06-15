import React, { useMemo, useState } from 'react'
import { SupplyRequest, UserRole } from '../types'

type Props = {
    role: UserRole
    requests: SupplyRequest[]
    onCreateRequest: (input: {
        itemName: string
        category: SupplyRequest['category']
        quantityLevel: SupplyRequest['quantityLevel']
        customQuantity?: string
        roomNumber?: string
        note?: string
        priority: SupplyRequest['priority']
    }) => void
}

const chips = ['Toaletní papír', 'Pytle malé', 'Pytle velké', 'Tablety do myčky', 'Gel na praní', 'Lenor', 'Cif', 'Savo', 'Vodní kámen', 'Houbičky', 'Papírové utěrky', 'Baterky', 'Káva', 'Ručníky', 'Povlečení']

const categoryByItem: Record<string, SupplyRequest['category']> = {
    'Toaletní papír': 'bathroom',
    'Pytle malé': 'cleaning',
    'Pytle velké': 'cleaning',
    'Tablety do myčky': 'kitchen',
    'Gel na praní': 'laundry',
    Lenor: 'laundry',
    Cif: 'cleaning',
    Savo: 'cleaning',
    'Vodní kámen': 'bathroom',
    Houbičky: 'kitchen',
    'Papírové utěrky': 'kitchen',
    Baterky: 'maintenance',
    Káva: 'kitchen',
    Ručníky: 'laundry',
    Povlečení: 'laundry'
}

function quantityText(level: SupplyRequest['quantityLevel'], customQuantity?: string) {
    if (level === 'low') return 'Málo'
    if (level === 'medium') return 'Středně'
    if (level === 'high') return 'Hodně'
    return `Vlastní: ${customQuantity || '-'}`
}

function statusText(status: SupplyRequest['status']) {
    if (status === 'new') return 'Nové'
    if (status === 'approved') return 'Schválené'
    if (status === 'ordered') return 'Objednáno'
    if (status === 'delivered') return 'Doručeno'
    if (status === 'handed_over') return 'Předáno'
    return 'Zrušeno'
}

export default function SuppliesView({ role, requests, onCreateRequest }: Props) {
    const [selectedItem, setSelectedItem] = useState<string>('')
    const [quantityLevel, setQuantityLevel] = useState<SupplyRequest['quantityLevel']>('medium')
    const [customQuantity, setCustomQuantity] = useState('')
    const [priority, setPriority] = useState<SupplyRequest['priority']>('normal')
    const [note, setNote] = useState('')
    const [roomNumber, setRoomNumber] = useState('')
    const [category, setCategory] = useState<SupplyRequest['category']>('cleaning')

    const canCreate = role === 'admin' || role === 'lead' || role === 'cleaner' || role === 'maintenance'
    const roleLockedCategory = role === 'maintenance'

    const newRequests = useMemo(() => requests.filter((r) => r.status === 'new' || r.status === 'approved'), [requests])
    const orderedRequests = useMemo(() => requests.filter((r) => r.status === 'ordered'), [requests])
    const completedRequests = useMemo(() => requests.filter((r) => r.status === 'delivered' || r.status === 'handed_over'), [requests])
    const cancelledRequests = useMemo(() => requests.filter((r) => r.status === 'cancelled'), [requests])

    function handleSelectItem(item: string) {
        setSelectedItem(item)
        setCategory(roleLockedCategory ? 'maintenance' : (categoryByItem[item] || 'other'))
    }

    function resetForm() {
        setQuantityLevel('medium')
        setCustomQuantity('')
        setPriority('normal')
        setNote('')
        setRoomNumber('')
    }

    function handleCreate() {
        if (!canCreate || !selectedItem) return
        onCreateRequest({
            itemName: selectedItem,
            category: roleLockedCategory ? 'maintenance' : category,
            quantityLevel,
            customQuantity: quantityLevel === 'custom' ? customQuantity : undefined,
            roomNumber: roomNumber.trim() || undefined,
            note: note.trim() || undefined,
            priority
        })
        resetForm()
    }

    return (
        <div>
            <div className="section">
                <h3>Rychlé požadavky</h3>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {chips.map((chip) => (
                        <button
                            key={chip}
                            className="chip"
                            style={{
                                fontWeight: 700,
                                border: selectedItem === chip ? '2px solid #0ea5a4' : '1px solid #dbe7f3',
                                background: selectedItem === chip ? '#ecfeff' : '#f8fafc'
                            }}
                            onClick={() => handleSelectItem(chip)}
                        >
                            {chip}
                        </button>
                    ))}
                </div>
            </div>

            {selectedItem && (
                <div className="section" style={{ background: '#fff', border: '1px solid #dbe7f3', borderRadius: 12, padding: 12 }}>
                    <h3 style={{ marginBottom: 8 }}>Přidat do nákupu: {selectedItem}</h3>

                    {!roleLockedCategory && (
                        <div style={{ marginBottom: 10 }}>
                            <div className="room-meta" style={{ marginBottom: 6 }}>Kategorie</div>
                            <select
                                value={category}
                                onChange={(e) => setCategory(e.target.value as SupplyRequest['category'])}
                                style={{ width: '100%', minHeight: 42, borderRadius: 10, border: '1px solid #dbe7f3', padding: '8px 10px' }}
                            >
                                <option value="cleaning">Úklid</option>
                                <option value="laundry">Prádelna</option>
                                <option value="bathroom">Koupelna</option>
                                <option value="kitchen">Kuchyně</option>
                                <option value="maintenance">Údržba</option>
                                <option value="other">Ostatní</option>
                            </select>
                        </div>
                    )}

                    <div style={{ marginBottom: 10 }}>
                        <div className="room-meta" style={{ marginBottom: 6 }}>Množství</div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {[
                                { value: 'low', label: 'Málo' },
                                { value: 'medium', label: 'Středně' },
                                { value: 'high', label: 'Hodně' },
                                { value: 'custom', label: 'Vlastní' }
                            ].map((option) => (
                                <button
                                    key={option.value}
                                    className="btn"
                                    style={{
                                        border: quantityLevel === option.value ? '2px solid #0ea5a4' : '1px solid #dbe7f3',
                                        background: quantityLevel === option.value ? '#ecfeff' : '#fff'
                                    }}
                                    onClick={() => setQuantityLevel(option.value as SupplyRequest['quantityLevel'])}
                                >
                                    {option.label}
                                </button>
                            ))}
                        </div>
                        {quantityLevel === 'custom' && (
                            <input
                                value={customQuantity}
                                onChange={(e) => setCustomQuantity(e.target.value)}
                                placeholder="Např. 24 ks"
                                style={{ width: '100%', marginTop: 8, minHeight: 42, borderRadius: 10, border: '1px solid #dbe7f3', padding: '8px 10px' }}
                            />
                        )}
                    </div>

                    <div style={{ marginBottom: 10 }}>
                        <div className="room-meta" style={{ marginBottom: 6 }}>Priorita</div>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <button
                                className="btn"
                                style={{ border: priority === 'normal' ? '2px solid #0ea5a4' : '1px solid #dbe7f3', background: priority === 'normal' ? '#ecfeff' : '#fff' }}
                                onClick={() => setPriority('normal')}
                            >
                                Normální
                            </button>
                            <button
                                className="btn"
                                style={{ border: priority === 'urgent' ? '2px solid #dc2626' : '1px solid #dbe7f3', background: priority === 'urgent' ? '#fef2f2' : '#fff', color: '#991b1b' }}
                                onClick={() => setPriority('urgent')}
                            >
                                Urgentní
                            </button>
                        </div>
                    </div>

                    <div style={{ marginBottom: 10 }}>
                        <div className="room-meta" style={{ marginBottom: 6 }}>Číslo pokoje (volitelné)</div>
                        <input
                            value={roomNumber}
                            onChange={(e) => setRoomNumber(e.target.value)}
                            placeholder="Např. 101"
                            style={{ width: '100%', minHeight: 42, borderRadius: 10, border: '1px solid #dbe7f3', padding: '8px 10px' }}
                        />
                    </div>

                    <div style={{ marginBottom: 12 }}>
                        <div className="room-meta" style={{ marginBottom: 6 }}>Poznámka (volitelně)</div>
                        <textarea
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="Doplňující poznámka"
                            style={{ width: '100%', minHeight: 70, borderRadius: 10, border: '1px solid #dbe7f3', padding: '8px 10px', resize: 'vertical' }}
                        />
                    </div>

                    <button className="action-large" style={{ width: '100%' }} onClick={handleCreate}>Přidat do nákupu</button>
                </div>
            )}

            <div className="section">
                <h3>Nové požadavky</h3>
                <div className="room-list">
                    {newRequests.length === 0 && <div className="room-card">Bez nových požadavků</div>}
                    {newRequests.map((request) => (
                        <div
                            key={request.id}
                            className="room-card"
                            style={{ borderLeft: request.priority === 'urgent' ? '6px solid #dc2626' : '6px solid #0ea5a4', alignItems: 'flex-start' }}
                        >
                            <div style={{ flex: 1 }}>
                                <div style={{ fontWeight: 800 }}>{request.itemName}</div>
                                <div className="room-meta">{quantityText(request.quantityLevel, request.customQuantity)} • {statusText(request.status)}</div>
                                <div className="room-meta">Žádal: {request.requestedBy} • {request.createdAt}</div>
                                {request.roomNumber && <div className="room-meta">Pokoj: {request.roomNumber}</div>}
                                {request.note && <div className="note-chip" style={{ marginTop: 6 }}>{request.note}</div>}
                            </div>
                            {request.priority === 'urgent' && <div className="status red">URGENT</div>}
                        </div>
                    ))}
                </div>
            </div>

            <div className="section">
                <h3>Objednáno</h3>
                <div className="room-list">
                    {orderedRequests.length === 0 && <div className="room-card">Nic není objednáno</div>}
                    {orderedRequests.map((request) => (
                        <div key={request.id} className="room-card" style={{ borderLeft: '6px solid #2563eb' }}>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontWeight: 800 }}>{request.itemName}</div>
                                <div className="room-meta">{quantityText(request.quantityLevel, request.customQuantity)} • {statusText(request.status)}</div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            <div className="section">
                <h3>Doručeno / předáno</h3>
                <div className="room-list">
                    {completedRequests.length === 0 && <div className="room-card">Zatím nic</div>}
                    {completedRequests.map((request) => (
                        <div key={request.id} className="room-card" style={{ borderLeft: '6px solid #059669' }}>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontWeight: 800 }}>{request.itemName}</div>
                                <div className="room-meta">{quantityText(request.quantityLevel, request.customQuantity)} • {statusText(request.status)}</div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {cancelledRequests.length > 0 && (
                <div className="section" style={{ opacity: 0.6 }}>
                    <h3>Zrušené</h3>
                    <div className="room-list">
                        {cancelledRequests.map((request) => (
                            <div key={request.id} className="room-card">
                                <div style={{ flex: 1 }}>
                                    <div style={{ fontWeight: 700 }}>{request.itemName}</div>
                                    <div className="room-meta">{statusText(request.status)}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}
