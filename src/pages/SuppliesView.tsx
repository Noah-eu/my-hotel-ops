import React from 'react'
import { supplyRequests } from '../mockData'

export default function SuppliesView(){
  const chips = ['Toaletní papír','Pytle malé','Pytle velké','Tablety do myčky','Gel na praní','Lenor','Cif','Savo','Vodní kámen','Houbičky','Papírové utěrky','Baterky','Káva','Ručníky','Povlečení']
  return (
    <div>
      <div className="section">
        <h3>Rychlé požadavky</h3>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          {chips.map(c => <div key={c} className="chip">{c}</div>)}
        </div>
      </div>
      <div className="section">
        <h3>Požadavky</h3>
        <div className="room-list">
          {supplyRequests.map(s => (
            <div key={s.id} className="room-card">
              <div style={{flex:1}}>
                <div style={{fontWeight:700}}>{s.item} × {s.qty}</div>
                <div style={{fontSize:13,color:'#64748b'}}>{s.note || ''}</div>
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:6}}>
                <button className="chip">Odeslat</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
