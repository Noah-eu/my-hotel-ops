import React from 'react'
import { Task } from '../types'

function statusLabel(status: Task['status']) {
    switch (status) {
        case 'new':
            return 'Nový'
        case 'read':
            return 'Přečteno'
        case 'accepted':
            return 'Převzato'
        case 'in_progress':
            return 'Řeší se'
        case 'done':
            return 'Hotovo'
        case 'problem':
            return 'Potřebuji materiál'
        case 'cancelled':
            return 'Nelze dnes'
        default:
            return status
    }
}

export default function MaintenanceView({ tasks, onTaskAction }: { tasks: Task[]; onTaskAction: (taskId: string, action: 'accepted' | 'done' | 'problem' | 'cancelled') => void }) {
    return (
        <div>
            <div className="section">
                <h3>Údržba</h3>
                <div className="room-list">
                    {tasks.length === 0 && (
                        <div className="room-card">Žádné úkoly pro údržbu.</div>
                    )}
                    {tasks.map((m) => (
                        <div key={m.id} className="room-card" style={m.priority === 'urgent' ? { borderLeft: '6px solid #ef4444' } : {}}>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontWeight: 700 }}>Pokoj {m.roomNumber}: {m.title}</div>
                                <div style={{ fontSize: 13, color: '#64748b' }}>
                                    Status: {statusLabel(m.status)}
                                    {m.priority === 'urgent' ? ' • Urgentní' : ''}
                                </div>
                                {m.note && <div style={{ fontSize: 12, marginTop: 4, color: '#475569' }}>{m.note}</div>}
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                <button className="chip" onClick={() => onTaskAction(m.id, 'accepted')}>Převzato</button>
                                <button className="chip" onClick={() => onTaskAction(m.id, 'done')}>Hotovo</button>
                                <button className="chip" onClick={() => onTaskAction(m.id, 'problem')}>Potřebuji materiál</button>
                                <button className="chip" onClick={() => onTaskAction(m.id, 'cancelled')}>Nelze dnes</button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    )
}
