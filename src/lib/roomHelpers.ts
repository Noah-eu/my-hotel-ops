import type { RoomPlan } from '../types'

export function isTodayRoomEligibleForCarryOver(room?: RoomPlan): boolean {
    if (!room) return false

    // Do not show carry-over for rooms explicitly resolved or already completed
    if (room.carryOverResolvedAt) return false
    if (room.status === 'hotovo') return false

    const hasDeparture = Boolean(room.departure || room.departureTime)
    const hasArrival = Boolean(room.arrival || room.arrivalTime)

    // Eligible only when there's no departure, no arrival and not occupied
    if (hasDeparture) return false
    if (hasArrival) return false
    if (room.occupiedConfirmed) return false

    return true
}

export default isTodayRoomEligibleForCarryOver
