import React, { useMemo } from 'react'
import { UserRole } from '../types'
import { TranslateFn } from '../i18n'
import { canManageStaffAvailability, dedupeSharedTeamMembers, summarizeTeamAvailability } from '../lib/teamAvailability'

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
    t: TranslateFn
    onSetAvailability: (id: string, availability: Availability) => void
}

function availabilityLabel(t: TranslateFn, availability?: Availability) {
    if (availability === 'dnes_pracuji') return t('team.statusWorking')
    if (availability === 'jen_urgentni') return t('team.urgentOnly')
    return t('team.statusNotWorking')
}

function availabilityColor(availability?: Availability) {
    if (availability === 'dnes_pracuji') return '#10b981'
    if (availability === 'jen_urgentni') return '#f97316'
    return '#94a3b8'
}

function roleLabelForUi(t: TranslateFn, role: UserRole) {
    if (role === 'admin') return t('roles.admin')
    if (role === 'lead' || role === 'iryna') return t('roles.lead')
    if (role === 'maintenance') return t('roles.maintenance')
    return t('roles.cleaner')
}

export default function TeamOverview({ staff, role, currentUserId, t, onSetAvailability }: TeamOverviewProps) {
    const uniqueStaff = useMemo(() => dedupeSharedTeamMembers(staff), [staff])
    const summary = useMemo(() => summarizeTeamAvailability(uniqueStaff), [uniqueStaff])

    return (
        <div className="section">
            <div className="team-summary-row" aria-label={t('team.summary')}>
                <div className="team-summary-chip team-summary-working">
                    <span className="team-summary-label">{t('team.working')}</span>
                    <strong className="team-summary-value">{summary.working}</strong>
                </div>
                <div className="team-summary-chip team-summary-urgent">
                    <span className="team-summary-label">{t('team.urgentOnly')}</span>
                    <strong className="team-summary-value">{summary.urgentOnly}</strong>
                </div>
                <div className="team-summary-chip team-summary-off">
                    <span className="team-summary-label">{t('team.notWorking')}</span>
                    <strong className="team-summary-value">{summary.notWorking}</strong>
                </div>
            </div>

            <div className="team-list">
                {uniqueStaff.map((member) => {
                    const editable = canManageStaffAvailability(role, currentUserId, member.id)
                    return (
                        <div key={member.id} className="team-card">
                            <div className="team-card-head">
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                                    <span className="team-dot" style={{ background: availabilityColor(member.availability) }} />
                                    <div style={{ minWidth: 0 }}>
                                        <div className="team-name">{member.name}</div>
                                        <div className="team-role">{roleLabelForUi(t, member.role)}</div>
                                    </div>
                                </div>
                                <div className="team-status">{availabilityLabel(t, member.availability)}</div>
                            </div>

                            <div className="team-actions">
                                <button className="chip" disabled={!editable} onClick={() => onSetAvailability(member.id, 'dnes_pracuji')}>{t('buttons.working')}</button>
                                <button className="chip" disabled={!editable} onClick={() => onSetAvailability(member.id, 'dnes_nepracuji')}>{t('buttons.notWorking')}</button>
                                <button className="chip" disabled={!editable} onClick={() => onSetAvailability(member.id, 'jen_urgentni')}>{t('buttons.urgentOnly')}</button>
                            </div>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}