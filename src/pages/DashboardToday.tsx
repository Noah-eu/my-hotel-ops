import React, { useState } from 'react'
import { RoomPlan } from '../types'

export default function DashboardToday({ rooms, onAction, role, dayLabel }: { rooms: RoomPlan[]; onAction: (id: string, action: string) => void; role: string; dayLabel: string }) {
    const [expandedRoom, setExpandedRoom] = useState<string | null>(null)

    function statusClass(status: RoomPlan['status']) {
        switch (status) {
            case 'ceka':
                return 'status-row-red'
            case 'prevzato':
                return 'status-row-blue'
            case 'probihá':
                return 'status-row-orange'
            case 'odhad':
                return 'status-row-purple'
            case 'hotovo':
                return 'status-row-green'
            default:
                return 'status-row-gray'
        }
    }

    function statusLabel(status: RoomPlan['status']) {
        switch (status) {
            case 'ceka':
                return 'Čeká'
            case 'prevzato':
                return 'Převzato'
            case 'probihá':
                return 'Probíhá'
            case 'odhad':
                return 'Odhad hotovo'
            case 'hotovo':
                return 'Připraveno'
            default:
                return 'Není potřeba řešit'
        }
    }

    function nextArrivalText(room: RoomPlan) {
        if (!room.nextArrivalPreview) return null
        const dayLabel = room.nextArrivalPreview.day === 'zitra' ? 'zítra' : 'pozítří'
        return `Další příjezd: ${dayLabel} ${room.nextArrivalPreview.time}`
    }

    return (
        <div className="section">
            <h3>Denní plán pokojů</h3>
            <div className="room-meta" style={{ marginBottom: 8, fontSize: 13 }}>{dayLabel}</div>
            <div className="daily-table">
                <div className="daily-table-header">
                    <div>Pokoj</div>
                    <div>Odjezd</div>
                    <div>Příjezd</div>
                </div>

                {rooms.map((room) => {
                    const isExpanded = expandedRoom === room.id

                    return (
                        <div key={room.id} className={`daily-row-wrap ${statusClass(room.status)}`}>
                            <div className="daily-row">
                                <div className="room-col">
                                    <div className="room-no">{room.number}</div>
                                    <div className="mini-badge">{statusLabel(room.status)}</div>
                                    {room.assigned && <div className="mini-muted">{room.assigned}</div>}
                                </div>

                                <div className={`plan-col ${room.departure ? '' : 'empty-col'}`}>
                                    {room.departure ? (
                                        <>
                                            <div className="plan-time">{room.departure.time}</div>
                                            <div className="plan-meta">{room.departure.guestLabel || 'Host'}</div>
                                            {room.departure.guestCount !== undefined && <div className="plan-meta">Hosté: {room.departure.guestCount}</div>}
                                            <div className="plan-meta">Stav: {statusLabel(room.status)}</div>
                                            {room.assigned && <div className="plan-meta">Úklid: {room.assigned}</div>}
                                        </>
                                    ) : (
                                        <div className="plan-empty">bez odjezdu</div>
                                    )}
                                </div>

                                <div className={`plan-col ${room.arrival ? '' : 'empty-col'}`}>
                                    {room.arrival ? (
                                        <>
                                            <div className="plan-time">{room.arrival.time}</div>
                                            <div className="plan-meta">{room.arrival.guestLabel || 'Host'}</div>
                                            {room.arrival.guestCount !== undefined && <div className="plan-meta">Hosté: {room.arrival.guestCount}</div>}
                                            {room.arrival.box && <div className="plan-meta">{room.arrival.box}</div>}
                                            {room.arrival.notes && room.arrival.notes.length > 0 && <div className="plan-note">{room.arrival.notes.join(', ')}</div>}
                                            {room.estimatedReady && <div className="plan-ready">Odhad hotovo: {room.estimatedReady}</div>}
                                        </>
                                    ) : (
                                        <>
                                            <div className="plan-empty">bez příjezdu</div>
                                            {room.situation === 'odjezd' && nextArrivalText(room) && (
                                                <div className="plan-preview">{nextArrivalText(room)}</div>
                                            )}
                                        </>
                                    )}
                                </div>
                            </div>

                            <div className="row-actions-toggle">
                                <button className="btn" onClick={() => setExpandedRoom(isExpanded ? null : room.id)}>
                                    Detail / Akce
                                </button>
                            </div>

                            {isExpanded && (
                                <div className="expanded-actions">
                                    <button className={role === 'cleaner' ? 'action-large' : 'chip'} onClick={() => onAction(room.id, 'prevzit')}>Převzít pokoj</button>
                                    <button className={role === 'cleaner' ? 'action-large' : 'chip'} onClick={() => onAction(room.id, 'odhad')}>Odhad hotovo</button>
                                    <button className={role === 'cleaner' ? 'action-large' : 'chip'} onClick={() => onAction(room.id, 'hotovo')}>Hotovo</button>
                                    <button className={role === 'cleaner' ? 'action-large' : 'chip'} style={role === 'cleaner' ? { background: '#ef4444' } : {}} onClick={() => onAction(room.id, 'problem')}>Problém</button>
                                    <button className="action-secondary" onClick={() => onAction(room.id, 'host_zustava')}>Host je ještě na pokoji</button>
                                    {role === 'admin' && <button className="chip" onClick={() => onAction(room.id, 'add_task')}>Přidat úkol</button>}
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
