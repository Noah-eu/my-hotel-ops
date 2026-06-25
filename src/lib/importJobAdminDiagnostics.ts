import { ImportJob } from '../types'

function normalizeStringArray(value: unknown) {
    if (!Array.isArray(value)) return []
    return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
}

function normalizeOptionalString(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : ''
}

export function buildImportJobAdminRenderState(job: ImportJob) {
    const warnings = normalizeStringArray(job.warnings)
    const backupAffectedDates = normalizeStringArray(job.backupSummary?.affectedDates)
    const autoConfirmMode = normalizeOptionalString(job.automation?.autoConfirm?.mode)
    const autoConfirmDecision = normalizeOptionalString(job.automation?.autoConfirm?.decision)
    const autoConfirmReason = normalizeOptionalString(job.automation?.autoConfirmReason)
    const autoConfirmedAt = normalizeOptionalString(job.automation?.autoConfirmedAt)

    const renderIssues: string[] = []
    if (!Array.isArray(job.warnings)) {
        renderIssues.push('missing-warnings')
    }
    if (job.backupSummary && !Array.isArray(job.backupSummary.affectedDates)) {
        renderIssues.push('missing-backup-dates')
    }

    return {
        warnings,
        backupAffectedDates,
        autoConfirmMode,
        autoConfirmDecision,
        autoConfirmReason,
        autoConfirmedAt,
        hasRenderIssues: renderIssues.length > 0,
        renderIssues
    }
}
