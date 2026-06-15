import React from 'react'
import React from 'react'
import { RoomPlan } from '../types'

function statusClass(status: string) {
    switch (status) {
        case 'ceka':
            return 'red'
        case 'prevzato':
            return 'blue'
        case 'probihá':
            return 'orange'
        case 'odhad':
            return 'purple'
        case 'hotovo':
            return 'green'
        default:
            return 'gray'
    }
}

export function RoomCard({ room, onAction, role, currentUserId }: { room: RoomPlan; onAction: (id: string, action: string) => void; role: string; currentUserId?: string }) {
    const badge = statusClass(room.status)

    return (
        <div className="room-card">
            <div className="room-left">
                <div className="room-number">{room.number}</div>
                <div className="room-meta">{room.box || ''}</div>
            </div>
            <div className="room-center">
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                    <div style={{fontSize:14,fontWeight:700}}>{room.situation.replace('_', ' + ')}</div>
                    <div className={`status ${badge}`}>{room.status === 'hotovo' ? 'Připraveno' : room.status}</div>
                </div>

                <div style={{display:'flex',gap:10,marginTop:8,flexWrap:'wrap',alignItems:'center'}}>
                    {room.departureTime && <div className="room-meta">Odjezd: <strong style={{color:'#0f172a'}}>{room.departureTime}</strong></div>}
                    {room.arrivalTime && <div className="room-meta">Příjezd: <strong style={{color:'#0f172a'}}>{room.arrivalTime}</strong></div>}
                    {room.guestCount !== undefined && <div className="room-meta">Hosté: <strong>{room.guestCount}</strong></div>}
                    {room.estimatedReady && <div className="room-meta">Odhad: <strong>{room.estimatedReady}</strong></div>}
                </div>

                {room.notes && room.notes.length > 0 && (
                    <div style={{marginTop:8,fontSize:13,color:'#475569'}}>
                        <strong>Poznámka:</strong> {room.notes.join(', ')}
                    </div>
                )}

                {/* Actions */}
                <div className="room-actions">
                    {role === 'cleaner' ? (
                        <>
                            <button className="action-large" onClick={() => onAction(room.id, 'prevzit')}>Převzít</button>
                            <button className="action-large" onClick={() => onAction(room.id, 'odhad')}>Odhad</button>
                            <button className="action-large" onClick={() => onAction(room.id, 'hotovo')}>Hotovo</button>
                            <button className="action-large" style={{background:'#ef4444'}} onClick={() => onAction(room.id, 'problem')}>Problém</button>
                            <button className="action-secondary" onClick={() => onAction(room.id, 'host_zustava')}>Host ještě na pokoji</button>
                        </>
                    ) : role === 'admin' ? (
                        <>
                            <div style={{display:'flex',flexDirection:'column',gap:6}}>
                                <div className="room-meta">Přiřazeno: {room.assigned || '—'}</div>
                                {room.estimatedReady && <div className="room-meta">Odhad hotovo: <strong>{room.estimatedReady}</strong></div>}
                            </div>
                            <button className="chip" onClick={() => onAction(room.id, 'add_task')}>Přidat úkol</button>
                        </>
                    ) : (
                        <>
                            <button className="chip" onClick={() => onAction(room.id, 'prevzit')}>Převzít</button>
                            <button className="chip" onClick={() => onAction(room.id, 'odhad')}>Odhad</button>
                            <button className="chip" onClick={() => onAction(room.id, 'hotovo')}>Hotovo</button>
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}
