import type { RoomPlan } from '../types'

export function buildOperationalStatusMeta(dateIso: string, updatedAt: string, updatedBy?: string): Partial<RoomPlan> {
    return {
        operationalStatusDateIso: dateIso,
        operationalStatusUpdatedAt: updatedAt,
        operationalStatusUpdatedBy: updatedBy
    }
}

export function buildResetRoomToWaitingPatch(dateIso: string, updatedAt: string, updatedBy?: string): Partial<RoomPlan> {
    return {
        status: 'ceka',
        ...buildOperationalStatusMeta(dateIso, updatedAt, updatedBy)
    }
}

export function applyRoomOperationalPatch(room: RoomPlan, patch: Partial<RoomPlan>): RoomPlan {
    return {
        ...room,
        ...patch
    }
}