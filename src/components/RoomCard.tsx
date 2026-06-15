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

export function RoomCard({ room, onAction }: { room: RoomPlan; onAction: (id: string, action: string) => void }) {
  return (
    <div className="room-card">
      <div className="room-left">
        <div className="room-number">{room.number}</div>
        <div className="room-meta">{room.box || ''}</div>
      </div>
      <div className="room-center">
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div className="room-meta">{room.situation.replace('_', ' + ')}</div>
          <div className={`status ${statusClass(room.status)}`}>{room.status}</div>
        </div>
        <div style={{marginTop:6,fontSize:13,color:'#475569'}}>
          {room.departureTime ? `Odjezd: ${room.departureTime}` : ''} {room.arrivalTime ? ` • Příjezd: ${room.arrivalTime}` : ''}
        </div>
        <div style={{marginTop:6}} className="room-actions">
          <button className="chip" onClick={() => onAction(room.id, 'prevzit')}>Převzít pokoj</button>
          <button className="chip" onClick={() => onAction(room.id, 'odhad')}>Odhad hotovo</button>
          <button className="chip" onClick={() => onAction(room.id, 'hotovo')}>Hotovo</button>
          <button className="chip" onClick={() => onAction(room.id, 'problem')}>Problém</button>
          <button className="chip" onClick={() => onAction(room.id, 'host_zustava')}>Host je ještě na pokoji</button>
        </div>
        {room.notes && room.notes.length > 0 && (
          <div style={{marginTop:8,fontSize:12,color:'#475569'}}>
            Poznámky: {room.notes.join(', ')}
          </div>
        )}
        {room.estimatedReady && (
          <div style={{marginTop:6,fontSize:13}}>Odhad hotovo: {room.estimatedReady}</div>
        )}
      </div>
    </div>
  )
}
