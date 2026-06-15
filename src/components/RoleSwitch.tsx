import React from 'react'
import { users } from '../mockData'

export function RoleSwitch({ current, onChange }: { current: string; onChange: (id: string) => void }) {
    return (
        <div style={{width:'100%'}}>
            <div className="role-switch">
                {users.map((u) => (
                    <button key={u.id} className={`btn ${current === u.id ? 'active' : ''}`} onClick={() => onChange(u.id)}>
                        {u.name}
                    </button>
                ))}
            </div>
            <select className="role-select" value={current} onChange={(e) => onChange(e.target.value)} aria-label="Vyber roli">
                {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 6 }}>Demo režim – výběr osoby nahrazuje přihlášení.</div>
        </div>
    )
}
