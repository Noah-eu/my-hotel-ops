import { ImportJob, ImportJobAutoConfirmMode, ImportJobSafetySummary } from '../types'

type ResolveImportAutoConfirmConfigInput = {
    explicitEnabledValue?: unknown
    legacyEnabledValue?: unknown
    legacyDryRunValue?: unknown
}

type ImportAutoConfirmConfigSource = 'VITE_PREVIO_AUTO_CONFIRM' | 'VITE_AUTO_CONFIRM_STAV_IMPORTS' | 'VITE_AUTO_CONFIRM_STAV_IMPORTS_DRY_RUN' | 'default'

export type ResolvedImportAutoConfirmConfig = {
    mode: ImportJobAutoConfirmMode
    enabled: boolean
    source: ImportAutoConfirmConfigSource
    explicitEnabled: boolean | null
    legacyEnabled: boolean | null
    legacyDryRun: boolean | null
}

type EvaluateImportAutoConfirmInput = {
    job: ImportJob
    mode: ImportJobAutoConfirmMode
    isNewestPrevioStateJob: boolean
    isSupersededPrevioStateJob: boolean
    hasByDate: boolean
    hasParsedTabDates: boolean
    safety: ImportJobSafetySummary | null
    likelyTestImport?: boolean
}

export function parseBooleanFlag(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) return null
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false
    return null
}

export function resolveImportAutoConfirmConfig(input: ResolveImportAutoConfirmConfigInput): ResolvedImportAutoConfirmConfig {
    const explicitEnabled = parseBooleanFlag(input.explicitEnabledValue)
    const legacyEnabled = parseBooleanFlag(input.legacyEnabledValue)
    const legacyDryRun = parseBooleanFlag(input.legacyDryRunValue)

    if (explicitEnabled === true) {
        return {
            mode: 'enabled',
            enabled: true,
            source: 'VITE_PREVIO_AUTO_CONFIRM',
            explicitEnabled,
            legacyEnabled,
            legacyDryRun
        }
    }

    if (explicitEnabled === false) {
        return {
            mode: 'off',
            enabled: false,
            source: 'VITE_PREVIO_AUTO_CONFIRM',
            explicitEnabled,
            legacyEnabled,
            legacyDryRun
        }
    }

    if (legacyEnabled === true) {
        return {
            mode: 'enabled',
            enabled: true,
            source: 'VITE_AUTO_CONFIRM_STAV_IMPORTS',
            explicitEnabled,
            legacyEnabled,
            legacyDryRun
        }
    }

    if (legacyEnabled === false && legacyDryRun === true) {
        return {
            mode: 'dry-run',
            enabled: false,
            source: 'VITE_AUTO_CONFIRM_STAV_IMPORTS_DRY_RUN',
            explicitEnabled,
            legacyEnabled,
            legacyDryRun
        }
    }

    return {
        mode: 'off',
        enabled: false,
        source: 'default',
        explicitEnabled,
        legacyEnabled,
        legacyDryRun
    }
}

function isSpreadsheetPrimaryImport(job: ImportJob) {
    const contentType = String(job.contentType || '').toLowerCase()
    if (contentType.includes('spreadsheet') || contentType.includes('excel') || contentType.includes('sheet')) return true

    const primaryKind = String(job.previewSummary?.diagnostics?.primary?.importKind || '').toLowerCase()
    return primaryKind === 'xls' || primaryKind === 'xlsx'
}

function hasBlockingOverlayMismatch(job: ImportJob) {
    const mismatchRows = job.previewSummary?.arrivalOverlayMismatchRows || []
    if (mismatchRows.length > 0) return true

    const auditMismatches = job.previewSummary?.diagnostics?.arrivalOverlay?.auditMismatches || 0
    return auditMismatches > 0
}

function parserDiagnosticsOk(job: ImportJob) {
    const diagnostics = job.previewSummary?.diagnostics
    if (!diagnostics) return false

    const processingPath = String(diagnostics.processingPath || '').trim()
    const parserVersion = String(job.previewSummary?.parserVersion || job.parserVersion || diagnostics.parserVersion || '').trim()
    if (!processingPath) return false
    if (!parserVersion) return false

    return true
}

function operationalMergeDiagnosticsOk(job: ImportJob) {
    const summary = job.confirmationDiagnostics?.operationalMerge || job.previewSummary?.diagnostics?.operationalMerge
    if (!summary) return true
    if (summary.status === 'failed') return false
    if ((summary.inconsistencyWarningCount || 0) > 0) return false
    return true
}

export function evaluateImportAutoConfirm(input: EvaluateImportAutoConfirmInput) {
    const {
        job,
        mode,
        isNewestPrevioStateJob,
        isSupersededPrevioStateJob,
        hasByDate,
        hasParsedTabDates,
        safety,
        likelyTestImport
    } = input

    const blockedReasons: string[] = []

    if (mode !== 'enabled') blockedReasons.push('Automatické potvrzení je vypnuté konfigurací.')
    if (job.type !== 'previo-state-pdf') blockedReasons.push('Podporován je jen Stav PDF import.')
    if (job.source !== 'email') blockedReasons.push('Automatické potvrzení je jen pro e-mailové importy.')
    if (likelyTestImport) blockedReasons.push('Import vypadá jako testovací; potvrďte ho ručně.')
    if (job.status === 'confirmed') blockedReasons.push('Import je už potvrzen.')
    if (job.status === 'cancelled') blockedReasons.push('Import je zrušený.')
    if (job.status !== 'needs_review') blockedReasons.push('Import není ve stavu čeká na kontrolu.')

    if (isSupersededPrevioStateJob || !isNewestPrevioStateJob) blockedReasons.push('Import není nejnovější.')

    if (!job.previewSummary?.preview) blockedReasons.push('Náhled importu není dostupný.')
    if (!hasByDate) blockedReasons.push('Není dostupné byDate pro potvrzení.')
    if (!hasParsedTabDates) blockedReasons.push('Není dostupné parsedTabDates pro potvrzení.')
    if (!isSpreadsheetPrimaryImport(job)) blockedReasons.push('Primární zdroj není XLS/XLSX.')

    if (!parserDiagnosticsOk(job)) blockedReasons.push('Diagnostika parseru není kompletní.')
    if (hasBlockingOverlayMismatch(job)) blockedReasons.push('Overlay mismatch blokuje automatické potvrzení.')
    if (!operationalMergeDiagnosticsOk(job)) blockedReasons.push('Diagnostika merge hlásí nekonzistenci.')

    if (!safety) {
        blockedReasons.push('Chybí bezpečnostní kontrola importu.')
    } else if (safety.blocked || safety.status !== 'ok') {
        blockedReasons.push('Bezpečnostní kontrola import blokuje.')
            ; (safety.blocks || []).slice(0, 3).forEach((reason) => {
                if (!blockedReasons.includes(reason)) blockedReasons.push(reason)
            })
    }

    const storedBlockedReasons = (job.automation?.autoConfirm?.blockedReasons || []).filter((reason) => !blockedReasons.includes(reason))
    const mergedBlockedReasons = [...blockedReasons, ...storedBlockedReasons]
    const eligible = mergedBlockedReasons.length === 0

    return {
        mode,
        eligible,
        wouldConfirm: eligible,
        blockedReasons: mergedBlockedReasons
    }
}
