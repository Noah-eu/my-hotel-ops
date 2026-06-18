import { UserRole } from '../types'

export function isAdminRole(role?: UserRole | string | null) {
    return role === 'admin'
}

export function isCleaningLeadRole(role?: UserRole | string | null) {
    return role === 'lead' || role === 'iryna'
}

export function isCleanerRole(role?: UserRole | string | null) {
    return role === 'cleaner'
}

export function isMaintenanceRole(role?: UserRole | string | null) {
    return role === 'maintenance'
}

export function isCleaningStaffRole(role?: UserRole | string | null) {
    return isCleaningLeadRole(role) || isCleanerRole(role)
}

export function roleLabel(role?: UserRole | string | null) {
    if (isAdminRole(role)) return 'Admin'
    if (isCleaningLeadRole(role)) return 'Vedoucí úklidu'
    if (isCleanerRole(role)) return 'Úklid'
    if (isMaintenanceRole(role)) return 'Údržba'
    return 'Úklid'
}
