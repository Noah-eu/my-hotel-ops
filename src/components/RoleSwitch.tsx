import React from 'react'
import { users } from '../mockData'

export function RoleSwitch({ current, onChange }: { current: string; onChange: (id: string) => void }) {
    return (
        <div className="role-switch">
            {users.map((u) => (
                <button key={u.id} className={`btn ${current === u.id ? 'active' : ''}`} onClick={() => onChange(u.id)}>
                    {u.name}
                </button>
            ))}
        </div>
    )
}
