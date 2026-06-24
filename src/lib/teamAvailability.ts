import { Availability, StaffAvailabilityRecord, UserRole } from '../types'
import { isAdminRole } from './roles'

type TeamMember = {
    id: string
    name: string
    role: UserRole
    availability?: Availability
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

function availabilityRank(availability?: Availability) {
    if (availability === 'dnes_pracuji') return 3
    if (availability === 'jen_urgentni') return 2
    if (availability === 'dnes_nepracuji') return 1
    return 0
}

function compareRecords(left: StaffAvailabilityRecord, right: StaffAvailabilityRecord) {
    const leftRank = availabilityRank(left.availability)
    const rightRank = availabilityRank(right.availability)
    if (leftRank !== rightRank) return leftRank - rightRank
    return (left.updatedAt || '').localeCompare(right.updatedAt || '')
}

function compareMembers(left: TeamMember, right: TeamMember) {
    const leftRank = availabilityRank(left.availability)
    const rightRank = availabilityRank(right.availability)
    if (leftRank !== rightRank) return leftRank - rightRank
    const leftAdmin = Number(isAdminRole(left.role))
    const rightAdmin = Number(isAdminRole(right.role))
    if (leftAdmin !== rightAdmin) return leftAdmin - rightAdmin
    return String(left.id).localeCompare(String(right.id))
}

export function buildStaffAvailabilityRecordId(dateIso: string, staffId: string) {
    return `${dateIso}__${staffId}`
}

export function upsertStaffAvailabilityRecord(
    records: StaffAvailabilityRecord[],
    nextRecord: StaffAvailabilityRecord
) {
    const nextId = buildStaffAvailabilityRecordId(nextRecord.dateIso, nextRecord.staffId)
    const filtered = records.filter((record) => record.id !== nextId)
    return [...filtered, { ...nextRecord, id: nextId }]
}

export function resolveStaffAvailabilityForDate(
    staff: TeamMember[],
    records: StaffAvailabilityRecord[],
    dateIso: string
) {
    const directByStaffId = new Map<string, StaffAvailabilityRecord>()

    records.forEach((record) => {
        if (record.dateIso !== dateIso) return
        const existing = directByStaffId.get(record.staffId)
        if (!existing || compareRecords(existing, record) < 0) {
            directByStaffId.set(record.staffId, record)
        }
    })

    const sharedByName = new Map<string, StaffAvailabilityRecord>()
    staff.forEach((member) => {
        const directRecord = directByStaffId.get(member.id)
        if (!directRecord) return
        const key = normalizeIdentity(member.name)
        if (!key) return
        const existing = sharedByName.get(key)
        if (!existing || compareRecords(existing, directRecord) < 0) {
            sharedByName.set(key, directRecord)
        }
    })

    return staff.map((member) => {
        const key = normalizeIdentity(member.name)
        const resolvedRecord = directByStaffId.get(member.id) || (key ? sharedByName.get(key) : undefined)
        return {
            ...member,
            availability: resolvedRecord?.availability || member.availability
        }
    })
}

export function dedupeSharedTeamMembers(staff: TeamMember[]) {
    const byName = new Map<string, TeamMember>()

    for (const member of staff) {
        const key = normalizeIdentity(member.name)
        if (!key) continue

        const existing = byName.get(key)
        if (!existing || compareMembers(existing, member) < 0) {
            byName.set(key, member)
        }
    }

    return Array.from(byName.values())
}

export function summarizeTeamAvailability(staff: TeamMember[]) {
    return staff.reduce((acc, member) => {
        if (member.availability === 'dnes_pracuji') acc.working += 1
        else if (member.availability === 'jen_urgentni') acc.urgentOnly += 1
        else acc.notWorking += 1
        return acc
    }, { working: 0, urgentOnly: 0, notWorking: 0 })
}

export function canManageStaffAvailability(viewerRole: UserRole, viewerId: string, targetStaffId: string) {
    if (isAdminRole(viewerRole)) return true
    return viewerId === targetStaffId
}