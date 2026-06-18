import React, { useEffect, useMemo, useState } from 'react'
import { MaintenanceItem, RoomPlan, Task, UserRole } from '../types'
import OriginBadge from '../components/OriginBadge'
import { isAdminRole, isCleanerRole, isCleaningLeadRole, isCleaningStaffRole, isMaintenanceRole, roleLabel } from '../lib/roles'

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

type ReportRoomProblemInput = {
    description: string
    priority: Task['priority']
}

type LateTaskRoomFocusRequest = {
    requestId: number
    roomNumber: string
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
    if (isAdminRole(role)) return true
    if (isCleaningLeadRole(role)) return task.category === 'cleaning' || task.assignedToRole === 'lead' || task.assignedToRole === 'cleaner'
    if (isCleanerRole(role)) return task.category === 'cleaning' || task.assignedToRole === 'cleaner'
    if (isMaintenanceRole(role)) return task.assignedToRole === 'maintenance'
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
    if (isAdminRole(role)) return true
    if (isCleaningLeadRole(role)) return task.category === 'cleaning' || task.assignedToRole === 'lead' || task.assignedToRole === 'cleaner'
    if (isCleanerRole(role)) {
        if (!task.createdBy) return false
        const creator = normalizeIdentity(task.createdBy)
        const userId = normalizeIdentity(currentUserId)
        const userName = normalizeIdentity(currentUserName)
        return creator === userId || (!!userName && creator === userName)
    }
    return false
}

function normalizeRoomNumber(value?: string) {
    if (!value) return ''
    const trimmed = value.trim()
    const match = trimmed.match(/\b(\d{3})\b/)
    if (match) return match[1]

    const digits = trimmed.replace(/\D/g, '')
    if (digits.length >= 3) return digits.slice(-3)
    return trimmed
}

function getVisibleRoomProblemNote(room: RoomPlan, maintenanceItems: MaintenanceItem[]) {
    if (room.checkoutException) {
        return room.statusNote?.trim() || 'Host neodešel'
    }

    const roomStatusNote = room.statusNote?.trim()
    if (!roomStatusNote) return null

    const normalizedRoomNumber = normalizeRoomNumber(room.number)
    const normalizedRoomNote = normalizeIdentity(roomStatusNote)
    const hasActiveRoomIssue = maintenanceItems.some((item) => (
        item.category === 'room_issue'
        && item.status !== 'done'
        && item.status !== 'cancelled'
        && normalizeRoomNumber(item.roomNumber) === normalizedRoomNumber
        && normalizeIdentity(item.title) === normalizedRoomNote
    ))

    return hasActiveRoomIssue ? roomStatusNote : null
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

function getTaskDetailText(task: Task) {
    return task.note?.trim() || ''
}

export default function DashboardToday({
    rooms,
    tasks,
    onAction,
    onCreateTask,
    onUpdateTaskStatus,
    onCancelTask,
    onAcknowledgeLateTasks,
    onReportProblem,
    role,
    dayLabel,
    currentUserId,
    currentUserName,
    staff,
    maintenanceItems,
    focusLateTaskRoomRequest,
    onFocusLateTaskRoomResult,
    readOnly
}: {
    rooms: RoomPlan[]
    tasks: Task[]
    onAction: (id: string, action: string, payload?: RoomActionPayload) => void
    onCreateTask: (roomId: string, input: CreateTaskInput) => void
    onUpdateTaskStatus: (taskId: string, status: Task['status']) => void
    onCancelTask: (taskId: string) => void
    onAcknowledgeLateTasks: (roomNumber: string) => void
    onReportProblem: (roomId: string, input: ReportRoomProblemInput) => void
    role: UserRole
    dayLabel: string
    currentUserId: string
    currentUserName?: string
    staff: Array<{ id: string; name: string; role: UserRole; availability?: 'dnes_pracuji' | 'dnes_nepracuji' | 'jen_urgentni' }>
    maintenanceItems: MaintenanceItem[]
    focusLateTaskRoomRequest?: LateTaskRoomFocusRequest | null
    onFocusLateTaskRoomResult?: (result: { requestId: number; roomNumber: string; found: boolean }) => void
    readOnly?: boolean
}) {
    const [expandedRoom, setExpandedRoom] = useState<string | null>(null)
    const [estimatingRoom, setEstimatingRoom] = useState<string | null>(null)
    const [taskPanelRoom, setTaskPanelRoom] = useState<string | null>(null)
    const [selectedQuickTask, setSelectedQuickTask] = useState<string>('')
    const [taskTitle, setTaskTitle] = useState<string>('')
    const [taskCategory, setTaskCategory] = useState<Task['category']>('cleaning')
    const [taskAssignedRole, setTaskAssignedRole] = useState<Extract<UserRole, 'lead' | 'cleaner' | 'maintenance'>>('cleaner')
    const [taskPriority, setTaskPriority] = useState<Task['priority']>('normal')
    const [taskFormError, setTaskFormError] = useState<string | null>(null)
    const [problemPanelRoom, setProblemPanelRoom] = useState<string | null>(null)
    const [problemText, setProblemText] = useState<string>('')
    const [problemPriority, setProblemPriority] = useState<Task['priority']>('normal')
    const [problemFormError, setProblemFormError] = useState<string | null>(null)
    const [highlightedRoomId, setHighlightedRoomId] = useState<string | null>(null)
    const isCleaningRole = isCleaningStaffRole(role)
    const canCreateTask = isAdminRole(role) || isCleaningLeadRole(role)
    const fixedEstimateOptions = ['12:00', '12:15', '12:30', '12:45', '13:00']
    const relativeEstimateOptions = [30, 45, 60]

    useEffect(() => {
        if (!focusLateTaskRoomRequest) return

        const targetRoom = rooms.find((room) => room.number === focusLateTaskRoomRequest.roomNumber)
        if (!targetRoom) {
            onFocusLateTaskRoomResult?.({
                requestId: focusLateTaskRoomRequest.requestId,
                roomNumber: focusLateTaskRoomRequest.roomNumber,
                found: false
            })
            return
        }

        setExpandedRoom(targetRoom.id)
        setEstimatingRoom(null)
        setTaskPanelRoom(null)
        setProblemPanelRoom(null)

        const frameId = window.requestAnimationFrame(() => {
            const roomElement = document.querySelector(`[data-room-id="${targetRoom.id}"]`) as HTMLElement | null
            if (!roomElement) {
                onFocusLateTaskRoomResult?.({
                    requestId: focusLateTaskRoomRequest.requestId,
                    roomNumber: focusLateTaskRoomRequest.roomNumber,
                    found: false
                })
                return
            }

            roomElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
            setHighlightedRoomId(targetRoom.id)
            window.setTimeout(() => setHighlightedRoomId((prev) => (prev === targetRoom.id ? null : prev)), 2600)

            onFocusLateTaskRoomResult?.({
                requestId: focusLateTaskRoomRequest.requestId,
                roomNumber: focusLateTaskRoomRequest.roomNumber,
                found: true
            })
        })

        return () => {
            window.cancelAnimationFrame(frameId)
        }
    }, [focusLateTaskRoomRequest, rooms])

    function toggleExpandedRoom(roomId: string) {
        setExpandedRoom((prev) => {
            const nextExpanded = prev === roomId ? null : roomId
            if (nextExpanded !== roomId && taskPanelRoom === roomId) {
                setTaskPanelRoom(null)
            }
            if (nextExpanded !== roomId && estimatingRoom === roomId) {
                setEstimatingRoom(null)
            }
            if (nextExpanded !== roomId && problemPanelRoom === roomId) {
                setProblemPanelRoom(null)
            }
            if (nextExpanded === roomId) {
                if (taskPanelRoom && taskPanelRoom !== roomId) setTaskPanelRoom(null)
                if (estimatingRoom && estimatingRoom !== roomId) setEstimatingRoom(null)
                if (problemPanelRoom && problemPanelRoom !== roomId) setProblemPanelRoom(null)
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
        setTaskFormError(null)
        if (problemPanelRoom === roomId) {
            setProblemPanelRoom(null)
        }
    }

    function pickQuickTask(label: string, category: Task['category']) {
        setSelectedQuickTask(label)
        setTaskCategory(category)
        setTaskTitle('')
        setTaskFormError(null)
    }

    function submitTask(roomId: string) {
        if (readOnly) return
        const isQuickTask = Boolean(selectedQuickTask && selectedQuickTask !== 'Vlastní úkol')
        const textValue = taskTitle.trim()
        const effectiveTaskTitle = isQuickTask ? selectedQuickTask.trim() : textValue
        const effectiveTaskNote = isQuickTask ? textValue : undefined

        if (!effectiveTaskTitle) {
            setTaskFormError('Napište, co je potřeba udělat.')
            return
        }

        try {
            onCreateTask(roomId, {
                title: effectiveTaskTitle,
                category: taskCategory,
                priority: taskPriority,
                assignedToRole: taskAssignedRole,
                note: effectiveTaskNote || undefined
            })

            setTaskPanelRoom(null)
            setSelectedQuickTask('')
            setTaskTitle('')
            setTaskCategory('cleaning')
            setTaskAssignedRole('cleaner')
            setTaskPriority('normal')
            setTaskFormError(null)
        } catch (error: any) {
            console.error('[task-create] save failed', error)
            setTaskFormError(error?.message || 'Úkol se nepodařilo uložit. Zkuste to prosím znovu.')
        }
    }

    function openProblemPanel(roomId: string) {
        setExpandedRoom(roomId)
        setTaskPanelRoom((prev) => (prev === roomId ? null : prev))
        setEstimatingRoom((prev) => (prev === roomId ? null : prev))
        if (problemPanelRoom === roomId) {
            setProblemPanelRoom(null)
            return
        }

        setProblemPanelRoom(roomId)
        setProblemText('')
        setProblemPriority('normal')
        setProblemFormError(null)
    }

    function submitProblem(roomId: string) {
        if (readOnly) return
        if (!problemText.trim()) {
            setProblemFormError('Popište problém.')
            return
        }

        try {
            onReportProblem(roomId, {
                description: problemText.trim(),
                priority: problemPriority
            })
            setProblemPanelRoom(null)
            setProblemText('')
            setProblemPriority('normal')
            setProblemFormError(null)
        } catch (error: any) {
            console.error('[problem-report] save failed', error)
            setProblemFormError(error?.message || 'Problém se nepodařilo uložit. Zkuste to prosím znovu.')
        }
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

    function taskAssigneeHint(roleToAssign: Extract<UserRole, 'lead' | 'cleaner' | 'maintenance'>) {
        const candidates = staff.filter(s => s.role === roleToAssign)
        if (candidates.length === 0) return ''
        const working = candidates.filter(c => c.availability === 'dnes_pracuji')
        if (working.length > 0) return `Dostupní: ${working.map(w => w.name).join(', ')}`
        const urgentOnly = candidates.filter(c => c.availability === 'jen_urgentni')
        if (urgentOnly.length > 0) return `Pouze urgentní: ${urgentOnly.map(w => w.name).join(', ')}`
        return `${candidates.map(c => c.name).join(', ')} dnes nepracuje`
    }

    function isStateOnlyRoom(room: RoomPlan) {
        const hasTurnover = Boolean(room.departureTime || room.arrivalTime)
        return !hasTurnover && (room.occupiedConfirmed || room.freeConfirmed)
    }

    const dailySummary = useMemo(() => {
        return rooms.reduce((summary, room) => {
            const hasDeparture = Boolean(room.departureTime || room.departure?.time || room.departure?.guestLabel)
            const hasArrival = Boolean(room.arrivalTime || room.arrival?.time || room.arrival?.guestLabel)
            const hasTurnover = hasDeparture || hasArrival

            const occupied = Boolean(
                room.occupiedConfirmed
                || (!hasTurnover && Boolean(room.stayoverGuestName))
            )

            const free = Boolean(
                room.freeConfirmed
                || (!hasTurnover && !occupied)
            )

            if (hasDeparture) summary.departures += 1
            if (hasArrival) summary.arrivals += 1
            if (occupied) summary.occupied += 1
            if (free) summary.free += 1

            return summary
        }, {
            departures: 0,
            arrivals: 0,
            occupied: 0,
            free: 0
        })
    }, [rooms])

    const dayLabelDisplay = dayLabel.replace(' • ', ' · ')

    return (
        <div className="section">
            <div className="selected-date-block">
                <div className="selected-date-main">{dayLabelDisplay}</div>
            </div>
            {readOnly && <div className="room-meta" style={{ marginBottom: 8, color: '#0c4a6e', fontWeight: 700 }}>Náhled importovaného dne mimo Dnes/Zítra/Pozítří je pouze pro čtení.</div>}

            <div className="daily-table">
                <div className="daily-summary" aria-label="Denní souhrn pokojů">
                    <div className="daily-summary-chip summary-departures"><span className="daily-summary-label">Odjezdy</span><strong className="daily-summary-value">{dailySummary.departures}</strong></div>
                    <div className="daily-summary-chip summary-arrivals"><span className="daily-summary-label">Příjezdy</span><strong className="daily-summary-value">{dailySummary.arrivals}</strong></div>
                    <div className="daily-summary-chip summary-occupied"><span className="daily-summary-label">Obsazené</span><strong className="daily-summary-value">{dailySummary.occupied}</strong></div>
                    <div className="daily-summary-chip summary-free"><span className="daily-summary-label">Volné</span><strong className="daily-summary-value">{dailySummary.free}</strong></div>
                </div>
                <div className="daily-table-header">
                    <div>Pokoj</div>
                    <div>Odjezd</div>
                    <div>Příjezd</div>
                </div>

                {rooms.map((room, index) => {
                    const isExpanded = expandedRoom === room.id
                    const isProblemPanelOpen = problemPanelRoom === room.id
                    const stateOnlyRoom = isStateOnlyRoom(room)
                    const workflowDisabled = readOnly || stateOnlyRoom
                    const taskAndProblemDisabled = readOnly
                    const roomTasks = tasks.filter((t) => t.roomNumber === room.number && canSeeTask(role, t))
                    const activeRoomTasks = roomTasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled')
                    const arrivalPrepTasks = activeRoomTasks.filter((t) => arrivalPreparationTitles.has(t.title))
                    const lateAttentionTasks = activeRoomTasks.filter((task) => (
                        task.attentionRequired
                        && task.attentionReason === 'late_today_room_task'
                        && task.status !== 'read'
                        && task.status !== 'done'
                        && task.status !== 'cancelled'
                    ))
                    const hasLateTaskAlert = lateAttentionTasks.length > 0
                    const arrivalPrepChips = arrivalPrepChipsFromNotes(room.arrival?.notes)
                    const arrivalDisplay = displayNotesWithoutDuplicateBox(room.arrival?.box, room.arrival?.notes)
                    const departureDisplay = displayNotesWithoutDuplicateBox(undefined, room.departure?.notes)
                    const arrivalPrepChipsDeduped = arrivalPrepChips.filter((chip) => (
                        !arrivalDisplay.notes.some((note) => normalizeForKeywordMatch(note) === normalizeForKeywordMatch(chip))
                    ))
                    const roomOrigin = {
                        source: room.source,
                        stateSource: room.stateSource,
                        createdByUid: room.createdByUid,
                        createdByName: room.createdByName,
                        createdByRole: room.createdByRole,
                        importJobId: room.importJobId,
                        importedAt: room.importedAt || room.stateImportedAt
                    }
                    const visibleRoomProblemNote = getVisibleRoomProblemNote(room, maintenanceItems)
                    const displayStatus = !room.checkoutException && !visibleRoomProblemNote && room.status === 'problem'
                        ? 'ceka'
                        : room.status
                    const stateRowClass = room.occupiedConfirmed
                        ? 'status-row-stayover'
                        : room.freeConfirmed
                            ? 'status-row-free'
                            : statusClass(displayStatus)

                    return (
                        <div
                            key={room.id}
                            data-room-id={room.id}
                            data-room-number={room.number}
                            className={`daily-row-wrap ${stateRowClass} ${index % 2 === 0 ? 'row-even' : 'row-odd'}${highlightedRoomId === room.id ? ' late-room-focus-highlight' : ''}`}
                        >
                            <div className="daily-row">
                                <div className="room-col">
                                    <div className="room-no">{room.number}</div>
                                    {room.occupiedConfirmed ? (
                                        <div className="mini-badge mini-badge-stayover">Obsazeno / pobyt</div>
                                    ) : room.freeConfirmed ? (
                                        <div className="mini-badge mini-badge-free">Potvrzeně volný</div>
                                    ) : (
                                        <div className="mini-badge">{statusLabel(displayStatus)}</div>
                                    )}
                                    <button className="room-action-btn" onClick={() => toggleExpandedRoom(room.id)}>{isExpanded ? '×' : '⋯'}</button>
                                    {room.assigned && <div className="mini-muted">{room.assigned}</div>}
                                    {room.occupiedConfirmed && room.stayoverGuestName && <div className="mini-muted mini-muted-stayover">{room.stayoverGuestName}</div>}
                                    {room.freeConfirmed && <div className="mini-muted mini-muted-free">Pokoj je dostupný při volné kapacitě.</div>}
                                    {hasLateTaskAlert && (
                                        <div style={{ marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: '#9a3412', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 999, padding: '2px 8px' }}>
                                            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#f97316', display: 'inline-block' }} />
                                            Nový úkol{lateAttentionTasks.length > 1 ? ` (${lateAttentionTasks.length})` : ''}
                                        </div>
                                    )}
                                    {room.checkoutException && (
                                        <div style={{ marginTop: 6, padding: '4px 6px', borderRadius: 8, border: '1px solid #fecaca', background: '#fef2f2' }}>
                                            <div style={{ fontSize: 12, fontWeight: 800, color: '#b91c1c', display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                                {visibleRoomProblemNote || 'Host neodešel'}
                                                <OriginBadge input={roomOrigin} />
                                            </div>
                                            <button className="chip" style={{ marginTop: 4, fontSize: 11, padding: '4px 8px' }} onClick={() => onAction(room.id, 'clear_exception')} disabled={readOnly || stateOnlyRoom}>Vyřešeno</button>
                                        </div>
                                    )}
                                    {!room.checkoutException && visibleRoomProblemNote && (
                                        <div className="mini-muted" style={{ color: '#b45309', display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                            {visibleRoomProblemNote}
                                            <OriginBadge input={roomOrigin} />
                                        </div>
                                    )}
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
                                                    {departureDisplay.notes.map((n) => (
                                                        <div key={n} className="note-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                                            <span>{n}</span>
                                                            <OriginBadge input={roomOrigin} context="previo-note" />
                                                        </div>
                                                    ))}
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
                                                {arrivalDisplay.box && (
                                                    <div className="note-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                                        <span>{arrivalDisplay.box}</span>
                                                        <OriginBadge input={roomOrigin} context="box-chip" />
                                                    </div>
                                                )}
                                                {arrivalDisplay.notes.map(n => (
                                                    <div key={n} className="note-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                                        <span>{n}</span>
                                                        <OriginBadge input={roomOrigin} context="previo-note" />
                                                    </div>
                                                ))}
                                                {arrivalPrepChipsDeduped.map((chip) => (
                                                    <div key={`prep-${room.id}-${chip}`} className="note-chip" style={{ border: '1px solid #bfdbfe', background: '#eff6ff', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                                        <span>{chip}</span>
                                                        <OriginBadge input={roomOrigin} context="previo-note" />
                                                    </div>
                                                ))}
                                                {arrivalPrepTasks.map((task) => (
                                                    <button
                                                        key={task.id}
                                                        className="note-chip"
                                                        style={{ cursor: 'pointer', border: '1px solid #bfdbfe', background: '#eff6ff' }}
                                                        onClick={() => !readOnly && onUpdateTaskStatus(task.id, 'done')}
                                                        title="Označit jako hotovo"
                                                        disabled={readOnly}
                                                    >
                                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                                            <span>{task.title || 'Bez názvu úkolu'}</span>
                                                            <OriginBadge
                                                                input={{
                                                                    source: task.source,
                                                                    createdByUid: task.createdByUid,
                                                                    createdByName: task.createdByName,
                                                                    createdByRole: task.createdByRole,
                                                                    createdBy: task.createdBy
                                                                }}
                                                            />
                                                        </span>
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

                            {isExpanded && (
                                <div className="expanded-actions">
                                    {hasLateTaskAlert && (
                                        <div style={{ width: '100%', border: '1px solid #fb923c', background: '#fff7ed', borderRadius: 10, padding: 8, marginBottom: 4, display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                            <div style={{ fontSize: 13, fontWeight: 800, color: '#9a3412' }}>
                                                Nový úkol po kontrole{lateAttentionTasks.length > 1 ? ` (${lateAttentionTasks.length})` : ''}
                                            </div>
                                            <button
                                                className="chip"
                                                style={{ borderColor: '#fdba74', color: '#9a3412', background: '#ffedd5' }}
                                                onClick={() => !readOnly && onAcknowledgeLateTasks(room.number)}
                                                disabled={readOnly}
                                            >
                                                Přečteno
                                            </button>
                                        </div>
                                    )}
                                    <button className={isCleaningRole ? 'action-large' : 'chip'} disabled={workflowDisabled} onClick={() => onAction(room.id, 'prevzit')}>Převzít</button>
                                    <button
                                        className={isCleaningRole ? 'action-large' : 'chip'}
                                        disabled={workflowDisabled}
                                        onClick={() => setEstimatingRoom(estimatingRoom === room.id ? null : room.id)}
                                    >
                                        Odhad
                                    </button>
                                    <button
                                        className={isCleaningRole ? 'action-large' : 'chip'}
                                        disabled={workflowDisabled}
                                        onClick={() => {
                                            onAction(room.id, 'hotovo')
                                            setExpandedRoom(null)
                                            setEstimatingRoom(null)
                                        }}
                                    >
                                        Hotovo
                                    </button>
                                    <button className={isCleaningRole ? 'action-large' : 'chip'} disabled={taskAndProblemDisabled} style={isCleaningRole ? { background: '#ef4444' } : {}} onClick={() => openProblemPanel(room.id)}>Problém</button>
                                    {canCreateTask && <button className="chip" disabled={taskAndProblemDisabled} onClick={() => openTaskPanel(room.id)}>Přidat úkol</button>}

                                    <div style={{ width: '100%', marginTop: 8, paddingTop: 8, borderTop: '1px dashed rgba(148,163,184,0.6)' }}>
                                        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>Výjimky</div>
                                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                                            <button className="action-secondary" disabled={workflowDisabled} onClick={() => onAction(room.id, 'host_zustava')}>Host neodešel</button>
                                            {room.checkoutException && <button className="chip" disabled={workflowDisabled} onClick={() => onAction(room.id, 'clear_exception')}>Vyřešeno</button>}
                                            {/* TODO: Push notifications for admin to be added after backend integration. Not shown to users. */}
                                        </div>
                                    </div>

                                    {estimatingRoom === room.id && (
                                        <div style={{ width: '100%', display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                                            {fixedEstimateOptions.map((time) => (
                                                <button
                                                    key={time}
                                                    className="chip"
                                                    disabled={workflowDisabled}
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
                                                    disabled={workflowDisabled}
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

                                            <textarea
                                                value={taskTitle}
                                                onChange={(e) => {
                                                    setTaskTitle(e.target.value)
                                                    if (taskFormError) setTaskFormError(null)
                                                }}
                                                placeholder={selectedQuickTask && selectedQuickTask !== 'Vlastní úkol' ? 'Poznámka k úkolu (volitelné)' : 'Napište úkol'}
                                                style={{ width: '100%', marginBottom: 8, minHeight: 72, borderRadius: 8, border: '1px solid #cbd5e1', padding: '8px 10px', resize: 'vertical', background: '#fff' }}
                                            />

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

                                            {taskFormError && (
                                                <div style={{ marginTop: 8, fontSize: 12, color: '#b91c1c', fontWeight: 700 }}>{taskFormError}</div>
                                            )}

                                            <button
                                                className="action-large"
                                                style={{ width: '100%', marginTop: 8 }}
                                                onClick={() => submitTask(room.id)}
                                            >
                                                Vytvořit úkol
                                            </button>
                                        </div>
                                    )}

                                    {isProblemPanelOpen && (
                                        <div style={{ width: '100%', marginTop: 8, padding: 10, border: '1px solid rgba(248,113,113,0.5)', borderRadius: 10, background: 'rgba(254,242,242,0.9)' }}>
                                            <div style={{ fontWeight: 800, marginBottom: 8, color: '#991b1b' }}>Nahlásit problém</div>
                                            <div style={{ fontSize: 12, color: '#7f1d1d', marginBottom: 8 }}>Pokoj {room.number}</div>

                                            <textarea
                                                value={problemText}
                                                onChange={(e) => {
                                                    setProblemText(e.target.value)
                                                    if (problemFormError) setProblemFormError(null)
                                                }}
                                                placeholder="Popište problém"
                                                style={{ width: '100%', minHeight: 72, borderRadius: 8, border: '1px solid #fca5a5', padding: '8px 10px', resize: 'vertical', background: '#fff' }}
                                            />

                                            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                                                <button
                                                    className="btn"
                                                    style={problemPriority === 'normal' ? { borderColor: '#fca5a5', background: '#fee2e2', color: '#7f1d1d' } : {}}
                                                    onClick={() => setProblemPriority('normal')}
                                                >
                                                    Normální
                                                </button>
                                                <button
                                                    className="btn"
                                                    style={problemPriority === 'urgent' ? { borderColor: '#fca5a5', background: '#fee2e2', color: '#7f1d1d' } : {}}
                                                    onClick={() => setProblemPriority('urgent')}
                                                >
                                                    Urgentní
                                                </button>
                                            </div>

                                            {problemFormError && (
                                                <div style={{ marginTop: 8, fontSize: 12, color: '#b91c1c', fontWeight: 700 }}>{problemFormError}</div>
                                            )}

                                            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                                                <button className="action-large" style={{ background: '#dc2626' }} onClick={() => submitProblem(room.id)}>Uložit</button>
                                                <button className="btn" onClick={() => setProblemPanelRoom(null)}>Zrušit</button>
                                            </div>
                                        </div>
                                    )}

                                    {activeRoomTasks.length > 0 && (
                                        <div style={{ width: '100%', marginTop: 8, padding: 10, border: '1px solid rgba(148,163,184,0.35)', borderRadius: 10, background: 'rgba(255,255,255,0.9)' }}>
                                            <div style={{ fontWeight: 800, marginBottom: 8 }}>Aktivní úkoly pokoje</div>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                                {activeRoomTasks.map((task) => {
                                                    const canDelete = canDeleteTask(role, currentUserId, currentUserName, task)
                                                    const taskDetail = getTaskDetailText(task)
                                                    return (
                                                        <div key={`active-task-${room.id}-${task.id}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, border: '1px solid #e2e8f0', borderRadius: 8, padding: '6px 8px' }}>
                                                            <div>
                                                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                                                    <div style={{ fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                                                        {task.title || 'Bez názvu úkolu'}
                                                                        <OriginBadge
                                                                            input={{
                                                                                source: task.source,
                                                                                createdByUid: task.createdByUid,
                                                                                createdByName: task.createdByName,
                                                                                createdByRole: task.createdByRole,
                                                                                createdBy: task.createdBy
                                                                            }}
                                                                        />
                                                                    </div>
                                                                    {task.attentionRequired && task.attentionReason === 'late_today_room_task' && task.status === 'new' && (
                                                                        <span style={{ fontSize: 10, fontWeight: 700, color: '#7c2d12', border: '1px solid #fed7aa', background: '#fff7ed', borderRadius: 999, padding: '1px 6px' }}>
                                                                            Nové
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                <div style={{ color: '#475569', fontSize: 12 }}>
                                                                    {roleLabel((task.assignedToRole || 'cleaner') as UserRole)} • {task.priority === 'urgent' ? 'Urgentní' : 'Normální'} • {taskStatusLabel(task.status)}
                                                                </div>
                                                                {taskDetail && (
                                                                    <div style={{ marginTop: 4, color: '#334155', fontSize: 13, lineHeight: 1.35 }}>
                                                                        {taskDetail}
                                                                    </div>
                                                                )}
                                                            </div>
                                                            {canDelete && (
                                                                <button
                                                                    type="button"
                                                                    className="chip"
                                                                    style={{ borderColor: '#fecaca', color: '#b91c1c', background: '#fff1f2', position: 'relative', zIndex: 1, pointerEvents: 'auto', flexShrink: 0 }}
                                                                    onClick={(event) => {
                                                                        event.preventDefault()
                                                                        if (readOnly) return
                                                                        onCancelTask(task.id)
                                                                    }}
                                                                    title="Smazat úkol"
                                                                    disabled={readOnly}
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

            <div className="section" style={{ marginTop: 12 }}>
                <h3>Když je čas</h3>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {rooms.filter((room) => room.freeConfirmed && !room.occupiedConfirmed).map((room) => (
                        <div key={`free-confirmed-${room.id}`} className="note-chip" style={{ border: '1px solid #86efac', background: '#f0fdf4', color: '#166534' }}>
                            {room.number} • Potvrzeně volný
                        </div>
                    ))}
                    {rooms.filter((room) => room.freeConfirmed && !room.occupiedConfirmed).length === 0 && (
                        <div className="room-meta">Žádné potvrzeně volné pokoje pro tento den.</div>
                    )}
                </div>
            </div>
        </div>
    )
}
