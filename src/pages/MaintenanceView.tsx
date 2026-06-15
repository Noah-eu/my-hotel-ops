import React from 'react'

const mock = [
    { id: 'm1', title: 'Zasekaná zásuvka v 101', status: 'open' },
    { id: 'm2', title: 'Kapání v koupelně 204', status: 'open' }
]

export default function MaintenanceView() {
    return (
        <div>
            <div className="section">
                <h3>Údržba</h3>
                <div className="room-list">
                    {mock.map(m => (
                        <div key={m.id} className="room-card">
                            <div style={{ flex: 1 }}>
                                <div style={{ fontWeight: 700 }}>{m.title}</div>
                                <div style={{ fontSize: 13, color: '#64748b' }}>Status: {m.status}</div>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                <button className="chip">Převzato</button>
                                <button className="chip">Hotovo</button>
                                <button className="chip">Potřebuji materiál</button>
                                <button className="chip">Nelze dnes</button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    )
}
