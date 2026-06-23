import type { RoomPlan } from '../types'

export type OperationalMergeDiagnosticKind =
    | 'status_preserved'
    | 'assignment_preserved'
    | 'estimate_preserved'
    | 'problem_preserved'
    | 'carry_over_preserved'
    | 'possible_inconsistent_state'

export interface OperationalMergeDiagnostic {
    dateIso: string
    roomNumber: string
    kind: OperationalMergeDiagnosticKind
    message: string
}

export interface MergeRoomOperationalStateInput {
    dateIso: string
    importedRoom: RoomPlan
    existingRoom?: RoomPlan | null
}

export interface MergeRoomOperationalStateResult {
    room: RoomPlan
    diagnostics: OperationalMergeDiagnostic[]
}

export interface MergeByDateOperationalStateInput {
    importedByDate: Record<string, RoomPlan[]>
    existingByDate: Record<string, RoomPlan[]>
}

export interface OperationalMergeSummary {
    touchedRoomCount: number
    statusPreservedCount: number
    assignmentPreservedCount: number
    estimatePreservedCount: number
    problemPreservedCount: number
    carryOverPreservedCount: number
    inconsistencyWarningCount: number
    inconsistencyRooms: string[]
}

const IN_PROGRESS_STATUSES = new Set<RoomPlan['status']>(['prevzato', 'probihá', 'odhad'])
const TOUCHED_STATUSES = new Set<RoomPlan['status']>(['prevzato', 'probihá', 'odhad', 'hotovo', 'problem'])

export function normalizeRoomNumberForOperationalMerge(rawValue?: string) {
    const value = String(rawValue || '').trim()
    if (!value) return ''

    const exactThreeDigits = value.match(/\b(\d{3})\b/)
    if (exactThreeDigits) return exactThreeDigits[1]

    const digits = value.replace(/\D/g, '')
    if (digits.length >= 3) return digits.slice(-3)
    return value
}

function roomHasTurnover(room: RoomPlan) {
    return Boolean(
        room.situation !== 'volny'
        || room.departureTime
        || room.arrivalTime
        || room.departure
        || room.arrival
    )
}

function roomTouchedOperationally(room: RoomPlan) {
    if (TOUCHED_STATUSES.has(room.status)) return true
    if (room.occupiedConfirmed || room.freeConfirmed) return true
    if (Boolean(room.assigned)) return true
    if (Boolean(room.estimatedReady || room.estimateSetAt)) return true
    if (Boolean(room.checkoutException || room.statusNote)) return true
    if (Boolean(room.carryOverResolvedAt)) return true
    return false
}

function roomNumberLabel(room: RoomPlan) {
    return normalizeRoomNumberForOperationalMerge(room.number) || room.number || room.id
}

export function mergeImportedRoomDayWithExistingOperationalState(input: MergeRoomOperationalStateInput): MergeRoomOperationalStateResult {
    const { dateIso, importedRoom, existingRoom } = input
    const diagnostics: OperationalMergeDiagnostic[] = []

    if (!existingRoom || !roomTouchedOperationally(existingRoom)) {
        return { room: importedRoom, diagnostics }
    }

    const roomNumber = roomNumberLabel(importedRoom)
    const merged: RoomPlan = {
        ...importedRoom
    }

    if (existingRoom.status && existingRoom.status !== 'neni' && existingRoom.status !== importedRoom.status) {
        merged.status = existingRoom.status
        diagnostics.push({
            dateIso,
            roomNumber,
            kind: 'status_preserved',
            message: `${dateIso}/${roomNumber}: zachován stav pokoje ${existingRoom.status}`
        })
    }

    if (existingRoom.assigned && existingRoom.assigned !== importedRoom.assigned) {
        merged.assigned = existingRoom.assigned
        diagnostics.push({
            dateIso,
            roomNumber,
            kind: 'assignment_preserved',
            message: `${dateIso}/${roomNumber}: zachováno přiřazení pokoje`
        })
    }

    if (existingRoom.estimatedReady || existingRoom.estimateSetAt) {
        merged.estimatedReady = existingRoom.estimatedReady
        merged.estimateSetAt = existingRoom.estimateSetAt
        diagnostics.push({
            dateIso,
            roomNumber,
            kind: 'estimate_preserved',
            message: `${dateIso}/${roomNumber}: zachován odhad dokončení`
        })
    }

    if (existingRoom.statusNote || existingRoom.checkoutException) {
        merged.statusNote = existingRoom.statusNote
        merged.checkoutException = Boolean(existingRoom.checkoutException)
        diagnostics.push({
            dateIso,
            roomNumber,
            kind: 'problem_preserved',
            message: `${dateIso}/${roomNumber}: zachována provozní poznámka / výjimka`
        })
    }

    if (existingRoom.carryOverResolvedAt) {
        merged.carryOverResolvedAt = existingRoom.carryOverResolvedAt
        diagnostics.push({
            dateIso,
            roomNumber,
            kind: 'carry_over_preserved',
            message: `${dateIso}/${roomNumber}: zachován příznak vyřešeného carry-over`
        })
    }

    if (!roomHasTurnover(importedRoom) && IN_PROGRESS_STATUSES.has(merged.status)) {
        diagnostics.push({
            dateIso,
            roomNumber,
            kind: 'possible_inconsistent_state',
            message: `${dateIso}/${roomNumber}: pokoj bez turnoveru ponechal rozpracovaný stav ${merged.status}`
        })
    }

    if (importedRoom.freeConfirmed && merged.checkoutException) {
        diagnostics.push({
            dateIso,
            roomNumber,
            kind: 'possible_inconsistent_state',
            message: `${dateIso}/${roomNumber}: pokoj je volný, ale zůstala výjimka checkoutu`
        })
    }

    return {
        room: merged,
        diagnostics
    }
}

export function mergeImportedByDateWithExistingOperationalState(input: MergeByDateOperationalStateInput) {
    const { importedByDate, existingByDate } = input
    const mergedByDate: Record<string, RoomPlan[]> = {}
    const diagnostics: OperationalMergeDiagnostic[] = []

    Object.entries(importedByDate).forEach(([dateIso, importedRooms]) => {
        const existingRooms = existingByDate[dateIso] || []
        const existingById = new Map(existingRooms.map((room) => [room.id, room]))
        const existingByNumber = new Map(existingRooms.map((room) => [normalizeRoomNumberForOperationalMerge(room.number), room]))

        mergedByDate[dateIso] = importedRooms.map((importedRoom) => {
            const roomNumber = normalizeRoomNumberForOperationalMerge(importedRoom.number)
            const existingRoom = existingById.get(importedRoom.id) || existingByNumber.get(roomNumber)
            const merged = mergeImportedRoomDayWithExistingOperationalState({
                dateIso,
                importedRoom,
                existingRoom
            })
            diagnostics.push(...merged.diagnostics)
            return merged.room
        })
    })

    return {
        byDate: mergedByDate,
        diagnostics
    }
}

export function summarizeOperationalMergeDiagnostics(diagnostics: OperationalMergeDiagnostic[]): OperationalMergeSummary {
    const touchedRooms = new Set<string>()
    const inconsistencyRooms = new Set<string>()

    let statusPreservedCount = 0
    let assignmentPreservedCount = 0
    let estimatePreservedCount = 0
    let problemPreservedCount = 0
    let carryOverPreservedCount = 0
    let inconsistencyWarningCount = 0

    diagnostics.forEach((diagnostic) => {
        const roomKey = `${diagnostic.dateIso}/${diagnostic.roomNumber}`
        touchedRooms.add(roomKey)

        if (diagnostic.kind === 'status_preserved') statusPreservedCount += 1
        if (diagnostic.kind === 'assignment_preserved') assignmentPreservedCount += 1
        if (diagnostic.kind === 'estimate_preserved') estimatePreservedCount += 1
        if (diagnostic.kind === 'problem_preserved') problemPreservedCount += 1
        if (diagnostic.kind === 'carry_over_preserved') carryOverPreservedCount += 1

        if (diagnostic.kind === 'possible_inconsistent_state') {
            inconsistencyWarningCount += 1
            inconsistencyRooms.add(roomKey)
        }
    })

    return {
        touchedRoomCount: touchedRooms.size,
        statusPreservedCount,
        assignmentPreservedCount,
        estimatePreservedCount,
        problemPreservedCount,
        carryOverPreservedCount,
        inconsistencyWarningCount,
        inconsistencyRooms: Array.from(inconsistencyRooms).slice(0, 5)
    }
}
