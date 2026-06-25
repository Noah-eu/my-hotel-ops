import { isAdminRole, isMaintenanceRole } from './roles'
import { Task, UserRole } from '../types'

type MaintenanceSelfTaskInput = {
    title: string
    roomNumber?: string
    note?: string
    priority: Task['priority']
    taskDateIso?: string
    createdAt: string
    createdByUid: string
    createdByName: string
    createdByRole: UserRole
}

type TaskActor = {
    uid?: string
    name?: string
}

export function canCreateMaintenanceSelfTask(role?: UserRole | null) {
    return isAdminRole(role) || isMaintenanceRole(role)
}

export function createMaintenanceSelfTask(input: MaintenanceSelfTaskInput): Task {
    return {
        id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        roomNumber: String(input.roomNumber || '').trim(),
        title: input.title.trim(),
        category: 'maintenance',
        priority: input.priority,
        assignedToRole: 'maintenance',
        assignedToUid: input.createdByUid,
        assignedToName: input.createdByName,
        status: 'new',
        note: input.note?.trim() || undefined,
        createdBy: input.createdByName,
        createdAt: input.createdAt,
        taskDateIso: input.taskDateIso,
        source: 'manual',
        createdSource: 'maintenance_self',
        createdByUid: input.createdByUid,
        createdByName: input.createdByName,
        createdByRole: input.createdByRole
    }
}

export function applyMaintenanceTaskStatus(task: Task, status: Task['status'], actor: TaskActor, nowIso: string): Task {
    const next: Task = {
        ...task,
        status,
        assignedToRole: 'maintenance',
        assignedToUid: actor.uid || task.assignedToUid,
        assignedToName: actor.name || task.assignedToName
    }

    if (status === 'done') {
        next.completedAt = nowIso
        next.completedByUid = actor.uid || task.completedByUid
        next.completedByName = actor.name || task.completedByName
    }

    return next
}