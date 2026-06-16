import React, { useState } from 'react'
import { RoomPlan, Task, UserRole } from '../types'

type RoomActionPayload = {
    estimateTime?: string
    relativeMinutes?: number
}

type CreateTaskInput = {
    title: string
    category: Task['category']
    priority: Task['priority']
    assignedToRole: Extract<UserRole, 'lead' | 'cleaner' | 'maintenance'>
    note?: string
}

const arrivalPreparationTitles = new Set([
    'Připravit postýlku',
    'Připravit gauč',
    'Vyměnit ručníky',
    'Extra ručníky',
    'Doplnit toaletní papír'
])

const quickTaskOptions: { label: string; category: Task['category'] }[] = [
    { label: 'Připravit postýlku', category: 'cleaning' },
    { label: 'Připravit gauč', category: 'cleaning' },
    { label: 'Vyměnit ručníky', category: 'cleaning' },
    { label: 'Extra ručníky', category: 'cleaning' },
    { label: 'Doplnit toaletní papír', category: 'supplies' },
    { label: 'Najít zapomenutou věc', category: 'guest_request' },
    { label: 'Zkontrolovat sejf', category: 'maintenance' },
    { label: 'Zkontrolovat klíč / box', category: 'guest_request' },
    { label: 'Poslat údržbáře', category: 'maintenance' },
    { label: 'Zkontrolovat závadu', category: 'maintenance' },
    { label: 'Vlastní úkol', category: 'other' }
]

function normalizeForKeywordMatch(value: string) {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
}

function arrivalPrepChipsFromNotes(notes?: string[]) {
    if (!notes || notes.length === 0) return []

    const joined = normalizeForKeywordMatch(notes.join(' | '))
    const chips: string[] = []

    if (joined.includes('detska postylka') || joined.includes('postylka')) chips.push('dětská postýlka')
    if (joined.includes('gauc')) chips.push('gauč')
    if (joined.includes('extra rucniky')) chips.push('extra ručníky')

    return chips
}

function canonicalBoxValue(value?: string) {
    if (!value) return undefined
    const match = value.match(/\bbox\s*([a-z0-9-]+)/i)
    if (!match) return undefined
    return `BOX ${match[1].toUpperCase()}`
}

function normalizeChipText(value: string) {
    return value
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/\s*[,;]\s*$/g, '')
}

function stripBoxFromNote(note: string, canonicalBox?: string) {
    if (!canonicalBox) return normalizeChipText(note)

    const boxTokenMatch = canonicalBox.match(/BOX\s+([A-Z0-9-]+)/i)
    if (!boxTokenMatch) return normalizeChipText(note)
    const boxToken = boxTokenMatch[1]

    const parts = note.split(/[,;]+/).map((part) => part.trim()).filter(Boolean)
    const cleanedParts = parts
        .map((part) => {
            const withoutRecepce = part.replace(/^\s*recepce\s*:\s*/i, '').trim()
            const removedSameBox = withoutRecepce
                .replace(new RegExp(`\\bbox\\s*${boxToken}\\b`, 'ig'), ' ')
                .replace(/^[\s:,-]+/, '')
                .replace(/[\s:,-]+$/, '')
                .replace(/\s+/g, ' ')
                .trim()

            if (!removedSameBox) return ''
            if (/^box$/i.test(removedSameBox)) return ''
            return removedSameBox
        })
        .map((part) => normalizeChipText(part))
        .filter(Boolean)

    if (cleanedParts.length === 0) return ''
    return cleanedParts.join(', ')
}

function displayNotesWithoutDuplicateBox(box?: string, notes?: string[]) {
    const canonicalBox = canonicalBoxValue(box)
    const renderedNotes = (notes || [])
        .map((note) => stripBoxFromNote(note, canonicalBox))
        .map((note) => normalizeChipText(note))
        .filter(Boolean)
        .filter((note, index, all) => all.findIndex((item) => normalizeForKeywordMatch(item) === normalizeForKeywordMatch(note)) === index)

    return {
        box: canonicalBox,
        notes: renderedNotes
    }
}

function canSeeTask(role: UserRole, task: Task) {
    if (role === 'admin') return true
    if (role === 'lead') return task.category === 'cleaning' || task.assignedToRole === 'lead'
    if (role === 'cleaner') return task.category === 'cleaning' || task.assignedToRole === 'cleaner'
    if (role === 'maintenance') return task.assignedToRole === 'maintenance'
    return false
}

function normalizeIdentity(value?: string) {
    if (!value) return ''
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
}

function canDeleteTask(role: UserRole, currentUserId: string, currentUserName: string | undefined, task: Task) {
    if (role === 'admin') return true
    if (role === 'lead') return task.category === 'cleaning'
    if (role === 'cleaner') {
        if (!task.createdBy) return false
        const creator = normalizeIdentity(task.createdBy)
        const userId = normalizeIdentity(currentUserId)
        const userName = normalizeIdentity(currentUserName)
        return creator === userId || (!!userName && creator === userName)
    }
    return false
}

function roleLabel(role: UserRole) {
    switch (role) {
        case 'admin':
            return 'Admin'
        case 'lead':
            return 'Iryna'
        case 'cleaner':
            return 'Úklid'
        case 'maintenance':
            return 'Údržba'
        default:
            return role
    }
}

function taskStatusLabel(status: Task['status']) {
    switch (status) {
        case 'new':
            return 'Nový'
        case 'read':
            return 'Přečteno'
        case 'accepted':
            return 'Převzato'
        case 'in_progress':
            return 'Probíhá'
        case 'done':
            return 'Hotovo'
        case 'problem':
            return 'Problém'
        case 'cancelled':
            return 'Zrušeno'
        default:
            return status
    }
}

export default function DashboardToday({
    rooms,
    tasks,
    onAction,
    onCreateTask,
    onUpdateTaskStatus,
    role,
    dayLabel,
    staff,
    onSetAvailability,
    currentUserId,
    currentUserName
}: {
    rooms: RoomPlan[]
    tasks: Task[]
    onAction: (id: string, action: string, payload?: RoomActionPayload) => void
    onCreateTask: (roomId: string, input: CreateTaskInput) => void
    onUpdateTaskStatus: (taskId: string, status: Task['status']) => void
    role: UserRole
    dayLabel: string
    staff: { id: string; name: string; role: UserRole; availability?: 'dnes_pracuji' | 'dnes_nepracuji' | 'jen_urgentni' }[]
    onSetAvailability: (id: string, availability: 'dnes_pracuji' | 'dnes_nepracuji' | 'jen_urgentni') => void
    currentUserId: string
    currentUserName?: string
}) {
    const [expandedRoom, setExpandedRoom] = useState<string | null>(null)
    const [estimatingRoom, setEstimatingRoom] = useState<string | null>(null)
    const [taskPanelRoom, setTaskPanelRoom] = useState<string | null>(null)
    const [selectedQuickTask, setSelectedQuickTask] = useState<string>('')
    const [taskTitle, setTaskTitle] = useState<string>('')
    const [taskCategory, setTaskCategory] = useState<Task['category']>('cleaning')
    const [taskAssignedRole, setTaskAssignedRole] = useState<Extract<UserRole, 'lead' | 'cleaner' | 'maintenance'>>('cleaner')
    const [taskPriority, setTaskPriority] = useState<Task['priority']>('normal')
    const [taskNote, setTaskNote] = useState<string>('')
    const [showStaff, setShowStaff] = useState(false)

    const isCleaningRole = role === 'cleaner' || role === 'lead'
    const canCreateTask = role === 'admin' || role === 'lead'
    const fixedEstimateOptions = ['12:00', '12:15', '12:30', '12:45', '13:00']
    const relativeEstimateOptions = [30, 45, 60]

    function toggleExpandedRoom(roomId: string) {
        setExpandedRoom((prev) => {
            const nextExpanded = prev === roomId ? null : roomId
            if (nextExpanded !== roomId && taskPanelRoom === roomId) {
                setTaskPanelRoom(null)
            }
            if (nextExpanded !== roomId && estimatingRoom === roomId) {
                setEstimatingRoom(null)
            }
            if (nextExpanded === roomId) {
                if (taskPanelRoom && taskPanelRoom !== roomId) setTaskPanelRoom(null)
                if (estimatingRoom && estimatingRoom !== roomId) setEstimatingRoom(null)
            }
            return nextExpanded
        })
    }

    function openTaskPanel(roomId: string) {
        setExpandedRoom(roomId)
        setEstimatingRoom((prev) => (prev === roomId ? null : prev))
        if (taskPanelRoom === roomId) {
            setTaskPanelRoom(null)
            return
        }

        setTaskPanelRoom(roomId)
        setSelectedQuickTask('')
        setTaskTitle('')
        setTaskCategory('cleaning')
        setTaskAssignedRole('cleaner')
        setTaskPriority('normal')
        setTaskNote('')
    }

    function pickQuickTask(label: string, category: Task['category']) {
        setSelectedQuickTask(label)
        setTaskCategory(category)
        if (label === 'Vlastní úkol') {
            setTaskTitle('')
        } else {
            setTaskTitle(label)
        }
    }

    function submitTask(roomId: string) {
        if (!taskTitle.trim()) return

        onCreateTask(roomId, {
            title: taskTitle.trim(),
            category: taskCategory,
            priority: taskPriority,
            assignedToRole: taskAssignedRole,
            note: taskNote.trim() || undefined
        })

        setTaskPanelRoom(null)
        setSelectedQuickTask('')
        setTaskTitle('')
        setTaskCategory('cleaning')
        setTaskAssignedRole('cleaner')
        setTaskPriority('normal')
        setTaskNote('')
    }

    function statusClass(status: RoomPlan['status']) {
        switch (status) {
            case 'ceka':
            case 'problem':
                return 'status-row-red'
            case 'prevzato':
                return 'status-row-blue'
            case 'probihá':
                return 'status-row-orange'
            case 'odhad':
                return 'status-row-purple'
            case 'hotovo':
                return 'status-row-green'
            default:
                return 'status-row-gray'
        }
    }

    function statusLabel(status: RoomPlan['status']) {
        switch (status) {
            case 'ceka':
                return 'Čeká'
            case 'problem':
                return 'Problém'
            case 'prevzato':
                return 'Převzato'
            case 'probihá':
                return 'Probíhá'
            case 'odhad':
                return 'Odhad'
            case 'hotovo':
                return 'Hotovo'
            default:
                return 'Volno'
        }
    }

    function nextArrivalText(room: RoomPlan) {
        if (!room.nextArrivalPreview) return null
        const nextDayLabel = room.nextArrivalPreview.day === 'zitra' ? 'zítra' : 'pozítří'
        return `Další příjezd: ${nextDayLabel} ${room.nextArrivalPreview.time}`
    }

    function availabilityLabel(a?: 'dnes_pracuji' | 'dnes_nepracuji' | 'jen_urgentni') {
        if (a === 'dnes_pracuji') return 'Pracuji dnes'
        if (a === 'dnes_nepracuji') return 'Nepracuji dnes'
        if (a === 'jen_urgentni') return 'Jen urgentní'
        return 'Neurčeno'
    }

    function availabilityColor(a?: 'dnes_pracuji' | 'dnes_nepracuji' | 'jen_urgentni') {
        if (a === 'dnes_pracuji') return '#10b981'
        if (a === 'dnes_nepracuji') return '#94a3b8'
        if (a === 'jen_urgentni') return '#f97316'
        return '#cbd5e1'
    }

    function canEditAvailability(viewerRole: UserRole, viewerId: string, staffMember: any) {
        if (viewerRole === 'admin') return true
        if (viewerRole === 'lead') return staffMember.role === 'cleaner'
        if (viewerRole === 'cleaner') return staffMember.id === viewerId
        if (viewerRole === 'maintenance') return staffMember.id === viewerId
        return false
    }

    function visibleStaff(viewerRole: UserRole, viewerId: string) {
        if (viewerRole === 'admin') return staff
        if (viewerRole === 'lead') return staff.filter(s => s.role === 'cleaner')
        if (viewerRole === 'cleaner') return staff.filter(s => s.id === viewerId)
        if (viewerRole === 'maintenance') return staff.filter(s => s.id === viewerId)
        return []
    }

    function shortNames(names: string[]) {
        if (names.length <= 2) return names.join(', ')
        return `${names.slice(0, 2).join(', ')}…`
    }

    function taskAssigneeHint(roleToAssign: Extract<UserRole, 'lead' | 'cleaner' | 'maintenance'>) {
        const candidates = staff.filter(s => s.role === roleToAssign)
        if (candidates.length === 0) return ''
        const working = candidates.filter(c => c.availability === 'dnes_pracuji')
        if (working.length > 0) return `Dostupní: ${working.map(w => w.name).join(', ')}`
        const urgentOnly = candidates.filter(c => c.availability === 'jen_urgentni')
        if (urgentOnly.length > 0) return `Pouze urgentní: ${urgentOnly.map(w => w.name).join(', ')}`
        return `${candidates.map(c => c.name).join(', ')} dnes nepracuje`
    }

    return (
        <div className="section">
            <h3>Denní plán pokojů</h3>
            <div className="room-meta" style={{ marginBottom: 8, fontSize: 13 }}>{dayLabel}</div>

            <div className="section" style={{ marginBottom: 10 }}>
                <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>Moje dostupnost dnes</div>
                    <div style={{ fontSize: 12, color: '#475569' }}>{/* placeholder for alignment */}</div>
                </h3>
                {/* Personal availability card */}
                {(() => {
                    const me = staff.find(s => s.id === currentUserId)
                    return (
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
                            <div style={{ flex: 1, minWidth: 160 }}>
                                <div style={{ fontWeight: 800 }}>{me?.name || 'Uživatel'}</div>
                                <div style={{ color: '#475569', fontSize: 13 }}>{me ? (me.availability === 'dnes_pracuji' ? 'Jsem: Pracuji dnes' : me.availability === 'jen_urgentni' ? 'Jsem: Jen urgentní' : 'Jsem: Nepracuji dnes') : ''}</div>
                            </div>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                <button className="action-large" style={{ minWidth: 120 }} onClick={() => onSetAvailability(currentUserId, 'dnes_pracuji')}>Pracuji dnes</button>
                                <button className="btn" style={{ minWidth: 120 }} onClick={() => onSetAvailability(currentUserId, 'dnes_nepracuji')}>Nepracuji dnes</button>
                                <button className="btn" style={{ minWidth: 120 }} onClick={() => onSetAvailability(currentUserId, 'jen_urgentni')}>Jen urgentní</button>
                            </div>
                        </div>
                    )
                })()}

                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button className="btn" style={{ padding: '6px 8px' }} onClick={() => setShowStaff(s => !s)}>{showStaff ? 'Skrýt přehled' : 'Zobrazit přehled'}</button>
                </div>
                {showStaff ? (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        {visibleStaff(role, currentUserId).map((s) => (
                            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8, border: '1px solid #e6edf3', borderRadius: 8, minWidth: 140 }}>
                                <div style={{ width: 10, height: 10, borderRadius: 10, background: availabilityColor(s.availability) }} />
                                <div style={{ flex: 1 }}>
                                    <div style={{ fontWeight: 700 }}>{s.name}</div>
                                    <div style={{ fontSize: 12, color: '#475569' }}>{roleLabel(s.role)}</div>
                                </div>
                                <div style={{ fontSize: 12, color: '#475569' }}>{availabilityLabel(s.availability)}</div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div style={{ fontSize: 13, color: '#475569', marginTop: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {(() => {
                            const visible = visibleStaff(role, currentUserId)
                            const working = visible.filter(s => s.availability === 'dnes_pracuji').map(s => s.name)
                            const notWorking = visible.filter(s => s.availability === 'dnes_nepracuji' || s.availability === undefined).map(s => s.name)
                            const urgent = visible.filter(s => s.availability === 'jen_urgentni').map(s => s.name)
                            const parts: string[] = []
                            if (working.length) parts.push(`V práci: ${shortNames(working)}`)
                            if (urgent.length) parts.push(`Urgentní: ${shortNames(urgent)}`)
                            if (notWorking.length) parts.push(`Nepracují: ${shortNames(notWorking)}`)
                            return parts.join(' • ')
                        })()}
                    </div>
                )}
                {showStaff && (
                    <div style={{ marginTop: 8, display: 'flex', gap: 8, flexDirection: 'column' }}>
                        {staff.map((s) => (
                            <div key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                <div style={{ flex: 1 }}>{s.name} • {roleLabel(s.role)}</div>
                                <div style={{ display: 'flex', gap: 6 }}>
                                    <button className="chip" onClick={() => onSetAvailability(s.id, 'dnes_pracuji')} disabled={!canEditAvailability(role, currentUserId, s)}>Pracuji</button>
                                    <button className="chip" onClick={() => onSetAvailability(s.id, 'dnes_nepracuji')} disabled={!canEditAvailability(role, currentUserId, s)}>Nepracuji</button>
                                    <button className="chip" onClick={() => onSetAvailability(s.id, 'jen_urgentni')} disabled={!canEditAvailability(role, currentUserId, s)}>Jen urgentní</button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="daily-table">
                <div className="daily-table-header">
                    <div>Pokoj</div>
                    <div>Odjezd</div>
                    <div>Příjezd</div>
                </div>

                {rooms.map((room, index) => {
                    const isExpanded = expandedRoom === room.id
                    const roomTasks = tasks.filter((t) => t.roomNumber === room.number && canSeeTask(role, t))
                    const activeRoomTasks = roomTasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled')
                    const arrivalPrepTasks = activeRoomTasks.filter((t) => arrivalPreparationTitles.has(t.title))
                    const otherRoomTasks = activeRoomTasks.filter((t) => !arrivalPreparationTitles.has(t.title))
                    const arrivalPrepChips = arrivalPrepChipsFromNotes(room.arrival?.notes)
                    const arrivalDisplay = displayNotesWithoutDuplicateBox(room.arrival?.box, room.arrival?.notes)
                    const departureDisplay = displayNotesWithoutDuplicateBox(undefined, room.departure?.notes)
                    const arrivalPrepChipsDeduped = arrivalPrepChips.filter((chip) => (
                        !arrivalDisplay.notes.some((note) => normalizeForKeywordMatch(note) === normalizeForKeywordMatch(chip))
                    ))

                    return (
                        <div key={room.id} className={`daily-row-wrap ${statusClass(room.status)} ${index % 2 === 0 ? 'row-even' : 'row-odd'}`}>
                            <div className="daily-row">
                                <div className="room-col">
                                    <div className="room-no">{room.number}</div>
                                    <div className="mini-badge">{statusLabel(room.status)}</div>
                                    <button className="room-action-btn" onClick={() => toggleExpandedRoom(room.id)}>{isExpanded ? '×' : '⋯'}</button>
                                    {room.assigned && <div className="mini-muted">{room.assigned}</div>}
                                    {room.checkoutException && (
                                        <div style={{ marginTop: 6, padding: '4px 6px', borderRadius: 8, border: '1px solid #fecaca', background: '#fef2f2' }}>
                                            <div style={{ fontSize: 12, fontWeight: 800, color: '#b91c1c' }}>{room.statusNote || 'Host neodešel'}</div>
                                            <button className="chip" style={{ marginTop: 4, fontSize: 11, padding: '4px 8px' }} onClick={() => onAction(room.id, 'clear_exception')}>Vyřešeno</button>
                                        </div>
                                    )}
                                    {!room.checkoutException && room.statusNote && <div className="mini-muted" style={{ color: '#b45309' }}>{room.statusNote}</div>}
                                </div>

                                <div className={`plan-col ${room.departure ? '' : 'empty-col'}`}>
                                    {room.departure ? (
                                        <>
                                            <div className="plan-time">{room.departure.time}</div>
                                            {(room.departure.guestLabel || room.departure.guestCount) && (
                                                <div className="plan-meta" style={{ color: '#64748b' }}>
                                                    {room.departure.guestLabel || ''}
                                                    {room.departure.guestCount ? `${room.departure.guestLabel ? ' • ' : ''}${room.departure.guestCount}p` : ''}
                                                </div>
                                            )}
                                            {departureDisplay.notes.length > 0 && (
                                                <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                                    {departureDisplay.notes.map((n) => <div key={n} className="note-chip">{n}</div>)}
                                                </div>
                                            )}
                                        </>
                                    ) : (
                                        <div className="plan-empty">—</div>
                                    )}
                                </div>

                                <div className={`plan-col ${room.arrival ? '' : 'empty-col'}`}>
                                    {room.arrival ? (
                                        <>
                                            <div className="plan-time">{room.arrival.time}</div>
                                            {(room.arrival.guestLabel || room.arrival.guestCount) && (
                                                <div className="plan-meta" style={{ color: '#64748b' }}>
                                                    {room.arrival.guestLabel || ''}
                                                    {room.arrival.guestCount ? `${room.arrival.guestLabel ? ' • ' : ''}${room.arrival.guestCount}p` : ''}
                                                </div>
                                            )}
                                            <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                                {arrivalDisplay.box && <div className="note-chip">{arrivalDisplay.box}</div>}
                                                {arrivalDisplay.notes.map(n => <div key={n} className="note-chip">{n}</div>)}
                                                {arrivalPrepChipsDeduped.map((chip) => (
                                                    <div key={`prep-${room.id}-${chip}`} className="note-chip" style={{ border: '1px solid #bfdbfe', background: '#eff6ff' }}>
                                                        {chip}
                                                    </div>
                                                ))}
                                                {arrivalPrepTasks.map((task) => (
                                                    <button
                                                        key={task.id}
                                                        className="note-chip"
                                                        style={{ cursor: 'pointer', border: '1px solid #bfdbfe', background: '#eff6ff' }}
                                                        onClick={() => onUpdateTaskStatus(task.id, 'done')}
                                                        title="Označit jako hotovo"
                                                    >
                                                        {task.title}
                                                    </button>
                                                ))}
                                            </div>
                                            {room.estimatedReady && (
                                                <div className="plan-ready">
                                                    Odhad: {room.estimatedReady}
                                                    {room.estimateSetAt ? ` (zadán v ${room.estimateSetAt})` : ''}
                                                </div>
                                            )}
                                        </>
                                    ) : (
                                        <>
                                            <div className="plan-empty">—</div>
                                            {room.estimatedReady && (
                                                <div className="plan-ready">
                                                    Odhad: {room.estimatedReady}
                                                    {room.estimateSetAt ? ` (zadán v ${room.estimateSetAt})` : ''}
                                                </div>
                                            )}
                                            {room.situation === 'odjezd' && nextArrivalText(room) && (
                                                <div className="plan-preview">{nextArrivalText(room)}</div>
                                            )}
                                        </>
                                    )}
                                </div>
                            </div>

                            {otherRoomTasks.length > 0 && (
                                <div style={{ padding: '8px 10px', borderTop: '1px solid rgba(15,23,42,0.06)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    {otherRoomTasks.map((task) => (
                                        <div
                                            key={task.id}
                                            style={{
                                                border: task.priority === 'urgent' ? '1px solid rgba(239,68,68,0.4)' : '1px solid rgba(148,163,184,0.35)',
                                                background: task.priority === 'urgent' ? 'rgba(254,242,242,0.8)' : 'rgba(248,250,252,0.85)',
                                                borderRadius: 8,
                                                padding: '6px 8px',
                                                fontSize: 12
                                            }}
                                        >
                                            <div style={{ fontWeight: 700 }}>{task.title}</div>
                                            <div style={{ color: '#475569' }}>
                                                {roleLabel(task.assignedToRole)} • {task.priority === 'urgent' ? 'Urgentní' : 'Normální'} • {taskStatusLabel(task.status)}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {isExpanded && (
                                <div className="expanded-actions">
                                    <button className={isCleaningRole ? 'action-large' : 'chip'} onClick={() => onAction(room.id, 'prevzit')}>Převzít</button>
                                    <button
                                        className={isCleaningRole ? 'action-large' : 'chip'}
                                        onClick={() => setEstimatingRoom(estimatingRoom === room.id ? null : room.id)}
                                    >
                                        Odhad
                                    </button>
                                    <button
                                        className={isCleaningRole ? 'action-large' : 'chip'}
                                        onClick={() => {
                                            onAction(room.id, 'hotovo')
                                            setExpandedRoom(null)
                                            setEstimatingRoom(null)
                                        }}
                                    >
                                        Hotovo
                                    </button>
                                    <button className={isCleaningRole ? 'action-large' : 'chip'} style={isCleaningRole ? { background: '#ef4444' } : {}} onClick={() => onAction(room.id, 'problem')}>Problém</button>
                                    {canCreateTask && <button className="chip" onClick={() => openTaskPanel(room.id)}>Přidat úkol</button>}

                                    <div style={{ width: '100%', marginTop: 8, paddingTop: 8, borderTop: '1px dashed rgba(148,163,184,0.6)' }}>
                                        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>Výjimky</div>
                                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                                            <button className="action-secondary" onClick={() => onAction(room.id, 'host_zustava')}>Host neodešel</button>
                                            {room.checkoutException && <button className="chip" onClick={() => onAction(room.id, 'clear_exception')}>Vyřešeno</button>}
                                            <div style={{ fontSize: 12, color: '#64748b' }}>Push notifikace pro admin zde doplníme po backend integraci.</div>
                                        </div>
                                    </div>

                                    {estimatingRoom === room.id && (
                                        <div style={{ width: '100%', display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                                            {fixedEstimateOptions.map((time) => (
                                                <button
                                                    key={time}
                                                    className="chip"
                                                    onClick={() => {
                                                        onAction(room.id, 'odhad', { estimateTime: time })
                                                        setEstimatingRoom(null)
                                                    }}
                                                >
                                                    {time}
                                                </button>
                                            ))}
                                            {relativeEstimateOptions.map((mins) => (
                                                <button
                                                    key={mins}
                                                    className="chip"
                                                    onClick={() => {
                                                        onAction(room.id, 'odhad', { relativeMinutes: mins })
                                                        setEstimatingRoom(null)
                                                    }}
                                                >
                                                    +{mins} min
                                                </button>
                                            ))}
                                        </div>
                                    )}

                                    {taskPanelRoom === room.id && (
                                        <div style={{ width: '100%', marginTop: 8, padding: 10, border: '1px solid rgba(148,163,184,0.35)', borderRadius: 10, background: 'rgba(248,250,252,0.9)' }}>
                                            <div style={{ fontWeight: 800, marginBottom: 8 }}>Nový úkol pro pokoj {room.number}</div>
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                                                {quickTaskOptions.map((option) => (
                                                    <button
                                                        key={option.label}
                                                        className="chip"
                                                        style={selectedQuickTask === option.label ? { background: '#dbeafe' } : {}}
                                                        onClick={() => pickQuickTask(option.label, option.category)}
                                                    >
                                                        {option.label}
                                                    </button>
                                                ))}
                                            </div>

                                            {selectedQuickTask === 'Vlastní úkol' && (
                                                <input
                                                    value={taskTitle}
                                                    onChange={(e) => setTaskTitle(e.target.value)}
                                                    placeholder="Název úkolu"
                                                    style={{ width: '100%', marginBottom: 8, minHeight: 38, borderRadius: 8, border: '1px solid #cbd5e1', padding: '8px 10px' }}
                                                />
                                            )}

                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                                                <label style={{ fontSize: 12 }}>
                                                    Komu
                                                    <select
                                                        value={taskAssignedRole}
                                                        onChange={(e) => setTaskAssignedRole(e.target.value as Extract<UserRole, 'lead' | 'cleaner' | 'maintenance'>)}
                                                        style={{ width: '100%', marginTop: 4, minHeight: 36, borderRadius: 8, border: '1px solid #cbd5e1' }}
                                                    >
                                                        <option value="cleaner">Úklid</option>
                                                        <option value="maintenance">Údržba</option>
                                                        <option value="lead">Iryna</option>
                                                    </select>
                                                </label>
                                                <label style={{ fontSize: 12 }}>
                                                    Priorita
                                                    <select
                                                        value={taskPriority}
                                                        onChange={(e) => setTaskPriority(e.target.value as Task['priority'])}
                                                        style={{ width: '100%', marginTop: 4, minHeight: 36, borderRadius: 8, border: '1px solid #cbd5e1' }}
                                                    >
                                                        <option value="normal">Normální</option>
                                                        <option value="urgent">Urgentní</option>
                                                    </select>
                                                </label>
                                            </div>

                                            <div style={{ fontSize: 13, color: '#334155', marginTop: 8 }}>{taskAssigneeHint(taskAssignedRole)}</div>

                                            <textarea
                                                value={taskNote}
                                                onChange={(e) => setTaskNote(e.target.value)}
                                                placeholder="Poznámka (volitelné)"
                                                style={{ width: '100%', marginTop: 8, minHeight: 64, borderRadius: 8, border: '1px solid #cbd5e1', padding: '8px 10px', resize: 'vertical' }}
                                            />

                                            <button
                                                className="action-large"
                                                style={{ width: '100%', marginTop: 8 }}
                                                onClick={() => submitTask(room.id)}
                                                disabled={!taskTitle.trim()}
                                            >
                                                Vytvořit úkol
                                            </button>
                                        </div>
                                    )}

                                    {activeRoomTasks.length > 0 && (
                                        <div style={{ width: '100%', marginTop: 8, padding: 10, border: '1px solid rgba(148,163,184,0.35)', borderRadius: 10, background: 'rgba(255,255,255,0.9)' }}>
                                            <div style={{ fontWeight: 800, marginBottom: 8 }}>Aktivní úkoly pokoje</div>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                                {activeRoomTasks.map((task) => {
                                                    const canDelete = canDeleteTask(role, currentUserId, currentUserName, task)
                                                    return (
                                                        <div key={`active-task-${room.id}-${task.id}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, border: '1px solid #e2e8f0', borderRadius: 8, padding: '6px 8px' }}>
                                                            <div>
                                                                <div style={{ fontWeight: 700 }}>{task.title}</div>
                                                                <div style={{ color: '#475569', fontSize: 12 }}>{roleLabel(task.assignedToRole)} • {task.priority === 'urgent' ? 'Urgentní' : 'Normální'}</div>
                                                            </div>
                                                            {canDelete && (
                                                                <button
                                                                    className="chip"
                                                                    style={{ borderColor: '#fecaca', color: '#b91c1c', background: '#fff1f2' }}
                                                                    onClick={() => onUpdateTaskStatus(task.id, 'cancelled')}
                                                                    title="Smazat úkol"
                                                                >
                                                                    Smazat
                                                                </button>
                                                            )}
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
