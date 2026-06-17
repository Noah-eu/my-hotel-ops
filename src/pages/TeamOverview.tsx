import React, { useMemo } from 'react'
import { UserRole } from '../types'

type Availability = 'dnes_pracuji' | 'dnes_nepracuji' | 'jen_urgentni'

type TeamMember = {
    id: string
    name: string
    role: UserRole
    availability?: Availability
}

type TeamOverviewProps = {
    staff: TeamMember[]
    role: UserRole
    currentUserId: string
    onSetAvailability: (id: string, availability: Availability) => void
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

function roleLabel(role: UserRole) {
    if (role === 'admin') return 'Admin'
    if (role === 'lead') return 'Iryna'
    if (role === 'cleaner') return 'Úklid'
    return 'Údržba'
}

function availabilityLabel(availability?: Availability) {
    if (availability === 'dnes_pracuji') return 'Pracuje dnes'
    if (availability === 'jen_urgentni') return 'Jen urgentní'
    return 'Nepracuje dnes'
}

function availabilityColor(availability?: Availability) {
    if (availability === 'dnes_pracuji') return '#10b981'
    if (availability === 'jen_urgentni') return '#f97316'
    return '#94a3b8'
}

function canEditAvailability(viewerRole: UserRole, viewerId: string, staffMember: TeamMember) {
    if (viewerRole === 'admin') return true
    if (viewerRole === 'lead') return staffMember.role === 'cleaner' || staffMember.id === viewerId
    return staffMember.id === viewerId
}

function dedupeTeamMembers(staff: TeamMember[], currentUserId: string) {
    const byName = new Map<string, TeamMember>()

    for (const member of staff) {
        const key = normalizeIdentity(member.name)
        if (!key) continue

        if (!byName.has(key)) {
            byName.set(key, member)
            continue
        }

        const existing = byName.get(key) as TeamMember
        const existingScore = Number(existing.id === currentUserId) * 10 + Number(existing.role === 'admin') * 5 + Number(Boolean(existing.availability))
        const incomingScore = Number(member.id === currentUserId) * 10 + Number(member.role === 'admin') * 5 + Number(Boolean(member.availability))

        if (incomingScore > existingScore) {
            byName.set(key, member)
        }
    }

    return Array.from(byName.values())
}

export default function TeamOverview({ staff, role, currentUserId, onSetAvailability }: TeamOverviewProps) {
    const uniqueStaff = useMemo(() => dedupeTeamMembers(staff, currentUserId), [staff, currentUserId])

    const summary = useMemo(() => {
        return uniqueStaff.reduce((acc, member) => {
            if (member.availability === 'dnes_pracuji') acc.working += 1
            else if (member.availability === 'jen_urgentni') acc.urgentOnly += 1
            else acc.notWorking += 1
            return acc
        }, { working: 0, urgentOnly: 0, notWorking: 0 })
    }, [uniqueStaff])

    return (
        <div className="section">
            <div className="team-summary-row" aria-label="Souhrn týmu">
                <div className="team-summary-chip team-summary-working">
                    <span className="team-summary-label">V práci</span>
                    <strong className="team-summary-value">{summary.working}</strong>
                </div>
                <div className="team-summary-chip team-summary-urgent">
                    <span className="team-summary-label">Jen urgentní</span>
                    <strong className="team-summary-value">{summary.urgentOnly}</strong>
                </div>
                <div className="team-summary-chip team-summary-off">
                    <span className="team-summary-label">Nepracují</span>
                    <strong className="team-summary-value">{summary.notWorking}</strong>
                </div>
            </div>

            <div className="team-list">
                {uniqueStaff.map((member) => {
                    const editable = canEditAvailability(role, currentUserId, member)
                    return (
                        <div key={member.id} className="team-card">
                            <div className="team-card-head">
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                                    <span className="team-dot" style={{ background: availabilityColor(member.availability) }} />
                                    <div style={{ minWidth: 0 }}>
                                        <div className="team-name">{member.name}</div>
                                        <div className="team-role">{roleLabel(member.role)}</div>
                                    </div>
                                </div>
                                <div className="team-status">{availabilityLabel(member.availability)}</div>
                            </div>

                            <div className="team-actions">
                                <button className="chip" disabled={!editable} onClick={() => onSetAvailability(member.id, 'dnes_pracuji')}>Pracuji</button>
                                <button className="chip" disabled={!editable} onClick={() => onSetAvailability(member.id, 'dnes_nepracuji')}>Nepracuji</button>
                                <button className="chip" disabled={!editable} onClick={() => onSetAvailability(member.id, 'jen_urgentni')}>Jen urgentní</button>
                            </div>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}