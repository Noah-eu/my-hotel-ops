import React from 'react'
import { roomPlans, supplyRequests } from '../mockData'

export default function AdminDashboard() {
  const hotove = roomPlans.filter(r => r.status === 'hotovo').length
  const ceka = roomPlans.filter(r => r.status === 'ceka').length
  const problemy = roomPlans.filter(r => r.status === 'probihá').length
  const nakupy = supplyRequests.filter(s => s.status === 'open').length

  return (
    <div>
      <div className="section">
        <h3>Rychlý přehled</h3>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          <div className="room-card"><div className="room-number">Hotové pokoje</div><div className="room-meta">{hotove}</div></div>
          <div className="room-card"><div className="room-number">Čeká na úklid</div><div className="room-meta">{ceka}</div></div>
          <div className="room-card"><div className="room-number">Problémy</div><div className="room-meta">{problemy}</div></div>
          <div className="room-card"><div className="room-number">Nákupy</div><div className="room-meta">{nakupy}</div></div>
        </div>
      </div>
      <div className="section">
        <h3>Kdo je dnes v práci</h3>
        <div className="room-list">
          <div className="room-card">David - Admin</div>
          <div className="room-card">Iryna - Vedoucí úklidu</div>
          <div className="room-card">Karla - Uklízečka</div>
        </div>
      </div>
    </div>
  )
}
