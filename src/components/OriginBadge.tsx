import React from 'react'
import { UserRole } from '../types'

type OriginInput = {
    source?: 'manual' | 'previo' | 'legacy'
    stateSource?: string
    createdByUid?: string
    createdByName?: string
    createdByRole?: UserRole
    createdBy?: string
    reportedBy?: string
    requestedBy?: string
    importJobId?: string
    importedAt?: string
}

type OriginBadgeInfo = {
    code: string
    description: string
    title: string
}

function normalizeText(value?: string) {
    if (!value) return ''
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
}

function inferSource(input: OriginInput): 'manual' | 'previo' | 'legacy' | undefined {
    if (input.source) return input.source
    if (input.stateSource === 'previo-state-pdf') return 'previo'
    return undefined
}

function inferCleanerCode(identity: string) {
    if (!identity) return null
    if (/\bu\s*1\b/.test(identity) || /\buklid\s*1\b/.test(identity)) return 'U1'
    if (/\bu\s*2\b/.test(identity) || /\buklid\s*2\b/.test(identity)) return 'U2'
    if (/\bu\s*3\b/.test(identity) || /\buklid\s*3\b/.test(identity)) return 'U3'
    return null
}

export function resolveOriginBadge(input: OriginInput): OriginBadgeInfo {
    const source = inferSource(input)
    const role = input.createdByRole
    const identityRaw = [input.createdByUid, input.createdByName, input.createdBy, input.reportedBy, input.requestedBy]
        .filter((value): value is string => Boolean(value))
        .join(' | ')
    const identity = normalizeText(identityRaw)

    if (source === 'previo') {
        const details = [
            'Zdroj: Previo import',
            input.importJobId ? `Import job: ${input.importJobId}` : null,
            input.importedAt ? `Importovano: ${input.importedAt}` : null
        ].filter(Boolean).join(' | ')
        return {
            code: 'P',
            description: 'Previo import',
            title: details
        }
    }

    if (source === 'legacy') {
        return {
            code: '?',
            description: 'Legacy bez puvodu',
            title: 'Zdroj: Legacy zaznam bez metadata puvodu'
        }
    }

    if (role === 'admin' || identity.includes('david')) {
        return {
            code: 'D',
            description: 'Manualne David/admin',
            title: 'Zdroj: Manualne | Autor: David/admin'
        }
    }

    if (role === 'lead' || identity.includes('iryna')) {
        return {
            code: 'I',
            description: 'Manualne Iryna/lead',
            title: 'Zdroj: Manualne | Autor: Iryna/lead'
        }
    }

    if (role === 'maintenance' || identity.includes('serhii')) {
        return {
            code: 'S',
            description: 'Manualne Serhii/udrzba',
            title: 'Zdroj: Manualne | Autor: Serhii/udrzba'
        }
    }

    if (role === 'cleaner') {
        const cleanerCode = inferCleanerCode(identity)
        return {
            code: cleanerCode || 'U',
            description: cleanerCode ? `Manualne uklid ${cleanerCode}` : 'Manualne uklid',
            title: cleanerCode
                ? `Zdroj: Manualne | Autor: Uklid ${cleanerCode}`
                : 'Zdroj: Manualne | Autor: Uklid'
        }
    }

    const fallbackSource = source ? `Zdroj: ${source}` : 'Zdroj: neznamy'
    const fallbackIdentity = identityRaw ? `Autor: ${identityRaw}` : 'Autor: neni k dispozici'

    return {
        code: '?',
        description: 'Neznamy puvod',
        title: `${fallbackSource} | ${fallbackIdentity}`
    }
}

export default function OriginBadge({ input, hidePrevio = false }: { input: OriginInput; hidePrevio?: boolean }) {
    const source = inferSource(input)
    if (hidePrevio && source === 'previo') return null

    const info = resolveOriginBadge(input)

    return (
        <span
            title={info.title}
            aria-label={info.title}
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 22,
                height: 18,
                borderRadius: 999,
                border: '1px solid rgba(148,163,184,0.6)',
                background: '#f8fafc',
                color: '#0f172a',
                fontSize: 11,
                fontWeight: 800,
                lineHeight: 1,
                padding: '0 6px'
            }}
        >
            {info.code}
        </span>
    )
}
