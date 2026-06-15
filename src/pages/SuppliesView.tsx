import React, { useMemo, useState } from 'react'
import { SupplyRequest, UserRole } from '../types'

type Props = {
    userName: string
    role: UserRole
    requests: SupplyRequest[]
    customChips: string[]
    onCreateRequest: (input: {
        itemName: string
        category: SupplyRequest['category']
        quantityLevel: SupplyRequest['quantityLevel']
        customQuantity?: string
        roomNumber?: string
        note?: string
        priority: SupplyRequest['priority']
    }) => void
    onSaveCustomChip: (name: string) => void
    onCancelRequest: (requestId: string) => void
}

const cleaningChips = ['Toaletní papír', 'Pytle malé', 'Pytle velké', 'Tablety do myčky', 'Gel na praní', 'Lenor', 'Cif', 'Savo', 'Vodní kámen', 'Houbičky', 'Papírové utěrky', 'Baterky', 'Káva', 'Ručníky', 'Povlečení']

const categoryByItem: Record<string, SupplyRequest['category']> = {
    'Toaletní papír': 'bathroom',
    'Pytle malé': 'cleaning',
    'Pytle velké': 'cleaning',
    'Tablety do myčky': 'kitchen',
    'Gel na praní': 'laundry',
    Lenor: 'laundry',
    Cif: 'bathroom',
    Savo: 'bathroom',
    'Vodní kámen': 'bathroom',
    Houbičky: 'kitchen',
    'Papírové utěrky': 'kitchen',
    Baterky: 'kitchen',
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

function canCancel(role: UserRole, userName: string, request: SupplyRequest) {
    if (role === 'admin') return true
    if (role === 'lead') return request.category !== 'maintenance'
    if (role === 'cleaner') return request.status === 'new' && request.requestedBy === userName && request.requestedByRole === 'cleaner'
    if (role === 'maintenance') {
        return request.status === 'new' && request.category === 'maintenance' && request.requestedBy === userName && request.requestedByRole === 'maintenance'
    }
    return false
}

export default function SuppliesView({
    userName,
    role,
    requests,
    customChips,
    onCreateRequest,
    onSaveCustomChip,
    onCancelRequest
}: Props) {
    const [feedback, setFeedback] = useState('')

    const [customItem, setCustomItem] = useState('')
    const [customPriority, setCustomPriority] = useState<SupplyRequest['priority']>('normal')
    const [customNote, setCustomNote] = useState('')
    const [saveCustomChip, setSaveCustomChip] = useState(false)

    const [maintenanceItem, setMaintenanceItem] = useState('')
    const [maintenancePriority, setMaintenancePriority] = useState<SupplyRequest['priority']>('normal')
    const [maintenanceRoomNumber, setMaintenanceRoomNumber] = useState('')
    const [maintenanceNote, setMaintenanceNote] = useState('')

    const [roomNumber, setRoomNumber] = useState('')

    const newRequests = useMemo(() => requests.filter((r) => r.status === 'new' || r.status === 'approved'), [requests])
    const orderedRequests = useMemo(() => requests.filter((r) => r.status === 'ordered'), [requests])
    const completedRequests = useMemo(() => requests.filter((r) => r.status === 'delivered' || r.status === 'handed_over'), [requests])
    const cancelledRequests = useMemo(() => requests.filter((r) => r.status === 'cancelled'), [requests])

    const shouldShowCleaningChips = role === 'admin' || role === 'lead' || role === 'cleaner'
    const shouldShowMaintenanceForm = role === 'maintenance'

    const visibleChips = useMemo(() => {
        if (!shouldShowCleaningChips) return []
        return [...cleaningChips, ...customChips]
    }, [shouldShowCleaningChips, customChips])

    function setFeedbackText(text: string) {
        setFeedback(text)
        window.setTimeout(() => {
            setFeedback((prev) => (prev === text ? '' : prev))
        }, 1800)
    }

    function inferCategory(itemName: string): SupplyRequest['category'] {
        return categoryByItem[itemName] || 'other'
    }

    function handleQuickAdd(item: string) {
        onCreateRequest({
            itemName: item,
            category: inferCategory(item),
            quantityLevel: 'medium',
            priority: 'normal',
            note: undefined,
            roomNumber: undefined
        })
        setFeedbackText(`Přidáno: ${item}`)
    }

    function handleAddCustomRequest() {
        const itemName = customItem.trim()
        if (!itemName) return

        onCreateRequest({
            itemName,
            category: inferCategory(itemName),
            quantityLevel: 'medium',
            priority: customPriority,
            note: customNote.trim() || undefined,
            roomNumber: roomNumber.trim() || undefined
        })

        if (saveCustomChip) {
            onSaveCustomChip(itemName)
        }

        setCustomItem('')
        setCustomPriority('normal')
        setCustomNote('')
        setRoomNumber('')
        setSaveCustomChip(false)
        setFeedbackText(`Přidáno: ${itemName}`)
    }

    function handleAddMaintenanceRequest() {
        const itemName = maintenanceItem.trim()
        if (!itemName) return

        onCreateRequest({
            itemName,
            category: 'maintenance',
            quantityLevel: 'medium',
            priority: maintenancePriority,
            note: maintenanceNote.trim() || undefined,
            roomNumber: maintenanceRoomNumber.trim() || undefined
        })

        setMaintenanceItem('')
        setMaintenancePriority('normal')
        setMaintenanceNote('')
        setMaintenanceRoomNumber('')
        setFeedbackText(`Přidáno: ${itemName}`)
    }

    function getCancelLabel(request: SupplyRequest) {
        return request.status === 'new' ? 'Smazat' : 'Zrušit'
    }

    return (
        <div>
            {feedback && (
                <div className="section" style={{ paddingTop: 0, paddingBottom: 6 }}>
                    <div className="room-card" style={{ borderLeft: '6px solid #0ea5a4', paddingTop: 8, paddingBottom: 8 }}>
                        <div style={{ fontWeight: 700 }}>{feedback}</div>
                    </div>
                </div>
            )}

            {shouldShowCleaningChips && (
                <>
                    <div className="section">
                        <h3>Rychlé požadavky</h3>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {visibleChips.map((chip) => (
                                <button
                                    key={chip}
                                    className="chip"
                                    style={{ fontWeight: 700, border: '1px solid #dbe7f3', background: '#f8fafc' }}
                                    onClick={() => handleQuickAdd(chip)}
                                >
                                    {chip}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="section" style={{ background: '#fff', border: '1px solid #dbe7f3', borderRadius: 12, padding: 12 }}>
                        <h3 style={{ marginBottom: 8 }}>Jiný požadavek</h3>
                        <input
                            value={customItem}
                            onChange={(e) => setCustomItem(e.target.value)}
                            placeholder="Např. rukavice, nový mop, vůně do koupelny…"
                            style={{ width: '100%', minHeight: 42, borderRadius: 10, border: '1px solid #dbe7f3', padding: '8px 10px', marginBottom: 8 }}
                        />
                        <input
                            value={roomNumber}
                            onChange={(e) => setRoomNumber(e.target.value)}
                            placeholder="Pokoj (volitelně)"
                            style={{ width: '100%', minHeight: 38, borderRadius: 10, border: '1px solid #dbe7f3', padding: '8px 10px', marginBottom: 8 }}
                        />
                        <input
                            value={customNote}
                            onChange={(e) => setCustomNote(e.target.value)}
                            placeholder="Poznámka (volitelně)"
                            style={{ width: '100%', minHeight: 38, borderRadius: 10, border: '1px solid #dbe7f3', padding: '8px 10px', marginBottom: 8 }}
                        />
                        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                            <button
                                className="btn"
                                style={{ border: customPriority === 'normal' ? '2px solid #0ea5a4' : '1px solid #dbe7f3', background: customPriority === 'normal' ? '#ecfeff' : '#fff' }}
                                onClick={() => setCustomPriority('normal')}
                            >
                                Normální
                            </button>
                            <button
                                className="btn"
                                style={{ border: customPriority === 'urgent' ? '2px solid #dc2626' : '1px solid #dbe7f3', background: customPriority === 'urgent' ? '#fef2f2' : '#fff', color: '#991b1b' }}
                                onClick={() => setCustomPriority('urgent')}
                            >
                                Urgentní
                            </button>
                        </div>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 13, color: '#334155' }}>
                            <input
                                type="checkbox"
                                checked={saveCustomChip}
                                onChange={(e) => setSaveCustomChip(e.target.checked)}
                            />
                            Uložit jako chip pro příště
                        </label>
                        <button className="action-large" style={{ width: '100%' }} onClick={handleAddCustomRequest}>Přidat požadavek</button>
                    </div>
                </>
            )}

            {shouldShowMaintenanceForm && (
                <div className="section" style={{ background: '#fff', border: '1px solid #dbe7f3', borderRadius: 12, padding: 12 }}>
                    <h3 style={{ marginBottom: 8 }}>Zapsat materiál pro údržbu</h3>
                    <input
                        value={maintenanceItem}
                        onChange={(e) => setMaintenanceItem(e.target.value)}
                        placeholder="Např. silikon, sifon, žárovka, baterie do zámku…"
                        style={{ width: '100%', minHeight: 42, borderRadius: 10, border: '1px solid #dbe7f3', padding: '8px 10px', marginBottom: 8 }}
                    />
                    <input
                        value={maintenanceRoomNumber}
                        onChange={(e) => setMaintenanceRoomNumber(e.target.value)}
                        placeholder="Pokoj (volitelně)"
                        style={{ width: '100%', minHeight: 38, borderRadius: 10, border: '1px solid #dbe7f3', padding: '8px 10px', marginBottom: 8 }}
                    />
                    <input
                        value={maintenanceNote}
                        onChange={(e) => setMaintenanceNote(e.target.value)}
                        placeholder="Poznámka (volitelně)"
                        style={{ width: '100%', minHeight: 38, borderRadius: 10, border: '1px solid #dbe7f3', padding: '8px 10px', marginBottom: 8 }}
                    />
                    <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                        <button
                            className="btn"
                            style={{ border: maintenancePriority === 'normal' ? '2px solid #0ea5a4' : '1px solid #dbe7f3', background: maintenancePriority === 'normal' ? '#ecfeff' : '#fff' }}
                            onClick={() => setMaintenancePriority('normal')}
                        >
                            Normální
                        </button>
                        <button
                            className="btn"
                            style={{ border: maintenancePriority === 'urgent' ? '2px solid #dc2626' : '1px solid #dbe7f3', background: maintenancePriority === 'urgent' ? '#fef2f2' : '#fff', color: '#991b1b' }}
                            onClick={() => setMaintenancePriority('urgent')}
                        >
                            Urgentní
                        </button>
                    </div>
                    <button className="action-large" style={{ width: '100%' }} onClick={handleAddMaintenanceRequest}>Přidat materiál</button>
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
                                {canCancel(role, userName, request) && (
                                    <div style={{ marginTop: 8 }}>
                                        <button className="btn danger" onClick={() => onCancelRequest(request.id)}>{getCancelLabel(request)}</button>
                                    </div>
                                )}
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
