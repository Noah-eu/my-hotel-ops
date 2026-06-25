import React, { useEffect, useMemo, useState } from 'react'
import { Task, MaintenanceItem, UserRole } from '../types'
import { TranslateFn } from '../i18n'
import OriginBadge from '../components/OriginBadge'
import { isAdminRole, isCleaningLeadRole, isMaintenanceRole } from '../lib/roles'

type MaintenanceFocusRequest = {
    requestId: number
    targetId: string
    targetKind: 'task' | 'item'
}

function statusLabel(t: TranslateFn, status: MaintenanceItem['status']) {
    switch (status) {
        case 'new':
            return t('maintenance.status.new')
        case 'accepted':
            return t('maintenance.status.accepted')
        case 'in_progress':
            return t('maintenance.status.inProgress')
        case 'done':
            return t('maintenance.status.done')
        case 'waiting_material':
            return t('maintenance.status.waitingMaterial')
        case 'cannot_today':
            return t('maintenance.status.cannotToday')
        case 'cancelled':
            return t('maintenance.status.cancelled')
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

type UnifiedMaintenanceEntry =
    | { kind: 'maintenanceItem'; item: MaintenanceItem }
    | { kind: 'roomTask'; task: Task }

function isDoneItem(entry?: UnifiedMaintenanceEntry | null) {
    if (!entry) return false
    if (entry.kind === 'maintenanceItem') return (entry.item?.status || '') === 'done'
    return (entry.task?.status || '') === 'done'
}

function isCancelledItem(entry?: UnifiedMaintenanceEntry | null) {
    if (!entry) return false
    if (entry.kind === 'maintenanceItem') return (entry.item?.status || '') === 'cancelled'
    return (entry.task?.status || '') === 'cancelled'
}

function isActiveItem(entry?: UnifiedMaintenanceEntry | null) {
    if (!entry) return false
    return !isDoneItem(entry) && !isCancelledItem(entry)
}

function isUrgentItem(entry?: UnifiedMaintenanceEntry | null) {
    if (!entry) return false
    if (entry.kind === 'maintenanceItem') return (entry.item?.priority || 'normal') === 'urgent'
    return (entry.task?.priority || 'normal') === 'urgent'
}

function isWaitingForMaterialItem(entry?: UnifiedMaintenanceEntry | null) {
    if (!entry) return false
    if (entry.kind === 'maintenanceItem') return (entry.item?.status || '') === 'waiting_material'
    return (entry.task?.status || '') === 'waiting_material'
}

function isNewItem(entry?: UnifiedMaintenanceEntry | null) {
    if (!entry || !isActiveItem(entry)) return false

    if (entry.kind === 'maintenanceItem') {
        const status = entry.item?.status || ''
        return status === 'new' || (!entry.item?.maintenanceAcknowledgedAt && status !== 'accepted' && status !== 'in_progress' && status !== 'waiting_material')
    }

    const status = entry.task?.status || ''
    return status === 'new' || status === 'read' || (!entry.task?.maintenanceAcknowledgedAt && status !== 'accepted' && status !== 'in_progress' && status !== 'waiting_material')
}

function isTaskAssignedToMaintenance(task?: Task | null) {
    if (!task) return false
    if ((task.assignedToRole || '') === 'maintenance') return true

    const assignedName = (task.assignedToName || '').toLowerCase()
    return assignedName.includes('serhii') || assignedName.includes('udrzb')
}

export default function MaintenanceView({
    maintenanceItems,
    tasks,
    currentUserId,
    role,
    onCreateMaintenance,
    onCreateSelfTask,
    onUpdateMaintenance,
    onMaterialNeeded,
    onAcknowledgeTask,
    onAcknowledgeMaintenanceItem,
    onTaskAction,
    onRequestMaterial,
    onJumpToRoom,
    focusRequest,
    onFocusResult,
    t
}: {
    maintenanceItems: MaintenanceItem[]
    tasks: Task[]
    currentUserId: string
    role: UserRole
    onCreateMaintenance: (input: { roomNumber?: string; title: string; category: MaintenanceItem['category']; priority: MaintenanceItem['priority']; note?: string }) => void
    onCreateSelfTask: (input: { roomNumber?: string; title: string; note?: string; priority: Task['priority'] }) => void
    onUpdateMaintenance: (itemId: string, patch: Partial<MaintenanceItem>) => void
    onMaterialNeeded: (itemId: string, materialText: string) => void
    onAcknowledgeTask: (taskId: string) => void
    onAcknowledgeMaintenanceItem: (itemId: string) => void
    onTaskAction: (taskId: string, action: 'accepted' | 'done' | 'problem' | 'cancelled') => void
    onRequestMaterial?: (taskId: string, materialText: string) => void
    onJumpToRoom: (roomNumber?: string) => void
    focusRequest?: MaintenanceFocusRequest | null
    onFocusResult?: (result: { requestId: number; targetId: string; targetKind: 'task' | 'item'; found: boolean }) => void
    t: TranslateFn
}) {
    const [creating, setCreating] = useState(false)
    const [creatingSelfTask, setCreatingSelfTask] = useState(false)
    const [newRoom, setNewRoom] = useState('')
    const [newTitle, setNewTitle] = useState('')
    const [newCategory, setNewCategory] = useState<MaintenanceItem['category']>('other')
    const [newPriority, setNewPriority] = useState<MaintenanceItem['priority']>('normal')
    const [newNote, setNewNote] = useState('')
    const [newSelfTaskRoom, setNewSelfTaskRoom] = useState('')
    const [newSelfTaskTitle, setNewSelfTaskTitle] = useState('')
    const [newSelfTaskPriority, setNewSelfTaskPriority] = useState<Task['priority']>('normal')
    const [newSelfTaskNote, setNewSelfTaskNote] = useState('')
    const [materialInput, setMaterialInput] = useState<Record<string, string>>({})
    const [materialOpenItemId, setMaterialOpenItemId] = useState<string | null>(null)
    const [materialOpenTaskId, setMaterialOpenTaskId] = useState<string | null>(null)
    const [highlightTargetKey, setHighlightTargetKey] = useState<string | null>(null)
    const [activeFilter, setActiveFilter] = useState<'active' | 'new' | 'urgent' | 'waiting' | 'done'>('active')

    const isAdmin = isAdminRole(role)
    const isLead = isCleaningLeadRole(role)
    const isMaintenance = isMaintenanceRole(role)

    function categoryLabel(category: MaintenanceItem['category']) {
        switch (category) {
            case 'water':
                return t('maintenance.categories.water')
            case 'drain':
                return t('maintenance.categories.drain')
            case 'electricity':
                return t('maintenance.categories.electricity')
            case 'lock':
                return t('maintenance.categories.lock')
            case 'safe':
                return t('maintenance.categories.safe')
            case 'tv_wifi':
                return t('maintenance.categories.tvWifi')
            case 'heating':
                return t('maintenance.categories.heating')
            case 'furniture':
                return t('maintenance.categories.furniture')
            case 'appliance':
                return t('maintenance.categories.appliance')
            case 'room_issue':
                return t('maintenance.categories.roomIssue')
            default:
                return t('maintenance.categories.other')
        }
    }

    function formatCreatedAt(ts?: string | null) {
        if (!ts) return '-'
        const parsed = new Date(ts)
        if (!isNaN(parsed.getTime())) {
            return parsed.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
        }
        // fallback: if it's like HH:MM, attach today's date
        if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(ts)) {
            const today = new Date()
            const parts = ts.split(':')
            const hh = Number(parts[0]) || 0
            const mm = Number(parts[1]) || 0
            today.setHours(hh, mm, 0, 0)
            return today.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
        }
        return ts
    }

    useEffect(() => {
        if (!focusRequest) return

        const targetSelector = focusRequest.targetKind === 'item'
            ? `[data-maintenance-item-id="${focusRequest.targetId}"]`
            : `[data-maintenance-task-id="${focusRequest.targetId}"]`

        const frameId = window.requestAnimationFrame(() => {
            const target = document.querySelector(targetSelector) as HTMLElement | null
            if (!target) {
                onFocusResult?.({
                    requestId: focusRequest.requestId,
                    targetId: focusRequest.targetId,
                    targetKind: focusRequest.targetKind,
                    found: false
                })
                return
            }

            target.scrollIntoView({ behavior: 'smooth', block: 'center' })
            setHighlightTargetKey(`${focusRequest.targetKind}:${focusRequest.targetId}`)
            window.setTimeout(() => {
                setHighlightTargetKey((prev) => (prev === `${focusRequest.targetKind}:${focusRequest.targetId}` ? null : prev))
            }, 2600)

            onFocusResult?.({
                requestId: focusRequest.requestId,
                targetId: focusRequest.targetId,
                targetKind: focusRequest.targetKind,
                found: true
            })
        })

        return () => {
            window.cancelAnimationFrame(frameId)
        }
    }, [focusRequest])

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

    function handleCreateSelfTask() {
        if (!newSelfTaskTitle.trim()) return
        onCreateSelfTask({
            roomNumber: newSelfTaskRoom.trim() || undefined,
            title: newSelfTaskTitle,
            note: newSelfTaskNote,
            priority: newSelfTaskPriority
        })
        setNewSelfTaskRoom('')
        setNewSelfTaskTitle('')
        setNewSelfTaskPriority('normal')
        setNewSelfTaskNote('')
        setCreatingSelfTask(false)
    }

    // Safe wrappers for incoming props to avoid runtime undefined errors
    const visibleItems = useMemo(() => maintenanceItems || [], [maintenanceItems])
    const safeTasks = useMemo(() => tasks || [], [tasks])

    const maintenanceVisibleToUser = isAdmin
        ? visibleItems
        : isLead
            ? visibleItems
            : isMaintenance
                ? visibleItems.filter(i => !i.assignedTo || i.assignedTo === currentUserId || i.priority === 'urgent')
                : visibleItems

    const maintenanceRoomTasks = useMemo(
        () => safeTasks.filter((task) => isTaskAssignedToMaintenance(task)),
        [safeTasks]
    )

    const unifiedEntries = useMemo<UnifiedMaintenanceEntry[]>(() => {
        const items: UnifiedMaintenanceEntry[] = maintenanceVisibleToUser.map((item) => ({ kind: 'maintenanceItem', item }))
        const roomTasks: UnifiedMaintenanceEntry[] = maintenanceRoomTasks.map((task) => ({ kind: 'roomTask', task }))
        return [...items, ...roomTasks]
    }, [maintenanceVisibleToUser, maintenanceRoomTasks])

    const counts = useMemo(() => ({
        nove: unifiedEntries.filter((entry) => isNewItem(entry)).length,
        urgent: unifiedEntries.filter((entry) => isActiveItem(entry) && isUrgentItem(entry)).length,
        waiting: unifiedEntries.filter((entry) => isActiveItem(entry) && isWaitingForMaterialItem(entry)).length,
        done: unifiedEntries.filter((entry) => isDoneItem(entry)).length
    }), [unifiedEntries])

    const filteredEntries = useMemo(() => (
        unifiedEntries.filter((entry) => {
            if (activeFilter === 'active') return isActiveItem(entry)
            if (activeFilter === 'new') return isNewItem(entry)
            if (activeFilter === 'urgent') return isActiveItem(entry) && isUrgentItem(entry)
            if (activeFilter === 'waiting') return isActiveItem(entry) && isWaitingForMaterialItem(entry)
            if (activeFilter === 'done') return isDoneItem(entry)
            return true
        })
    ), [unifiedEntries, activeFilter])

    const visibleMaintenanceItemIds = useMemo(() => {
        const ids = new Set<string>()
        filteredEntries.forEach((entry) => {
            if (entry.kind === 'maintenanceItem' && entry.item?.id) ids.add(entry.item.id)
        })
        return ids
    }, [filteredEntries])

    const visibleTaskIds = useMemo(() => {
        const ids = new Set<string>()
        filteredEntries.forEach((entry) => {
            if (entry.kind === 'roomTask' && entry.task?.id) ids.add(entry.task.id)
        })
        return ids
    }, [filteredEntries])

    const sortedItems = [...maintenanceVisibleToUser]
        .filter((item) => visibleMaintenanceItemIds.has(item.id))
        .sort((a, b) => {
            const pa = a.priority === 'urgent' ? 0 : 1
            const pb = b.priority === 'urgent' ? 0 : 1
            if (pa !== pb) return pa - pb
            return (a.createdAt || '').localeCompare(b.createdAt || '')
        })

    const visibleRoomTasks = useMemo(
        () => maintenanceRoomTasks.filter((task) => visibleTaskIds.has(task.id)),
        [maintenanceRoomTasks, visibleTaskIds]
    )

    function renderItemCard(m: MaintenanceItem) {
        const canActAsMaintenance = isMaintenance && (!m.assignedTo || m.assignedTo === currentUserId)
        const cardStatusColor = statusColor(m)
        const unreadForMaintenance = m.status !== 'done' && m.status !== 'cancelled' && !m.maintenanceAcknowledgedAt

        return (
            <div
                key={m.id}
                data-maintenance-item-id={m.id}
                className="room-card"
                style={{
                    borderLeft: `6px solid ${cardStatusColor}`,
                    padding: 12,
                    ...(highlightTargetKey === `item:${m.id}` ? { outline: '2px solid #ef4444', boxShadow: '0 0 0 8px rgba(239,68,68,0.12)' } : {})
                }}
            >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                        <div style={{ fontWeight: 800, fontSize: 17, color: '#0f172a' }}>{m.roomNumber ? t('supplies.roomLabel', { roomNumber: m.roomNumber }) : t('maintenance.place')}</div>
                        <div style={{ padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 700, background: m.priority === 'urgent' ? '#fee2e2' : '#ecfeff', color: m.priority === 'urgent' ? '#991b1b' : '#0f766e' }}>
                            {m.priority === 'urgent' ? t('maintenance.priority.urgent') : t('maintenance.priority.normal')}
                        </div>
                        <div style={{ padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 700, background: '#f1f5f9', color: cardStatusColor }}>
                            {statusLabel(t, m.status)}
                        </div>
                        <div style={{ fontSize: 12, color: '#475569' }}>{categoryLabel(m.category)}</div>
                    </div>

                    <div style={{ fontWeight: 800, fontSize: 18, lineHeight: 1.2, color: '#0f172a', display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {m.title}
                        <OriginBadge
                            input={{
                                source: m.source,
                                createdByUid: m.createdByUid,
                                createdByName: m.createdByName,
                                createdByRole: m.createdByRole,
                                createdBy: m.reportedBy,
                                reportedBy: m.reportedBy,
                                importJobId: m.importJobId,
                                importedAt: m.importedAt
                            }}
                        />
                    </div>

                    {m.note && <div style={{ fontSize: 14, color: '#334155' }}>{m.note}</div>}
                    {m.materialNeeded && <div style={{ fontSize: 14, color: '#6b21a8', fontWeight: 600 }}>{t('maintenance.materialLabel')}: {m.materialNeeded}</div>}
                    <div style={{ fontSize: 12, color: '#64748b' }}>
                        {t('maintenance.reportedBy')}: {m.reportedBy || t('maintenance.unknownReporter')} • {t('maintenance.createdAt')}: {formatCreatedAt(m.createdAt)}
                        {m.assignedTo ? ` • ${t('maintenance.assignedTo')}: ${m.assignedTo}` : ''}
                        {m.updatedAt ? ` • ${t('maintenance.updatedAt')}: ${m.updatedAt}` : ''}
                    </div>

                    {m.roomNumber && (
                        <button className="chip" style={{ width: 'fit-content' }} onClick={() => onJumpToRoom(m.roomNumber)}>{t('buttons.goToRoom')}</button>
                    )}

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {unreadForMaintenance && (
                            <button className="chip" style={{ padding: '8px 10px', borderColor: '#fdba74', color: '#9a3412', background: '#ffedd5' }} onClick={() => onAcknowledgeMaintenanceItem(m.id)}>{t('buttons.read')}</button>
                        )}
                        {canActAsMaintenance && !m.assignedTo && (
                            <button className="chip" style={{ padding: '8px 10px' }} onClick={() => onUpdateMaintenance(m.id, { status: 'accepted', assignedTo: currentUserId })}>{t('buttons.takeOver')}</button>
                        )}
                        {canActAsMaintenance && m.status !== 'in_progress' && (
                            <button className="chip" style={{ padding: '8px 10px' }} onClick={() => onUpdateMaintenance(m.id, { status: 'in_progress' })}>{t('buttons.inProgress')}</button>
                        )}
                        {(isAdmin || isLead || canActAsMaintenance) && (
                            <button className="chip" style={{ padding: '8px 10px' }} onClick={() => onUpdateMaintenance(m.id, { status: 'done' })}>{t('buttons.done')}</button>
                        )}

                        {(isAdmin || isLead || canActAsMaintenance) && (
                            <button className="chip" style={{ padding: '8px 10px' }} onClick={() => setMaterialOpenItemId(materialOpenItemId === m.id ? null : m.id)}>{t('buttons.needMaterial')}</button>
                        )}

                        {(isAdmin || isLead || canActAsMaintenance) && (
                            <button className="chip" style={{ padding: '8px 10px' }} onClick={() => onUpdateMaintenance(m.id, { status: 'cannot_today' })}>{t('buttons.cannotToday')}</button>
                        )}

                        {isAdmin && (
                            <button className="chip" style={{ padding: '8px 10px', color: '#b91c1c', borderColor: '#fecaca', background: '#fff1f2' }} onClick={() => onUpdateMaintenance(m.id, { status: 'cancelled' })}>{t('buttons.cancel')}</button>
                        )}
                    </div>

                    {materialOpenItemId === m.id && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: 8, border: '1px solid #e2e8f0', borderRadius: 8, background: '#faf5ff' }}>
                            <input
                                className="material-input"
                                placeholder={t('maintenance.materialPlaceholder')}
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
                                {t('buttons.saveMaterial')}
                            </button>
                            <button className="btn" onClick={() => setMaterialOpenItemId(null)}>{t('buttons.close')}</button>
                        </div>
                    )}
                </div>
            </div>
        )
    }

    return (
        <div>
            <div className="section">
                <h3>{t('maintenance.section')}</h3>

                <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                    <button className={`chip ${activeFilter === 'active' ? 'active' : ''}`} onClick={() => setActiveFilter('active')}>{t('maintenance.filters.active')}</button>
                    <button className={`chip ${activeFilter === 'new' ? 'active' : ''}`} onClick={() => setActiveFilter('new')}>{t('maintenance.filters.new')}: <strong>{counts.nove}</strong></button>
                    <button className={`chip ${activeFilter === 'urgent' ? 'active' : ''}`} onClick={() => setActiveFilter('urgent')}>{t('maintenance.filters.urgent')}: <strong>{counts.urgent}</strong></button>
                    <button className={`chip ${activeFilter === 'waiting' ? 'active' : ''}`} onClick={() => setActiveFilter('waiting')}>{t('maintenance.filters.waiting')}: <strong>{counts.waiting}</strong></button>
                    <button className={`chip ${activeFilter === 'done' ? 'active' : ''}`} onClick={() => setActiveFilter('done')}>{t('maintenance.filters.done')}: <strong>{counts.done}</strong></button>
                </div>

                {(isAdmin || isLead) && (
                    <div style={{ marginBottom: 8 }}>
                        {!creating ? (
                            <button className="action-large" onClick={() => setCreating(true)}>{t('maintenance.addIssue')}</button>
                        ) : (
                            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                <textarea
                                    className="new-issue-textarea"
                                    placeholder={t('maintenance.fixPrompt')}
                                    value={newTitle}
                                    onChange={(e) => setNewTitle(e.target.value)}
                                />
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <button className="action-large" onClick={handleCreate}>{t('maintenance.createIssue')}</button>
                                    <button className="btn" onClick={() => { setCreating(false); setNewTitle('') }}>{t('buttons.cancel')}</button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {(isMaintenance || isAdmin) && (
                    <div style={{ marginBottom: 8 }}>
                        {!creatingSelfTask ? (
                            <button className="action-large" onClick={() => setCreatingSelfTask(true)}>{t('maintenance.addSelfTask')}</button>
                        ) : (
                            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                <input
                                    className="material-input"
                                    placeholder={t('maintenance.selfTaskTitlePlaceholder')}
                                    value={newSelfTaskTitle}
                                    onChange={(e) => setNewSelfTaskTitle(e.target.value)}
                                />
                                <input
                                    className="material-input"
                                    placeholder={t('maintenance.selfTaskRoomPlaceholder')}
                                    value={newSelfTaskRoom}
                                    onChange={(e) => setNewSelfTaskRoom(e.target.value)}
                                />
                                <select value={newSelfTaskPriority} onChange={(e) => setNewSelfTaskPriority(e.target.value as Task['priority'])}>
                                    <option value="normal">{t('maintenance.priority.normal')}</option>
                                    <option value="urgent">{t('maintenance.priority.urgent')}</option>
                                </select>
                                <textarea
                                    className="new-issue-textarea"
                                    placeholder={t('maintenance.selfTaskNotePlaceholder')}
                                    value={newSelfTaskNote}
                                    onChange={(e) => setNewSelfTaskNote(e.target.value)}
                                />
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <button className="action-large" onClick={handleCreateSelfTask}>{t('maintenance.createSelfTask')}</button>
                                    <button className="btn" onClick={() => { setCreatingSelfTask(false); setNewSelfTaskTitle('') }}>{t('buttons.cancel')}</button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                <h4 className="section-heading">{t('maintenance.roomIssues')}</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {sortedItems.length === 0 && visibleRoomTasks.length === 0 && (
                        <div className="room-card" style={{ color: '#475569' }}>{t('maintenance.noIssues')}</div>
                    )}
                    {sortedItems.map(renderItemCard)}
                </div>

                {maintenanceRoomTasks.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                        <h4 className="section-heading">{t('maintenance.roomTasks')}</h4>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {visibleRoomTasks
                                .filter((task) => (task?.status || '') !== 'cancelled')
                                .map((task) => {
                                    const unreadForMaintenance = (task.status || '') !== 'done' && (task.status || '') !== 'waiting_material' && !task.maintenanceAcknowledgedAt
                                    const taskColor = task.status === 'done' ? '#16a34a'
                                        : task.status === 'waiting_material' ? '#7e22ce'
                                            : task.status === 'in_progress' ? '#ea580c'
                                                : (task.priority === 'urgent' ? '#dc2626' : '#0ea5a4')

                                    return (
                                        <div
                                            key={task.id}
                                            data-maintenance-task-id={task.id}
                                            className="room-card"
                                            style={{
                                                borderLeft: `6px solid ${taskColor}`,
                                                padding: 12,
                                                ...(highlightTargetKey === `task:${task.id}` ? { outline: '2px solid #ef4444', boxShadow: '0 0 0 8px rgba(239,68,68,0.12)' } : {})
                                            }}
                                        >
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                                <div style={{ fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                                    {task.roomNumber || t('maintenance.unknownRoom')} – {task.title || t('rooms.untitledTask')}
                                                    {task.createdSource === 'maintenance_self' && (
                                                        <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: '#e0f2fe', color: '#075985' }}>
                                                            {t('maintenance.selfCreated')}
                                                        </span>
                                                    )}
                                                    <OriginBadge
                                                        input={{
                                                            source: task.source,
                                                            createdByUid: task.createdByUid,
                                                            createdByName: task.createdByName,
                                                            createdByRole: task.createdByRole,
                                                            createdBy: task.createdBy,
                                                            importJobId: task.importJobId,
                                                            importedAt: task.importedAt
                                                        }}
                                                    />
                                                </div>
                                                <div style={{ fontSize: 13, color: '#64748b' }}>
                                                    {task.priority === 'urgent' ? t('maintenance.priority.urgent') : t('maintenance.priority.normal')} • {statusLabel(t, task.status)} • {t('maintenance.createdBy')}: {task.createdBy || t('maintenance.unknownReporter')} • {formatCreatedAt(task.createdAt)}
                                                </div>
                                                {(task.note || '').trim() && (
                                                    <div style={{ marginTop: 6, color: '#334155', fontSize: 13, lineHeight: 1.35 }}>
                                                        {(task.note || '').trim()}
                                                    </div>
                                                )}
                                                {task.status === 'waiting_material' && (task.materialNote || '').trim() && (
                                                    <div style={{ marginTop: 6, color: '#6b21a8', fontSize: 13, fontWeight: 700 }}>
                                                        {t('maintenance.materialLabel')}: {(task.materialNote || '').trim()}
                                                    </div>
                                                )}
                                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                                    {unreadForMaintenance && (
                                                        <button className="chip" style={{ borderColor: '#fdba74', color: '#9a3412', background: '#ffedd5' }} onClick={() => onAcknowledgeTask(task.id)}>{t('buttons.read')}</button>
                                                    )}
                                                    {task.status !== 'done' && (
                                                        <button className="chip" onClick={() => onTaskAction(task.id, 'done')}>{t('buttons.done')}</button>
                                                    )}
                                                    {task.status !== 'accepted' && task.status !== 'in_progress' && task.status !== 'done' && (
                                                        <button className="chip" onClick={() => onTaskAction(task.id, 'accepted')}>{t('maintenance.status.accepted')}</button>
                                                    )}
                                                    {task.roomNumber && (
                                                        <button className="chip" onClick={() => onJumpToRoom(task.roomNumber)}>{t('buttons.goToRoom')}</button>
                                                    )}
                                                    {(isAdmin || isLead || isMaintenance || isTaskAssignedToMaintenance(task)) && (task.status !== 'done' && task.status !== 'cancelled') && (
                                                        <button className="chip" onClick={() => setMaterialOpenTaskId(materialOpenTaskId === task.id ? null : task.id)}>{t('buttons.needMaterial')}</button>
                                                    )}
                                                </div>
                                                {materialOpenTaskId === task.id && (
                                                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingTop: 6 }}>
                                                        <input
                                                            className="material-input"
                                                            placeholder={t('maintenance.materialTaskPlaceholder')}
                                                            value={materialInput[task.id] || ''}
                                                            onChange={(e) => setMaterialInput((prev) => ({ ...prev, [task.id]: e.target.value }))}
                                                            style={{ minWidth: 180, flex: 1 }}
                                                        />
                                                        <button
                                                            className="btn"
                                                            onClick={() => {
                                                                onRequestMaterial?.(task.id, materialInput[task.id] || '')
                                                                setMaterialInput((prev) => ({ ...prev, [task.id]: '' }))
                                                                setMaterialOpenTaskId(null)
                                                            }}
                                                        >
                                                            {t('buttons.saveMaterial')}
                                                        </button>
                                                        <button className="btn" onClick={() => setMaterialOpenTaskId(null)}>{t('buttons.close')}</button>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )
                                })}
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
