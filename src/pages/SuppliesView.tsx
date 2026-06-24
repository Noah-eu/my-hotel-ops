import React, { useMemo, useState, useEffect } from 'react'
import { SupplyRequest, UserRole } from '../types'
import { isAdminRole, isCleanerRole, isCleaningLeadRole, isMaintenanceRole } from '../lib/roles'
import { buildBoughtArchiveModel, buildSupplyRequestUiBuckets, canManageSupplyLifecycle, canSetSupplyStatus, getCustomSupplyChipsForSection, getSupplyCategoryForChipSection, getSupplyRequestArchiveDate, type SupplyChipSection } from '../lib/opsUiInvariants'

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
    onSaveCustomChip: (name: string, section: 'uklid' | 'vybaveni' | 'ostatni') => void
    onCancelRequest: (requestId: string) => void
    onSetRequestStatus: (requestId: string, status: SupplyRequest['status']) => void
}

const uklidChips = [
    'Toaletní papír',
    'Pytle malé',
    'Pytle velké',
    'Tablety do myčky',
    'Gel na praní',
    'Lenor',
    'Jar',
    'Cif',
    'Savo',
    'Vodní kámen',
    'Houbičky',
    'Papírové utěrky',
    'Hadry / utěrky',
    'Rukavice',
    'Mop / náhradní hlavice'
]

const vybaveniChips = [
    'Ručníky',
    'Osušky',
    'Povlečení',
    'Prostěradla',
    'Polštáře',
    'Deky'
]

const ostatniChips = [
    'Baterky',
    'Žárovky',
    'Káva',
    'Vody'
]

const categoryByItem: Record<string, SupplyRequest['category']> = {
    // Úklid
    'Toaletní papír': 'bathroom',
    'Pytle malé': 'cleaning',
    'Pytle velké': 'cleaning',
    'Tablety do myčky': 'kitchen',
    'Gel na praní': 'laundry',
    Lenor: 'laundry',
    Jar: 'kitchen',
    Cif: 'cleaning',
    Savo: 'cleaning',
    'Vodní kámen': 'bathroom',
    Houbičky: 'kitchen',
    'Papírové utěrky': 'kitchen',
    'Hadry / utěrky': 'cleaning',
    Rukavice: 'cleaning',
    'Mop / náhradní hlavice': 'cleaning',
    // Vybavení
    Ručníky: 'equipment',
    Osušky: 'equipment',
    Povlečení: 'equipment',
    Prostěradla: 'equipment',
    Polštáře: 'equipment',
    Deky: 'equipment',
    // Ostatní / maintenance
    Baterky: 'maintenance',
    Žárovky: 'maintenance',
    Káva: 'other',
    Vody: 'other'
}

function quantityText(level: SupplyRequest['quantityLevel'], customQuantity?: string) {
    if (level === 'low') return 'Málo'
    if (level === 'medium') return 'Středně'
    if (level === 'high') return 'Hodně'
    return `Množství: ${customQuantity || '-'}`
}

function statusText(status: SupplyRequest['status']) {
    if (status === 'new' || status === 'approved') return 'Čeká'
    if (status === 'ordered') return 'Objednáno'
    if (status === 'delivered' || status === 'handed_over') return 'Koupeno'
    return 'Zrušeno'
}

function canCancel(role: UserRole, userName: string, request: SupplyRequest) {
    if (isAdminRole(role)) return true
    if (isCleaningLeadRole(role)) return request.category !== 'maintenance'
    if (isCleanerRole(role)) return request.status === 'new' && request.requestedBy === userName && request.requestedByRole === 'cleaner'
    if (isMaintenanceRole(role)) {
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
    onCancelRequest,
    onSetRequestStatus
}: Props) {
    const [feedback, setFeedback] = useState('')
    const [selectedCategory, setSelectedCategory] = useState<SupplyChipSection>('uklid')
    const [boughtArchiveOpen, setBoughtArchiveOpen] = useState(false)
    const [selectedArchiveYear, setSelectedArchiveYear] = useState<number | null>(null)
    const [selectedArchiveMonthKey, setSelectedArchiveMonthKey] = useState<string | null>(null)

    const [customItem, setCustomItem] = useState('')
    const [customPriority, setCustomPriority] = useState<SupplyRequest['priority']>('normal')
    const [customNote, setCustomNote] = useState('')
    const [saveCustomChip, setSaveCustomChip] = useState(false)

    const [maintenanceItem, setMaintenanceItem] = useState('')
    const [maintenancePriority, setMaintenancePriority] = useState<SupplyRequest['priority']>('normal')
    const [maintenanceNote, setMaintenanceNote] = useState('')

    const {
        maintenanceRequests,
        normalNewRequests,
        orderedRequests,
        cancelledRequests
    } = useMemo(() => buildSupplyRequestUiBuckets(requests), [requests])
    const [selectedSubsection, setSelectedSubsection] = useState<'normal' | 'maintenance'>('normal')

    // localStorage seen tracking
    const STORAGE_KEY = 'supplies.seen.v1'
    const loadSeen = () => {
        try {
            const raw = window.localStorage.getItem(STORAGE_KEY)
            if (!raw) return { normal: [] as string[], maintenance: [] as string[] }
            const parsed = JSON.parse(raw || '{}')
            return { normal: Array.isArray(parsed.normal) ? parsed.normal : [], maintenance: Array.isArray(parsed.maintenance) ? parsed.maintenance : [] }
        } catch (e) {
            return { normal: [], maintenance: [] }
        }
    }

    const saveSeen = (obj: { normal: string[]; maintenance: string[] }) => {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(obj))
        } catch (e) {
            // ignore
        }
    }

    const [seenMap, setSeenMap] = useState<{ normal: string[]; maintenance: string[] }>(() => {
        if (typeof window === 'undefined') return { normal: [], maintenance: [] }
        return loadSeen()
    })

    useEffect(() => {
        // initialize selection: maintenance role sees maintenance by default
        if (isMaintenanceRole(role)) {
            setSelectedSubsection('maintenance')
            return
        }
        // otherwise prefer normal if it has items
        if (normalNewRequests.length > 0) setSelectedSubsection('normal')
        else if (maintenanceRequests.length > 0) setSelectedSubsection('maintenance')
    }, [normalNewRequests.length, maintenanceRequests.length])

    function uniqueKeyForRequest(r: SupplyRequest) {
        if (!r) return ''
        if (r.id) return String(r.id)
        return `${(r.itemName || '').trim()}::${(r.createdAt || '').trim()}::${(r.requestedBy || '').trim()}`
    }

    const normalUnseenCount = useMemo(() => {
        const seen = new Set<string>(seenMap.normal || [])
        return normalNewRequests.reduce((acc, r) => {
            const k = uniqueKeyForRequest(r)
            if (!k) return acc
            return acc + (seen.has(k) ? 0 : 1)
        }, 0)
    }, [normalNewRequests, seenMap])

    const maintenanceUnseenCount = useMemo(() => {
        const seen = new Set<string>(seenMap.maintenance || [])
        return maintenanceRequests.reduce((acc, r) => {
            const k = uniqueKeyForRequest(r)
            if (!k) return acc
            return acc + (seen.has(k) ? 0 : 1)
        }, 0)
    }, [maintenanceRequests, seenMap])

    function markSeen(section: 'normal' | 'maintenance') {
        const current = loadSeen()
        const targetList = section === 'normal' ? normalNewRequests : maintenanceRequests
        const added = new Set<string>(section === 'normal' ? current.normal : current.maintenance)
        for (const r of targetList) {
            const k = uniqueKeyForRequest(r)
            if (k) added.add(k)
        }
        const updated = { normal: current.normal, maintenance: current.maintenance }
        if (section === 'normal') updated.normal = Array.from(added)
        else updated.maintenance = Array.from(added)
        setSeenMap(updated)
        saveSeen(updated)
    }
    const canManageLifecycle = canManageSupplyLifecycle(role)
    const boughtArchive = useMemo(() => buildBoughtArchiveModel(requests), [requests])

    const shouldShowCleaningChips = (isAdminRole(role) || isCleaningLeadRole(role)) && !isMaintenanceRole(role)
    const shouldShowMaintenanceForm = isMaintenanceRole(role)
    const selectedCustomChips = useMemo(() => getCustomSupplyChipsForSection(customChips, selectedCategory), [customChips, selectedCategory])
    const selectedArchiveYearModel = useMemo(() => boughtArchive.years.find((year) => year.year === selectedArchiveYear) || null, [boughtArchive.years, selectedArchiveYear])
    const selectedArchiveMonthModel = useMemo(() => selectedArchiveYearModel?.months.find((month) => month.key === selectedArchiveMonthKey) || null, [selectedArchiveMonthKey, selectedArchiveYearModel])

    useEffect(() => {
        if (!boughtArchiveOpen) return
        const firstYear = boughtArchive.years[0] || null
        if (!firstYear) {
            setSelectedArchiveYear(null)
            setSelectedArchiveMonthKey(null)
            return
        }

        if (selectedArchiveYear !== firstYear.year && !boughtArchive.years.some((year) => year.year === selectedArchiveYear)) {
            setSelectedArchiveYear(firstYear.year)
            setSelectedArchiveMonthKey(firstYear.months[0]?.key || null)
            return
        }

        const activeYear = boughtArchive.years.find((year) => year.year === selectedArchiveYear) || firstYear
        if (!activeYear.months.some((month) => month.key === selectedArchiveMonthKey)) {
            setSelectedArchiveMonthKey(activeYear.months[0]?.key || null)
        }
    }, [boughtArchive, boughtArchiveOpen, selectedArchiveMonthKey, selectedArchiveYear])

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

    function handleCustomChipQuickAdd(item: string, section: SupplyChipSection) {
        onCreateRequest({
            itemName: item,
            category: getSupplyCategoryForChipSection(section),
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
            category: getSupplyCategoryForChipSection(selectedCategory),
            quantityLevel: 'medium',
            priority: customPriority,
            note: customNote.trim() || undefined,
            roomNumber: undefined
        })

        if (saveCustomChip) {
            onSaveCustomChip(itemName, selectedCategory)
        }

        setCustomItem('')
        setCustomPriority('normal')
        setCustomNote('')
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
            roomNumber: undefined
        })

        setMaintenanceItem('')
        setMaintenancePriority('normal')
        setMaintenanceNote('')
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
                        {!isMaintenanceRole(role) && (
                            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                                <button
                                    className={`btn ${selectedCategory === 'uklid' ? 'active' : ''}`}
                                    onClick={() => setSelectedCategory('uklid')}
                                >Úklid</button>
                                <button
                                    className={`btn ${selectedCategory === 'vybaveni' ? 'active' : ''}`}
                                    onClick={() => setSelectedCategory('vybaveni')}
                                >Vybavení</button>
                                <button
                                    className={`btn ${selectedCategory === 'ostatni' ? 'active' : ''}`}
                                    onClick={() => setSelectedCategory('ostatni')}
                                >Ostatní</button>
                            </div>
                        )}

                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {(selectedCategory === 'uklid' ? uklidChips : selectedCategory === 'vybaveni' ? vybaveniChips : ostatniChips).map((chip) => (
                                <button key={chip} className="chip" style={{ fontWeight: 700, border: '1px solid #dbe7f3', background: '#f8fafc' }} onClick={() => handleQuickAdd(chip)}>{chip}</button>
                            ))}

                            {selectedCustomChips.map((chip) => (
                                <button key={`${chip.section}::${chip.name}`} className="chip" style={{ fontWeight: 700, border: '1px solid #dbe7f3', background: '#fff9f0' }} onClick={() => handleCustomChipQuickAdd(chip.name, chip.section)}>{chip.name}</button>
                            ))}
                        </div>

                        <div style={{ marginTop: 12 }} className="section" >
                            <h3 style={{ marginBottom: 8 }}>Jiný požadavek</h3>
                            <input
                                value={customItem}
                                onChange={(e) => setCustomItem(e.target.value)}
                                placeholder="Např. rukavice, nový mop, vůně do koupelny…"
                                style={{ width: '100%', minHeight: 42, borderRadius: 10, border: '1px solid #dbe7f3', padding: '8px 10px', marginBottom: 8 }}
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
                    {/* room field removed for maintenance requests */}
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
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    {!isMaintenanceRole(role) && (
                        <button
                            className={`chip ${selectedSubsection === 'normal' ? 'active' : ''}`}
                            onClick={() => { setSelectedSubsection('normal'); markSeen('normal') }}
                            style={{ fontWeight: 800, border: '1px solid #dbe7f3', background: '#fff' }}
                        >
                            Úklid / běžné nákupy
                            {normalUnseenCount > 0 && <span className="chip-badge">{normalUnseenCount}</span>}
                        </button>
                    )}

                    <button
                        className={`chip ${selectedSubsection === 'maintenance' ? 'active' : ''}`}
                        onClick={() => { setSelectedSubsection('maintenance'); markSeen('maintenance') }}
                        style={{ fontWeight: 800, border: '1px solid #dbe7f3', background: '#fff' }}
                    >
                        Materiál pro údržbu
                        {maintenanceUnseenCount > 0 && <span className="chip-badge">{maintenanceUnseenCount}</span>}
                    </button>

                    <button
                        type="button"
                        className="chip"
                        style={{ fontWeight: 800, border: '1px solid #bbf7d0', background: '#f0fdf4', color: '#166534' }}
                        onClick={() => setBoughtArchiveOpen(true)}
                    >
                        Koupeno ({boughtArchive.totalCount})
                    </button>
                </div>

                <div style={{ marginTop: 10 }}>
                    {selectedSubsection === 'maintenance' ? (
                        <div>
                            <h3>Materiál pro údržbu</h3>
                            <div className="room-list">
                                {maintenanceRequests.length === 0 && <div className="room-card">Žádný materiál pro údržbu</div>}
                                {maintenanceRequests.map((request) => (
                                    <div
                                        key={request.id || `${request.itemName}-${request.createdAt}`}
                                        className={`room-card maintenance-supply-card`}
                                        style={{ borderLeft: request.priority === 'urgent' ? '6px solid #dc2626' : '6px solid #0ea5a4', alignItems: 'flex-start' }}
                                    >
                                        <div style={{ flex: 1 }}>
                                            <div style={{ fontWeight: 800 }}>{request.itemName}</div>
                                            <div className="room-meta">{request.roomNumber ? `Pokoj ${request.roomNumber}` : 'Zdroj: Údržba'} • {quantityText(request.quantityLevel, request.customQuantity)} • {statusText(request.status)}</div>
                                            <div className="room-meta">Žádal: {request.requestedBy} • {request.createdAt}</div>
                                            {request.linkedTaskId && <div className="room-meta" style={{ marginTop: 6 }}>Úkol: {request.linkedTaskId}</div>}
                                            {request.note && <div className="note-chip" style={{ marginTop: 6 }}>{request.note}</div>}
                                            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                                {canManageLifecycle && canSetSupplyStatus(request.status, 'ordered') && (
                                                    <button className="btn" onClick={() => onSetRequestStatus(request.id, 'ordered')}>Objednáno</button>
                                                )}
                                                {canManageLifecycle && canSetSupplyStatus(request.status, 'delivered') && (
                                                    <button className="btn" onClick={() => onSetRequestStatus(request.id, 'delivered')}>Koupeno</button>
                                                )}
                                                {canCancel(role, userName, request) && (
                                                    <button className="btn danger" onClick={() => onCancelRequest(request.id)}>{getCancelLabel(request)}</button>
                                                )}
                                            </div>
                                        </div>
                                        {request.priority === 'urgent' && <div className="status red">URGENT</div>}
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : (
                        <div>
                            <h3>Čeká</h3>
                            <div className="room-list">
                                {normalNewRequests.length === 0 && <div className="room-card">Bez nových požadavků</div>}
                                {normalNewRequests.map((request) => (
                                    <div
                                        key={request.id || `${request.itemName}-${request.createdAt}`}
                                        className="room-card"
                                        style={{ borderLeft: request.priority === 'urgent' ? '6px solid #dc2626' : '6px solid #0ea5a4', alignItems: 'flex-start' }}
                                    >
                                        <div style={{ flex: 1 }}>
                                            <div style={{ fontWeight: 800 }}>{request.itemName}</div>
                                            <div className="room-meta">{quantityText(request.quantityLevel, request.customQuantity)} • {statusText(request.status)}</div>
                                            <div className="room-meta">Žádal: {request.requestedBy} • {request.createdAt}</div>
                                            {/* room number is intentionally hidden in supplies UI */}
                                            {request.note && <div className="note-chip" style={{ marginTop: 6 }}>{request.note}</div>}
                                            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                                {canManageLifecycle && canSetSupplyStatus(request.status, 'ordered') && (
                                                    <button className="btn" onClick={() => onSetRequestStatus(request.id, 'ordered')}>Objednáno</button>
                                                )}
                                                {canManageLifecycle && canSetSupplyStatus(request.status, 'delivered') && (
                                                    <button className="btn" onClick={() => onSetRequestStatus(request.id, 'delivered')}>Koupeno</button>
                                                )}
                                                {canCancel(role, userName, request) && (
                                                    <button className="btn danger" onClick={() => onCancelRequest(request.id)}>{getCancelLabel(request)}</button>
                                                )}
                                            </div>
                                        </div>
                                        {request.priority === 'urgent' && <div className="status red">URGENT</div>}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
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
                                {canManageLifecycle && canSetSupplyStatus(request.status, 'delivered') && (
                                    <div style={{ marginTop: 8 }}>
                                        <button className="btn" onClick={() => onSetRequestStatus(request.id, 'delivered')}>Koupeno</button>
                                    </div>
                                )}
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

            {boughtArchiveOpen && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-label="Koupeno"
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(15, 23, 42, 0.45)',
                        zIndex: 40,
                        padding: 16,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                    }}
                    onClick={() => setBoughtArchiveOpen(false)}
                >
                    <div
                        className="section"
                        style={{ maxWidth: 760, width: '100%', maxHeight: '90vh', overflow: 'auto', background: '#fff', borderRadius: 16, margin: 0 }}
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 12 }}>
                            <h3 style={{ margin: 0 }}>Koupeno</h3>
                            <button type="button" className="btn" onClick={() => setBoughtArchiveOpen(false)}>Zavřít</button>
                        </div>

                        {boughtArchive.years.length === 0 ? (
                            <div className="room-card">Zatím nic</div>
                        ) : (
                            <div style={{ display: 'grid', gap: 10 }}>
                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                    {boughtArchive.years.map((year) => (
                                        <button
                                            key={year.year}
                                            className={`chip ${selectedArchiveYear === year.year ? 'active' : ''}`}
                                            onClick={() => {
                                                setSelectedArchiveYear(year.year)
                                                setSelectedArchiveMonthKey(year.months[0]?.key || null)
                                            }}
                                            style={{ fontWeight: 800, border: '1px solid #dbe7f3', background: '#fff' }}
                                        >
                                            {year.year}
                                        </button>
                                    ))}
                                </div>

                                {selectedArchiveYearModel && (
                                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                        {selectedArchiveYearModel.months.map((month) => (
                                            <button
                                                key={month.key}
                                                className={`chip ${selectedArchiveMonthKey === month.key ? 'active' : ''}`}
                                                onClick={() => setSelectedArchiveMonthKey(month.key)}
                                                style={{ fontWeight: 700, border: '1px solid #dbe7f3', background: '#fff' }}
                                            >
                                                {month.label} ({month.count})
                                            </button>
                                        ))}
                                    </div>
                                )}

                                {selectedArchiveMonthModel && (
                                    <div className="room-list">
                                        {selectedArchiveMonthModel.requests.map((request) => {
                                            const archiveDate = getSupplyRequestArchiveDate(request)
                                            return (
                                                <div key={request.id} className="room-card" style={{ borderLeft: '6px solid #059669' }}>
                                                    <div style={{ flex: 1 }}>
                                                        <div style={{ fontWeight: 800 }}>{request.itemName}</div>
                                                        <div className="room-meta">{quantityText(request.quantityLevel, request.customQuantity)} • {statusText(request.status)}</div>
                                                        <div className="room-meta">{archiveDate.toLocaleString('cs-CZ')}</div>
                                                        {request.note && <div className="note-chip" style={{ marginTop: 6 }}>{request.note}</div>}
                                                    </div>
                                                </div>
                                            )
                                        })}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
