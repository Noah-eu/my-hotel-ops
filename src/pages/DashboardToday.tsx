import React from 'react'
import { RoomPlan } from '../types'
import { RoomCard } from '../components/RoomCard'

export default function DashboardToday({ rooms, onAction }: { rooms: RoomPlan[]; onAction: (id: string, action: string) => void }) {
  const musi = rooms.filter(r => r.status === 'ceka' && r.situation !== 'volny')
  const tasksFromLeads = rooms.filter(r => r.status === 'probihá' || r.status === 'odhad')
  const kdy = rooms.filter(r => r.situation === 'volny')

  return (
    <div>
      <div className="section">
        <h3>Musí se udělat dnes</h3>
        <div className="room-list">
          {musi.map(r => <RoomCard key={r.id} room={r} onAction={onAction} />)}
        </div>
      </div>
      <div className="section">
        <h3>Úkoly od Davida / Iryny</h3>
        <div className="room-list">
          {tasksFromLeads.map(r => <RoomCard key={r.id} room={r} onAction={onAction} />)}
        </div>
      </div>
      <div className="section">
        <h3>Když je čas</h3>
        <div className="room-list">
          {kdy.map(r => <RoomCard key={r.id} room={r} onAction={onAction} />)}
        </div>
      </div>
    </div>
  )
}
