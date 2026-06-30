import { Task, UserRole } from '../types'
import { isTaskVisibleForOperationalDate } from './opsUiInvariants'
import { isAdminRole, isCleanerRole, isCleaningLeadRole, isMaintenanceRole } from './roles'

function dedupeTasksById(tasks: Task[]) {
    const seen = new Set<string>()
    return tasks.filter((task) => {
        if (!task.id || seen.has(task.id)) return false
        seen.add(task.id)
        return true
    })
}

export function canSeeRoomTaskForRole(role: UserRole, task: Task) {
    if (isAdminRole(role)) return true
    if (isCleaningLeadRole(role)) return task.category === 'cleaning' || task.assignedToRole === 'lead' || task.assignedToRole === 'cleaner'
    if (isCleanerRole(role)) return task.category === 'cleaning' || task.assignedToRole === 'cleaner'
    if (isMaintenanceRole(role)) return task.assignedToRole === 'maintenance'
    return false
}

export function isRoomTaskUnresolved(task: Task) {
    return task.status !== 'done' && task.status !== 'cancelled'
}

export function isRoomTaskAlertActive(task: Task, todayDateIso: string) {
    return Boolean(
        task.taskDateIso === todayDateIso
        && task.attentionRequired
        && task.attentionReason === 'late_today_room_task'
        && task.status !== 'read'
        && task.status !== 'waiting_material'
        && task.status !== 'done'
        && task.status !== 'cancelled'
    )
}

export function getVisibleRoomTasksForViewer(params: {
    tasks: Task[]
    role: UserRole
    roomNumber: string
    effectiveDateIso: string
    todayDateIso: string
}) {
    const { tasks, role, roomNumber, effectiveDateIso, todayDateIso } = params

    return dedupeTasksById(tasks.filter((task) => (
        task.roomNumber === roomNumber
        && canSeeRoomTaskForRole(role, task)
        && isTaskVisibleForOperationalDate(task.taskDateIso, effectiveDateIso, todayDateIso)
    )))
}

export function getRoomTaskAlertsForViewer(params: {
    tasks: Task[]
    role: UserRole
    roomNumber: string
    effectiveDateIso: string
    todayDateIso: string
}) {
    return getVisibleRoomTasksForViewer(params).filter((task) => isRoomTaskAlertActive(task, params.todayDateIso))
}
