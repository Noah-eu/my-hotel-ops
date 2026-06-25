import React, { useMemo, useState, useEffect, useRef } from 'react'
import type { User } from 'firebase/auth'
import { collection, doc, getDoc, getDocs, setDoc } from 'firebase/firestore'
import { RoleSwitch } from './components/RoleSwitch'
import DashboardToday from './pages/DashboardToday'
import RoomSheetView from './pages/RoomSheetView'
import TeamOverview from './pages/TeamOverview'
import MaintenanceView from './pages/MaintenanceView'
import SuppliesView from './pages/SuppliesView'
import { roomPlansByDay, users, supplyRequests as initialSupplyRequests, maintenanceItems as initialMaintenanceItems } from './mockData'
import {
    Availability,
    ImportJob,
    ImportJobAutoConfirmMode,
    ImportJobBackupPayload,
    ImportJobBackupSummary,
    ImportJobSafetySummary,
    RoomPlan,
    RoomPlanScheduleSnapshot,
    MaintenanceItem,
    SupplyRequest,
    StaffAvailabilityRecord,
    Task,
    UserRole
} from './types'
import {
    appMode,
    firebaseEnvDiagnostics,
    firestoreDb,
    onFirebaseAuthState,
    signInWithEmailPassword,
    signOutFirebaseUser
} from './lib/firebase'
import { runRollbackBackupSanitizerSelfCheck, sanitizeForFirestore } from './lib/firestoreSanitizer'
import { buildDateSelectorItems, getPrimaryTabDateIso, parseIsoDateForDisplay, resolveEffectiveDateIso, toLocalDateIso } from './lib/dateTabs'
import { applyRoomOperationalPatch, buildOperationalStatusMeta, buildResetRoomToWaitingPatch } from './lib/roomOperationalState'
import { evaluateImportAutoConfirm } from './lib/importAutoConfirm'
import {
    mergeImportedByDateWithExistingOperationalState,
    mergeImportedRoomDayWithExistingOperationalState,
    type OperationalMergeDiagnostic,
    summarizeOperationalMergeDiagnostics
} from './lib/importOperationalMerge'
import { isAdminRole, isCleanerRole, isCleaningLeadRole, isCleaningStaffRole, isMaintenanceRole, roleLabel } from './lib/roles'
import { applyCarryOverResolution, applySupplyStatusUpdate, buildCarryOverResolutionPatch, buildCustomSupplyChipKey, buildSupplyStatusPatch, canManageSupplyLifecycle, canSetSupplyStatus, isOpenSupplyStatus, type SupplyChipSection } from './lib/opsUiInvariants'
import { AppLanguage, createTranslator, getLanguageLocale, LANGUAGE_STORAGE_KEY, resolveLanguage } from './i18n'
import { canManageStaffAvailability, resolveStaffAvailabilityForDate, upsertStaffAvailabilityRecord } from './lib/teamAvailability'
import { applyMaintenanceTaskStatus, canCreateMaintenanceSelfTask, createMaintenanceSelfTask } from './lib/maintenanceSelfTask'
import { createFirebaseOpsStore, createLocalOpsStore } from './services'
import { OpsPersistedState, OpsTab } from './services/opsStore'
import { ONLINE_HOTEL_ID } from './services/firebaseOpsStore'
import {
    buildPrevioImportPreview,
    extractTextFromPdfFile,
    getDefaultRoomCatalog,
    parsePrevioPdfText,
    type PrevioParseResult,
    type PrevioImportPreview,
    type RoomCatalogItem
} from './services/previoPdfParser'
import {
    buildPrevioStateImportPreview,
    evaluatePrevioStateImportSafety,
    extractStateDataFromXlsxFile,
    extractStateTextFromPdfFile,
    MASTER_ROOM_NUMBERS,
    PREVIO_STAV_PARSER_VERSION,
    parsePrevioStatePdfText,
    parsePrevioStateXlsxData,
    type PrevioStateImportPreview,
    type PrevioStateParseResult
} from './services/previoStatePdfParser'

type AppDiagnostics = {
    firebaseConfigured: boolean
    missingEnvVars: string[]
    intendedMode: 'demo' | 'online'
    activeMode: 'demo' | 'online' | 'fallback'
    authStatus: 'not_started' | 'signed_out' | 'signing_in' | 'signed_in_email' | 'signed_in_anonymous' | 'error'
    authUid?: string
    isAnonymous?: boolean
    profileLoaded?: boolean
    firestoreStatus: 'not_started' | 'seeding' | 'listening' | 'connected' | 'permission_denied' | 'error'
    supplySyncCount?: number
    hotelId: string
    lastErrorCode?: string
    lastErrorMessage?: string
}

type StaffMember = {
    id: string
    name: string
    role: UserRole
    availability?: 'dnes_pracuji' | 'dnes_nepracuji' | 'jen_urgentni'
}

type OnlineStaffProfile = StaffMember & {
    uid: string
    active: boolean
}

function extractErrorInfo(error: any): { code?: string; message: string } {
    return {
        code: error?.code,
        message: error?.message || 'Neznámá chyba'
    }
}

type RoomAction = 'prevzit' | 'odhad' | 'hotovo' | 'problem' | 'host_zustava' | 'clear_exception' | 'resolve_carry_over' | 'reset_to_waiting'

type RoomActionPayload = {
    estimateTime?: string
    relativeMinutes?: number
    problemText?: string
}

type CreateTaskInput = {
    title: string
    category: Task['category']
    priority: Task['priority']
    assignedToRole: Extract<UserRole, 'lead' | 'cleaner' | 'maintenance'>
    note?: string
}

type ReportRoomProblemInput = {
    description: string
    priority: Task['priority']
}

type LateTaskRoomFocusRequest = {
    requestId: number
    roomNumber: string
}

type MaintenanceAttentionTarget = {
    id: string
    kind: 'task' | 'item'
    roomNumber?: string
    createdAt: string
    sortGroup: number
    priority: 'normal' | 'urgent'
}

type MaintenanceFocusRequest = {
    requestId: number
    targetId: string
    targetKind: 'task' | 'item'
}

function isRoomLikelyAlreadyTouched(room: RoomPlan) {
    if (room.status === 'prevzato' || room.status === 'probihá' || room.status === 'odhad' || room.status === 'hotovo' || room.status === 'problem') return true
    if (room.occupiedConfirmed || room.freeConfirmed) return true
    if (Boolean(room.assigned)) return true
    if (Boolean(room.estimatedReady || room.estimateSetAt)) return true
    if (Boolean(room.checkoutException || room.statusNote)) return true
    return false
}

type CreateSupplyRequestInput = {
    itemName: string
    category: SupplyRequest['category']
    quantityLevel: SupplyRequest['quantityLevel']
    customQuantity?: string
    roomNumber?: string
    note?: string
    priority: SupplyRequest['priority']
}

type StateImportDayRow = PrevioStateImportPreview['days'][number]['rows'][number]

type ImportJobInlinePreviewRow = {
    dateIso: string
    roomNumber: string
    departureTime?: string
    arrivalTime?: string
    departureGuestName?: string
    departureGuestCount?: number
    arrivalGuestName?: string
    arrivalGuestCount?: number
    departureNotes: string[]
    arrivalNotes: string[]
    isStayover: boolean
}

type ImportJobInlinePreviewModel = {
    detectedDaysCount: number
    turnoverCount: number
    stayoverCount: number
    freeCount: number
    warnings: string[]
    rows: ImportJobInlinePreviewRow[]
    byDate: Record<string, RoomPlan[]> | null
    parsedTabDates: Partial<Record<OpsTab, string>> | null
    parserVersion?: string
    safety?: ImportJobSafetySummary
}

type ImportCleanupMode = 'test_unconfirmed' | 'old'
type ImportCleanupAction = 'superseded' | 'test_unconfirmed' | 'old' | 'single'
type RollbackAvailability = 'checking' | 'available' | 'legacy'

type ImportCleanupFeedback = {
    tone: 'info' | 'success' | 'warning' | 'error'
    message: string
    candidates: number
    deletedJobs: number
    deletedPdfs: number
    skippedProtected: number
    storageWarnings: number
    notFound: number
}

type AdminImportGroup = 'current' | 'pending'

type ImportAutoConfirmEvaluation = {
    mode: ImportJobAutoConfirmMode
    eligible: boolean
    wouldConfirm: boolean
    blockedReasons: string[]
}

type ImportAutoPreviewStatusInfo = {
    status: 'pending' | 'done' | 'error'
    checkedAt?: string
    error?: string
}

const IMPORT_CLEANUP_PRECHECK_MESSAGE = 'Kontrola akce…'

const APP_SHORT_NAME = import.meta.env.VITE_APP_SHORT_NAME || 'Chill Ops'
function readBooleanViteEnv(value: unknown, fallback: boolean) {
    if (typeof value !== 'string' || !value.trim()) return fallback
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false
    return fallback
}

const AUTO_CONFIRM_STAV_IMPORTS_ENABLED = readBooleanViteEnv(
    import.meta.env.VITE_PREVIO_AUTO_CONFIRM,
    readBooleanViteEnv(import.meta.env.VITE_AUTO_CONFIRM_STAV_IMPORTS, false)
)
const AUTO_CONFIRM_STAV_IMPORTS_MODE: ImportJobAutoConfirmMode = AUTO_CONFIRM_STAV_IMPORTS_ENABLED ? 'enabled' : 'off'

const IMPORT_CONFIRM_BLOCKED_MESSAGE = 'Import nelze potvrdit, protože kontrola náhledu našla chyby. Přegenerujte náhled nebo opravte parser.'
const IMPORT_CONFIRM_SUPERSEDED_MESSAGE = 'Tento import je starší než novější Stav PDF. Nepotvrzujte ho.'
const IMPORT_CLEANUP_OLD_DAYS = 30

function importAutoConfirmModeLabel(mode: ImportJobAutoConfirmMode) {
    if (mode === 'enabled') return 'Zapnuto'
    return 'Vypnuto'
}

function importAutoPreviewStatusLabel(status: ImportAutoPreviewStatusInfo['status']) {
    if (status === 'done') return 'hotovo'
    if (status === 'error') return 'chyba'
    return 'čeká'
}

function resolveImportJobAutoPreviewStatus(job: ImportJob): ImportAutoPreviewStatusInfo | null {
    const fromAutomation = job.automation?.autoPreview
    if (fromAutomation) {
        return {
            status: fromAutomation.status,
            checkedAt: fromAutomation.checkedAt,
            error: fromAutomation.error
        }
    }

    if (job.source !== 'email') return null

    if (job.status === 'failed') {
        return {
            status: 'error',
            error: job.error
        }
    }

    if (job.previewSummary?.byDate) {
        return {
            status: 'done',
            checkedAt: job.parsedAt
        }
    }

    return {
        status: 'pending'
    }
}

function evaluateImportJobAutoConfirm(params: {
    job: ImportJob
    mode: ImportJobAutoConfirmMode
    isNewestPrevioStateJob: boolean
    isSupersededPrevioStateJob: boolean
    hasByDate: boolean
    hasParsedTabDates: boolean
    safety: ImportJobSafetySummary | null
}) {
    const {
        job,
        mode,
        isNewestPrevioStateJob,
        isSupersededPrevioStateJob,
        hasByDate,
        hasParsedTabDates,
        safety
    } = params

    return evaluateImportAutoConfirm({
        job,
        mode,
        isNewestPrevioStateJob,
        isSupersededPrevioStateJob,
        hasByDate,
        hasParsedTabDates,
        safety,
        likelyTestImport: likelyTestImportJob(job)
    }) satisfies ImportAutoConfirmEvaluation
}

if (import.meta.env.DEV) {
    runRollbackBackupSanitizerSelfCheck()
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
}

function normalizeNotes(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
}

function roomSortKey(roomNumber: string) {
    const digits = String(roomNumber || '').replace(/\D/g, '')
    if (!digits) return Number.MAX_SAFE_INTEGER
    return Number(digits)
}

function sortInlinePreviewRows(rows: ImportJobInlinePreviewRow[]) {
    return [...rows].sort((left, right) => {
        if (left.dateIso !== right.dateIso) return left.dateIso.localeCompare(right.dateIso)
        const leftRoom = roomSortKey(left.roomNumber)
        const rightRoom = roomSortKey(right.roomNumber)
        if (leftRoom !== rightRoom) return leftRoom - rightRoom
        return left.roomNumber.localeCompare(right.roomNumber)
    })
}

function getImportJobByDate(summary: ImportJob['previewSummary']): Record<string, RoomPlan[]> | null {
    const summaryRecord = asRecord(summary)
    if (!summaryRecord) return null

    const byDateRaw = asRecord(summaryRecord.byDate)
    if (!byDateRaw) return null

    const byDate: Record<string, RoomPlan[]> = {}
    Object.entries(byDateRaw).forEach(([dateIso, rooms]) => {
        if (!Array.isArray(rooms)) return
        byDate[dateIso] = rooms as RoomPlan[]
    })

    return Object.keys(byDate).length > 0 ? byDate : null
}

function getImportJobParsedTabDates(summary: ImportJob['previewSummary']): Partial<Record<OpsTab, string>> | null {
    const summaryRecord = asRecord(summary)
    if (!summaryRecord) return null

    const parsedRaw = asRecord(summaryRecord.parsedTabDates)
    if (!parsedRaw) return null

    const parsed: Partial<Record<OpsTab, string>> = {}
        ; (['Dnes', 'Zitra', 'Pozitri'] as OpsTab[]).forEach((day) => {
            const value = parsedRaw[day]
            if (typeof value === 'string' && value.trim()) parsed[day] = value
        })

    return Object.keys(parsed).length > 0 ? parsed : null
}

const DEBUG_PROBE_ROW_KEYS = [
    '2026-06-21/105',
    '2026-06-21/201',
    '2026-06-22/201',
    '2026-06-22/202',
    '2026-06-24/205',
    '2026-06-24/303'
]

function getImportJobPreviewDiagnostics(summary: ImportJob['previewSummary']) {
    const summaryRecord = asRecord(summary)
    if (!summaryRecord) return null

    const nestedDiagnostics = asRecord(summaryRecord.diagnostics)
    const nestedPrimary = asRecord(nestedDiagnostics?.primary)

    const parserBuildId = typeof summaryRecord.parserBuildId === 'string'
        ? summaryRecord.parserBuildId
        : (typeof nestedDiagnostics?.parserBuildId === 'string' ? nestedDiagnostics.parserBuildId : '')
    const parserFileVersion = typeof summaryRecord.parserFileVersion === 'string'
        ? summaryRecord.parserFileVersion
        : (typeof nestedDiagnostics?.parserFileVersion === 'string' ? nestedDiagnostics.parserFileVersion : '')
    const previewGeneratedAt = typeof summaryRecord.previewGeneratedAt === 'string' ? summaryRecord.previewGeneratedAt : ''
    const previewGeneratedBy = typeof summaryRecord.previewGeneratedBy === 'string' ? summaryRecord.previewGeneratedBy : ''
    const sourceStoragePath = typeof summaryRecord.sourceStoragePath === 'string'
        ? summaryRecord.sourceStoragePath
        : (typeof nestedPrimary?.storagePath === 'string' ? nestedPrimary.storagePath : '')
    const previewRequestId = typeof summaryRecord.previewRequestId === 'string' ? summaryRecord.previewRequestId : ''
    const previewFreshGenerated = summaryRecord.previewFreshGenerated === true
        || nestedDiagnostics?.previewFreshGenerated === true

    const debugProbeRowsRaw = asRecord(summaryRecord.debugProbeRows)
    const debugProbeRows: Record<string, {
        departureTime: string
        arrivalTime: string
        departureGuest: string
        departureCount: number | null
        arrivalGuest: string
        arrivalCount: number | null
        departureNotes: string[]
        arrivalNotes: string[]
    } | null> = {}

    DEBUG_PROBE_ROW_KEYS.forEach((key) => {
        const row = asRecord(debugProbeRowsRaw?.[key])
        if (!row) {
            debugProbeRows[key] = null
            return
        }

        debugProbeRows[key] = {
            departureTime: typeof row.departureTime === 'string' ? row.departureTime : '',
            arrivalTime: typeof row.arrivalTime === 'string' ? row.arrivalTime : '',
            departureGuest: typeof row.departureGuest === 'string' ? row.departureGuest : '',
            departureCount: typeof row.departureCount === 'number' ? row.departureCount : null,
            arrivalGuest: typeof row.arrivalGuest === 'string' ? row.arrivalGuest : '',
            arrivalCount: typeof row.arrivalCount === 'number' ? row.arrivalCount : null,
            departureNotes: normalizeNotes(row.departureNotes),
            arrivalNotes: normalizeNotes(row.arrivalNotes)
        }
    })

    return {
        parserBuildId,
        parserFileVersion,
        previewGeneratedAt,
        previewGeneratedBy,
        sourceStoragePath,
        previewRequestId,
        previewFreshGenerated,
        debugProbeRows
    }
}

function buildInlineRowsFromByDate(byDate: Record<string, RoomPlan[]>): ImportJobInlinePreviewRow[] {
    const rows: ImportJobInlinePreviewRow[] = []

    Object.entries(byDate).forEach(([dateIso, dayRooms]) => {
        dayRooms.forEach((room) => {
            const departureTime = room.departureTime || room.departure?.time
            const arrivalTime = room.arrivalTime || room.arrival?.time
            const stayoverGuestName = room.stayoverGuestName || room.departure?.guestLabel
            const isStayover = Boolean(!departureTime && !arrivalTime && (stayoverGuestName || room.occupiedConfirmed))

            if (!departureTime && !arrivalTime && !isStayover) return

            rows.push({
                dateIso,
                roomNumber: String(room.number || room.id || ''),
                departureTime,
                arrivalTime,
                departureGuestName: room.departure?.guestLabel || (isStayover ? stayoverGuestName : undefined),
                departureGuestCount: room.departure?.guestCount,
                arrivalGuestName: room.arrival?.guestLabel,
                arrivalGuestCount: room.arrival?.guestCount,
                departureNotes: normalizeNotes(room.departure?.notes),
                arrivalNotes: normalizeNotes(room.arrival?.notes),
                isStayover
            })
        })
    })

    return sortInlinePreviewRows(rows)
}

function buildImportJobInlinePreviewModel(job: ImportJob): ImportJobInlinePreviewModel | null {
    const summaryRecord = asRecord(job.previewSummary)
    if (!summaryRecord) return null

    const byDate = getImportJobByDate(job.previewSummary)
    const parsedTabDates = getImportJobParsedTabDates(job.previewSummary)
    const previewRaw = summaryRecord.preview
    const parserVersion = typeof summaryRecord.parserVersion === 'string'
        ? summaryRecord.parserVersion
        : job.parserVersion
    const safetyRaw = asRecord(summaryRecord.safety)
    const safety = safetyRaw ? (safetyRaw as unknown as ImportJobSafetySummary) : undefined

    if (previewRaw && typeof previewRaw === 'object') {
        const preview = previewRaw as {
            days?: Array<{
                dateIso: string
                rows: Array<{
                    departureTime?: string
                    arrivalTime?: string
                    departureGuestName?: string
                    departureGuestCount?: number
                    arrivalGuestName?: string
                    arrivalGuestCount?: number
                    stayoverGuestName?: string
                    departureNotes?: string[]
                    arrivalNotes?: string[]
                    isStayover?: boolean
                    roomNumber: string
                }>
            }>
            warnings?: string[]
            turnoverCount?: number
            stayoverCount?: number
            derivedFreeCount?: number
        }

        if (Array.isArray(preview.days)) {
            const flattenedRows = preview.days.flatMap((day) => {
                if (!Array.isArray(day.rows)) return []
                return day.rows.map((row) => ({
                    dateIso: day.dateIso,
                    roomNumber: String(row.roomNumber || ''),
                    departureTime: row.departureTime,
                    arrivalTime: row.arrivalTime,
                    departureGuestName: row.departureGuestName || (row.isStayover ? row.stayoverGuestName : undefined),
                    departureGuestCount: typeof row.departureGuestCount === 'number' ? row.departureGuestCount : undefined,
                    arrivalGuestName: row.arrivalGuestName,
                    arrivalGuestCount: typeof row.arrivalGuestCount === 'number' ? row.arrivalGuestCount : undefined,
                    departureNotes: normalizeNotes(row.departureNotes),
                    arrivalNotes: normalizeNotes(row.arrivalNotes),
                    isStayover: Boolean(row.isStayover)
                }))
            })

            const fallbackRows = byDate ? buildInlineRowsFromByDate(byDate) : []

            return {
                detectedDaysCount: preview.days.length,
                turnoverCount: typeof preview.turnoverCount === 'number' ? preview.turnoverCount : (job.turnoverCount ?? 0),
                stayoverCount: typeof preview.stayoverCount === 'number' ? preview.stayoverCount : (job.stayoverCount ?? 0),
                freeCount: typeof preview.derivedFreeCount === 'number' ? preview.derivedFreeCount : (job.freeCount ?? 0),
                warnings: normalizeNotes(preview.warnings),
                rows: flattenedRows.length > 0 ? sortInlinePreviewRows(flattenedRows) : fallbackRows,
                byDate,
                parsedTabDates,
                parserVersion,
                safety
            }
        }
    }

    if (!byDate) return null

    const byDateRows = buildInlineRowsFromByDate(byDate)
    const missingDateLabels = normalizeNotes(summaryRecord.missingDateLabels)

    return {
        detectedDaysCount: typeof job.detectedDaysCount === 'number' ? job.detectedDaysCount : Object.keys(byDate).length,
        turnoverCount: typeof job.turnoverCount === 'number'
            ? job.turnoverCount
            : byDateRows.filter((row) => Boolean(row.departureTime || row.arrivalTime)).length,
        stayoverCount: typeof job.stayoverCount === 'number'
            ? job.stayoverCount
            : byDateRows.filter((row) => row.isStayover).length,
        freeCount: typeof job.freeCount === 'number'
            ? job.freeCount
            : Object.values(byDate).reduce((sum, rooms) => sum + rooms.filter((room) => room.freeConfirmed).length, 0),
        warnings: missingDateLabels.length > 0
            ? missingDateLabels.map((label) => `Chybějící den: ${label}`)
            : normalizeNotes(job.warnings),
        rows: byDateRows,
        byDate,
        parsedTabDates,
        parserVersion,
        safety
    }
}

function formatPreviewRowDate(dateIso: string) {
    const parsed = new Date(`${dateIso}T00:00:00`)
    if (Number.isNaN(parsed.getTime())) return dateIso
    return parsed.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' })
}

function isCleaningDomain(category: SupplyRequest['category']) {
    return category !== 'maintenance'
}

function canViewTask(role: UserRole, task: Task) {
    if (isAdminRole(role)) return true
    if (isCleaningLeadRole(role)) return task.category === 'cleaning' || task.assignedToRole === 'lead' || task.assignedToRole === 'cleaner'
    if (isCleanerRole(role)) return task.category === 'cleaning' || task.assignedToRole === 'cleaner'
    if (isMaintenanceRole(role)) return task.assignedToRole === 'maintenance'
    return false
}

function matchesOperationalTaskDate(task: Task, effectiveDateIso: string, todayDateIso: string) {
    if (task.taskDateIso) return task.taskDateIso === effectiveDateIso
    return effectiveDateIso === todayDateIso
}

function defaultAssigneeName(role: Task['assignedToRole']) {
    if (role === 'lead') return 'Iryna'
    if (role === 'cleaner') return 'Uklízečka'
    if (role === 'maintenance') return 'Údržbář'
    return undefined
}

function importJobStatusLabel(status: ImportJob['status']) {
    if (status === 'received') return 'Přijato'
    if (status === 'parsed') return 'Parsováno'
    if (status === 'needs_review') return 'Čeká na kontrolu'
    if (status === 'confirmed') return 'Potvrzeno'
    if (status === 'failed') return 'Chyba'
    if (status === 'cancelled') return 'Zrušeno'
    return status
}

function importJobStatusStyle(status: ImportJob['status']) {
    if (status === 'confirmed') return { background: '#dcfce7', color: '#166534', border: '1px solid #86efac' }
    if (status === 'needs_review') return { background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d' }
    if (status === 'failed') return { background: '#fee2e2', color: '#991b1b', border: '1px solid #fca5a5' }
    if (status === 'cancelled') return { background: '#e2e8f0', color: '#475569', border: '1px solid #cbd5e1' }
    if (status === 'parsed') return { background: '#dbeafe', color: '#1e3a8a', border: '1px solid #93c5fd' }
    return { background: '#e0f2fe', color: '#0c4a6e', border: '1px solid #7dd3fc' }
}

function importJobSortTimestamp(job: ImportJob) {
    const candidate = job.receivedAt || job.parsedAt || job.confirmedAt
    if (!candidate) return 0
    const ms = new Date(candidate).getTime()
    return Number.isNaN(ms) ? 0 : ms
}

function getLatestPrevioStateJob(jobs: ImportJob[]) {
    const sorted = jobs
        .filter((job) => job.type === 'previo-state-pdf')
        .sort((a, b) => {
            const tsDiff = importJobSortTimestamp(b) - importJobSortTimestamp(a)
            if (tsDiff !== 0) return tsDiff
            return (b.receivedAt || '').localeCompare(a.receivedAt || '')
        })
    return sorted[0] || null
}

function getSupersededPrevioStateJobIds(jobs: ImportJob[]) {
    const newest = getLatestPrevioStateJob(jobs)
    if (!newest) return new Set<string>()

    const newestTs = importJobSortTimestamp(newest)
    const superseded = new Set<string>()

    jobs.forEach((job) => {
        if (job.type !== 'previo-state-pdf') return
        if (job.id === newest.id) return
        if (job.status === 'confirmed' || job.status === 'cancelled') return
        if (importJobSortTimestamp(job) <= newestTs) {
            superseded.add(job.id)
        }
    })

    return superseded
}

function getSupersededUnconfirmedPrevioJobs(jobs: ImportJob[]) {
    const supersededIds = getSupersededPrevioStateJobIds(jobs)
    return jobs.filter((job) => supersededIds.has(job.id))
}

function formatBytes(bytes?: number) {
    if (!bytes || bytes <= 0) return '—'
    if (bytes < 1024) return `${bytes} B`
    const kb = bytes / 1024
    if (kb < 1024) return `${kb.toFixed(1)} KB`
    const mb = kb / 1024
    return `${mb.toFixed(2)} MB`
}

function normalizeTaskTitleForCleanup(value: string) {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
}

function shouldCleanupTestTask(title: string) {
    const normalized = normalizeTaskTitleForCleanup(title)
    if (!normalized) return false

    const exactMatches = new Set([
        'najit zapomenutou vec',
        'pripravit gauc',
        'extra rucniky'
    ])

    return exactMatches.has(normalized) || normalized.includes('test')
}

function formatLocalDateIso(date: Date) {
    const y = date.getFullYear()
    const m = `${date.getMonth() + 1}`.padStart(2, '0')
    const d = `${date.getDate()}`.padStart(2, '0')
    return `${y}-${m}-${d}`
}

function detectMissingDatesInRange(dateIsos: string[]) {
    const sorted = Array.from(new Set(dateIsos)).sort()
    if (sorted.length < 2) return []

    const missing: string[] = []
    for (let i = 0; i < sorted.length - 1; i++) {
        const start = new Date(`${sorted[i]}T00:00:00`)
        const end = new Date(`${sorted[i + 1]}T00:00:00`)
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue

        const cursor = new Date(start)
        cursor.setDate(cursor.getDate() + 1)
        while (cursor < end) {
            missing.push(formatLocalDateIso(cursor))
            cursor.setDate(cursor.getDate() + 1)
        }
    }

    return missing
}

function toMinutesSafe(value?: string) {
    if (!value || !/^\d{1,2}:\d{2}$/.test(value)) return null
    const [h, m] = value.split(':').map(Number)
    return h * 60 + m
}

function buildPreviewSafetyFallbackWarnings(preview: PrevioStateImportPreview, missingDateLabels: string[]) {
    const warnings: string[] = []

    const turnoverRows = preview.days.flatMap((day) => day.rows).filter((row) => Boolean(row.departureTime || row.arrivalTime))
    const arrivals = turnoverRows.filter((row) => Boolean(row.arrivalTime))
    const departures = turnoverRows.filter((row) => Boolean(row.departureTime))

    const suspiciousNightRows = turnoverRows.filter((row) => {
        const dep = toMinutesSafe(row.departureTime)
        const arr = toMinutesSafe(row.arrivalTime)
        return (dep !== null && dep >= 60 && dep <= 450) || (arr !== null && arr >= 60 && arr <= 450)
    })
    if (preview.amPmEvidence && suspiciousNightRows.length > 0) {
        warnings.push('Detekovány podezřelé noční časy (01:00-07:30) v AM/PM režimu.')
    }

    const arrivalsAtEleven = arrivals.filter((row) => row.arrivalTime === '11:00').length
    if (arrivals.length >= 4 && arrivalsAtEleven >= 3 && arrivalsAtEleven / arrivals.length >= 0.35) {
        warnings.push('Příliš mnoho příjezdů je přesně v 11:00.')
    }

    const departuresBeforeEight = departures.filter((row) => {
        const minute = toMinutesSafe(row.departureTime)
        return minute !== null && minute < 8 * 60
    }).length
    if (departures.length >= 4 && departuresBeforeEight >= 3 && departuresBeforeEight / departures.length >= 0.35) {
        warnings.push('Příliš mnoho odjezdů je před 08:00.')
    }

    const turnoverRowsMissingGuestName = turnoverRows.filter((row) => {
        const missingDepartureGuest = Boolean(row.departureTime && !row.departureGuestName)
        const missingArrivalGuest = Boolean(row.arrivalTime && !row.arrivalGuestName)
        return missingDepartureGuest || missingArrivalGuest
    }).length
    if (turnoverRows.length >= 6 && turnoverRowsMissingGuestName >= 4 && turnoverRowsMissingGuestName / turnoverRows.length >= 0.3) {
        warnings.push('U mnoha turnover řádků chybí jména hostů.')
    }

    if (preview.parsedDateCount > preview.days.length) {
        warnings.push('Počet dnů v náhledu je nižší než počet dnů detekovaných v PDF.')
    }

    const minimumExpectedRows = Math.max(12, preview.days.length * 6)
    if (preview.parsedRows < minimumExpectedRows) {
        warnings.push(`Počet parsovaných řádků je nečekaně nízký (${preview.parsedRows}).`)
    }

    if (missingDateLabels.length > 0) {
        warnings.push(`V náhledu chybí dny uprostřed rozsahu: ${missingDateLabels.join(', ')}`)
    }

    if (preview.confidenceLow) {
        warnings.push('Import není bezpečný podle confidenceLow parseru.')
    }

    let totalsMismatchDetected = false
    const dayByIso = new Map(preview.days.map((day) => [day.dateIso, day]))
    Object.entries(preview.dayTotals || {}).forEach(([dateIso, totals]) => {
        const day = dayByIso.get(dateIso)
        if (!day) return

        const arrivalsCount = day.rows.filter((row) => Boolean(row.arrivalTime)).length
        const departuresCount = day.rows.filter((row) => Boolean(row.departureTime)).length
        const arrivalGuests = day.rows.reduce((sum, row) => sum + (typeof row.arrivalGuestCount === 'number' ? row.arrivalGuestCount : 0), 0)
        const departureGuests = day.rows.reduce((sum, row) => sum + (typeof row.departureGuestCount === 'number' ? row.departureGuestCount : 0), 0)

        const effectiveArrivals = arrivalGuests > 0 ? arrivalGuests : arrivalsCount
        const effectiveDepartures = departureGuests > 0 ? departureGuests : departuresCount

        const mismatchArrivals = typeof totals.arrivals === 'number'
            && Math.abs(effectiveArrivals - totals.arrivals) > Math.max(2, Math.round(totals.arrivals * 0.2))
        const mismatchDepartures = typeof totals.departures === 'number'
            && Math.abs(effectiveDepartures - totals.departures) > Math.max(2, Math.round(totals.departures * 0.2))

        if (mismatchArrivals || mismatchDepartures) {
            totalsMismatchDetected = true
        }
    })
    if (totalsMismatchDetected) {
        warnings.push('Počty v náhledu nesedí s řádkem Celkem v PDF.')
    }

    return warnings
}

function resolveImportSafety(
    preview: PrevioStateImportPreview | null,
    missingDateLabels: string[],
    parserVersion?: string,
    storedSafety?: ImportJobSafetySummary
): ImportJobSafetySummary | null {
    if (!preview) return null

    const evaluated = evaluatePrevioStateImportSafety({
        preview,
        missingDateLabels,
        parserVersion,
        checkedAt: new Date()
    })

    if (!storedSafety) {
        return evaluated
    }

    const mergedWarnings = Array.from(new Set([
        ...(storedSafety.warnings || []),
        ...(storedSafety.blocks || []),
        ...buildPreviewSafetyFallbackWarnings(preview, missingDateLabels),
        ...evaluated.warnings,
        ...evaluated.blocks
    ]))

    const parserVersionMissing = storedSafety.parserVersionMissing || evaluated.parserVersionMissing
    const parserVersionOutdated = storedSafety.parserVersionOutdated || evaluated.parserVersionOutdated
    const blocked = Boolean(storedSafety.blocked || evaluated.blocked)

    return {
        status: blocked ? 'blocked' : 'ok',
        blocked,
        warnings: mergedWarnings,
        blocks: mergedWarnings,
        checkedAt: evaluated.checkedAt,
        parserVersion: parserVersion || storedSafety.parserVersion || PREVIO_STAV_PARSER_VERSION,
        parserVersionMissing,
        parserVersionOutdated,
        metrics: evaluated.metrics
    }
}

const SCHEDULE_RESTORE_DEFAULTS: RoomPlanScheduleSnapshot = {
    situation: 'volny',
    departure: null,
    arrival: null,
    nextArrivalPreview: null,
    departureTime: undefined,
    arrivalTime: undefined,
    guestCount: undefined,
    box: undefined,
    notes: undefined,
    occupiedConfirmed: false,
    freeConfirmed: false,
    stateSource: undefined,
    stateImportedAt: undefined,
    planDateIso: undefined,
    stayoverGuestName: undefined,
    stayoverUntil: undefined
}

function toScheduleSnapshot(room?: RoomPlan): RoomPlanScheduleSnapshot {
    if (!room) return { ...SCHEDULE_RESTORE_DEFAULTS }

    const snapshot: RoomPlanScheduleSnapshot = {
        situation: room.situation,
        departure: room.departure || null,
        arrival: room.arrival || null,
        nextArrivalPreview: room.nextArrivalPreview || null,
        occupiedConfirmed: Boolean(room.occupiedConfirmed),
        freeConfirmed: Boolean(room.freeConfirmed)
    }

    if (typeof room.departureTime === 'string') snapshot.departureTime = room.departureTime
    if (typeof room.arrivalTime === 'string') snapshot.arrivalTime = room.arrivalTime
    if (typeof room.guestCount === 'number') snapshot.guestCount = room.guestCount
    if (typeof room.box === 'string') snapshot.box = room.box
    if (Array.isArray(room.notes)) snapshot.notes = room.notes.filter((note) => typeof note === 'string')
    if (room.stateSource) snapshot.stateSource = room.stateSource
    if (typeof room.stateImportedAt === 'string') snapshot.stateImportedAt = room.stateImportedAt
    if (typeof room.planDateIso === 'string') snapshot.planDateIso = room.planDateIso
    if (typeof room.stayoverGuestName === 'string') snapshot.stayoverGuestName = room.stayoverGuestName
    if (typeof room.stayoverUntil === 'string') snapshot.stayoverUntil = room.stayoverUntil

    return snapshot
}

function applyScheduleSnapshot(room: RoomPlan, snapshot?: RoomPlanScheduleSnapshot): RoomPlan {
    const schedule = {
        ...SCHEDULE_RESTORE_DEFAULTS,
        ...(snapshot || {})
    }

    return {
        ...room,
        situation: schedule.situation || 'volny',
        departure: schedule.departure || undefined,
        arrival: schedule.arrival || undefined,
        nextArrivalPreview: schedule.nextArrivalPreview || undefined,
        departureTime: schedule.departureTime,
        arrivalTime: schedule.arrivalTime,
        guestCount: schedule.guestCount,
        box: schedule.box,
        notes: schedule.notes,
        occupiedConfirmed: Boolean(schedule.occupiedConfirmed),
        freeConfirmed: Boolean(schedule.freeConfirmed),
        stateSource: schedule.stateSource,
        stateImportedAt: schedule.stateImportedAt,
        planDateIso: schedule.planDateIso,
        stayoverGuestName: schedule.stayoverGuestName,
        stayoverUntil: schedule.stayoverUntil
    }
}

export default function App() {
    function normalizeIdentity(value?: string) {
        if (!value) return ''
        return value
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim()
    }

    function normalizeCatalogRoomNumber(value: string) {
        const trimmed = value.trim()
        const match = trimmed.match(/\b(\d{3})\b/)
        if (match) return match[1]

        const digits = trimmed.replace(/\D/g, '')
        if (digits.length >= 3) return digits.slice(-3)
        return trimmed
    }

    const localStore = useMemo(() => createLocalOpsStore(), [])
    const onlineStore = useMemo(() => createFirebaseOpsStore(), [])
    const [runtimeMode, setRuntimeMode] = useState<'demo' | 'online'>(appMode)
    const [onlineLoading, setOnlineLoading] = useState(appMode === 'online')
    const [onlineError, setOnlineError] = useState<string | null>(null)
    const [diagOpen, setDiagOpen] = useState(false)
    const [authUser, setAuthUser] = useState<User | null>(null)
    const [isStandalone, setIsStandalone] = useState(false)
    const [profileLoading, setProfileLoading] = useState(false)
    const [onlineProfile, setOnlineProfile] = useState<OnlineStaffProfile | null>(null)
    const [missingProfileUid, setMissingProfileUid] = useState<string | null>(null)
    const [loginEmail, setLoginEmail] = useState('')
    const [loginPassword, setLoginPassword] = useState('')
    const [loginLoading, setLoginLoading] = useState(false)
    const [loginError, setLoginError] = useState<string | null>(null)
    const [diagnostics, setDiagnostics] = useState<AppDiagnostics>({
        firebaseConfigured: firebaseEnvDiagnostics.firebaseConfigured,
        missingEnvVars: firebaseEnvDiagnostics.missingEnvVars,
        intendedMode: appMode,
        activeMode: appMode,
        authStatus: appMode === 'online' ? 'not_started' : 'not_started',
        isAnonymous: false,
        profileLoaded: false,
        firestoreStatus: 'not_started',
        hotelId: ONLINE_HOTEL_ID
    })

    const defaultState: OpsPersistedState = useMemo(() => ({
        userId: 'david',
        tab: 'Dnes',
        view: 'today',
        roomsByDay: roomPlansByDay,
        importJobs: [],
        latestStateImportBackup: null,
        tasks: [],
        supplyRequests: initialSupplyRequests,
        maintenanceItems: initialMaintenanceItems,
        customSupplyChips: [],
        dailyAvailabilityRecords: [],
        staff: users
    }), [])

    const saved = typeof window !== 'undefined'
        ? (appMode === 'online' ? null : localStore.loadInitialState())
        : null

    const [userId, setUserId] = useState<string>(saved?.userId ?? 'david')
    const [tab, setTab] = useState<'Dnes' | 'Zitra' | 'Pozitri'>(saved?.tab ?? 'Dnes')
    const [view, setView] = useState<'today' | 'sheet' | 'team' | 'admin' | 'maintenance' | 'supplies'>(saved?.view ?? 'today')
    const [roomsByDay, setRoomsByDay] = useState(() => saved?.roomsByDay ?? roomPlansByDay)
    const [tasks, setTasks] = useState<Task[]>(() => saved?.tasks ?? [])
    const [supplyRequests, setSupplyRequests] = useState<SupplyRequest[]>(() => saved?.supplyRequests ?? initialSupplyRequests)
    const [maintenanceItems, setMaintenanceItems] = useState<MaintenanceItem[]>(() => saved?.maintenanceItems ?? initialMaintenanceItems)
    const [customSupplyChips, setCustomSupplyChips] = useState<string[]>(() => saved?.customSupplyChips ?? [])
    const [dailyAvailabilityRecords, setDailyAvailabilityRecords] = useState<StaffAvailabilityRecord[]>(() => saved?.dailyAvailabilityRecords ?? [])
    const [staff, setStaff] = useState<StaffMember[]>(() => saved?.staff ?? users)
    const [language, setLanguage] = useState<AppLanguage>(() => {
        if (typeof window === 'undefined') return 'cs'
        try {
            return resolveLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY))
        } catch (e) {
            return 'cs'
        }
    })
    const [roomCatalog, setRoomCatalog] = useState<RoomCatalogItem[]>(() => getDefaultRoomCatalog())
    const [importPdfStatus, setImportPdfStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
    const [importPdfError, setImportPdfError] = useState<string | null>(null)
    const [importPreview, setImportPreview] = useState<PrevioImportPreview | null>(null)
    const [importRawText, setImportRawText] = useState('')
    const [importParseResult, setImportParseResult] = useState<PrevioParseResult | null>(null)
    const [stateImportPdfStatus, setStateImportPdfStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
    const [stateImportPdfError, setStateImportPdfError] = useState<string | null>(null)
    const [stateImportActionMessage, setStateImportActionMessage] = useState<string | null>(null)
    const [stateImportPreview, setStateImportPreview] = useState<PrevioStateImportPreview | null>(null)
    const [stateImportRawText, setStateImportRawText] = useState('')
    const [stateImportParseResult, setStateImportParseResult] = useState<PrevioStateParseResult | null>(null)
    const [importedTabDates, setImportedTabDates] = useState<Partial<Record<OpsTab, string>>>(() => saved?.importedTabDates ?? {})
    const [importedRoomsByDate, setImportedRoomsByDate] = useState<Record<string, typeof roomPlansByDay[OpsTab]>>(() => saved?.importedRoomsByDate ?? {})
    const [importJobs, setImportJobs] = useState<ImportJob[]>(() => (saved?.importJobs || []).sort((a, b) => (b.receivedAt || '').localeCompare(a.receivedAt || '')))
    const [selectedImportedDateIso, setSelectedImportedDateIso] = useState<string | null>(null)
    const [selectedImportJobId, setSelectedImportJobId] = useState<string | null>(null)
    const [activeStateImportJobId, setActiveStateImportJobId] = useState<string | null>(null)
    const [latestStateImportBackup, setLatestStateImportBackup] = useState<ImportJobBackupPayload | null>(() => saved?.latestStateImportBackup || null)
    const [generatingImportPreviewJobId, setGeneratingImportPreviewJobId] = useState<string | null>(null)
    const [lastPreviewRegenerateResponseByJobId, setLastPreviewRegenerateResponseByJobId] = useState<Record<string, { requestId: string; receivedAt: string }>>({})
    const [openImportJobPreviewId, setOpenImportJobPreviewId] = useState<string | null>(null)
    const [expandedImportJobPreviewRows, setExpandedImportJobPreviewRows] = useState<Record<string, boolean>>({})
    const [importJobPreviewInlineErrors, setImportJobPreviewInlineErrors] = useState<Record<string, string>>({})
    const [showConfirmedImportHistory, setShowConfirmedImportHistory] = useState(false)
    const [showManualPrevioImportSection, setShowManualPrevioImportSection] = useState(false)
    const [cleanupConfirm, setCleanupConfirm] = useState(false)
    const [cleanupResult, setCleanupResult] = useState<string | null>(null)
    const [planCleanupConfirm, setPlanCleanupConfirm] = useState(false)
    const [planCleanupResult, setPlanCleanupResult] = useState<string | null>(null)
    const [importCleanupInProgress, setImportCleanupInProgress] = useState(false)
    const [importCleanupAction, setImportCleanupAction] = useState<ImportCleanupAction | null>(null)
    const [importCleanupFeedback, setImportCleanupFeedback] = useState<ImportCleanupFeedback | null>(null)
    const [rollingBackJobId, setRollingBackJobId] = useState<string | null>(null)
    const [rollbackAvailabilityByJobId, setRollbackAvailabilityByJobId] = useState<Record<string, RollbackAvailability>>({})
    const [lateTaskRoomFocusRequest, setLateTaskRoomFocusRequest] = useState<LateTaskRoomFocusRequest | null>(null)
    const [lateTaskLastFocusedRoomNumber, setLateTaskLastFocusedRoomNumber] = useState<string | null>(null)
    const [lateTaskNavMessage, setLateTaskNavMessage] = useState<string | null>(null)
    const [maintenanceFocusRequest, setMaintenanceFocusRequest] = useState<MaintenanceFocusRequest | null>(null)
    const [maintenanceLastFocusedTargetId, setMaintenanceLastFocusedTargetId] = useState<string | null>(null)
    const [maintenanceNavMessage, setMaintenanceNavMessage] = useState<string | null>(null)
    const [soundEnabled, setSoundEnabled] = useState(() => {
        if (typeof window === 'undefined') return false
        return window.localStorage.getItem('chill_ops_alert_sound_enabled') === '1'
    })
    const [soundHintMessage, setSoundHintMessage] = useState<string | null>(null)
    const lateTaskFocusRequestCounterRef = useRef(0)
    const lateTaskNavMessageTimeoutRef = useRef<number | null>(null)
    const maintenanceFocusRequestCounterRef = useRef(0)
    const maintenanceNavMessageTimeoutRef = useRef<number | null>(null)
    const audioContextRef = useRef<AudioContext | null>(null)
    const seenAlertSoundKeysRef = useRef<Set<string>>(new Set())
    const alertSoundBaselineReadyRef = useRef(false)
    const [installHintDismissed, setInstallHintDismissed] = useState(() => {
        if (typeof window === 'undefined') return false
        return window.localStorage.getItem('chill_ops_install_hint_dismissed') === '1'
    })
    const importJobPreviewPanelRefs = useRef<Record<string, HTMLDivElement | null>>({})
    const autoConfirmInFlightJobIdRef = useRef<string | null>(null)

    const activeStore = runtimeMode === 'online' ? onlineStore : localStore

    const activeRooms = useMemo(
        () => roomCatalog.filter((room) => room.active).sort((a, b) => a.sortOrder - b.sortOrder),
        [roomCatalog]
    )

    const activeSheetRoomNumbers = useMemo(() => (
        activeRooms
            .map((room) => normalizeCatalogRoomNumber(room.roomNumber))
            .filter((roomNumber, index, all) => Boolean(roomNumber) && all.indexOf(roomNumber) === index)
            .sort((a, b) => Number(a) - Number(b))
    ), [activeRooms])

    // Security boundary: in online mode trust only authenticated profile role (not switchable UI state).
    const currentUser = runtimeMode === 'online'
        ? (onlineProfile || null)
        : (users.find((u) => u.id === userId) || null)
    const realUserRole = (currentUser?.role || 'cleaner') as UserRole
    const isRealAdminUser = isAdminRole(realUserRole)
    const isAdminUser = isRealAdminUser
    const t = useMemo(() => createTranslator(language), [language])
    const languageLocale = useMemo(() => getLanguageLocale(language), [language])
    const debugEnabled = useMemo(() => {
        if (typeof window === 'undefined') return Boolean(import.meta.env.DEV)
        try {
            const url = new URL(window.location.href)
            const urlDebug = url.searchParams.get('debug') === '1'
            const ls = window.localStorage.getItem('hotelOpsDebug') === '1'
            return Boolean(import.meta.env.DEV) || urlDebug || ls
        } catch (e) {
            return Boolean(import.meta.env.DEV)
        }
    }, [])

    const showDiagnostics = Boolean(isRealAdminUser && debugEnabled)
    const PREVIEW_ROLE_KEY = 'chill_ops_preview_role_v1'

    const allowedPreviewRoles: Array<'real' | UserRole> = ['real', 'admin', 'lead', 'cleaner', 'maintenance']

    const [previewRole, setPreviewRole] = useState<'real' | UserRole>(() => {
        try {
            if (typeof window === 'undefined') return 'real'
            const stored = window.localStorage.getItem(PREVIEW_ROLE_KEY)
            if (!stored) return 'real'
            if (allowedPreviewRoles.includes(stored as any)) return stored as any
            return 'real'
        } catch (e) {
            return 'real'
        }
    })

    // UI-only role preview: can only affect presentation for real admins.
    const effectiveRole = useMemo(() => {
        if (isRealAdminUser && previewRole && previewRole !== 'real') return previewRole as UserRole
        return realUserRole
    }, [isRealAdminUser, previewRole, realUserRole])

    useEffect(() => {
        if (!isRealAdminUser && previewRole !== 'real') {
            setPreviewRole('real')
            try { window.localStorage.removeItem(PREVIEW_ROLE_KEY) } catch (e) { }
        }
    }, [isRealAdminUser])
    useEffect(() => {
        if (typeof window === 'undefined') return
        try {
            window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
        } catch (e) { }
    }, [language])
    const enableDangerousReset = isRealAdminUser && (import.meta.env.DEV || import.meta.env.VITE_ENABLE_DANGEROUS_ACTIONS === 'true')
    const showInstallHint = isRealAdminUser && !isStandalone && !installHintDismissed

    const dayTitle = tab === 'Dnes' ? t('dates.today') : tab === 'Zitra' ? t('dates.tomorrow') : t('dates.dayAfterTomorrow')
    const selectedTabDateIso = getPrimaryTabDateIso(tab, importedTabDates)
    const selectedTabDate = parseIsoDateForDisplay(selectedTabDateIso)
    const isExtraImportedDay = Boolean(selectedImportedDateIso && importedRoomsByDate[selectedImportedDateIso])
    const effectiveDateIso = resolveEffectiveDateIso({
        tab,
        importedTabDates,
        importedRoomsByDate,
        selectedImportedDateIso
    })
    const effectiveDate = parseIsoDateForDisplay(effectiveDateIso)
    const showOrientationNote = tab !== 'Dnes' || isExtraImportedDay
    const dayLabelPrefix = isExtraImportedDay ? 'Další den' : dayTitle
    const dayLabel = `${dayLabelPrefix} • ${effectiveDate.toLocaleDateString(languageLocale, { weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric' })}`
    const displayedRooms = selectedImportedDateIso && importedRoomsByDate[selectedImportedDateIso]
        ? importedRoomsByDate[selectedImportedDateIso]
        : roomsByDay[tab]

    const dateSelectorItems = useMemo(() => buildDateSelectorItems({
        importedTabDates,
        importedRoomsByDate,
        selectedImportedDateIso,
        activeTab: tab,
        primaryLabels: {
            Dnes: t('dates.today'),
            Zitra: t('dates.tomorrow'),
            Pozitri: t('dates.dayAfterTomorrow')
        },
        locale: languageLocale
    }), [importedRoomsByDate, importedTabDates, selectedImportedDateIso, tab, t, languageLocale])

    // Normalize selectedImportedDateIso if it points to a past date (never allow past selection)
    useEffect(() => {
        if (!selectedImportedDateIso) return
        const todayIso = toLocalDateIso(new Date())
        if (selectedImportedDateIso < todayIso) {
            // Reset selection back to primary tabs (Dnes) to avoid showing past data in main selector
            setSelectedImportedDateIso(null)
            setTab('Dnes')
        }
    }, [selectedImportedDateIso, importedRoomsByDate, importedTabDates])

    const statePreviewMissingDates = useMemo(() => (
        stateImportPreview
            ? detectMissingDatesInRange(stateImportPreview.days.map((day) => day.dateIso))
            : []
    ), [stateImportPreview])

    const statePreviewMissingDateLabels = useMemo(() => (
        statePreviewMissingDates.map((dateIso) => new Date(`${dateIso}T00:00:00`).toLocaleDateString('cs-CZ', {
            day: 'numeric',
            month: 'numeric',
            year: 'numeric'
        }))
    ), [statePreviewMissingDates])

    const selectedImportJob = useMemo(
        () => importJobs.find((job) => job.id === selectedImportJobId) || null,
        [importJobs, selectedImportJobId]
    )

    const selectedImportJobPreview = (selectedImportJob?.previewSummary?.preview || null) as PrevioStateImportPreview | null
    const selectedImportJobMissingDateLabels = selectedImportJob?.previewSummary?.missingDateLabels || []
    const selectedImportJobParserVersion = selectedImportJob?.previewSummary?.parserVersion || selectedImportJob?.parserVersion
    const selectedImportJobStoredSafety = selectedImportJob?.previewSummary?.safety
    const selectedImportJobSafety = useMemo(() => (
        resolveImportSafety(
            selectedImportJobPreview,
            selectedImportJobMissingDateLabels,
            selectedImportJobParserVersion,
            selectedImportJobStoredSafety
        )
    ), [selectedImportJobPreview, selectedImportJobMissingDateLabels, selectedImportJobParserVersion, selectedImportJobStoredSafety])

    const stateImportPreviewForUi = selectedImportJobPreview || stateImportPreview
    const stateImportWarningsForUi = stateImportPreviewForUi?.warnings || []
    const stateImportParserVersionForUi = selectedImportJob
        ? selectedImportJobParserVersion
        : PREVIO_STAV_PARSER_VERSION
    const stateImportSafetyForUi = selectedImportJob
        ? selectedImportJobSafety
        : resolveImportSafety(stateImportPreview, statePreviewMissingDateLabels, PREVIO_STAV_PARSER_VERSION)
    const stateImportBlockedForUi = Boolean(stateImportSafetyForUi?.blocked)

    const latestRollbackCandidateJob = useMemo(
        () => importJobs.find((job) => (
            job.status === 'confirmed'
            && job.type === 'previo-state-pdf'
            && rollbackAvailabilityByJobId[job.id] === 'available'
        )),
        [importJobs, rollbackAvailabilityByJobId]
    )

    const newestPrevioStateJob = useMemo(
        () => getLatestPrevioStateJob(importJobs),
        [importJobs]
    )

    const supersededPrevioStateJobIds = useMemo(
        () => getSupersededPrevioStateJobIds(importJobs),
        [importJobs]
    )

    const supersededUnconfirmedPrevioJobs = useMemo(
        () => getSupersededUnconfirmedPrevioJobs(importJobs),
        [importJobs]
    )

    const selectedImportJobIsSuperseded = Boolean(selectedImportJob && supersededPrevioStateJobIds.has(selectedImportJob.id))

    const importCurrentJobIds = useMemo(() => {
        const ids = new Set<string>()
        if (newestPrevioStateJob?.id) ids.add(newestPrevioStateJob.id)
        if (latestRollbackCandidateJob?.id) ids.add(latestRollbackCandidateJob.id)
        return ids
    }, [newestPrevioStateJob?.id, latestRollbackCandidateJob?.id])

    const currentImportJobs = useMemo(
        () => importJobs.filter((job) => importCurrentJobIds.has(job.id)),
        [importJobs, importCurrentJobIds]
    )

    const pendingImportJobs = useMemo(
        () => importJobs.filter((job) => !importCurrentJobIds.has(job.id) && job.status !== 'confirmed'),
        [importJobs, importCurrentJobIds]
    )

    const confirmedHistoryImportJobs = useMemo(
        () => importJobs.filter((job) => !importCurrentJobIds.has(job.id) && job.status === 'confirmed'),
        [importJobs, importCurrentJobIds]
    )

    const adminVisibleImportJobs = useMemo(() => {
        const grouped: Array<{ job: ImportJob; group: AdminImportGroup }> = []
        currentImportJobs.forEach((job) => grouped.push({ job, group: 'current' }))
        pendingImportJobs.forEach((job) => grouped.push({ job, group: 'pending' }))
        return grouped
    }, [currentImportJobs, pendingImportJobs])

    const visibleTodayTasks = useMemo(
        () => tasks.filter((task) => canViewTask(effectiveRole, task)),
        [tasks, effectiveRole]
    )

    const todayDateIso = formatLocalDateIso(new Date())
    const staffWithTodayAvailability = useMemo(
        () => resolveStaffAvailabilityForDate(staff, dailyAvailabilityRecords, todayDateIso),
        [staff, dailyAvailabilityRecords, todayDateIso]
    )
    const staffWithEffectiveAvailability = useMemo(
        () => resolveStaffAvailabilityForDate(staff, dailyAvailabilityRecords, effectiveDateIso),
        [staff, dailyAvailabilityRecords, effectiveDateIso]
    )
    const currentUserAvailability = useMemo(() => {
        if (!currentUser) return undefined
        return staffWithTodayAvailability.find((member) => member.id === currentUser.id)?.availability || currentUser.availability
    }, [currentUser, staffWithTodayAvailability])
    const isAvailabilityOff = currentUserAvailability === 'dnes_nepracuji'
    const urgentOnlyAvailability = currentUserAvailability === 'jen_urgentni'

    const unfinishedCarryOverByRoomNumber = useMemo(() => {
        const map: Record<string, string> = {}
        const today = todayDateIso

        // scan importedRoomsByDate for past dates
        Object.keys(importedRoomsByDate).forEach((dateIso) => {
            if (!dateIso || dateIso >= today) return
            const rows = importedRoomsByDate[dateIso] || []
            rows.forEach((r) => {
                // skip already completed
                if (r.status === 'hotovo') return

                const hasDeparture = Boolean(r.departure || r.departureTime)
                const hasArrival = Boolean(r.arrival || r.arrivalTime)

                // Only consider carry-over when there was a departure and no arrival,
                // or when an explicit checkoutException exists.
                // A room with `status === 'problem'` is considered a carry candidate
                // only if it also meets the departure-without-arrival condition.
                const isCarryCandidate = (hasDeparture && !hasArrival) || Boolean(r.checkoutException) || (r.status === 'problem' && hasDeparture && !hasArrival)
                if (!isCarryCandidate) return

                const normalized = normalizeCatalogRoomNumber(r.number || r.roomNumber || '')
                if (!normalized) return

                const existing = map[normalized]
                // choose the most recent past date (closest to today)
                if (!existing || existing < dateIso) map[normalized] = dateIso
            })
        })

        // exclude carry-overs already resolved in today's room plan
        Object.values(roomsByDay.Dnes || []).forEach((r) => {
            const normalized = normalizeCatalogRoomNumber(r.number || '')
            if (!normalized) return
            // If today's room is explicitly marked resolved or already hotovo, remove carry-over
            if (r.carryOverResolvedAt || r.status === 'hotovo') {
                delete map[normalized]
                return
            }

            // Use shared helper to decide eligibility for carry-over rendering
            // Import dynamically to avoid circular imports at module scope
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { isTodayRoomEligibleForCarryOver } = require('./lib/roomHelpers')
                if (!isTodayRoomEligibleForCarryOver(r)) {
                    delete map[normalized]
                    return
                }
            } catch (e) {
                // fallback conservative behavior: if helper can't be loaded, remove when occupied
                const hasDepartureToday = Boolean(r.departure || r.departureTime)
                if (r.occupiedConfirmed || hasDepartureToday || r.arrival || r.arrivalTime) {
                    delete map[normalized]
                    return
                }
            }
        })

        return map
    }, [importedRoomsByDate, roomsByDay, todayDateIso])

    const visibleDashboardTasks = useMemo(
        () => visibleTodayTasks.filter((task) => matchesOperationalTaskDate(task, effectiveDateIso, todayDateIso)),
        [visibleTodayTasks, effectiveDateIso, todayDateIso]
    )

    const maintenanceTasks = useMemo(
        () => tasks.filter((task) => {
            const assignedName = normalizeIdentity(task.assignedToName)
            return (
                task.assignedToRole === 'maintenance'
                || task.category === 'maintenance'
                || assignedName.includes('serhii')
                || assignedName.includes('udrzb')
            )
        }),
        [tasks]
    )

    const unacknowledgedLateTodayTasks = useMemo(() => (
        visibleTodayTasks.filter((task) => (
            task.taskDateIso === todayDateIso
            && task.attentionRequired
            && task.attentionReason === 'late_today_room_task'
            && task.status !== 'read'
            && task.status !== 'waiting_material'
            && task.status !== 'done'
            && task.status !== 'cancelled'
        ))
    ), [visibleTodayTasks, todayDateIso])

    const orderedLateRoomNumbers = useMemo(() => {
        const roomOrder = new Map<string, number>()
        roomsByDay.Dnes.forEach((room, index) => {
            roomOrder.set(room.number, index)
        })

        const uniqueRooms = Array.from(new Set(unacknowledgedLateTodayTasks.map((task) => task.roomNumber)))
        return uniqueRooms.sort((left, right) => {
            const leftOrder = roomOrder.get(left)
            const rightOrder = roomOrder.get(right)
            if (typeof leftOrder === 'number' && typeof rightOrder === 'number') return leftOrder - rightOrder
            if (typeof leftOrder === 'number') return -1
            if (typeof rightOrder === 'number') return 1
            return left.localeCompare(right)
        })
    }, [unacknowledgedLateTodayTasks, roomsByDay])

    const unacknowledgedLateTodayCount = unacknowledgedLateTodayTasks.length

    const unacknowledgedMaintenanceTaskTargets = useMemo(() => (
        maintenanceTasks
            .filter((task) => task.status !== 'done' && task.status !== 'cancelled' && !task.maintenanceAcknowledgedAt)
            .map<MaintenanceAttentionTarget>((task) => ({
                id: task.id,
                kind: 'task',
                roomNumber: task.roomNumber,
                createdAt: task.createdAt || '',
                sortGroup: 1,
                priority: task.priority || 'normal'
            }))
    ), [maintenanceTasks])

    const unacknowledgedMaintenanceItemTargets = useMemo(() => (
        maintenanceItems
            .filter((item) => item.status !== 'done' && item.status !== 'cancelled' && !item.maintenanceAcknowledgedAt)
            .map<MaintenanceAttentionTarget>((item) => ({
                id: item.id,
                kind: 'item',
                roomNumber: item.roomNumber,
                createdAt: item.createdAt || '',
                sortGroup: 0,
                priority: item.priority || 'normal'
            }))
    ), [maintenanceItems])

    const orderedMaintenanceAttentionTargets = useMemo(() => {
        const roomOrder = new Map<string, number>()
        roomsByDay.Dnes.forEach((room, index) => {
            roomOrder.set(room.number, index)
        })

        return [...unacknowledgedMaintenanceItemTargets, ...unacknowledgedMaintenanceTaskTargets]
            .sort((left, right) => {
                const leftRoomOrder = left.roomNumber ? roomOrder.get(left.roomNumber) : undefined
                const rightRoomOrder = right.roomNumber ? roomOrder.get(right.roomNumber) : undefined

                if (typeof leftRoomOrder === 'number' && typeof rightRoomOrder === 'number' && leftRoomOrder !== rightRoomOrder) {
                    return leftRoomOrder - rightRoomOrder
                }
                if (typeof leftRoomOrder === 'number' && typeof rightRoomOrder !== 'number') return -1
                if (typeof leftRoomOrder !== 'number' && typeof rightRoomOrder === 'number') return 1

                if (left.sortGroup !== right.sortGroup) return left.sortGroup - right.sortGroup
                if (left.createdAt !== right.createdAt) return left.createdAt.localeCompare(right.createdAt)
                return left.id.localeCompare(right.id)
            })
    }, [roomsByDay, unacknowledgedMaintenanceItemTargets, unacknowledgedMaintenanceTaskTargets])

    const unacknowledgedMaintenanceCount = orderedMaintenanceAttentionTargets.length

    const relevantSoundAlerts = useMemo(() => {
        const alerts: Array<{ key: string; priority: 'normal' | 'urgent' }> = []

        if (isAdminRole(effectiveRole) || isCleaningStaffRole(effectiveRole)) {
            unacknowledgedLateTodayTasks.forEach((task) => {
                alerts.push({
                    key: `late:${task.id}`,
                    priority: task.priority || 'normal'
                })
            })
        }

        if (isMaintenanceRole(effectiveRole) || isAdminRole(effectiveRole)) {
            orderedMaintenanceAttentionTargets.forEach((target) => {
                alerts.push({
                    key: `maintenance:${target.kind}:${target.id}`,
                    priority: target.priority || 'normal'
                })
            })
        }

        return alerts
    }, [effectiveRole, unacknowledgedLateTodayTasks, orderedMaintenanceAttentionTargets])

    useEffect(() => {
        if (orderedLateRoomNumbers.length === 0) {
            setLateTaskLastFocusedRoomNumber(null)
        }
    }, [orderedLateRoomNumbers])

    useEffect(() => {
        if (orderedMaintenanceAttentionTargets.length === 0) {
            setMaintenanceLastFocusedTargetId(null)
        }
    }, [orderedMaintenanceAttentionTargets])

    useEffect(() => {
        return () => {
            if (lateTaskNavMessageTimeoutRef.current) {
                window.clearTimeout(lateTaskNavMessageTimeoutRef.current)
            }
            if (maintenanceNavMessageTimeoutRef.current) {
                window.clearTimeout(maintenanceNavMessageTimeoutRef.current)
            }
            if (audioContextRef.current) {
                void audioContextRef.current.close()
                audioContextRef.current = null
            }
        }
    }, [])

    async function getOrCreateAudioContext() {
        if (typeof window === 'undefined') return null
        const AudioCtor = window.AudioContext || (window as any).webkitAudioContext
        if (!AudioCtor) return null
        if (!audioContextRef.current) {
            audioContextRef.current = new AudioCtor()
        }
        if (audioContextRef.current.state === 'suspended') {
            await audioContextRef.current.resume()
        }
        return audioContextRef.current
    }

    async function unlockSoundByUserGesture() {
        const ctx = await getOrCreateAudioContext()
        if (!ctx) return false

        const oscillator = ctx.createOscillator()
        const gain = ctx.createGain()
        oscillator.type = 'sine'
        oscillator.frequency.value = 440
        gain.gain.value = 0.0001
        oscillator.connect(gain)
        gain.connect(ctx.destination)
        oscillator.start()
        oscillator.stop(ctx.currentTime + 0.03)
        return true
    }

    async function playInAppAlertSound() {
        const ctx = await getOrCreateAudioContext()
        if (!ctx) throw new Error('AudioContext not available')

        const now = ctx.currentTime
        const oscillator = ctx.createOscillator()
        const gain = ctx.createGain()
        oscillator.type = 'triangle'
        oscillator.frequency.setValueAtTime(830, now)
        oscillator.frequency.linearRampToValueAtTime(640, now + 0.16)

        gain.gain.setValueAtTime(0.0001, now)
        gain.gain.exponentialRampToValueAtTime(0.085, now + 0.018)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18)

        oscillator.connect(gain)
        gain.connect(ctx.destination)
        oscillator.start(now)
        oscillator.stop(now + 0.2)
    }

    function handleToggleAlertSound() {
        const nextEnabled = !soundEnabled
        setSoundEnabled(nextEnabled)
        if (typeof window !== 'undefined') {
            window.localStorage.setItem('chill_ops_alert_sound_enabled', nextEnabled ? '1' : '0')
        }

        if (!nextEnabled) {
            setSoundHintMessage(null)
            return
        }

        seenAlertSoundKeysRef.current = new Set(relevantSoundAlerts.map((item) => item.key))
        void unlockSoundByUserGesture()
            .then((ok) => {
                if (!ok) {
                    setSoundHintMessage('Zvuk je potřeba povolit klepnutím v aplikaci.')
                    return
                }
                setSoundHintMessage(null)
            })
            .catch(() => {
                setSoundHintMessage('Zvuk je potřeba povolit klepnutím v aplikaci.')
            })
    }

    useEffect(() => {
        if (!soundEnabled) {
            alertSoundBaselineReadyRef.current = false
            return
        }
        if (alertSoundBaselineReadyRef.current) return

        seenAlertSoundKeysRef.current = new Set(relevantSoundAlerts.map((item) => item.key))
        alertSoundBaselineReadyRef.current = true
    }, [soundEnabled, relevantSoundAlerts])

    useEffect(() => {
        if (!soundEnabled) return
        if (!alertSoundBaselineReadyRef.current) return

        const nextKeys = new Set(relevantSoundAlerts.map((item) => item.key))
        const newAlerts = relevantSoundAlerts.filter((item) => !seenAlertSoundKeysRef.current.has(item.key))
        seenAlertSoundKeysRef.current = nextKeys
        if (newAlerts.length === 0) return

        // TODO: Hook future push-notification delivery into this same alert sound trigger path.
        if (isAvailabilityOff) return

        const shouldPlay = urgentOnlyAvailability
            ? newAlerts.some((item) => item.priority === 'urgent')
            : true

        if (!shouldPlay) return

        void playInAppAlertSound().catch(() => {
            setSoundHintMessage('Zvuk je potřeba povolit klepnutím v aplikaci.')
        })
    }, [soundEnabled, relevantSoundAlerts, isAvailabilityOff, urgentOnlyAvailability])

    const visibleSupplies = useMemo(() => {
        const role = effectiveRole
        // Always hide cancelled requests from visible lists
        if (isAdminRole(role)) return supplyRequests.filter((s) => s.status !== 'cancelled')
        if (isCleaningStaffRole(role)) {
            return supplyRequests.filter((s) => s.status !== 'cancelled' && (s.category !== 'maintenance' || s.requestedByRole === role))
        }
        if (isMaintenanceRole(role)) {
            return supplyRequests.filter((s) => s.status !== 'cancelled' && (s.category === 'maintenance' || s.requestedByRole === 'maintenance'))
        }
        return supplyRequests.filter((s) => s.status !== 'cancelled')
    }, [supplyRequests, effectiveRole])

    async function loadOnlineProfile(user: User): Promise<OnlineStaffProfile | null> {
        if (!firestoreDb) return null
        const profileRef = doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'staff', user.uid)
        const profileSnap = await getDoc(profileRef)
        if (!profileSnap.exists()) return null

        const data = profileSnap.data() as Partial<OnlineStaffProfile>
        if (!data.role || !data.name) return null

        return {
            id: user.uid,
            uid: user.uid,
            name: data.name,
            role: data.role,
            active: data.active !== false,
            availability: data.availability
        }
    }

    function loginErrorMessage(code?: string) {
        if (code === 'auth/invalid-credential') return 'Neplatný e-mail nebo heslo.'
        if (code === 'auth/user-disabled') return 'Tento účet je deaktivovaný.'
        if (code === 'auth/too-many-requests') return 'Příliš mnoho pokusů. Zkuste to prosím později.'
        if (code === 'auth/network-request-failed') return 'Chyba sítě. Zkontrolujte připojení a zkuste to znovu.'
        return 'Přihlášení se nepodařilo. Zkuste to prosím znovu.'
    }

    async function handleLoginSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault()
        if (!loginEmail.trim() || !loginPassword) return
        setLoginLoading(true)
        setLoginError(null)
        try {
            const user = await signInWithEmailPassword(loginEmail.trim(), loginPassword)
            setAuthUser(user)
            setLoginPassword('')
        } catch (error: any) {
            setLoginError(loginErrorMessage(error?.code))
        } finally {
            setLoginLoading(false)
        }
    }

    async function handleLogout() {
        setLoginError(null)
        setOnlineProfile(null)
        setMissingProfileUid(null)
        setAuthUser(null)
        setOnlineLoading(false)
        await signOutFirebaseUser()
    }

    async function handleSignOutAnonymous() {
        await handleLogout()
    }

    async function loadRoomCatalogForCurrentMode() {
        if (runtimeMode !== 'online' || !firestoreDb || !authUser || authUser.isAnonymous) {
            setRoomCatalog(getDefaultRoomCatalog())
            return
        }

        const roomsRef = collection(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'rooms')
        const snap = await getDocs(roomsRef)
        if (snap.empty) {
            const defaults = getDefaultRoomCatalog()
            await Promise.all(
                defaults.map((room) =>
                    setDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'rooms', room.roomNumber), room)
                )
            )
            setRoomCatalog(defaults)
            return
        }

        const loadedRaw = snap.docs
            .map((d) => {
                const data = d.data() as Partial<RoomCatalogItem>
                const normalizedNumber = normalizeCatalogRoomNumber(data.roomNumber || d.id)
                return {
                    roomNumber: normalizedNumber,
                    displayName: data.displayName,
                    active: data.active !== false,
                    defaultBox: data.defaultBox,
                    sortOrder: typeof data.sortOrder === 'number' ? data.sortOrder : Number(normalizedNumber)
                } satisfies RoomCatalogItem
            })

        const byRoom = new Map<string, RoomCatalogItem>()
        loadedRaw.forEach((room) => {
            if (!byRoom.has(room.roomNumber)) {
                byRoom.set(room.roomNumber, room)
                return
            }

            const prev = byRoom.get(room.roomNumber) as RoomCatalogItem
            byRoom.set(room.roomNumber, {
                ...prev,
                displayName: prev.displayName || room.displayName,
                active: prev.active || room.active,
                defaultBox: prev.defaultBox || room.defaultBox,
                sortOrder: Math.min(prev.sortOrder, room.sortOrder)
            })
        })

        for (const roomNumber of MASTER_ROOM_NUMBERS) {
            if (byRoom.has(roomNumber)) continue
            const fallbackRoom: RoomCatalogItem = {
                roomNumber,
                active: true,
                sortOrder: Number(roomNumber)
            }
            byRoom.set(roomNumber, fallbackRoom)
            await setDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'rooms', roomNumber), fallbackRoom)
        }

        const loaded = Array.from(byRoom.values()).sort((a, b) => a.sortOrder - b.sortOrder)
        setRoomCatalog(loaded)
    }

    async function handlePrevioPdfSelected(file: File | null) {
        if (!isRealAdminUser) {
            setImportPdfStatus('error')
            setImportPdfError('Ruční import je povolen jen adminovi.')
            setImportPreview(null)
            setImportRawText('')
            setImportParseResult(null)
            return
        }
        if (!file) return
        const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
        if (!isPdf) {
            setImportPdfStatus('error')
            setImportPdfError('Soubor musí být ve formátu PDF.')
            setImportPreview(null)
            setImportRawText('')
            setImportParseResult(null)
            return
        }

        setImportPdfStatus('loading')
        setImportPdfError(null)
        setImportPreview(null)
        setImportRawText('')
        setImportParseResult(null)

        try {
            const extracted = await extractTextFromPdfFile(file)
            const parsed = parsePrevioPdfText(extracted, new Date())
            const preview = buildPrevioImportPreview(parsed, activeRooms, new Date())
            setImportPreview(preview)
            setImportRawText(extracted.rawText)
            setImportParseResult(parsed)
            setImportPdfStatus('loaded')
        } catch (error: any) {
            setImportPdfStatus('error')
            setImportPdfError(error?.message || 'PDF se nepodařilo načíst.')
            setImportPreview(null)
            setImportRawText('')
            setImportParseResult(null)
        }
    }

    async function handlePrevioStateImportSelected(file: File | null) {
        if (!isRealAdminUser) {
            setStateImportPdfStatus('error')
            setStateImportPdfError('Import Stav je povolen jen adminovi.')
            setStateImportPreview(null)
            setStateImportRawText('')
            setStateImportParseResult(null)
            return
        }
        if (!file) return
        const lowerName = file.name.toLowerCase()
        const isPdf = file.type === 'application/pdf' || lowerName.endsWith('.pdf')
        const isSpreadsheet = (
            lowerName.endsWith('.xlsx')
            || lowerName.endsWith('.xls')
            || file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            || file.type === 'application/vnd.ms-excel'
        )
        if (!isPdf && !isSpreadsheet) {
            setStateImportPdfStatus('error')
            setStateImportPdfError('Soubor musí být ve formátu XLS/XLSX nebo PDF.')
            setStateImportPreview(null)
            setStateImportRawText('')
            setStateImportParseResult(null)
            return
        }

        setStateImportPdfStatus('loading')
        setStateImportPdfError(null)
        setStateImportActionMessage(null)
        setStateImportPreview(null)
        setStateImportRawText('')
        setStateImportParseResult(null)

        try {
            let parsed: PrevioStateParseResult
            let rawText = ''

            if (isSpreadsheet) {
                const extracted = await extractStateDataFromXlsxFile(file)
                parsed = parsePrevioStateXlsxData(extracted, new Date())
                rawText = extracted.rawText
            } else {
                const extracted = await extractStateTextFromPdfFile(file)
                parsed = parsePrevioStatePdfText(extracted, new Date())
                rawText = extracted.rawText
            }

            const preview = buildPrevioStateImportPreview(parsed, activeRooms, new Date())
            const missingDateIsos = detectMissingDatesInRange(preview.days.map((day) => day.dateIso))
            const missingDateLabels = missingDateIsos.map((dateIso) => new Date(`${dateIso}T00:00:00`).toLocaleDateString('cs-CZ', {
                day: 'numeric',
                month: 'numeric',
                year: 'numeric'
            }))
            const safety = resolveImportSafety(preview, missingDateLabels, PREVIO_STAV_PARSER_VERSION)
            const combinedWarnings = Array.from(new Set([
                ...preview.warnings,
                ...(safety?.warnings || []),
                ...(safety?.blocks || [])
            ]))
            const importedAt = formatImportTimestamp(new Date())
            const { byDate } = buildMergedPlansFromStateImport(preview, importedAt)

            const createdJob = activeStore.createImportJob({
                type: 'previo-state-pdf',
                source: 'manual',
                status: safety?.blocked ? 'parsed' : 'needs_review',
                fileName: file.name,
                receivedAt: new Date().toISOString(),
                parsedAt: new Date().toISOString(),
                detectedDaysCount: preview.days.length,
                turnoverCount: preview.turnoverCount,
                stayoverCount: preview.stayoverCount,
                freeCount: preview.derivedFreeCount,
                warnings: combinedWarnings,
                parserVersion: PREVIO_STAV_PARSER_VERSION,
                previewSummary: {
                    parsedTabDates: preview.parsedTabDates,
                    byDate,
                    missingDateLabels,
                    parserVersion: PREVIO_STAV_PARSER_VERSION,
                    safety: safety || undefined,
                    preview
                }
            })

            if (createdJob) {
                upsertImportJobInState(createdJob)
                setSelectedImportJobId(createdJob.id)
                setActiveStateImportJobId(createdJob.id)
            }

            setStateImportPreview(preview)
            setStateImportRawText(rawText)
            setStateImportParseResult(parsed)
            setStateImportPdfStatus('loaded')
        } catch (error: any) {
            setStateImportPdfStatus('error')
            setStateImportPdfError(error?.message || 'Import Stav se nepodařilo načíst.')
            setStateImportPreview(null)
            setStateImportRawText('')
            setStateImportParseResult(null)
        }
    }

    async function handleGenerateImportJobPreview(jobId: string) {
        if (!isRealAdminUser) {
            const message = 'Generování náhledu je povoleno jen adminovi.'
            setImportJobPreviewInlineErrors((prev) => ({
                ...prev,
                [jobId]: message
            }))
            return
        }
        const job = importJobs.find((item) => item.id === jobId)
        if (!job || !job.storagePath) return

        setGeneratingImportPreviewJobId(jobId)
        setImportJobPreviewInlineErrors((prev) => {
            if (!(jobId in prev)) return prev
            const next = { ...prev }
            delete next[jobId]
            return next
        })

        try {
            if (!authUser || authUser.isAnonymous) {
                throw new Error('Pro vytvoření náhledu je nutné přihlášení.')
            }

            const token = await authUser.getIdToken()
            const controller = new AbortController()
            const timeout = window.setTimeout(() => controller.abort(), 45_000)

            let response: Response
            try {
                response = await fetch('/api/previo-import-preview', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        jobId,
                        hotelId: ONLINE_HOTEL_ID
                    }),
                    signal: controller.signal
                })
            } finally {
                window.clearTimeout(timeout)
            }

            const responseBody = await response.json().catch(() => ({} as any))
            if (!response.ok) {
                const apiError = responseBody?.error || `Server vrátil chybu ${response.status}.`
                throw new Error(apiError)
            }

            if (responseBody?.job) {
                const updatedJob = responseBody.job as ImportJob
                replaceImportJobInState(updatedJob)

                const responseRequestId = String(
                    responseBody?.diagnostics?.previewRequestId
                    || updatedJob?.previewSummary?.previewRequestId
                    || ''
                ).trim()

                setLastPreviewRegenerateResponseByJobId((prev) => ({
                    ...prev,
                    [jobId]: {
                        requestId: responseRequestId,
                        receivedAt: new Date().toISOString()
                    }
                }))
            }
        } catch (error: any) {
            const timeoutHit = error?.name === 'AbortError'
            const message = timeoutHit
                ? 'Generování náhledu vypršelo po 45 sekundách. Zkuste to prosím znovu.'
                : (error?.message || 'Náhled z uloženého PDF se nepodařilo vytvořit.')
            const failedPatch: Partial<ImportJob> = {
                error: message
            }

            setImportJobs((prev) => sortImportJobs(prev.map((item) => (
                item.id === jobId
                    ? { ...item, ...failedPatch }
                    : item
            ))))
            setImportJobPreviewInlineErrors((prev) => ({
                ...prev,
                [jobId]: message
            }))
        } finally {
            setGeneratingImportPreviewJobId(null)
        }
    }

    function formatImportTimestamp(date = new Date()) {
        const d = `${date.getDate()}`.padStart(2, '0')
        const m = `${date.getMonth() + 1}`.padStart(2, '0')
        const y = date.getFullYear()
        const hh = `${date.getHours()}`.padStart(2, '0')
        const mm = `${date.getMinutes()}`.padStart(2, '0')
        return `${d}.${m}.${y} ${hh}:${mm}`
    }

    function sortImportJobs(jobs: ImportJob[]) {
        return [...jobs].sort((a, b) => (b.receivedAt || '').localeCompare(a.receivedAt || ''))
    }

    function upsertImportJobInState(job: ImportJob) {
        setImportJobs((prev) => {
            const exists = prev.some((item) => item.id === job.id)
            if (!exists) return sortImportJobs([job, ...prev])
            return sortImportJobs(prev.map((item) => (item.id === job.id ? { ...item, ...job } : item)))
        })
    }

    function replaceImportJobInState(job: ImportJob) {
        setImportJobs((prev) => {
            const exists = prev.some((item) => item.id === job.id)
            if (!exists) return sortImportJobs([job, ...prev])
            return sortImportJobs(prev.map((item) => (item.id === job.id ? job : item)))
        })
    }

    function findTabForDate(dateIso: string, parsedTabDates?: Partial<Record<OpsTab, string>>) {
        const tabs = ['Dnes', 'Zitra', 'Pozitri'] as OpsTab[]
        return tabs.find((day) => importedTabDates[day] === dateIso || parsedTabDates?.[day] === dateIso)
    }

    function getCurrentRoomsForDate(dateIso: string, parsedTabDates?: Partial<Record<OpsTab, string>>) {
        const mappedTab = findTabForDate(dateIso, parsedTabDates)
        if (mappedTab) return roomsByDay[mappedTab]
        if (importedRoomsByDate[dateIso]) return importedRoomsByDate[dateIso]
        return []
    }

    function buildImportBackupPayload(
        jobId: string,
        byDate: Record<string, RoomPlan[]>,
        parsedTabDates: Partial<Record<OpsTab, string>>,
        createdBy: string
    ): ImportJobBackupPayload {
        const snapshotByDate: ImportJobBackupPayload['snapshotByDate'] = {}

        Object.entries(byDate).forEach(([dateIso, incomingRooms]) => {
            const currentRooms = getCurrentRoomsForDate(dateIso, parsedTabDates)
            const currentById = new Map(currentRooms.map((room) => [room.id, room]))
            const currentByNumber = new Map(currentRooms.map((room) => [normalizeCatalogRoomNumber(room.number), room]))

            snapshotByDate[dateIso] = incomingRooms.map((incomingRoom) => {
                const fallbackNumber = normalizeCatalogRoomNumber(incomingRoom.number)
                const previousRoom = currentById.get(incomingRoom.id) || currentByNumber.get(fallbackNumber)
                const snapshotEntry = {
                    roomId: String(incomingRoom.id || roomIdForNumber(fallbackNumber)),
                    roomNumber: String(fallbackNumber || incomingRoom.number || ''),
                    schedule: toScheduleSnapshot(previousRoom)
                }
                return sanitizeForFirestore(snapshotEntry)
            })
        })

        const affectedDates = Object.keys(snapshotByDate).sort()
        const affectedRoomCount = Object.values(snapshotByDate).reduce((sum, rows) => sum + rows.length, 0)

        return sanitizeForFirestore({
            jobId,
            createdAt: new Date().toISOString(),
            createdBy,
            affectedDates,
            affectedRoomCount,
            snapshotByDate
        })
    }

    async function persistImportBackup(job: ImportJob, backupPayload: ImportJobBackupPayload, createdBy: string) {
        const backupSummary: ImportJobBackupSummary = {
            backupId: backupPayload.jobId,
            createdAt: backupPayload.createdAt,
            createdBy,
            affectedDates: backupPayload.affectedDates,
            affectedRoomCount: backupPayload.affectedRoomCount
        }

        const sanitizedBackupPayload = sanitizeForFirestore(backupPayload)
        const sanitizedBackupSummary = sanitizeForFirestore(backupSummary)

        // Keep a sanitized copy in state so follow-up writes/rollback reads are safe.
        setLatestStateImportBackup(sanitizedBackupPayload)

        try {
            if (runtimeMode === 'online' && firestoreDb) {
                await setDoc(
                    doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'importBackups', sanitizedBackupPayload.jobId),
                    sanitizedBackupPayload
                )
                activeStore.updateImportJob(job.id, {
                    backupSummary: sanitizedBackupSummary
                })
                setImportJobs((prev) => sortImportJobs(prev.map((item) => (
                    item.id === job.id
                        ? { ...item, backupSummary: sanitizedBackupSummary }
                        : item
                ))))
                return
            }

            activeStore.updateImportJob(job.id, {
                backupSummary: sanitizedBackupSummary,
                backupPayload: sanitizedBackupPayload
            })
            setImportJobs((prev) => sortImportJobs(prev.map((item) => (
                item.id === job.id
                    ? { ...item, backupSummary: sanitizedBackupSummary, backupPayload: sanitizedBackupPayload }
                    : item
            ))))
        } catch (error: any) {
            const rawMessage = String(error?.message || '')
            if (rawMessage.includes('Unsupported field value: undefined')) {
                throw new Error('Nepodařilo se uložit rollback snapshot: data obsahovala neplatné hodnoty.')
            }
            throw new Error(`Nepodařilo se uložit rollback snapshot: ${error?.message || 'neznámá chyba'}`)
        }
    }

    async function loadBackupPayloadForJob(job: ImportJob) {
        if (runtimeMode === 'online' && firestoreDb) {
            const backupSnap = await getDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'importBackups', job.id))
            if (backupSnap.exists()) {
                return backupSnap.data() as ImportJobBackupPayload
            }
            return null
        }

        if (job.backupPayload?.jobId === job.id) return job.backupPayload
        if (latestStateImportBackup?.jobId === job.id) return latestStateImportBackup
        return null
    }

    async function handleRollbackImport(jobId: string, isLastImportAction = false) {
        const job = importJobs.find((item) => item.id === jobId)
        if (!job || job.status !== 'confirmed' || job.type !== 'previo-state-pdf') {
            setStateImportPdfError('Rollback není dostupný pro vybraný import.')
            return
        }

        const confirmed = window.confirm('Opravdu vrátit poslední import? Úkoly, odhady a provozní stavy zůstanou zachované.')
        if (!confirmed) return

        setRollingBackJobId(jobId)
        setStateImportPdfError(null)
        setStateImportActionMessage(null)

        try {
            const backupPayload = await loadBackupPayloadForJob(job)
            if (!backupPayload || !backupPayload.snapshotByDate) {
                setStateImportPdfError('Rollback není dostupný pro importy potvrzené starší verzí.')
                setRollbackAvailabilityByJobId((prev) => ({ ...prev, [jobId]: 'legacy' }))
                return
            }

            const parsedTabDates = getImportJobParsedTabDates(job.previewSummary) || {}
            const nextRoomsByDay: Record<OpsTab, RoomPlan[]> = {
                Dnes: roomsByDay.Dnes,
                Zitra: roomsByDay.Zitra,
                Pozitri: roomsByDay.Pozitri
            }
            const nextImportedRoomsByDate = { ...importedRoomsByDate }

            Object.entries(backupPayload.snapshotByDate).forEach(([dateIso, snapshots]) => {
                const currentRooms = getCurrentRoomsForDate(dateIso, parsedTabDates)
                if (!currentRooms || currentRooms.length === 0) return

                const snapshotsById = new Map(snapshots.map((entry) => [entry.roomId, entry]))
                const snapshotsByNumber = new Map(snapshots.map((entry) => [normalizeCatalogRoomNumber(entry.roomNumber), entry]))

                const restoredRooms = currentRooms.map((room) => {
                    const byId = snapshotsById.get(room.id)
                    const byNumber = snapshotsByNumber.get(normalizeCatalogRoomNumber(room.number))
                    const snapshot = byId || byNumber
                    if (!snapshot) return room
                    return applyScheduleSnapshot(room, snapshot.schedule)
                })

                nextImportedRoomsByDate[dateIso] = restoredRooms

                const mappedTab = findTabForDate(dateIso, parsedTabDates)
                if (mappedTab) {
                    nextRoomsByDay[mappedTab] = restoredRooms
                }
            })

            setImportedRoomsByDate(nextImportedRoomsByDate)
            setRoomsByDay(nextRoomsByDay)

            if (runtimeMode === 'online') {
                Object.entries(backupPayload.snapshotByDate).forEach(([dateIso]) => {
                    const restoredRooms = nextImportedRoomsByDate[dateIso]
                    if (!restoredRooms) return
                    const mappedTab = findTabForDate(dateIso, parsedTabDates)
                    if (mappedTab) {
                        restoredRooms.forEach((room) => activeStore.replaceRoomPlan(mappedTab, room))
                        return
                    }
                    restoredRooms.forEach((room) => activeStore.replaceRoomPlan(dateIso, room))
                })
            }

            const rollbackAt = new Date().toISOString()
            const rollbackBy = currentUser?.name || currentUser?.id || 'admin'
            const rollbackSummary = sanitizeForFirestore({
                ...(job.backupSummary || {
                    backupId: job.id,
                    createdAt: backupPayload.createdAt,
                    createdBy: backupPayload.createdBy,
                    affectedDates: backupPayload.affectedDates,
                    affectedRoomCount: backupPayload.affectedRoomCount
                }),
                rolledBackAt: rollbackAt,
                rolledBackBy: rollbackBy
            })

            activeStore.updateImportJob(job.id, {
                backupSummary: rollbackSummary
            })
            setImportJobs((prev) => sortImportJobs(prev.map((item) => (
                item.id === job.id
                    ? {
                        ...item,
                        backupSummary: rollbackSummary
                    }
                    : item
            ))))
            setRollbackAvailabilityByJobId((prev) => ({ ...prev, [job.id]: 'available' }))

            const label = isLastImportAction ? 'Rollback dokončen pro poslední import.' : `Rollback dokončen pro import ${job.fileName}.`
            setStateImportActionMessage(label)
        } catch (error: any) {
            setStateImportPdfError(error?.message || 'Rollback posledního importu selhal.')
        } finally {
            setRollingBackJobId(null)
        }
    }

    async function handleRollbackLastImport() {
        if (!latestRollbackCandidateJob) {
            setStateImportPdfError('Rollback není dostupný pro importy potvrzené starší verzí.')
            return
        }
        await handleRollbackImport(latestRollbackCandidateJob.id, true)
    }

    function roomIdForNumber(roomNumber: string) {
        return `r${roomNumber}`
    }

    function extractArrivalBoxFromNotes(notes?: string[]) {
        if (!notes || notes.length === 0) return undefined
        const match = notes.join(' ').match(/\bbox\s*([a-z0-9-]+)/i)
        if (!match) return undefined
        return `BOX ${match[1].toUpperCase()}`
    }

    function buildImportedBaseRow(base: RoomPlan | undefined, roomNumber: string, displayName: string | undefined, importedAt: string, importJobId?: string): RoomPlan {
        return {
            id: base?.id || roomIdForNumber(roomNumber),
            number: base?.number || displayName || roomNumber,
            situation: 'volny',
            status: 'neni',
            departure: undefined,
            arrival: undefined,
            nextArrivalPreview: undefined,
            departureTime: undefined,
            arrivalTime: undefined,
            guestCount: undefined,
            box: undefined,
            notes: undefined,
            assigned: undefined,
            estimatedReady: undefined,
            estimateSetAt: undefined,
            statusNote: undefined,
            checkoutException: false,
            occupiedConfirmed: false,
            freeConfirmed: false,
            stateSource: 'previo-state-pdf',
            stateImportedAt: importedAt,
            planDateIso: base?.planDateIso,
            stayoverGuestName: undefined,
            stayoverUntil: undefined,
            source: 'previo',
            importJobId,
            importedAt,
            createdByUid: undefined,
            createdByName: undefined,
            createdByRole: undefined
        }
    }

    function buildRoomsForStateDay(
        dateIso: string,
        dayPreview: PrevioStateImportPreview['days'][number],
        importedAt: string,
        importJobId?: string,
        diagnosticsCollector?: OperationalMergeDiagnostic[]
    ) {
        const existingTabs = ['Dnes', 'Zitra', 'Pozitri'] as OpsTab[]
        const currentTabDate = existingTabs.find((day) => importedTabDates[day] === dateIso)
        const sourceRooms = currentTabDate
            ? roomsByDay[currentTabDate]
            : (importedRoomsByDate[dateIso] || [])
        const existingByRoom = new Map(
            sourceRooms.map((room) => [normalizeCatalogRoomNumber(room.number), room])
        )
        const catalogByRoom = new Map(
            activeRooms.map((room) => [normalizeCatalogRoomNumber(room.roomNumber), room])
        )
        const roomNumbers = Array.from(new Set([
            ...MASTER_ROOM_NUMBERS,
            ...activeRooms.map((room) => normalizeCatalogRoomNumber(room.roomNumber))
        ])).sort((a, b) => Number(a) - Number(b))

        const parsedByRoom = new Map(
            dayPreview.rows.map((row) => [normalizeCatalogRoomNumber(row.roomNumber), row])
        )

        return roomNumbers.map((roomNumber) => {
            const base = existingByRoom.get(roomNumber)
            const parsed = parsedByRoom.get(roomNumber)
            const catalogRoom = catalogByRoom.get(roomNumber)
            const row = buildImportedBaseRow(base, roomNumber, catalogRoom?.displayName || catalogRoom?.roomNumber, importedAt, importJobId)

            let importedRoom: RoomPlan

            if (!parsed) {
                importedRoom = {
                    ...row,
                    planDateIso: dateIso,
                    freeConfirmed: Boolean(dayPreview.complete && dayPreview.derivedFreeRooms.includes(roomNumber))
                }
            } else {
                const hasDeparture = Boolean(parsed.departureTime)
                const hasArrival = Boolean(parsed.arrivalTime)
                if (!hasDeparture && !hasArrival) {
                    const stayoverNotes = parsed.arrivalNotes.length
                        ? parsed.arrivalNotes
                        : parsed.departureNotes.length
                            ? parsed.departureNotes
                            : undefined
                    const stayoverBox = extractArrivalBoxFromNotes(stayoverNotes)
                    const stayoverGuestCount = parsed.stayoverGuestCount ?? parsed.arrivalGuestCount ?? parsed.departureGuestCount

                    importedRoom = {
                        ...row,
                        planDateIso: dateIso,
                        occupiedConfirmed: true,
                        stayoverGuestName: parsed.stayoverGuestName || parsed.departureGuestName || parsed.arrivalGuestName,
                        stayoverUntil: parsed.stayoverUntil,
                        guestCount: stayoverGuestCount,
                        box: stayoverBox,
                        notes: stayoverNotes
                    }
                } else {
                    const mergedSituation = hasDeparture && hasArrival
                        ? 'odjezd_prijezd'
                        : hasDeparture
                            ? 'odjezd'
                            : 'prijezd'
                    const departureNotes = parsed.departureNotes.length ? parsed.departureNotes : undefined
                    const arrivalNotes = parsed.arrivalNotes.length ? parsed.arrivalNotes : undefined
                    const arrivalBox = extractArrivalBoxFromNotes(arrivalNotes)

                    importedRoom = {
                        ...row,
                        planDateIso: dateIso,
                        situation: mergedSituation,
                        departure: hasDeparture ? {
                            time: parsed.departureTime as string,
                            guestLabel: parsed.departureGuestName,
                            guestCount: parsed.departureGuestCount,
                            notes: departureNotes
                        } : undefined,
                        arrival: hasArrival ? {
                            time: parsed.arrivalTime as string,
                            guestLabel: parsed.arrivalGuestName,
                            guestCount: parsed.arrivalGuestCount,
                            box: arrivalBox,
                            notes: arrivalNotes
                        } : undefined,
                        departureTime: parsed.departureTime,
                        arrivalTime: parsed.arrivalTime,
                        guestCount: parsed.arrivalGuestCount ?? parsed.departureGuestCount,
                        box: arrivalBox,
                        status: 'ceka'
                    }
                }
            }

            const mergeResult = mergeImportedRoomDayWithExistingOperationalState({
                dateIso,
                importedRoom,
                existingRoom: base
            })
            if (diagnosticsCollector) diagnosticsCollector.push(...mergeResult.diagnostics)
            return mergeResult.room
        })
    }

    function buildMergedPlansFromStateImport(preview: PrevioStateImportPreview, importedAt: string, importJobId?: string) {
        const next: Record<OpsTab, typeof roomsByDay[OpsTab]> = {
            Dnes: [],
            Zitra: [],
            Pozitri: []
        }
        const diagnostics: OperationalMergeDiagnostic[] = []

        const byDate: Record<string, typeof roomsByDay[OpsTab]> = {}

        preview.days.forEach((day) => {
            byDate[day.dateIso] = buildRoomsForStateDay(day.dateIso, day, importedAt, importJobId, diagnostics)
        })

            ; (['Dnes', 'Zitra', 'Pozitri'] as OpsTab[]).forEach((day) => {
                const dateIso = preview.parsedTabDates[day]
                if (!dateIso || !byDate[dateIso]) {
                    next[day] = roomsByDay[day]
                    return
                }
                next[day] = byDate[dateIso]
            })

        return { next, byDate, diagnostics }
    }

    function buildOperationalMergeFeedbackMessages(summary: ReturnType<typeof summarizeOperationalMergeDiagnostics>) {
        const counts: string[] = []
        if (summary.statusPreservedCount > 0) counts.push(`stav: ${summary.statusPreservedCount}`)
        if (summary.assignmentPreservedCount > 0) counts.push(`přiřazení: ${summary.assignmentPreservedCount}`)
        if (summary.estimatePreservedCount > 0) counts.push(`odhad: ${summary.estimatePreservedCount}`)
        if (summary.problemPreservedCount > 0) counts.push(`problém: ${summary.problemPreservedCount}`)
        if (summary.carryOverPreservedCount > 0) counts.push(`carry-over: ${summary.carryOverPreservedCount}`)

        const touchedMessage = summary.touchedRoomCount > 0
            ? `Zachován provozní stav u ${summary.touchedRoomCount} pokojů${counts.length > 0 ? ` (${counts.join(', ')})` : ''}.`
            : ''

        const warningMessage = summary.inconsistencyWarningCount > 0
            ? `Pozor: ${summary.inconsistencyWarningCount} případů může být nekonzistentních (${summary.inconsistencyRooms.join(', ')}).`
            : ''

        const importWarnings: string[] = []
        if (touchedMessage) importWarnings.push(`[merge] ${touchedMessage}`)
        if (warningMessage) importWarnings.push(`[merge-warning] ${warningMessage}`)

        return {
            touchedMessage,
            warningMessage,
            importWarnings
        }
    }

    function applyPrevioOriginToByDate(byDate: Record<string, RoomPlan[]>, importedAt: string, importJobId?: string) {
        return Object.fromEntries(
            Object.entries(byDate).map(([dateIso, rooms]) => [
                dateIso,
                rooms.map((room) => ({
                    ...room,
                    source: 'previo' as const,
                    importJobId,
                    importedAt,
                    stateSource: room.stateSource || 'previo-state-pdf',
                    stateImportedAt: room.stateImportedAt || importedAt,
                    createdByUid: undefined,
                    createdByName: undefined,
                    createdByRole: undefined
                }))
            ])
        ) as Record<string, RoomPlan[]>
    }

    async function handleCopyImportDebugText() {
        if (!importRawText) return
        try {
            await navigator.clipboard.writeText(importRawText)
        } catch {
            setImportPdfError('Debug text se nepodařilo zkopírovat do schránky.')
        }
    }

    function handleDownloadImportDebugText() {
        if (!importRawText) return
        const blob = new Blob([importRawText], { type: 'text/plain;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = 'previo-debug-text.txt'
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        URL.revokeObjectURL(url)
    }

    async function handleCopyStateImportDebugText() {
        if (!stateImportRawText) return
        try {
            await navigator.clipboard.writeText(stateImportRawText)
        } catch {
            setStateImportPdfError('Debug text Stav se nepodařilo zkopírovat do schránky.')
        }
    }

    function handleDownloadStateImportDebugText() {
        if (!stateImportRawText) return
        const blob = new Blob([stateImportRawText], { type: 'text/plain;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = 'previo-state-debug-text.txt'
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        URL.revokeObjectURL(url)
    }

    function buildMergedPlansFromImport(preview: PrevioImportPreview): Record<OpsTab, typeof roomsByDay[OpsTab]> {
        const next: Record<OpsTab, typeof roomsByDay[OpsTab]> = {
            Dnes: [],
            Zitra: [],
            Pozitri: []
        }

            ; (['Dnes', 'Zitra', 'Pozitri'] as OpsTab[]).forEach((day) => {
                const existingByRoom = new Map(
                    roomsByDay[day].map((room) => {
                        const roomNumber = normalizeCatalogRoomNumber(room.number)
                        return [roomNumber, room]
                    })
                )

                next[day] = activeRooms.map((catalogRoom) => {
                    const normalizedRoom = normalizeCatalogRoomNumber(catalogRoom.roomNumber)
                    const base = existingByRoom.get(normalizedRoom)
                    const parsed = preview.byTab[day].get(normalizedRoom)

                    const row = base
                        ? { ...base }
                        : {
                            id: `r-${normalizedRoom}`,
                            number: catalogRoom.displayName || catalogRoom.roomNumber,
                            situation: 'volny' as const,
                            status: 'neni' as const
                        }

                    if (!parsed || (!parsed.arrivalTime && !parsed.departureTime)) {
                        return {
                            ...row,
                            departure: undefined,
                            arrival: undefined,
                            departureTime: undefined,
                            arrivalTime: undefined,
                            nextArrivalPreview: undefined,
                            situation: 'volny' as const
                        }
                    }

                    const hasDeparture = Boolean(parsed.departureTime)
                    const hasArrival = Boolean(parsed.arrivalTime)
                    const mergedSituation = hasDeparture && hasArrival
                        ? 'odjezd_prijezd'
                        : hasDeparture
                            ? 'odjezd'
                            : 'prijezd'

                    return {
                        ...row,
                        situation: mergedSituation,
                        departure: hasDeparture ? {
                            time: parsed.departureTime as string,
                            guestLabel: parsed.departureGuestName || parsed.guestLabel || row.departure?.guestLabel,
                            guestCount: parsed.guestCount,
                            notes: parsed.departureNotes.length ? parsed.departureNotes : row.departure?.notes
                        } : undefined,
                        arrival: hasArrival ? {
                            time: parsed.arrivalTime as string,
                            guestLabel: parsed.arrivalGuestName || parsed.guestLabel || row.arrival?.guestLabel,
                            guestCount: parsed.guestCount,
                            box: parsed.box || row.box,
                            notes: parsed.arrivalNotes.length ? parsed.arrivalNotes : row.arrival?.notes
                        } : undefined,
                        departureTime: parsed.departureTime,
                        arrivalTime: parsed.arrivalTime,
                        guestCount: parsed.guestCount ?? row.guestCount,
                        box: parsed.box || row.box || catalogRoom.defaultBox,
                        nextArrivalPreview: undefined
                    }
                })
            })

        return next
    }

    async function handleConfirmPrevioImport() {
        if (!isRealAdminUser) {
            setImportPdfError('Potvrzení importu je povoleno jen adminovi.')
            return
        }
        if (!importPreview) return
        const merged = buildMergedPlansFromImport(importPreview)
        setImportedTabDates(importPreview.parsedTabDates)
        setSelectedImportedDateIso(null)
        setRoomsByDay(merged)

        if (runtimeMode === 'online') {
            ; (['Dnes', 'Zitra', 'Pozitri'] as OpsTab[]).forEach((day) => {
                merged[day].forEach((room) => {
                    activeStore.updateRoomPlan(day, room.id, {
                        situation: room.situation,
                        departure: room.departure,
                        arrival: room.arrival,
                        departureTime: room.departureTime,
                        arrivalTime: room.arrivalTime,
                        guestCount: room.guestCount,
                        box: room.box,
                        nextArrivalPreview: room.nextArrivalPreview
                    })
                })
            })
        }

        setImportPreview(null)
        setImportPdfStatus('idle')
        setImportPdfError(null)
    }

    async function handleConfirmPrevioStateImport() {
        if (!isRealAdminUser) {
            setStateImportPdfError('Potvrzení importu Stav je povoleno jen adminovi.')
            return
        }
        if (!stateImportPreview) return

        const targetJob = activeStateImportJobId
            ? importJobs.find((job) => job.id === activeStateImportJobId) || null
            : null
        if (targetJob && supersededPrevioStateJobIds.has(targetJob.id)) {
            setStateImportPdfError(IMPORT_CONFIRM_SUPERSEDED_MESSAGE)
            return
        }
        const parserVersion = targetJob?.previewSummary?.parserVersion || targetJob?.parserVersion || PREVIO_STAV_PARSER_VERSION
        const safety = resolveImportSafety(stateImportPreview, statePreviewMissingDateLabels, parserVersion, targetJob?.previewSummary?.safety)

        if (!safety || safety.blocked) {
            setStateImportPdfError(IMPORT_CONFIRM_BLOCKED_MESSAGE)
            return
        }

        try {
            const importedAt = formatImportTimestamp(new Date())
            const { next, byDate, diagnostics } = buildMergedPlansFromStateImport(stateImportPreview, importedAt, targetJob?.id)
            const mergeSummary = summarizeOperationalMergeDiagnostics(diagnostics)
            const mergeFeedback = buildOperationalMergeFeedbackMessages(mergeSummary)

            const confirmedBy = currentUser?.name || currentUser?.id || 'admin'
            if (targetJob) {
                const backupPayload = buildImportBackupPayload(targetJob.id, byDate, stateImportPreview.parsedTabDates, confirmedBy)
                await persistImportBackup(targetJob, backupPayload, confirmedBy)
            }

            setImportedTabDates(stateImportPreview.parsedTabDates)
            setImportedRoomsByDate(byDate)
            setSelectedImportedDateIso(null)
            setRoomsByDay(next)

            if (runtimeMode === 'online') {
                ; (['Dnes', 'Zitra', 'Pozitri'] as OpsTab[]).forEach((day) => {
                    next[day].forEach((room) => {
                        activeStore.replaceRoomPlan(day, room)
                    })
                })

                const primaryDateSet = new Set(
                    Object.values(stateImportPreview.parsedTabDates).filter((dateIso): dateIso is string => Boolean(dateIso))
                )
                Object.entries(byDate).forEach(([dateIso, rooms]) => {
                    if (primaryDateSet.has(dateIso)) return
                    rooms.forEach((room) => {
                        activeStore.replaceRoomPlan(dateIso, room)
                    })
                })
            }

            if (activeStateImportJobId) {
                const confirmedAt = new Date().toISOString()
                const mergedWarnings = targetJob
                    ? Array.from(new Set([...(targetJob.warnings || []), ...mergeFeedback.importWarnings]))
                    : undefined
                activeStore.updateImportJob(activeStateImportJobId, {
                    status: 'confirmed',
                    confirmedAt,
                    confirmedBy,
                    error: undefined,
                    ...(mergedWarnings ? { warnings: mergedWarnings } : {})
                })
                setImportJobs((prev) => sortImportJobs(prev.map((job) => (
                    job.id === activeStateImportJobId
                        ? {
                            ...job,
                            status: 'confirmed',
                            confirmedAt,
                            confirmedBy,
                            error: undefined,
                            ...(mergedWarnings ? { warnings: mergedWarnings } : {})
                        }
                        : job
                ))))
            }

            setStateImportPreview(null)
            setStateImportPdfStatus('idle')
            setStateImportPdfError(null)
            setStateImportActionMessage(
                [
                    'Import Stav byl potvrzen a snapshot pro rollback je uložen.',
                    mergeFeedback.touchedMessage,
                    mergeFeedback.warningMessage
                ].filter(Boolean).join(' ')
            )
            setActiveStateImportJobId(null)
        } catch (error: any) {
            setStateImportPdfError(error?.message || 'Potvrzení importu Stav selhalo při ukládání snapshotu.')
        }
    }

    function handleCancelPrevioImport() {
        setImportPreview(null)
        setImportPdfStatus('idle')
        setImportPdfError(null)
        setImportRawText('')
        setImportParseResult(null)
    }

    function handleCancelPrevioStateImport() {
        setStateImportPreview(null)
        setStateImportPdfStatus('idle')
        setStateImportPdfError(null)
        setStateImportActionMessage(null)
        setStateImportRawText('')
        setStateImportParseResult(null)
        setSelectedImportJobId(null)
        setActiveStateImportJobId(null)
    }

    async function handleConfirmImportJob(jobId: string, options?: { autoConfirmReason?: string }) {
        if (!isRealAdminUser) {
            const message = 'Potvrzení importu je povoleno jen adminovi.'
            setImportJobPreviewInlineErrors((prev) => ({
                ...prev,
                [jobId]: message
            }))
            return
        }
        const job = importJobs.find((item) => item.id === jobId)
        const isAutoConfirm = Boolean(options?.autoConfirmReason)
        if (job && supersededPrevioStateJobIds.has(job.id)) {
            if (isAutoConfirm) {
                const autoBlocked = sanitizeForFirestore({
                    ...(job.automation || {}),
                    autoConfirm: {
                        mode: AUTO_CONFIRM_STAV_IMPORTS_MODE,
                        dryRun: AUTO_CONFIRM_STAV_IMPORTS_MODE !== 'enabled',
                        evaluatedAt: new Date().toISOString(),
                        eligible: false,
                        wouldConfirm: false,
                        blockedReasons: [IMPORT_CONFIRM_SUPERSEDED_MESSAGE],
                        parserVersion: PREVIO_STAV_PARSER_VERSION,
                        decision: 'blocked'
                    }
                })
                activeStore.updateImportJob(jobId, { automation: autoBlocked })
            }
            setImportJobs((prev) => sortImportJobs(prev.map((item) => (
                item.id === jobId
                    ? {
                        ...item,
                        error: IMPORT_CONFIRM_SUPERSEDED_MESSAGE,
                        automation: isAutoConfirm
                            ? sanitizeForFirestore({
                                ...(item.automation || {}),
                                autoConfirm: {
                                    mode: AUTO_CONFIRM_STAV_IMPORTS_MODE,
                                    dryRun: AUTO_CONFIRM_STAV_IMPORTS_MODE !== 'enabled',
                                    evaluatedAt: new Date().toISOString(),
                                    eligible: false,
                                    wouldConfirm: false,
                                    blockedReasons: [IMPORT_CONFIRM_SUPERSEDED_MESSAGE],
                                    parserVersion: PREVIO_STAV_PARSER_VERSION,
                                    decision: 'blocked'
                                }
                            })
                            : item.automation
                    }
                    : item
            ))))
            setImportJobPreviewInlineErrors((prev) => ({
                ...prev,
                [jobId]: IMPORT_CONFIRM_SUPERSEDED_MESSAGE
            }))
            setOpenImportJobPreviewId(jobId)
            return
        }
        const previewModel = job ? buildImportJobInlinePreviewModel(job) : null
        const byDate = job ? getImportJobByDate(job.previewSummary) : null
        const parsedTabDates = job ? getImportJobParsedTabDates(job.previewSummary) : null
        const preview = (job?.previewSummary?.preview || null) as PrevioStateImportPreview | null
        const missingDateLabels = job?.previewSummary?.missingDateLabels || []
        const parserVersion = job?.previewSummary?.parserVersion || job?.parserVersion || PREVIO_STAV_PARSER_VERSION
        const safety = resolveImportSafety(preview, missingDateLabels, parserVersion, job?.previewSummary?.safety || previewModel?.safety)

        if (!job || !previewModel || !byDate || !parsedTabDates || !preview || !safety) {
            const message = 'Náhled importu není dostupný. Zkuste náhled přegenerovat.'
            if (job) {
                setImportJobs((prev) => sortImportJobs(prev.map((item) => (
                    item.id === jobId
                        ? { ...item, error: message }
                        : item
                ))))
                setImportJobPreviewInlineErrors((prev) => ({
                    ...prev,
                    [jobId]: message
                }))
                setOpenImportJobPreviewId(jobId)
                console.warn('[import-job-preview] Potvrzení blokováno kvůli nevalidnímu náhledu', {
                    jobId,
                    previewSummaryKeys: Object.keys(asRecord(job.previewSummary) || {})
                })
            }
            return
        }

        if (safety.blocked) {
            setImportJobs((prev) => sortImportJobs(prev.map((item) => (
                item.id === jobId
                    ? { ...item, error: IMPORT_CONFIRM_BLOCKED_MESSAGE }
                    : item
            ))))
            setImportJobPreviewInlineErrors((prev) => ({
                ...prev,
                [jobId]: IMPORT_CONFIRM_BLOCKED_MESSAGE
            }))
            setOpenImportJobPreviewId(jobId)
            return
        }

        try {
            const importedAt = formatImportTimestamp(new Date())
            const byDateWithOrigin = applyPrevioOriginToByDate(byDate, importedAt, job.id)
            const existingByDate = Object.fromEntries(
                Object.keys(byDateWithOrigin).map((dateIso) => [dateIso, getCurrentRoomsForDate(dateIso, parsedTabDates)])
            ) as Record<string, RoomPlan[]>
            const mergeResult = mergeImportedByDateWithExistingOperationalState({
                importedByDate: byDateWithOrigin,
                existingByDate
            })
            const mergedByDate = mergeResult.byDate
            const mergeSummary = summarizeOperationalMergeDiagnostics(mergeResult.diagnostics)
            const mergeFeedback = buildOperationalMergeFeedbackMessages(mergeSummary)
            const next: Record<OpsTab, RoomPlan[]> = {
                Dnes: roomsByDay.Dnes,
                Zitra: roomsByDay.Zitra,
                Pozitri: roomsByDay.Pozitri
            }

                ; (['Dnes', 'Zitra', 'Pozitri'] as OpsTab[]).forEach((day) => {
                    const dateIso = parsedTabDates[day]
                    if (!dateIso || !mergedByDate[dateIso]) return
                    next[day] = mergedByDate[dateIso]
                })

            const confirmedBy = currentUser?.name || currentUser?.id || 'admin'
            const backupPayload = buildImportBackupPayload(job.id, mergedByDate, parsedTabDates, confirmedBy)
            await persistImportBackup(job, backupPayload, confirmedBy)

            setImportedTabDates(parsedTabDates)
            setImportedRoomsByDate(mergedByDate)
            setSelectedImportedDateIso(null)
            setRoomsByDay(next)

            if (runtimeMode === 'online') {
                ; (['Dnes', 'Zitra', 'Pozitri'] as OpsTab[]).forEach((day) => {
                    next[day].forEach((room) => activeStore.replaceRoomPlan(day, room))
                })

                const primaryDateSet = new Set(Object.values(parsedTabDates).filter((dateIso): dateIso is string => Boolean(dateIso)))
                Object.entries(mergedByDate).forEach(([dateIso, rooms]) => {
                    if (primaryDateSet.has(dateIso)) return
                    rooms.forEach((room) => activeStore.replaceRoomPlan(dateIso, room))
                })
            }

            const confirmedAt = new Date().toISOString()
            const operationalMergePatch = sanitizeForFirestore({
                status: 'applied',
                touchedRoomCount: mergeSummary.touchedRoomCount,
                statusPreservedCount: mergeSummary.statusPreservedCount,
                assignmentPreservedCount: mergeSummary.assignmentPreservedCount,
                estimatePreservedCount: mergeSummary.estimatePreservedCount,
                problemPreservedCount: mergeSummary.problemPreservedCount,
                carryOverPreservedCount: mergeSummary.carryOverPreservedCount,
                inconsistencyWarningCount: mergeSummary.inconsistencyWarningCount,
                inconsistencyRooms: mergeSummary.inconsistencyRooms,
                appliedAt: confirmedAt
            })
            const previewSummaryPatch = job.previewSummary
                ? sanitizeForFirestore({
                    ...job.previewSummary,
                    diagnostics: sanitizeForFirestore({
                        ...(asRecord(job.previewSummary?.diagnostics) || {}),
                        operationalMerge: operationalMergePatch
                    })
                })
                : undefined
            const automationPatch = isAutoConfirm
                ? sanitizeForFirestore({
                    ...(job.automation || {}),
                    autoConfirm: {
                        mode: AUTO_CONFIRM_STAV_IMPORTS_MODE,
                        dryRun: AUTO_CONFIRM_STAV_IMPORTS_MODE !== 'enabled',
                        evaluatedAt: confirmedAt,
                        eligible: true,
                        wouldConfirm: true,
                        blockedReasons: [],
                        parserVersion,
                        safetyStatus: safety.status,
                        decision: 'confirmed'
                    },
                    autoConfirmedAt: confirmedAt,
                    autoConfirmedBy: confirmedBy,
                    autoConfirmReason: options?.autoConfirmReason
                })
                : undefined

            activeStore.updateImportJob(jobId, {
                status: 'confirmed',
                confirmedAt,
                confirmedBy,
                error: undefined,
                warnings: Array.from(new Set([...(job.warnings || []), ...mergeFeedback.importWarnings])),
                confirmationDiagnostics: sanitizeForFirestore({
                    ...(asRecord(job.confirmationDiagnostics) || {}),
                    operationalMerge: operationalMergePatch
                }),
                ...(previewSummaryPatch ? { previewSummary: previewSummaryPatch } : {}),
                ...(automationPatch ? { automation: automationPatch } : {})
            })
            setImportJobs((prev) => sortImportJobs(prev.map((item) => (
                item.id === jobId
                    ? {
                        ...item,
                        status: 'confirmed',
                        confirmedAt,
                        confirmedBy,
                        error: undefined,
                        warnings: Array.from(new Set([...(item.warnings || []), ...mergeFeedback.importWarnings])),
                        confirmationDiagnostics: sanitizeForFirestore({
                            ...(asRecord(item.confirmationDiagnostics) || {}),
                            operationalMerge: operationalMergePatch
                        }),
                        ...(item.previewSummary
                            ? {
                                previewSummary: sanitizeForFirestore({
                                    ...item.previewSummary,
                                    diagnostics: sanitizeForFirestore({
                                        ...(asRecord(item.previewSummary?.diagnostics) || {}),
                                        operationalMerge: operationalMergePatch
                                    })
                                })
                            }
                            : {}),
                        ...(automationPatch ? { automation: automationPatch } : {})
                    }
                    : item
            ))))
            setStateImportPreview(null)
            setActiveStateImportJobId(null)
            setStateImportActionMessage([
                isAutoConfirm
                    ? 'Import Stav byl automaticky potvrzen a snapshot pro rollback je uložen.'
                    : 'Import Stav byl potvrzen a snapshot pro rollback je uložen.',
                mergeFeedback.touchedMessage,
                mergeFeedback.warningMessage
            ].filter(Boolean).join(' '))
        } catch (error: any) {
            const message = error?.message || 'Potvrzení importu selhalo při ukládání snapshotu.'
            if (job && isAutoConfirm) {
                const automationPatch = sanitizeForFirestore({
                    ...(job.automation || {}),
                    autoConfirm: {
                        mode: AUTO_CONFIRM_STAV_IMPORTS_MODE,
                        dryRun: AUTO_CONFIRM_STAV_IMPORTS_MODE !== 'enabled',
                        evaluatedAt: new Date().toISOString(),
                        eligible: false,
                        wouldConfirm: false,
                        blockedReasons: [message],
                        parserVersion: PREVIO_STAV_PARSER_VERSION,
                        decision: 'blocked'
                    }
                })
                activeStore.updateImportJob(job.id, { automation: automationPatch })
            }
            setImportJobs((prev) => sortImportJobs(prev.map((item) => (
                item.id === jobId
                    ? {
                        ...item,
                        error: message,
                        automation: (isAutoConfirm && job)
                            ? sanitizeForFirestore({
                                ...(item.automation || {}),
                                autoConfirm: {
                                    mode: AUTO_CONFIRM_STAV_IMPORTS_MODE,
                                    dryRun: AUTO_CONFIRM_STAV_IMPORTS_MODE !== 'enabled',
                                    evaluatedAt: new Date().toISOString(),
                                    eligible: false,
                                    wouldConfirm: false,
                                    blockedReasons: [message],
                                    parserVersion: PREVIO_STAV_PARSER_VERSION,
                                    decision: 'blocked'
                                }
                            })
                            : item.automation
                    }
                    : item
            ))))
            setImportJobPreviewInlineErrors((prev) => ({
                ...prev,
                [jobId]: message
            }))
        }
    }

    function handleCancelImportJob(jobId: string) {
        if (!isRealAdminUser) return
        activeStore.updateImportJob(jobId, {
            status: 'cancelled',
            error: undefined
        })
        setImportJobs((prev) => sortImportJobs(prev.map((item) => (
            item.id === jobId ? { ...item, status: 'cancelled', error: undefined } : item
        ))))
    }

    function likelyTestImportJob(job: ImportJob) {
        const normalized = normalizeTaskTitleForCleanup(`${job.fileName || ''} ${job.parserVersion || ''}`)
        return normalized.includes('test') || normalized.includes('demo') || normalized.includes('sample')
    }

    function olderThanDays(dateValue: string | undefined, days: number) {
        if (!dateValue) return false
        const receivedAt = new Date(dateValue)
        if (Number.isNaN(receivedAt.getTime())) return false
        const threshold = new Date()
        threshold.setDate(threshold.getDate() - days)
        return receivedAt < threshold
    }

    function getImportCleanupTargets(mode: ImportCleanupMode) {
        const protectedJobId = latestRollbackCandidateJob?.id
        const protectedNewestJobId = newestPrevioStateJob?.id

        if (mode === 'test_unconfirmed') {
            return importJobs.filter((job) => {
                if (job.id === protectedJobId) return false
                if (job.id === protectedNewestJobId) return false
                return job.status !== 'confirmed' || likelyTestImportJob(job)
            })
        }

        return importJobs.filter((job) => (
            job.id !== protectedJobId
            && job.id !== protectedNewestJobId
            &&
            olderThanDays(job.receivedAt, IMPORT_CLEANUP_OLD_DAYS)
        ))
    }

    function assertAdminCleanupAllowed() {
        if (!isRealAdminUser) {
            throw new Error('Mazání importů je povoleno jen adminovi.')
        }
    }

    function createCleanupFeedback(params: {
        tone: ImportCleanupFeedback['tone']
        message: string
        candidates: number
        summary?: {
            deletedJobIds: string[]
            notFoundJobIds: string[]
            storageDeletedCount: number
            storageWarnings: Array<{ jobId: string; warning: string }>
        }
        skippedProtected?: number
    }): ImportCleanupFeedback {
        const summary = params.summary
        return {
            tone: params.tone,
            message: params.message,
            candidates: params.candidates,
            deletedJobs: summary?.deletedJobIds.length || 0,
            deletedPdfs: summary?.storageDeletedCount || 0,
            skippedProtected: params.skippedProtected || 0,
            storageWarnings: summary?.storageWarnings.length || 0,
            notFound: summary?.notFoundJobIds.length || 0
        }
    }

    function removeImportJobsFromUi(deletedJobIds: string[]) {
        const deletedSet = new Set(deletedJobIds)
        if (deletedSet.size === 0) return

        setImportJobs((prev) => prev.filter((item) => !deletedSet.has(item.id)))

        if (latestStateImportBackup && deletedSet.has(latestStateImportBackup.jobId)) {
            setLatestStateImportBackup(null)
        }

        if (openImportJobPreviewId && deletedSet.has(openImportJobPreviewId)) {
            setOpenImportJobPreviewId(null)
        }

        if ((selectedImportJobId && deletedSet.has(selectedImportJobId)) || (activeStateImportJobId && deletedSet.has(activeStateImportJobId))) {
            setSelectedImportJobId(null)
            setStateImportPreview(null)
            setActiveStateImportJobId(null)
        }

        setExpandedImportJobPreviewRows((prev) => {
            const next = { ...prev }
            deletedJobIds.forEach((jobId) => {
                delete next[jobId]
            })
            return next
        })

        setImportJobPreviewInlineErrors((prev) => {
            const next = { ...prev }
            deletedJobIds.forEach((jobId) => {
                delete next[jobId]
            })
            return next
        })
    }

    async function refreshImportJobsFromServer() {
        if (runtimeMode !== 'online' || !firestoreDb || !isAdminUser) return
        const snap = await getDocs(collection(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'importJobs'))
        const refreshed = snap.docs
            .map((item) => ({ id: item.id, ...(item.data() as Record<string, any>) } as ImportJob))
            .sort((a, b) => (b.receivedAt || '').localeCompare(a.receivedAt || ''))
        setImportJobs(refreshed)
    }

    async function deleteImportJobsWithStorage(jobIds: string[]) {
        if (jobIds.length === 0) {
            return {
                deletedJobIds: [] as string[],
                notFoundJobIds: [] as string[],
                storageDeletedCount: 0,
                storageWarnings: [] as Array<{ jobId: string; warning: string }>
            }
        }

        if (runtimeMode !== 'online') {
            jobIds.forEach((jobId) => activeStore.deleteImportJob(jobId))
            removeImportJobsFromUi(jobIds)
            return {
                deletedJobIds: jobIds,
                notFoundJobIds: [],
                storageDeletedCount: 0,
                storageWarnings: [] as Array<{ jobId: string; warning: string }>
            }
        }

        if (!authUser || authUser.isAnonymous) {
            throw new Error('Pro mazání importů je nutné přihlášení.')
        }
        if (!isAdminUser) {
            throw new Error('Mazání importů je povoleno jen adminovi.')
        }

        const token = await authUser.getIdToken()
        const response = await fetch('/api/previo-import-cleanup', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({
                hotelId: ONLINE_HOTEL_ID,
                jobIds
            })
        })

        const responseBody = await response.json().catch(() => ({} as any))
        if (!response.ok) {
            const apiError = responseBody?.error || `Server vrátil chybu ${response.status}.`
            throw new Error(apiError)
        }

        const deletedJobIds = Array.isArray(responseBody?.deletedJobIds)
            ? responseBody.deletedJobIds.filter((value: unknown): value is string => typeof value === 'string')
            : []
        const notFoundJobIds = Array.isArray(responseBody?.notFoundJobIds)
            ? responseBody.notFoundJobIds.filter((value: unknown): value is string => typeof value === 'string')
            : []
        const storageWarnings = Array.isArray(responseBody?.storageWarnings)
            ? responseBody.storageWarnings.filter((item: unknown): item is { jobId: string; warning: string } => {
                if (!item || typeof item !== 'object') return false
                return typeof (item as any).jobId === 'string' && typeof (item as any).warning === 'string'
            })
            : []
        const storageDeletedCount = typeof responseBody?.storageDeletedCount === 'number'
            ? responseBody.storageDeletedCount
            : 0

        removeImportJobsFromUi(deletedJobIds)
        await refreshImportJobsFromServer()

        return {
            deletedJobIds,
            notFoundJobIds,
            storageDeletedCount,
            storageWarnings
        }
    }

    async function handleDeleteImportJob(jobId: string) {
        const job = importJobs.find((item) => item.id === jobId)
        if (!job) return

        try {
            assertAdminCleanupAllowed()
        } catch (error: any) {
            setImportCleanupFeedback(createCleanupFeedback({
                tone: 'error',
                message: error?.message || 'Mazání importů je povoleno jen adminovi.',
                candidates: 0
            }))
            return
        }

        const hasStorage = Boolean(job.storagePath)
        const confirmed = window.confirm(
            hasStorage
                ? 'Opravdu smazat tento import? Tato akce odstraní i uložené PDF.'
                : 'Opravdu smazat tento import?'
        )
        if (!confirmed) return

        setImportCleanupInProgress(true)
        setImportCleanupAction('single')
        setImportCleanupFeedback(null)

        try {
            const summary = await deleteImportJobsWithStorage([jobId])
            if (summary.deletedJobIds.length === 0) {
                setImportCleanupFeedback(createCleanupFeedback({
                    tone: 'warning',
                    message: 'Import nebyl smazán (záznam nebyl nalezen).',
                    candidates: 1,
                    summary
                }))
                return
            }

            setImportCleanupFeedback(createCleanupFeedback({
                tone: summary.storageWarnings.length > 0 ? 'warning' : 'success',
                message: `Import ${job.fileName} byl smazán.`,
                candidates: 1,
                summary
            }))
        } catch (error: any) {
            console.warn('[import-cleanup] delete single failed', { jobId, message: error?.message })
            setImportCleanupFeedback(createCleanupFeedback({
                tone: 'error',
                message: error?.message || 'Mazání importu selhalo.',
                candidates: 1
            }))
        } finally {
            setImportCleanupInProgress(false)
            setImportCleanupAction(null)
        }
    }

    async function handleBulkImportCleanup(mode: ImportCleanupMode) {
        setImportCleanupFeedback(createCleanupFeedback({
            tone: 'info',
            message: IMPORT_CLEANUP_PRECHECK_MESSAGE,
            candidates: 0
        }))

        try {
            assertAdminCleanupAllowed()
        } catch (error: any) {
            setImportCleanupFeedback(createCleanupFeedback({
                tone: 'error',
                message: error?.message || 'Mazání importů je povoleno jen adminovi.',
                candidates: 0
            }))
            return
        }

        const allCandidates = importJobs.filter((job) => {
            if (mode === 'test_unconfirmed') {
                return job.status !== 'confirmed' || likelyTestImportJob(job)
            }
            return olderThanDays(job.receivedAt, IMPORT_CLEANUP_OLD_DAYS)
        })

        const targets = getImportCleanupTargets(mode)
        const skippedProtected = Math.max(0, allCandidates.length - targets.length)
        console.log('[import-cleanup] action clicked', {
            action: mode,
            candidates: allCandidates.length,
            targets: targets.length,
            protectedCount: skippedProtected
        })
        if (targets.length === 0) {
            setImportCleanupFeedback(createCleanupFeedback({
                tone: 'info',
                message: 'Nebyly nalezeny žádné importy ke smazání.',
                candidates: allCandidates.length,
                skippedProtected
            }))
            return
        }

        const confirmed = window.confirm(
            mode === 'old'
                ? 'Opravdu smazat staré importy? Tato akce odstraní i uložená PDF.'
                : `Opravdu smazat ${targets.length} testovacích/nepotvrzených importů? Tato akce odstraní i uložená PDF.`
        )
        if (!confirmed) return

        setImportCleanupInProgress(true)
        setImportCleanupAction(mode)
        setImportCleanupFeedback(null)

        try {
            const summary = await deleteImportJobsWithStorage(targets.map((job) => job.id))
            setImportCleanupFeedback(createCleanupFeedback({
                tone: summary.storageWarnings.length > 0 || summary.notFoundJobIds.length > 0 ? 'warning' : 'success',
                message: `Smazáno ${summary.deletedJobIds.length} importů.`,
                candidates: allCandidates.length,
                summary,
                skippedProtected
            }))
        } catch (error: any) {
            console.warn('[import-cleanup] bulk failed', { mode, message: error?.message })
            setImportCleanupFeedback(createCleanupFeedback({
                tone: 'error',
                message: error?.message || 'Hromadné mazání importů selhalo.',
                candidates: allCandidates.length,
                skippedProtected
            }))
        } finally {
            setImportCleanupInProgress(false)
            setImportCleanupAction(null)
        }
    }

    async function handleCleanupSupersededImports() {
        setImportCleanupFeedback(createCleanupFeedback({
            tone: 'info',
            message: IMPORT_CLEANUP_PRECHECK_MESSAGE,
            candidates: 0
        }))

        try {
            assertAdminCleanupAllowed()
        } catch (error: any) {
            setImportCleanupFeedback(createCleanupFeedback({
                tone: 'error',
                message: error?.message || 'Mazání importů je povoleno jen adminovi.',
                candidates: 0
            }))
            return
        }

        const latestJobId = newestPrevioStateJob?.id
        const protectedRollbackJobId = latestRollbackCandidateJob?.id
        const allCandidates = supersededUnconfirmedPrevioJobs
        const targets = allCandidates.filter((job) => {
            if (job.id === latestJobId) return false
            if (job.id === protectedRollbackJobId) return false
            return true
        })
        const skippedProtected = Math.max(0, allCandidates.length - targets.length)
        console.log('[import-cleanup] action clicked', {
            action: 'superseded',
            candidates: allCandidates.length,
            targets: targets.length,
            protectedCount: skippedProtected,
            newestProtected: Boolean(latestJobId),
            rollbackProtected: Boolean(protectedRollbackJobId)
        })

        if (targets.length === 0) {
            setImportCleanupFeedback(createCleanupFeedback({
                tone: 'info',
                message: 'Žádné nahrazené nepotvrzené importy ke smazání. Potvrzené importy zůstávají kvůli historii a rollbacku.',
                candidates: allCandidates.length,
                skippedProtected
            }))
            return
        }

        const confirmed = window.confirm('Opravdu smazat nahrazené nepotvrzené importy? Odstraní se i uložená PDF, pokud existují.')
        if (!confirmed) return

        setImportCleanupInProgress(true)
        setImportCleanupAction('superseded')
        setImportCleanupFeedback(null)

        try {
            const summary = await deleteImportJobsWithStorage(targets.map((job) => job.id))
            if (summary.deletedJobIds.length === 0) {
                setImportCleanupFeedback(createCleanupFeedback({
                    tone: 'info',
                    message: 'Žádné nahrazené nepotvrzené importy ke smazání. Potvrzené importy zůstávají kvůli historii a rollbacku.',
                    candidates: allCandidates.length,
                    summary,
                    skippedProtected
                }))
                return
            }
            setImportCleanupFeedback(createCleanupFeedback({
                tone: summary.storageWarnings.length > 0 ? 'warning' : 'success',
                message: `Smazáno ${summary.deletedJobIds.length} importů.`,
                candidates: allCandidates.length,
                summary,
                skippedProtected
            }))
        } catch (error: any) {
            console.warn('[import-cleanup] superseded failed', { message: error?.message })
            setImportCleanupFeedback(createCleanupFeedback({
                tone: 'error',
                message: error?.message || 'Mazání nahrazených importů selhalo.',
                candidates: allCandidates.length,
                skippedProtected
            }))
        } finally {
            setImportCleanupInProgress(false)
            setImportCleanupAction(null)
        }
    }

    function handleShowImportJobPreview(jobId: string) {
        if (openImportJobPreviewId === jobId) {
            setOpenImportJobPreviewId(null)
            return
        }

        const job = importJobs.find((item) => item.id === jobId)
        const previewModel = job ? buildImportJobInlinePreviewModel(job) : null

        if (!previewModel) {
            const message = 'Náhled importu není dostupný. Zkuste náhled přegenerovat.'
            console.warn('[import-job-preview] Neplatný nebo chybějící náhled import jobu', {
                jobId,
                previewSummaryKeys: Object.keys(asRecord(job?.previewSummary) || {})
            })
            setImportJobPreviewInlineErrors((prev) => ({
                ...prev,
                [jobId]: message
            }))
        } else {
            setImportJobPreviewInlineErrors((prev) => {
                if (!(jobId in prev)) return prev
                const next = { ...prev }
                delete next[jobId]
                return next
            })
        }

        setOpenImportJobPreviewId(jobId)
        setExpandedImportJobPreviewRows((prev) => ({
            ...prev,
            [jobId]: false
        }))

        window.setTimeout(() => {
            importJobPreviewPanelRefs.current[jobId]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        }, 50)
    }

    function handleRoleChange(nextUserId: string) {
        if (runtimeMode === 'online') return
        const nextUser = users.find((u) => u.id === nextUserId)
        setUserId(nextUserId)

        if (isMaintenanceRole(nextUser?.role)) {
            setView('maintenance')
        } else if (view === 'maintenance') {
            setView('today')
        }
    }

    function formatNowHHmm(date = new Date()) {
        return date.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false })
    }

    function buildManualOriginMeta() {
        return {
            source: 'manual' as const,
            createdByUid: currentUser?.id,
            createdByName: currentUser?.name,
            createdByRole: currentUser?.role
        }
    }

    function addMinutes(base: Date, minutes: number) {
        const next = new Date(base.getTime() + minutes * 60 * 1000)
        return formatNowHHmm(next)
    }

    function handleAction(id: string, action: RoomAction, payload?: RoomActionPayload) {
        const assignedName = currentUser?.name
        const now = new Date()
        const nowIso = now.toISOString()
        const setAt = formatNowHHmm(now)
        const computedEstimate = payload?.estimateTime
            ? payload.estimateTime
            : typeof payload?.relativeMinutes === 'number'
                ? addMinutes(now, payload.relativeMinutes)
                : undefined
        const manualOriginMeta = buildManualOriginMeta()
        const operationalUpdatedBy = currentUser?.id || currentUser?.name || userId
        const operationalStatusMeta = buildOperationalStatusMeta(effectiveDateIso, nowIso, operationalUpdatedBy)

        let patch: Partial<any> = {}
        if (action === 'hotovo') {
            patch = { status: 'hotovo', carryOverResolvedAt: nowIso, ...operationalStatusMeta }
        }
        if (action === 'prevzit') patch = { status: 'prevzato', assigned: assignedName, ...operationalStatusMeta }
        if (action === 'odhad') patch = { status: 'odhad', estimatedReady: computedEstimate || '12:30', estimateSetAt: setAt, assigned: assignedName, ...operationalStatusMeta }
        if (action === 'problem') patch = { status: 'problem', statusNote: payload?.problemText?.trim() || 'Problém nahlášen', ...manualOriginMeta, ...operationalStatusMeta }
        if (action === 'host_zustava') patch = { status: 'problem', statusNote: 'Host neodešel', checkoutException: true, ...manualOriginMeta, ...operationalStatusMeta }
        if (action === 'clear_exception') patch = { checkoutException: false, statusNote: undefined, status: 'ceka', ...operationalStatusMeta }
        if (action === 'resolve_carry_over') patch = buildCarryOverResolutionPatch()
        if (action === 'reset_to_waiting') patch = buildResetRoomToWaitingPatch(effectiveDateIso, nowIso, operationalUpdatedBy)
        if (runtimeMode === 'online') {
            activeStore.updateRoomPlan(tab, id, patch)
        }

        setRoomsByDay((prev) => ({
            ...prev,
            [tab]: prev[tab].map((r) => {
                if (r.id !== id) return r

                if (action === 'hotovo') {
                    return {
                        ...r,
                        status: 'hotovo',
                        carryOverResolvedAt: nowIso,
                        ...operationalStatusMeta,
                        statusNote: r.checkoutException ? r.statusNote : undefined
                    }
                }
                if (action === 'prevzit') {
                    return {
                        ...r,
                        status: 'prevzato',
                        assigned: assignedName || r.assigned,
                        ...operationalStatusMeta,
                        statusNote: r.checkoutException ? r.statusNote : undefined
                    }
                }
                if (action === 'odhad') {
                    return {
                        ...r,
                        status: 'odhad',
                        estimatedReady: computedEstimate || r.estimatedReady || '12:30',
                        estimateSetAt: setAt,
                        assigned: assignedName || r.assigned,
                        ...operationalStatusMeta,
                        statusNote: r.checkoutException ? r.statusNote : undefined
                    }
                }
                if (action === 'problem') {
                    return {
                        ...r,
                        status: 'problem',
                        statusNote: payload?.problemText?.trim() || 'Problém nahlášen',
                        ...manualOriginMeta,
                        ...operationalStatusMeta
                    }
                }
                if (action === 'host_zustava') {
                    // TODO: Here we can trigger push notification to admin in future backend integration.
                    return {
                        ...r,
                        status: 'problem',
                        statusNote: 'Host neodešel',
                        checkoutException: true,
                        ...manualOriginMeta,
                        ...operationalStatusMeta
                    }
                }
                if (action === 'clear_exception') {
                    return {
                        ...r,
                        checkoutException: false,
                        statusNote: r.statusNote === 'Host neodešel' ? undefined : r.statusNote,
                        status: r.status === 'problem' ? 'ceka' : r.status,
                        ...operationalStatusMeta
                    }
                }
                if (action === 'resolve_carry_over') {
                    return applyCarryOverResolution(r)
                }
                if (action === 'reset_to_waiting') {
                    return applyRoomOperationalPatch(r, buildResetRoomToWaitingPatch(effectiveDateIso, nowIso, operationalUpdatedBy))
                }
                return r
            })
        }))
    }

    function handleUpdateTaskStatus(taskId: string, status: Task['status']) {
        const now = new Date().toISOString()
        const actorName = currentUser?.name || currentUser?.id || 'staff'
        const actorUid = currentUser?.id
        if (status === 'read') {
            activeStore.updateTask(taskId, {
                status,
                acknowledgedAt: now,
                acknowledgedBy: actorName
            })
        } else if (status === 'done') {
            activeStore.updateTask(taskId, {
                status,
                completedAt: now,
                completedByUid: actorUid,
                completedByName: actorName
            })
        } else {
            activeStore.updateTaskStatus(taskId, status)
        }
        setTasks((prev) => prev.map((task) => {
            if (task.id !== taskId) return task
            if (status === 'read') {
                return {
                    ...task,
                    status,
                    acknowledgedAt: task.acknowledgedAt || now,
                    acknowledgedBy: task.acknowledgedBy || actorName
                }
            }
            if (status === 'done') {
                return {
                    ...task,
                    status,
                    completedAt: now,
                    completedByUid: actorUid || task.completedByUid,
                    completedByName: actorName || task.completedByName
                }
            }
            return { ...task, status }
        }))
    }

    function handleCancelTask(taskId: string) {
        handleUpdateTaskStatus(taskId, 'cancelled')
    }

    function handleAcknowledgeRoomLateTasks(roomNumber: string) {
        const now = new Date().toISOString()
        const actor = currentUser?.name || currentUser?.id || 'staff'
        const targetIds = tasks
            .filter((task) => (
                task.roomNumber === roomNumber
                && task.taskDateIso === todayDateIso
                && task.attentionRequired
                && task.attentionReason === 'late_today_room_task'
                && task.status !== 'read'
                && task.status !== 'waiting_material'
                && task.status !== 'done'
                && task.status !== 'cancelled'
            ))
            .map((task) => task.id)

        if (targetIds.length === 0) return

        targetIds.forEach((taskId) => activeStore.updateTask(taskId, {
            status: 'read',
            acknowledgedAt: now,
            acknowledgedBy: actor
        }))

        setTasks((prev) => prev.map((task) => (
            targetIds.includes(task.id)
                ? {
                    ...task,
                    status: 'read',
                    acknowledgedAt: task.acknowledgedAt || now,
                    acknowledgedBy: task.acknowledgedBy || actor
                }
                : task
        )))
    }

    function handleAcknowledgeMaintenanceTask(taskId: string) {
        const now = new Date().toISOString()
        const actor = currentUser?.name || currentUser?.id || 'staff'

        activeStore.updateTask(taskId, {
            maintenanceAcknowledgedAt: now,
            maintenanceAcknowledgedBy: actor
        })

        setTasks((prev) => prev.map((task) => (
            task.id === taskId
                ? {
                    ...task,
                    maintenanceAcknowledgedAt: task.maintenanceAcknowledgedAt || now,
                    maintenanceAcknowledgedBy: task.maintenanceAcknowledgedBy || actor
                }
                : task
        )))
    }

    function handleAcknowledgeMaintenanceItem(itemId: string) {
        const now = new Date().toISOString()
        const actor = currentUser?.name || currentUser?.id || 'staff'

        handleUpdateMaintenanceItem(itemId, {
            maintenanceAcknowledgedAt: now,
            maintenanceAcknowledgedBy: actor
        })
    }

    function showLateTaskNavigationMessage(message: string) {
        setLateTaskNavMessage(message)
        if (lateTaskNavMessageTimeoutRef.current) {
            window.clearTimeout(lateTaskNavMessageTimeoutRef.current)
        }
        lateTaskNavMessageTimeoutRef.current = window.setTimeout(() => {
            setLateTaskNavMessage(null)
            lateTaskNavMessageTimeoutRef.current = null
        }, 4000)
    }

    function showMaintenanceNavigationMessage(message: string) {
        setMaintenanceNavMessage(message)
        if (maintenanceNavMessageTimeoutRef.current) {
            window.clearTimeout(maintenanceNavMessageTimeoutRef.current)
        }
        maintenanceNavMessageTimeoutRef.current = window.setTimeout(() => {
            setMaintenanceNavMessage(null)
            maintenanceNavMessageTimeoutRef.current = null
        }, 4000)
    }

    function handleJumpToLateTaskRoom() {
        if (orderedLateRoomNumbers.length === 0) return

        const currentIndex = lateTaskLastFocusedRoomNumber
            ? orderedLateRoomNumbers.indexOf(lateTaskLastFocusedRoomNumber)
            : -1
        const nextIndex = currentIndex >= 0 && currentIndex + 1 < orderedLateRoomNumbers.length
            ? currentIndex + 1
            : 0
        const targetRoomNumber = orderedLateRoomNumbers[nextIndex]

        setView('today')
        setSelectedImportedDateIso(null)
        setTab('Dnes')
        setLateTaskLastFocusedRoomNumber(targetRoomNumber)
        setLateTaskNavMessage(null)

        lateTaskFocusRequestCounterRef.current += 1
        setLateTaskRoomFocusRequest({
            requestId: lateTaskFocusRequestCounterRef.current,
            roomNumber: targetRoomNumber
        })
    }

    function handleLateTaskFocusResult(result: { requestId: number; roomNumber: string; found: boolean }) {
        if (lateTaskRoomFocusRequest?.requestId !== result.requestId) return
        if (!result.found) {
            console.warn('[late-task-nav] room not found for focus', result.roomNumber)
            showLateTaskNavigationMessage('Nový úkol existuje, ale pokoj se nepodařilo najít.')
        }
        setLateTaskRoomFocusRequest(null)
    }

    function handleJumpToMaintenanceAttention() {
        if (orderedMaintenanceAttentionTargets.length === 0) return

        const currentIndex = maintenanceLastFocusedTargetId
            ? orderedMaintenanceAttentionTargets.findIndex((target) => `${target.kind}:${target.id}` === maintenanceLastFocusedTargetId)
            : -1
        const nextIndex = currentIndex >= 0 && currentIndex + 1 < orderedMaintenanceAttentionTargets.length
            ? currentIndex + 1
            : 0
        const target = orderedMaintenanceAttentionTargets[nextIndex]

        setView('maintenance')
        setMaintenanceNavMessage(null)
        setMaintenanceLastFocusedTargetId(`${target.kind}:${target.id}`)

        maintenanceFocusRequestCounterRef.current += 1
        setMaintenanceFocusRequest({
            requestId: maintenanceFocusRequestCounterRef.current,
            targetId: target.id,
            targetKind: target.kind
        })
    }

    function handleMaintenanceFocusResult(result: { requestId: number; targetId: string; targetKind: 'task' | 'item'; found: boolean }) {
        if (maintenanceFocusRequest?.requestId !== result.requestId) return
        if (!result.found) {
            console.warn('[maintenance-task-nav] target not found for focus', `${result.targetKind}:${result.targetId}`)
            showMaintenanceNavigationMessage('Nový úkol údržby existuje, ale nepodařilo se ho najít.')
        }
        setMaintenanceFocusRequest(null)
    }

    function handleJumpToRoomFromMaintenance(roomNumber?: string) {
        const trimmed = (roomNumber || '').trim()
        if (!trimmed) return
        setView('today')
        setSelectedImportedDateIso(null)
        setTab('Dnes')
        lateTaskFocusRequestCounterRef.current += 1
        setLateTaskRoomFocusRequest({
            requestId: lateTaskFocusRequestCounterRef.current,
            roomNumber: trimmed
        })
    }

    function handleCreateTask(roomId: string, input: CreateTaskInput) {
        if (!input.title.trim()) {
            throw new Error('Napište, co je potřeba udělat.')
        }

        const room = roomsByDay[tab].find((r) => r.id === roomId)
        if (!room) {
            throw new Error('Pokoj se nepodařilo najít.')
        }
        if (!currentUser) {
            throw new Error('Chybí přihlášený uživatel.')
        }

        const createdAt = formatNowHHmm(new Date())
        const todayIso = formatLocalDateIso(new Date())
        const isTodayTask = tab === 'Dnes' && selectedTabDateIso === todayIso
        const lateTodayRoomTask = isTodayTask && isRoomLikelyAlreadyTouched(room)
        const manualOriginMeta = buildManualOriginMeta()

        // TODO: Hook push notification trigger here when backend notification pipeline is ready.
        const newTask: Task = {
            id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            roomNumber: room.number,
            title: input.title,
            category: input.category,
            priority: input.priority,
            assignedToRole: input.assignedToRole,
            assignedToName: defaultAssigneeName(input.assignedToRole),
            status: 'new',
            note: input.note,
            createdBy: currentUser.name,
            createdAt,
            taskDateIso: selectedTabDateIso,
            attentionRequired: lateTodayRoomTask || undefined,
            attentionReason: lateTodayRoomTask ? 'late_today_room_task' : undefined,
            ...manualOriginMeta
        }

        if (runtimeMode === 'online') {
            activeStore.createTask({
                id: newTask.id,
                roomNumber: newTask.roomNumber,
                title: newTask.title,
                category: newTask.category,
                priority: newTask.priority,
                assignedToRole: newTask.assignedToRole,
                note: newTask.note,
                createdBy: newTask.createdBy,
                createdAt: newTask.createdAt,
                taskDateIso: newTask.taskDateIso,
                attentionRequired: newTask.attentionRequired,
                attentionReason: newTask.attentionReason,
                source: newTask.source,
                createdByUid: newTask.createdByUid,
                createdByName: newTask.createdByName,
                createdByRole: newTask.createdByRole,
                importJobId: newTask.importJobId,
                importedAt: newTask.importedAt
            })
        }

        setTasks((prev) => [newTask, ...prev])
    }

    function handleReportRoomProblem(roomId: string, input: ReportRoomProblemInput) {
        const description = input.description.trim()
        if (!description) {
            throw new Error('Popište problém.')
        }

        const room = roomsByDay[tab].find((r) => r.id === roomId)
        if (!room) {
            throw new Error('Pokoj se nepodařilo najít.')
        }
        if (!currentUser) {
            throw new Error('Chybí přihlášený uživatel.')
        }

        const now = new Date()
        const createdAt = formatNowHHmm(now)
        const manualOriginMeta = buildManualOriginMeta()
        const newItem: MaintenanceItem = {
            id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            roomNumber: formatRoomNumber(room.number),
            title: description,
            category: 'room_issue',
            priority: input.priority,
            status: 'new',
            reportedBy: currentUser.name,
            createdAt,
            note: `Nahlášeno z pokojů (${dayLabel || tab})`,
            ...manualOriginMeta
        }

        if (runtimeMode === 'online') {
            activeStore.createMaintenanceItem({
                id: newItem.id,
                roomNumber: newItem.roomNumber,
                title: newItem.title,
                category: newItem.category,
                priority: newItem.priority,
                note: newItem.note,
                reportedBy: newItem.reportedBy,
                createdAt: newItem.createdAt,
                source: newItem.source,
                createdByUid: newItem.createdByUid,
                createdByName: newItem.createdByName,
                createdByRole: newItem.createdByRole,
                importJobId: newItem.importJobId,
                importedAt: newItem.importedAt
            })
        }
        setMaintenanceItems((prev) => [newItem, ...prev])

        handleAction(roomId, 'problem', { problemText: description })
    }

    function syncCancelledRoomProblemNote(item: MaintenanceItem) {
        if (item.category !== 'room_issue') return

        const normalizedRoomNumber = normalizeCatalogRoomNumber(item.roomNumber || '')
        const normalizedCancelledTitle = normalizeIdentity(item.title)

        if (!normalizedRoomNumber || !normalizedCancelledTitle) return

        const replacementIssue = maintenanceItems.find((candidate) => (
            candidate.id !== item.id
            && candidate.category === 'room_issue'
            && candidate.status !== 'done'
            && candidate.status !== 'cancelled'
            && normalizeCatalogRoomNumber(candidate.roomNumber || '') === normalizedRoomNumber
        ))

        const buildPatch = (room: RoomPlan): Partial<RoomPlan> | null => {
            if (room.checkoutException) return null
            if (normalizeCatalogRoomNumber(room.number) !== normalizedRoomNumber) return null

            if (replacementIssue) {
                if (normalizeIdentity(room.statusNote) !== normalizedCancelledTitle) return null
                return {
                    status: 'problem',
                    statusNote: replacementIssue.title,
                    source: replacementIssue.source,
                    createdByUid: replacementIssue.createdByUid,
                    createdByName: replacementIssue.createdByName,
                    createdByRole: replacementIssue.createdByRole,
                    importJobId: replacementIssue.importJobId,
                    importedAt: replacementIssue.importedAt
                }
            }

            if (!room.statusNote || room.status !== 'problem') return null

            return {
                statusNote: undefined,
                status: room.status === 'problem' ? 'ceka' : room.status
            }
        }

        const days: OpsTab[] = ['Dnes', 'Zitra', 'Pozitri']

        if (runtimeMode === 'online') {
            days.forEach((day) => {
                roomsByDay[day].forEach((room) => {
                    const patch = buildPatch(room)
                    if (patch) activeStore.updateRoomPlan(day, room.id, patch)
                })
            })
        }

        setRoomsByDay((prev) => {
            let changed = false
            const next = { ...prev }

            days.forEach((day) => {
                next[day] = prev[day].map((room) => {
                    const patch = buildPatch(room)
                    if (!patch) return room
                    changed = true
                    return { ...room, ...patch }
                })
            })

            return changed ? next : prev
        })
    }

    function handleCleanupTestTasks() {
        const matchingIds = tasks
            .filter((task) => task.status !== 'cancelled' && shouldCleanupTestTask(task.title))
            .map((task) => task.id)

        if (matchingIds.length === 0) {
            setCleanupResult('Nenalezeny žádné testovací úkoly k vyčištění.')
            setCleanupConfirm(false)
            return
        }

        if (runtimeMode === 'online') {
            matchingIds.forEach((taskId) => activeStore.updateTaskStatus(taskId, 'cancelled'))
        }

        setTasks((prev) => prev.map((task) => (
            matchingIds.includes(task.id)
                ? { ...task, status: 'cancelled' }
                : task
        )))

        setCleanupResult(`Vyčištěno testovacích úkolů: ${matchingIds.length}`)
        setCleanupConfirm(false)
    }

    function buildClearedRoomsForDay(sourceRooms: RoomPlan[]) {
        const roomNumbers = Array.from(new Set([
            ...MASTER_ROOM_NUMBERS,
            ...activeRooms.map((room) => normalizeCatalogRoomNumber(room.roomNumber))
        ])).sort((a, b) => Number(a) - Number(b))

        const sourceByRoom = new Map(
            sourceRooms.map((room) => [normalizeCatalogRoomNumber(room.number), room])
        )
        const catalogByRoom = new Map(
            activeRooms.map((room) => [normalizeCatalogRoomNumber(room.roomNumber), room])
        )

        return roomNumbers.map((roomNumber) => {
            const base = sourceByRoom.get(roomNumber)
            const catalog = catalogByRoom.get(roomNumber)

            return {
                id: base?.id || roomIdForNumber(roomNumber),
                number: base?.number || catalog?.displayName || catalog?.roomNumber || roomNumber,
                situation: 'volny' as const,
                status: 'neni' as const,
                departure: undefined,
                arrival: undefined,
                nextArrivalPreview: undefined,
                departureTime: undefined,
                arrivalTime: undefined,
                guestCount: undefined,
                box: undefined,
                notes: undefined,
                assigned: undefined,
                estimatedReady: undefined,
                estimateSetAt: undefined,
                statusNote: undefined,
                checkoutException: false,
                occupiedConfirmed: false,
                freeConfirmed: false,
                stateSource: undefined,
                stateImportedAt: undefined,
                stayoverGuestName: undefined,
                stayoverUntil: undefined,
                source: undefined,
                createdByUid: undefined,
                createdByName: undefined,
                createdByRole: undefined,
                importJobId: undefined,
                importedAt: undefined
            }
        })
    }

    function handleClearDemoPlan() {
        const dayMapping: Record<OpsTab, string | undefined> = {
            Dnes: importedTabDates.Dnes,
            Zitra: importedTabDates.Zitra,
            Pozitri: importedTabDates.Pozitri
        }
        const importedDateSet = new Set([
            ...Object.values(dayMapping).filter((dateIso): dateIso is string => Boolean(dateIso)),
            ...Object.keys(importedRoomsByDate)
        ])

        if (importedDateSet.size === 0) {
            setPlanCleanupResult('Nebyl nalezen žádný importovaný den k vyčištění.')
            setPlanCleanupConfirm(false)
            return
        }

        const clearedPlans: Record<OpsTab, RoomPlan[]> = {
            Dnes: importedDateSet.has(dayMapping.Dnes || '') ? buildClearedRoomsForDay(roomsByDay.Dnes) : roomsByDay.Dnes,
            Zitra: importedDateSet.has(dayMapping.Zitra || '') ? buildClearedRoomsForDay(roomsByDay.Zitra) : roomsByDay.Zitra,
            Pozitri: importedDateSet.has(dayMapping.Pozitri || '') ? buildClearedRoomsForDay(roomsByDay.Pozitri) : roomsByDay.Pozitri
        }

        const nextImportedRoomsByDate = { ...importedRoomsByDate }
        Array.from(importedDateSet).forEach((dateIso) => {
            const sourceRooms = importedRoomsByDate[dateIso]
            if (!sourceRooms) return
            nextImportedRoomsByDate[dateIso] = buildClearedRoomsForDay(sourceRooms)
        })

        setRoomsByDay(clearedPlans)
        setImportedRoomsByDate(nextImportedRoomsByDate)
        setSelectedImportedDateIso(null)
        setStateImportPreview(null)
        setStateImportPdfStatus('idle')
        setStateImportPdfError(null)

        if (runtimeMode === 'online') {
            ; (['Dnes', 'Zitra', 'Pozitri'] as OpsTab[]).forEach((day) => {
                if (!importedDateSet.has(dayMapping[day] || '')) return
                clearedPlans[day].forEach((room) => {
                    activeStore.replaceRoomPlan(day, room)
                })
            })
        }

        const clearedCount = (['Dnes', 'Zitra', 'Pozitri'] as OpsTab[])
            .filter((day) => importedDateSet.has(dayMapping[day] || ''))
            .reduce((sum, day) => sum + clearedPlans[day].length, 0)

        setPlanCleanupResult(`Plán pokojů vyčištěn: ${clearedCount} záznamů pro importované dny.`)
        setPlanCleanupConfirm(false)
    }

    function handleMaintenanceTaskAction(taskId: string, action: 'accepted' | 'done' | 'problem' | 'cancelled') {
        const nowIso = new Date().toISOString()
        const actorUid = currentUser?.id
        const actorName = currentUser?.name

        const currentTask = tasks.find((task) => task.id === taskId)
        if (!currentTask) return

        const nextTask = applyMaintenanceTaskStatus(currentTask, action, { uid: actorUid, name: actorName }, nowIso)

        if (runtimeMode === 'online') {
            activeStore.updateTask(taskId, {
                status: nextTask.status,
                assignedToUid: nextTask.assignedToUid,
                assignedToName: nextTask.assignedToName,
                completedAt: nextTask.completedAt,
                completedByUid: nextTask.completedByUid,
                completedByName: nextTask.completedByName
            })
        }
        setTasks((prev) =>
            prev.map((task) => {
                if (task.id !== taskId) return task
                return applyMaintenanceTaskStatus(task, action, { uid: actorUid, name: actorName }, nowIso)
            })
        )
    }

    function handleCreateMaintenanceSelfTask(input: { roomNumber?: string; title: string; note?: string; priority: Task['priority'] }) {
        if (!currentUser) return
        if (!canCreateMaintenanceSelfTask(currentUser.role)) return
        if (!input.title.trim()) return

        const createdAt = formatNowHHmm(new Date())
        const newTask = createMaintenanceSelfTask({
            title: input.title,
            roomNumber: input.roomNumber,
            note: input.note,
            priority: input.priority,
            taskDateIso: effectiveDateIso,
            createdAt,
            createdByUid: currentUser.id,
            createdByName: currentUser.name,
            createdByRole: currentUser.role
        })

        if (runtimeMode === 'online') {
            activeStore.createTask({
                id: newTask.id,
                roomNumber: newTask.roomNumber,
                title: newTask.title,
                category: newTask.category,
                priority: newTask.priority,
                assignedToRole: newTask.assignedToRole,
                assignedToUid: newTask.assignedToUid,
                assignedToName: newTask.assignedToName,
                note: newTask.note,
                createdBy: newTask.createdBy,
                createdAt: newTask.createdAt,
                taskDateIso: newTask.taskDateIso,
                source: newTask.source,
                createdSource: newTask.createdSource,
                createdByUid: newTask.createdByUid,
                createdByName: newTask.createdByName,
                createdByRole: newTask.createdByRole
            })
        }

        setTasks((prev) => [newTask, ...prev])
    }

    function handleRequestMaterial(taskId: string, materialText: string) {
        const material = (materialText || '').trim()
        if (!material) return

        const task = tasks.find((t) => t.id === taskId)
        if (!task) return

        const normalizedMaterial = material.toLowerCase()
        const hasOpenDuplicateRequest = (Array.isArray(supplyRequests) ? supplyRequests : []).some((request) => {
            if ((request?.linkedTaskId || '') !== task.id) return false
            if (((request?.itemName || '').trim().toLowerCase()) !== normalizedMaterial) return false
            const status = request?.status || ''
            return isOpenSupplyStatus(status as SupplyRequest['status'])
        })

        const patch: Partial<import('./types').Task> = {
            status: 'waiting_material',
            materialNote: material || undefined,
            materialRequestedAt: new Date().toISOString(),
            materialRequestedByName: currentUser?.name || undefined
        }

        if (runtimeMode === 'online') {
            activeStore.updateTask(taskId, patch)
        }

        setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...patch } : t)))

        if (hasOpenDuplicateRequest) return

        // create exactly one supply request linked to the original task
        const manualOriginMeta = buildManualOriginMeta()
        const newRequest: SupplyRequest = {
            id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            itemName: material,
            category: 'maintenance',
            quantityLevel: 'custom',
            customQuantity: undefined,
            roomNumber: task.roomNumber ? task.roomNumber : undefined,
            note: `Úkol: ${task.title || 'bez názvu'} (${task.id})`,
            requestedBy: currentUser?.name || 'Uživatel',
            requestedByRole: currentUser?.role || 'maintenance',
            createdAt: formatNowHHmm(new Date()),
            status: 'new',
            priority: task.priority,
            linkedTaskId: task.id,
            ...manualOriginMeta
        }

        if (runtimeMode === 'online') {
            activeStore.createSupplyRequest({
                id: newRequest.id,
                itemName: newRequest.itemName,
                category: newRequest.category,
                quantityLevel: newRequest.quantityLevel,
                customQuantity: newRequest.customQuantity,
                roomNumber: newRequest.roomNumber,
                note: newRequest.note,
                priority: newRequest.priority,
                requestedBy: newRequest.requestedBy,
                requestedByRole: newRequest.requestedByRole,
                createdAt: newRequest.createdAt,
                source: newRequest.source,
                createdByUid: newRequest.createdByUid,
                createdByName: newRequest.createdByName,
                createdByRole: newRequest.createdByRole,
                importJobId: newRequest.importJobId,
                importedAt: newRequest.importedAt,
                linkedTaskId: newRequest.linkedTaskId
            })
        }

        setSupplyRequests((prev) => [newRequest, ...prev])
    }

    function handleCreateMaintenanceItem(input: { roomNumber?: string; title: string; category: MaintenanceItem['category']; priority: MaintenanceItem['priority']; note?: string }) {
        if (!currentUser) return
        const manualOriginMeta = buildManualOriginMeta()
        const newItem: MaintenanceItem = {
            id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            roomNumber: formatRoomNumber(input.roomNumber),
            title: input.title.trim(),
            category: input.category,
            priority: input.priority,
            status: 'new',
            note: input.note?.trim() || undefined,
            reportedBy: currentUser.name,
            createdAt: formatNowHHmm(new Date()),
            ...manualOriginMeta
        }
        if (runtimeMode === 'online') {
            activeStore.createMaintenanceItem({
                id: newItem.id,
                roomNumber: newItem.roomNumber,
                title: newItem.title,
                category: newItem.category,
                priority: newItem.priority,
                note: newItem.note,
                reportedBy: newItem.reportedBy,
                createdAt: newItem.createdAt,
                source: newItem.source,
                createdByUid: newItem.createdByUid,
                createdByName: newItem.createdByName,
                createdByRole: newItem.createdByRole,
                importJobId: newItem.importJobId,
                importedAt: newItem.importedAt
            })
        }
        setMaintenanceItems((prev) => [newItem, ...prev])
    }

    function handleUpdateMaintenanceItem(itemId: string, patch: Partial<MaintenanceItem>) {
        const currentItem = maintenanceItems.find((it) => it.id === itemId)

        if (runtimeMode === 'online') {
            activeStore.updateMaintenanceItem(itemId, patch)
        }

        if (patch.status === 'cancelled' && currentItem) {
            syncCancelledRoomProblemNote(currentItem)
        }

        setMaintenanceItems((prev) => prev.map((it) => (it.id === itemId ? { ...it, ...patch, updatedAt: formatNowHHmm(new Date()) } : it)))
    }

    function handleMaterialNeeded(itemId: string, materialText: string) {
        const material = materialText.trim()
        if (!material) return
        const item = maintenanceItems.find((m) => m.id === itemId)
        if (!item) return
        const manualOriginMeta = buildManualOriginMeta()

        // update maintenance item
        handleUpdateMaintenanceItem(itemId, { materialNeeded: material, status: 'waiting_material' })

        // create supply request
        const newRequest: SupplyRequest = {
            id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            itemName: material,
            category: 'maintenance',
            quantityLevel: 'custom',
            customQuantity: undefined,
            roomNumber: item.roomNumber ? item.roomNumber : undefined,
            note: `Závada: ${item.title}`,
            requestedBy: currentUser?.name || 'Uživatel',
            requestedByRole: currentUser?.role || 'maintenance',
            createdAt: formatNowHHmm(new Date()),
            status: 'new',
            priority: item.priority,
            ...manualOriginMeta
        }

        if (runtimeMode === 'online') {
            activeStore.createSupplyRequest({
                id: newRequest.id,
                itemName: newRequest.itemName,
                category: newRequest.category,
                quantityLevel: newRequest.quantityLevel,
                customQuantity: newRequest.customQuantity,
                roomNumber: newRequest.roomNumber,
                note: newRequest.note,
                priority: newRequest.priority,
                requestedBy: newRequest.requestedBy,
                requestedByRole: newRequest.requestedByRole,
                createdAt: newRequest.createdAt,
                source: newRequest.source,
                createdByUid: newRequest.createdByUid,
                createdByName: newRequest.createdByName,
                createdByRole: newRequest.createdByRole,
                importJobId: newRequest.importJobId,
                importedAt: newRequest.importedAt
            })
        }

        setSupplyRequests((prev) => [newRequest, ...prev])
    }

    function formatRoomNumber(roomNumber?: string) {
        if (!roomNumber) return undefined
        return roomNumber.trim() || undefined
    }

    function handleCreateSupplyRequest(input: CreateSupplyRequestInput) {
        if (!currentUser) return
        const role = currentUser.role
        const canCreate = isAdminRole(role) || isCleaningLeadRole(role) || isCleanerRole(role) || isMaintenanceRole(role)
        if (!canCreate) return

        if (isMaintenanceRole(role) && input.category !== 'maintenance') return
        const manualOriginMeta = buildManualOriginMeta()

        const newRequest: SupplyRequest = {
            id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            itemName: input.itemName,
            category: input.category,
            quantityLevel: input.quantityLevel,
            customQuantity: input.quantityLevel === 'custom' ? input.customQuantity : undefined,
            roomNumber: formatRoomNumber(input.roomNumber),
            note: input.note,
            requestedBy: currentUser.name,
            requestedByRole: currentUser.role,
            createdAt: formatNowHHmm(new Date()),
            status: 'new',
            priority: input.priority,
            ...manualOriginMeta
        }

        if (runtimeMode === 'online') {
            activeStore.createSupplyRequest({
                id: newRequest.id,
                itemName: newRequest.itemName,
                category: newRequest.category,
                quantityLevel: newRequest.quantityLevel,
                customQuantity: newRequest.customQuantity,
                roomNumber: newRequest.roomNumber,
                note: newRequest.note,
                priority: newRequest.priority,
                requestedBy: newRequest.requestedBy,
                requestedByRole: newRequest.requestedByRole,
                createdAt: newRequest.createdAt,
                source: newRequest.source,
                createdByUid: newRequest.createdByUid,
                createdByName: newRequest.createdByName,
                createdByRole: newRequest.createdByRole,
                importJobId: newRequest.importJobId,
                importedAt: newRequest.importedAt
            })
        }

        setSupplyRequests((prev) => [newRequest, ...prev])
    }

    function setStaffAvailability(id: string, availability: Availability) {
        if (!currentUser) return
        if (!canManageStaffAvailability(realUserRole, currentUser.id, id)) return
        activeStore.setStaffAvailability(effectiveDateIso, id, availability)
        setDailyAvailabilityRecords((prev) => upsertStaffAvailabilityRecord(prev, {
            id: `${effectiveDateIso}__${id}`,
            dateIso: effectiveDateIso,
            staffId: id,
            availability,
            updatedAt: new Date().toISOString()
        }))
    }

    function handleSetSupplyGroupStatus(itemName: string, status: SupplyRequest['status']) {
        if (!currentUser || !isAdminRole(currentUser.role)) return
        if (runtimeMode === 'online') {
            supplyRequests.filter((s) => s.itemName === itemName).forEach((s) => activeStore.updateSupplyStatus(s.id, status, buildSupplyStatusPatch(s, status)))
        }
        setSupplyRequests((prev) => prev.map((s) => (s.itemName === itemName ? applySupplyStatusUpdate(s, status) : s)))
    }

    function handleSetSupplyRequestStatus(requestId: string, status: SupplyRequest['status']) {
        if (!currentUser || !canManageSupplyLifecycle(currentUser.role)) return

        setSupplyRequests((prev) => {
            const target = prev.find((request) => request.id === requestId)
            if (!target) return prev
            if (!canSetSupplyStatus(target.status, status)) return prev
            const nextPatch = buildSupplyStatusPatch(target, status)

            if (runtimeMode === 'online') {
                activeStore.updateSupplyStatus(requestId, status, nextPatch)
            }

            return prev.map((request) => (
                request.id === requestId
                    ? applySupplyStatusUpdate(request, status, nextPatch.updatedAt)
                    : request
            ))
        })
    }

    function handleSaveCustomSupplyChip(name: string, section: SupplyChipSection) {
        const cleaned = name.trim()
        if (!cleaned) return
        const key = buildCustomSupplyChipKey(cleaned, section)
        setCustomSupplyChips((prev) => {
            const exists = prev.some((chip) => chip.toLowerCase() === key.toLowerCase())
            if (exists) return prev
            const next = [...prev, key]
            if (runtimeMode === 'online') {
                try {
                    // persist to shared meta doc (store section-prefixed strings)
                    ; (activeStore as any).persistMetaState({ customSupplyChips: next })
                } catch (e) {
                    // fail silently
                }
            }
            return next
        })
    }

    function canCancelSupplyRequest(request: SupplyRequest) {
        if (!currentUser) return false
        if (isAdminRole(currentUser.role)) return true
        if (isCleaningLeadRole(currentUser.role)) return isCleaningDomain(request.category)
        if (isCleanerRole(currentUser.role)) return request.status === 'new' && request.requestedByRole === 'cleaner' && request.requestedBy === currentUser.name
        if (isMaintenanceRole(currentUser.role)) {
            return request.status === 'new' && request.category === 'maintenance' && request.requestedByRole === 'maintenance' && request.requestedBy === currentUser.name
        }
        return false
    }

    function handleCancelSupplyRequest(requestId: string) {
        if (runtimeMode === 'online') {
            activeStore.cancelSupplyRequest(requestId)
        }
        setSupplyRequests((prev) => {
            const idx = prev.findIndex((r) => r.id === requestId)
            if (idx === -1) return prev
            const target = prev[idx]
            if (!canCancelSupplyRequest(target)) return prev
            // remove the single request by id so other identical items remain
            return prev.filter((r) => r.id !== requestId)
        })
    }

    useEffect(() => {
        if (view !== 'admin' || isAdminUser) return
        if (isMaintenanceRole(currentUser?.role)) {
            setView('maintenance')
            return
        }
        setView('today')
    }, [view, isAdminUser, currentUser?.role])

    // save to localStorage whenever key pieces of state change
    useEffect(() => {
        const toSave = {
            userId,
            tab,
            view,
            roomsByDay,
            importedTabDates,
            importedRoomsByDate,
            importJobs,
            latestStateImportBackup,
            tasks,
            supplyRequests,
            maintenanceItems,
            customSupplyChips,
            dailyAvailabilityRecords,
            staff
        }
        activeStore.saveState(toSave)
    }, [userId, tab, view, roomsByDay, importedTabDates, importedRoomsByDate, importJobs, latestStateImportBackup, tasks, supplyRequests, maintenanceItems, customSupplyChips, dailyAvailabilityRecords, staff, activeStore])

    useEffect(() => {
        const updateStandaloneMode = () => {
            const displayModeStandalone = typeof window !== 'undefined'
                && window.matchMedia
                && window.matchMedia('(display-mode: standalone)').matches
            const iosStandalone = typeof window !== 'undefined'
                && typeof (window.navigator as Navigator & { standalone?: boolean }).standalone === 'boolean'
                && Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone)
            setIsStandalone(Boolean(displayModeStandalone || iosStandalone))
        }

        updateStandaloneMode()
        window.addEventListener('appinstalled', updateStandaloneMode)

        return () => {
            window.removeEventListener('appinstalled', updateStandaloneMode)
        }
    }, [])

    useEffect(() => {
        if (!firebaseEnvDiagnostics.firebaseConfigured) {
            setDiagnostics((prev) => ({
                ...prev,
                activeMode: 'demo',
                authStatus: 'not_started',
                isAnonymous: false,
                profileLoaded: false,
                firestoreStatus: 'not_started',
                lastErrorCode: undefined,
                lastErrorMessage: undefined
            }))
            setOnlineLoading(false)
            setOnlineError(null)
            return
        }

        if (runtimeMode !== 'online') return

        const unsubscribe = onFirebaseAuthState((user) => {
            setAuthUser(user)
            if (!user) {
                setOnlineProfile(null)
                setMissingProfileUid(null)
                setOnlineLoading(false)
                setDiagnostics((prev) => ({
                    ...prev,
                    activeMode: 'online',
                    authStatus: 'signed_out',
                    authUid: undefined,
                    isAnonymous: false,
                    profileLoaded: false,
                    firestoreStatus: 'not_started'
                }))
                return
            }

            setDiagnostics((prev) => ({
                ...prev,
                activeMode: 'online',
                authStatus: user.isAnonymous ? 'signed_in_anonymous' : 'signed_in_email',
                authUid: user.uid,
                isAnonymous: user.isAnonymous,
                profileLoaded: false
            }))
        })

        return () => {
            if (unsubscribe) unsubscribe()
        }
    }, [runtimeMode])

    useEffect(() => {
        let unsub: (() => void) | null = null
        let cancelled = false

        if (!firebaseEnvDiagnostics.firebaseConfigured || runtimeMode !== 'online') {
            setOnlineLoading(false)
            return
        }

        if (!authUser) {
            setOnlineLoading(false)
            return
        }

        if (authUser.isAnonymous) {
            setOnlineProfile(null)
            setMissingProfileUid(null)
            setOnlineError(null)
            setProfileLoading(false)
            setOnlineLoading(false)
            setDiagnostics((prev) => ({
                ...prev,
                authStatus: 'signed_in_anonymous',
                isAnonymous: true,
                profileLoaded: false,
                firestoreStatus: 'not_started',
                lastErrorCode: 'auth/requires-email-login',
                lastErrorMessage: 'Anonymní vývojové přihlášení není pro ostrý režim povoleno.'
            }))
            return
        }

        setProfileLoading(true)
        setOnlineLoading(true)
        setOnlineError(null)
        setDiagnostics((prev) => ({
            ...prev,
            authStatus: 'signed_in_email',
            isAnonymous: false,
            profileLoaded: false,
            firestoreStatus: 'seeding',
            lastErrorCode: undefined,
            lastErrorMessage: undefined
        }))

        loadOnlineProfile(authUser)
            .then((profile) => {
                if (cancelled) return null
                setProfileLoading(false)
                if (!profile || !profile.active) {
                    setOnlineProfile(null)
                    setMissingProfileUid(authUser.uid)
                    setOnlineLoading(false)
                    setDiagnostics((prev) => ({
                        ...prev,
                        profileLoaded: false,
                        firestoreStatus: 'error',
                        lastErrorCode: 'profile/not-found',
                        lastErrorMessage: 'Uživatel není přiřazený k hotelu.'
                    }))
                    return null
                }

                setMissingProfileUid(null)
                setOnlineProfile(profile)
                setUserId(profile.id)
                setDiagnostics((prev) => ({
                    ...prev,
                    profileLoaded: true
                }))
                if (isMaintenanceRole(profile.role)) {
                    setView('maintenance')
                }
                return onlineStore.initializeState(defaultState)
            })
            .then((initResult) => {
                if (cancelled || initResult === null) return
                setDiagnostics((prev) => ({
                    ...prev,
                    firestoreStatus: 'listening'
                }))

                unsub = onlineStore.subscribeState(
                    (state) => {
                        if (state.roomsByDay) setRoomsByDay(state.roomsByDay)
                        if (state.importedTabDates) setImportedTabDates(state.importedTabDates)
                        if (state.importedRoomsByDate) setImportedRoomsByDate(state.importedRoomsByDate)
                        if (state.importJobs) setImportJobs(sortImportJobs(state.importJobs))
                        if (state.tasks) setTasks(state.tasks)
                        if (state.supplyRequests) {
                            setSupplyRequests(state.supplyRequests)
                            setDiagnostics((prev) => ({ ...prev, supplySyncCount: state.supplyRequests?.length || 0 }))
                        }
                        if (state.maintenanceItems) setMaintenanceItems(state.maintenanceItems)
                        if (state.dailyAvailabilityRecords) setDailyAvailabilityRecords(state.dailyAvailabilityRecords as StaffAvailabilityRecord[])
                        if (state.staff) setStaff(state.staff as StaffMember[])
                        if (state.customSupplyChips && Array.isArray(state.customSupplyChips)) {
                            setCustomSupplyChips((prev) => {
                                const merged = [...prev]
                                state.customSupplyChips.forEach((c: string) => {
                                    if (!merged.some((m) => m.toLowerCase() === c.toLowerCase())) merged.push(c)
                                })
                                return merged
                            })
                        }
                        setDiagnostics((prev) => ({
                            ...prev,
                            firestoreStatus: 'connected'
                        }))
                        setOnlineLoading(false)
                    },
                    (error) => {
                        const code = error.code
                        const message = error.message
                        const isAuthError = Boolean(code && String(code).startsWith('auth/'))
                        setDiagnostics((prev) => ({
                            ...prev,
                            authStatus: isAuthError ? 'error' : prev.authStatus,
                            firestoreStatus: isAuthError
                                ? prev.firestoreStatus
                                : (code === 'permission-denied' ? 'permission_denied' : 'error'),
                            lastErrorCode: code,
                            lastErrorMessage: message
                        }))
                        setOnlineError(`${code ? `${code}: ` : ''}${message}`)
                        setOnlineLoading(false)
                    }
                )
            })
            .catch((err: any) => {
                if (cancelled) return
                setProfileLoading(false)
                const errorInfo = extractErrorInfo(err)
                const isAuthError = Boolean(errorInfo.code && String(errorInfo.code).startsWith('auth/'))
                setDiagnostics((prev) => ({
                    ...prev,
                    authStatus: isAuthError ? 'error' : prev.authStatus,
                    firestoreStatus: isAuthError
                        ? prev.firestoreStatus
                        : (errorInfo.code === 'permission-denied' ? 'permission_denied' : 'error'),
                    lastErrorCode: errorInfo.code,
                    lastErrorMessage: errorInfo.message
                }))
                setOnlineError(`${errorInfo.code ? `${errorInfo.code}: ` : ''}${errorInfo.message}`)
                setOnlineLoading(false)
            })

        return () => {
            cancelled = true
            if (unsub) unsub()
        }
    }, [runtimeMode, authUser, onlineStore, defaultState])

    useEffect(() => {
        const confirmedStateJobs = importJobs.filter((job) => job.status === 'confirmed' && job.type === 'previo-state-pdf')
        if (confirmedStateJobs.length === 0) {
            setRollbackAvailabilityByJobId({})
            return
        }

        let cancelled = false

        const initialStatus: Record<string, RollbackAvailability> = {}
        confirmedStateJobs.forEach((job) => {
            initialStatus[job.id] = 'checking'
        })
        setRollbackAvailabilityByJobId(initialStatus)

        async function resolveAvailability() {
            const nextStatus: Record<string, RollbackAvailability> = {}

            await Promise.all(confirmedStateJobs.map(async (job) => {
                const hasLocalPayload = Boolean(
                    (job.backupPayload && job.backupPayload.jobId === job.id)
                    || (latestStateImportBackup && latestStateImportBackup.jobId === job.id)
                )

                if (job.backupSummary || hasLocalPayload) {
                    nextStatus[job.id] = 'available'
                    return
                }

                if (runtimeMode === 'online' && firestoreDb) {
                    try {
                        const backupSnap = await getDoc(doc(firestoreDb, 'hotels', ONLINE_HOTEL_ID, 'importBackups', job.id))
                        nextStatus[job.id] = backupSnap.exists() ? 'available' : 'legacy'
                        return
                    } catch {
                        nextStatus[job.id] = 'legacy'
                        return
                    }
                }

                nextStatus[job.id] = 'legacy'
            }))

            if (cancelled) return
            setRollbackAvailabilityByJobId(nextStatus)
        }

        void resolveAvailability()

        return () => {
            cancelled = true
        }
    }, [importJobs, latestStateImportBackup, runtimeMode, firestoreDb])

    useEffect(() => {
        if (AUTO_CONFIRM_STAV_IMPORTS_MODE !== 'enabled') return
        if (!isAdminUser) return
        if (generatingImportPreviewJobId || rollingBackJobId) return

        const candidate = newestPrevioStateJob
        if (!candidate || candidate.type !== 'previo-state-pdf') return
        if (candidate.status === 'confirmed' || candidate.status === 'cancelled') return
        if (autoConfirmInFlightJobIdRef.current === candidate.id) return

        const autoDecision = candidate.automation?.autoConfirm?.decision
        if (autoDecision === 'blocked' && candidate.automation?.autoConfirm?.mode === 'enabled') return

        const byDate = getImportJobByDate(candidate.previewSummary)
        const parsedTabDates = getImportJobParsedTabDates(candidate.previewSummary)
        const preview = (candidate.previewSummary?.preview || null) as PrevioStateImportPreview | null
        const missingDateLabels = candidate.previewSummary?.missingDateLabels || []
        const parserVersion = candidate.previewSummary?.parserVersion || candidate.parserVersion || PREVIO_STAV_PARSER_VERSION
        const safety = resolveImportSafety(preview, missingDateLabels, parserVersion, candidate.previewSummary?.safety)
        const evaluation = evaluateImportJobAutoConfirm({
            job: candidate,
            mode: AUTO_CONFIRM_STAV_IMPORTS_MODE,
            isNewestPrevioStateJob: newestPrevioStateJob?.id === candidate.id,
            isSupersededPrevioStateJob: supersededPrevioStateJobIds.has(candidate.id),
            hasByDate: Boolean(byDate),
            hasParsedTabDates: Boolean(parsedTabDates),
            safety
        })

        if (!evaluation.eligible) return

        autoConfirmInFlightJobIdRef.current = candidate.id
        void (async () => {
            try {
                await handleConfirmImportJob(candidate.id, { autoConfirmReason: 'newest-safe-import' })
            } finally {
                autoConfirmInFlightJobIdRef.current = null
            }
        })()
    }, [
        isAdminUser,
        newestPrevioStateJob,
        supersededPrevioStateJobIds,
        generatingImportPreviewJobId,
        rollingBackJobId,
        importJobs
    ])

    useEffect(() => {
        void loadRoomCatalogForCurrentMode().catch((error: any) => {
            if (import.meta.env.DEV) {
                console.warn('[RoomCatalog] failed to load, using defaults', error?.message || error)
            }
            setRoomCatalog(getDefaultRoomCatalog())
        })
    }, [runtimeMode, authUser?.uid, authUser?.isAnonymous])

    async function resetDemoData() {
        // restore mock data and clear saved state
        setRoomsByDay(roomPlansByDay)
        setImportedTabDates({})
        setImportedRoomsByDate({})
        setImportJobs([])
        setLatestStateImportBackup(null)
        setTasks([])
        setSupplyRequests(initialSupplyRequests)
        setMaintenanceItems(initialMaintenanceItems)
        setCustomSupplyChips([])
        setDailyAvailabilityRecords([])
        setStaff(users)
        setTab('Dnes')
        setUserId('david')
        setView('today')
        await activeStore.resetDemoState(defaultState)
    }

    async function handleDangerousReset() {
        const message = runtimeMode === 'online'
            ? 'Opravdu resetovat online data? Tato akce může změnit data ve Firebase.'
            : 'Opravdu resetovat demo data?'
        const confirmed = window.confirm(message)
        if (!confirmed) return
        await resetDemoData()
    }

    function dismissInstallHint() {
        setInstallHintDismissed(true)
        if (typeof window !== 'undefined') {
            window.localStorage.setItem('chill_ops_install_hint_dismissed', '1')
        }
    }

    function roleLabelForUi(role: UserRole) {
        if (role === 'admin') return t('roles.admin')
        if (role === 'lead' || role === 'iryna') return t('roles.lead')
        if (role === 'maintenance') return t('roles.maintenance')
        return t('roles.cleaner')
    }

    return (
        <div className="app">
            <div className="topbar">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <div className="title">{APP_SHORT_NAME}</div>
                    <div style={{ fontSize: 11, color: '#64748b', border: '1px solid #cbd5e1', borderRadius: 999, padding: '2px 8px' }}>
                        {diagnostics.activeMode === 'online' ? 'Online režim' : diagnostics.activeMode === 'fallback' ? 'Fallback režim' : 'Demo režim'}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginLeft: 8 }}>
                        <span style={{ fontSize: 12, color: '#475569' }}>{t('language.switch')}</span>
                        <button className={`chip ${language === 'cs' ? 'active' : ''}`} onClick={() => setLanguage('cs')}>{t('language.cs')}</button>
                        <button className={`chip ${language === 'uk' ? 'active' : ''}`} onClick={() => setLanguage('uk')}>{t('language.uk')}</button>
                    </div>
                    {isAdminUser && (
                        <div style={{ marginLeft: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                            <label style={{ fontSize: 12, color: '#475569' }}>Náhled jako</label>
                            <select
                                value={previewRole}
                                onChange={(e) => {
                                    const val = e.target.value
                                    if (allowedPreviewRoles.includes(val as any)) {
                                        setPreviewRole(val as any)
                                        try { window.localStorage.setItem(PREVIEW_ROLE_KEY, val) } catch (er) { }
                                    } else {
                                        setPreviewRole('real')
                                        try { window.localStorage.removeItem(PREVIEW_ROLE_KEY) } catch (er) { }
                                    }
                                }}
                                style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid #dbe7f3' }}
                            >
                                <option value="real">Skutečná role</option>
                                <option value="admin">Admin</option>
                                <option value="lead">Vedoucí úklidu</option>
                                <option value="cleaner">Uklízečka</option>
                                <option value="maintenance">Údržba</option>
                            </select>
                            {previewRole && previewRole !== 'real' && (
                                <div style={{ fontSize: 12, color: '#b91c1c', fontWeight: 700, border: '1px solid #fecaca', padding: '4px 8px', borderRadius: 8, background: '#fff1f2' }}>
                                    Náhled role: {previewRole === 'admin' ? 'Admin' : previewRole === 'lead' ? 'Vedoucí úklidu' : previewRole === 'cleaner' ? 'Uklízečka' : previewRole === 'maintenance' ? 'Údržba' : previewRole}
                                </div>
                            )}
                        </div>
                    )}
                    {showDiagnostics && (
                        <div style={{ position: 'relative' }}>
                            <button
                                className="btn"
                                style={{ padding: '2px 8px', fontSize: 11, minHeight: 'unset' }}
                                onClick={() => setDiagOpen((prev) => !prev)}
                            >
                                Diagnostika
                            </button>
                            {diagOpen && (
                                <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 10, width: 320, marginTop: 6, padding: 10, borderRadius: 10, border: '1px solid #cbd5e1', background: '#ffffff', boxShadow: '0 8px 24px rgba(15,23,42,0.12)', fontSize: 12, color: '#334155' }}>
                                    <div><strong>Mode:</strong> intended {diagnostics.intendedMode}, active {diagnostics.activeMode}</div>
                                    <div><strong>Firebase configured:</strong> {diagnostics.firebaseConfigured ? 'ano' : 'ne'}</div>
                                    <div><strong>Missing env vars:</strong> {diagnostics.missingEnvVars.length ? diagnostics.missingEnvVars.join(', ') : 'žádné'}</div>
                                    <div><strong>Auth status:</strong> {diagnostics.authStatus}{diagnostics.authUid ? ` ({diagnostics.authUid})` : ''}</div>
                                    <div><strong>isAnonymous:</strong> {diagnostics.isAnonymous ? 'ano' : 'ne'}</div>
                                    <div><strong>profileLoaded:</strong> {diagnostics.profileLoaded ? 'ano' : 'ne'}</div>
                                    <div><strong>Firestore status:</strong> {diagnostics.firestoreStatus}</div>
                                    <div><strong>Supply sync count:</strong> {typeof diagnostics.supplySyncCount === 'number' ? diagnostics.supplySyncCount : '—'}</div>
                                    <div><strong>Hotel id:</strong> {diagnostics.hotelId}</div>
                                    <div><strong>Last error code:</strong> {diagnostics.lastErrorCode || '—'}</div>
                                    <div><strong>Last error message:</strong> {diagnostics.lastErrorMessage || '—'}</div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
                {runtimeMode === 'demo' ? (
                    <RoleSwitch current={userId} onChange={handleRoleChange} />
                ) : (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <div style={{ fontSize: 13, color: '#334155' }}>
                            {onlineProfile ? (
                                <>
                                    <strong>{onlineProfile.name}</strong> • {roleLabelForUi(onlineProfile.role)}
                                </>
                            ) : authUser?.isAnonymous ? (
                                <>Anonymní přihlášení</>
                            ) : authUser ? (
                                <>Přihlášený uživatel: {authUser.email || authUser.uid}</>
                            ) : (
                                <>Nejste přihlášeni</>
                            )}
                        </div>
                        <button className="btn" onClick={handleLogout} disabled={!authUser}>Odhlásit</button>
                    </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <div style={{ fontSize: 12, color: '#475569', fontWeight: 700 }}>Zvuk upozornění</div>
                    <button className={`btn ${soundEnabled ? 'active' : ''}`} style={{ minHeight: 32, padding: '6px 10px', fontSize: 12 }} onClick={handleToggleAlertSound}>
                        {soundEnabled ? 'Zapnuto' : 'Vypnuto'}
                    </button>
                </div>
                {soundHintMessage && (
                    <div style={{ fontSize: 12, color: '#92400e', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '6px 8px' }}>
                        {soundHintMessage}
                    </div>
                )}
            </div>

            {(runtimeMode === 'online' && onlineError) && (
                <div style={{ padding: '4px 12px', fontSize: 12, color: onlineError ? '#b91c1c' : '#475569' }}>
                    {onlineError}
                </div>
            )}

            {diagnostics.activeMode === 'fallback' && (
                <div style={{ padding: '4px 12px', fontSize: 12, color: '#b91c1c' }}>
                    Online režim se nepodařilo spustit – používám demo data
                    <div>{diagnostics.lastErrorCode ? `${diagnostics.lastErrorCode}: ` : ''}{diagnostics.lastErrorMessage || 'Neznámá chyba'}</div>
                </div>
            )}

            <div style={{ padding: 12 }}>
                {runtimeMode === 'online' && authUser?.isAnonymous && (
                    <div className="section" style={{ maxWidth: 420, margin: '0 auto', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 12, padding: 12 }}>
                        <div style={{ fontSize: 13, color: '#9a3412', marginBottom: 8 }}>Anonymní vývojové přihlášení není pro ostrý režim povoleno.</div>
                        <button className="btn" onClick={handleSignOutAnonymous}>Odhlásit anonymního uživatele</button>
                    </div>
                )}

                {runtimeMode === 'online' && (!authUser || authUser.isAnonymous) && (
                    <div className="section" style={{ maxWidth: 420, margin: '0 auto' }}>
                        <h3>Přihlášení</h3>
                        <form onSubmit={handleLoginSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 8, background: '#fff', padding: 12, borderRadius: 12, border: '1px solid #dbe7f3' }}>
                            <input
                                type="email"
                                value={loginEmail}
                                onChange={(e) => setLoginEmail(e.target.value)}
                                placeholder="E-mail"
                                autoComplete="email"
                                required
                            />
                            <input
                                type="password"
                                value={loginPassword}
                                onChange={(e) => setLoginPassword(e.target.value)}
                                placeholder="Heslo"
                                autoComplete="current-password"
                                required
                            />
                            <button className="action-large" type="submit" disabled={loginLoading}>
                                {loginLoading ? 'Přihlašuji…' : 'Přihlásit'}
                            </button>
                            {loginError && <div style={{ color: '#b91c1c', fontSize: 13 }}>{loginError}</div>}
                        </form>
                    </div>
                )}

                {runtimeMode === 'online' && authUser && !authUser.isAnonymous && !onlineProfile && !profileLoading && (
                    <div className="section" style={{ maxWidth: 520, margin: '0 auto', background: '#fff', padding: 12, borderRadius: 12, border: '1px solid #fecaca' }}>
                        <h3 style={{ marginBottom: 6 }}>Uživatel není přiřazený k hotelu.</h3>
                        <div style={{ fontSize: 13, color: '#475569' }}>Vytvořte prosím dokument ve Firestore: hotels/{ONLINE_HOTEL_ID}/staff/{missingProfileUid || authUser.uid}</div>
                        <div style={{ marginTop: 6, fontSize: 13, color: '#0f172a' }}>UID: {missingProfileUid || authUser.uid}</div>
                    </div>
                )}

                {runtimeMode === 'online' && (onlineLoading || profileLoading) && authUser && !authUser.isAnonymous && (
                    <div style={{ padding: '4px 12px', fontSize: 12, color: '#475569' }}>
                        Načítám online data...
                    </div>
                )}

                {runtimeMode === 'online' && (!authUser || authUser.isAnonymous || !onlineProfile) ? null : (
                    <>
                        <div className="date-selector" aria-label="Výběr dne">
                            <div className="date-selector-track">
                                {dateSelectorItems.map((chip) => (
                                    <button
                                        key={chip.key}
                                        className={`date-chip ${chip.active ? 'active' : ''}`}
                                        onClick={() => {
                                            if (chip.kind === 'tab') {
                                                setSelectedImportedDateIso(null)
                                                setTab(chip.tab)
                                                return
                                            }
                                            setSelectedImportedDateIso(chip.dateIso)
                                        }}
                                    >
                                        {chip.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="main-nav" aria-label="Hlavní navigace">
                            <div className="main-nav-track">
                                <button className={`nav-tab ${view === 'today' ? 'active' : ''}`} onClick={() => setView('today')}>{t('nav.rooms')}</button>
                                <button className={`nav-tab ${view === 'sheet' ? 'active' : ''}`} onClick={() => setView('sheet')}>{t('nav.sheet')}</button>
                                <button className={`nav-tab ${view === 'team' ? 'active' : ''}`} onClick={() => setView('team')}>{t('nav.team')}</button>
                                {isAdminUser && (
                                    <button className={`nav-tab ${view === 'admin' ? 'active' : ''}`} onClick={() => setView('admin')}>Admin</button>
                                )}
                                <button className={`nav-tab ${view === 'maintenance' ? 'active' : ''}`} onClick={() => setView('maintenance')}>{t('nav.maintenance')}</button>
                                <button className={`nav-tab ${view === 'supplies' ? 'active' : ''}`} onClick={() => setView('supplies')}>{t('nav.supplies')}</button>
                            </div>
                        </div>

                        {showInstallHint && (
                            <div className="install-hint" style={{ marginTop: 8 }}>
                                <span>Pro rychlejší spuštění přidejte aplikaci na plochu.</span>
                                <button className="install-hint-dismiss" onClick={dismissInstallHint} aria-label="Skrýt nápovědu instalace">Skrýt</button>
                            </div>
                        )}

                        {showOrientationNote && (
                            <div style={{ marginTop: 10, padding: 10, background: '#fff', borderRadius: 10 }}>Orientační plán – může se změnit novou rezervací.</div>
                        )}

                        {lateTaskNavMessage && (
                            <div style={{ marginTop: 10, padding: 10, borderRadius: 10, border: '1px solid #fecaca', background: '#fef2f2', color: '#b91c1c', fontWeight: 700 }}>
                                {lateTaskNavMessage}
                            </div>
                        )}

                        {maintenanceNavMessage && (
                            <div style={{ marginTop: 10, padding: 10, borderRadius: 10, border: '1px solid #fecaca', background: '#fff1f2', color: '#9f1239', fontWeight: 700 }}>
                                {maintenanceNavMessage}
                            </div>
                        )}

                        <div style={{ marginTop: 12 }}>
                            {view === 'today' && (
                                <DashboardToday
                                    rooms={displayedRooms}
                                    tasks={visibleDashboardTasks}
                                    maintenanceItems={maintenanceItems}
                                    onAction={handleAction}
                                    onCreateTask={handleCreateTask}
                                    onUpdateTaskStatus={handleUpdateTaskStatus}
                                    onCancelTask={handleCancelTask}
                                    onAcknowledgeLateTasks={handleAcknowledgeRoomLateTasks}
                                    onReportProblem={handleReportRoomProblem}
                                    unfinishedCarryOvers={unfinishedCarryOverByRoomNumber}
                                    role={(effectiveRole || 'cleaner') as UserRole}
                                    dayLabel={dayLabel}
                                    currentUserId={userId}
                                    currentUserName={currentUser?.name}
                                    staff={staffWithTodayAvailability}
                                    t={t}
                                    focusLateTaskRoomRequest={lateTaskRoomFocusRequest}
                                    onFocusLateTaskRoomResult={handleLateTaskFocusResult}
                                    readOnly={isExtraImportedDay}
                                />
                            )}
                            {view === 'sheet' && (
                                <RoomSheetView
                                    roomsByDay={roomsByDay}
                                    importedTabDates={importedTabDates}
                                    importedRoomsByDate={importedRoomsByDate}
                                    activeRoomNumbers={activeSheetRoomNumbers}
                                />
                            )}
                            {view === 'team' && (
                                <TeamOverview
                                    staff={staffWithEffectiveAvailability}
                                    role={realUserRole}
                                    currentUserId={currentUser?.id || userId}
                                    t={t}
                                    onSetAvailability={setStaffAvailability}
                                />
                            )}
                            {view === 'admin' && isAdminUser && (
                                <>
                                    {isAdminUser && (
                                        <div className="section">
                                            <h3>Import z Previa</h3>
                                            <div className="room-card" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, marginBottom: 8 }}>
                                                <div style={{ fontSize: 14, fontWeight: 800 }}>Importy z Previa</div>
                                                {latestRollbackCandidateJob && (
                                                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                                        <button className="btn" disabled={Boolean(rollingBackJobId)} onClick={() => void handleRollbackLastImport()}>
                                                            {rollingBackJobId ? 'Provádím rollback...' : 'Vrátit poslední import'}
                                                        </button>
                                                        <div className="room-meta">
                                                            Poslední potvrzený import: {latestRollbackCandidateJob.fileName}
                                                        </div>
                                                    </div>
                                                )}
                                                <div style={{ display: 'grid', gap: 8, border: '1px solid #e2e8f0', background: '#f8fafc', borderRadius: 8, padding: 8 }}>
                                                    <div style={{ fontSize: 12, color: '#334155', fontWeight: 700 }}>Post-import cleanup</div>
                                                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                                        <button
                                                            type="button"
                                                            className="btn danger"
                                                            disabled={importCleanupInProgress}
                                                            onClick={() => void handleCleanupSupersededImports()}
                                                        >
                                                            {importCleanupAction === 'superseded' ? 'Mažu…' : 'Smazat nahrazené nepotvrzené importy'}
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="btn danger"
                                                            disabled={importCleanupInProgress}
                                                            onClick={() => void handleBulkImportCleanup('test_unconfirmed')}
                                                        >
                                                            {importCleanupAction === 'test_unconfirmed' ? 'Mažu…' : 'Smazat testovací/nepotvrzené importy'}
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="btn"
                                                            disabled={importCleanupInProgress}
                                                            onClick={() => void handleBulkImportCleanup('old')}
                                                        >
                                                            {importCleanupAction === 'old' ? 'Mažu…' : 'Archivovat/Smazat staré importy'}
                                                        </button>
                                                    </div>
                                                    <div className="room-meta" style={{ color: '#475569' }}>
                                                        Staré importy mažou záznam i uložené PDF. Poslední potvrzený import se kvůli rollbacku ponechává.
                                                    </div>
                                                    <div className="room-meta" style={{ color: '#475569' }}>
                                                        Potvrzené importy se standardně jen skrývají v historii. Mazání používejte jen při úklidu.
                                                    </div>
                                                    {newestPrevioStateJob && (
                                                        <div className="room-meta" style={{ color: '#0c4a6e' }}>
                                                            Nejnovější Stav import: {newestPrevioStateJob.fileName} • {new Date(newestPrevioStateJob.receivedAt).toLocaleString('cs-CZ')}
                                                        </div>
                                                    )}
                                                    {importCleanupFeedback && (
                                                        <div
                                                            className="room-meta"
                                                            style={{
                                                                color: importCleanupFeedback.tone === 'error'
                                                                    ? '#b91c1c'
                                                                    : importCleanupFeedback.tone === 'warning'
                                                                        ? '#92400e'
                                                                        : importCleanupFeedback.tone === 'info'
                                                                            ? '#334155'
                                                                            : '#166534'
                                                            }}
                                                        >
                                                            {importCleanupFeedback.message}
                                                            {' '}Kandidáti: {importCleanupFeedback.candidates} •
                                                            {' '}Smazané joby: {importCleanupFeedback.deletedJobs} •
                                                            {' '}Smazaná PDF: {importCleanupFeedback.deletedPdfs} •
                                                            {' '}Přeskočeno (chráněné): {importCleanupFeedback.skippedProtected}
                                                            {(importCleanupFeedback.storageWarnings > 0 || importCleanupFeedback.notFound > 0) && (
                                                                <> • Warningy: {importCleanupFeedback.storageWarnings} • Nenalezeno: {importCleanupFeedback.notFound}</>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                                {importJobs.length === 0 && <div className="room-meta">Zatím nejsou žádné import joby.</div>}
                                                {adminVisibleImportJobs.map(({ job, group }, index) => {
                                                    const previousGroup = index > 0 ? adminVisibleImportJobs[index - 1].group : null
                                                    const showGroupHeading = index === 0 || previousGroup !== group
                                                    const isNewestPrevioStateJob = newestPrevioStateJob?.id === job.id
                                                    const isSupersededPrevioStateJob = supersededPrevioStateJobIds.has(job.id)
                                                    const inlinePreviewModel = buildImportJobInlinePreviewModel(job)
                                                    const jobByDate = getImportJobByDate(job.previewSummary)
                                                    const jobParsedTabDates = getImportJobParsedTabDates(job.previewSummary)
                                                    const jobPreview = (job.previewSummary?.preview || null) as PrevioStateImportPreview | null
                                                    const jobMissingDateLabels = job.previewSummary?.missingDateLabels || []
                                                    const jobParserVersion = job.previewSummary?.parserVersion || job.parserVersion
                                                    const rollbackAvailability = rollbackAvailabilityByJobId[job.id]
                                                    const isRollbackAvailable = rollbackAvailability === 'available'
                                                    const showLegacyRollbackHint = job.status === 'confirmed'
                                                        && job.type === 'previo-state-pdf'
                                                        && rollbackAvailability === 'legacy'
                                                    const showRollbackChecking = job.status === 'confirmed'
                                                        && job.type === 'previo-state-pdf'
                                                        && rollbackAvailability === 'checking'
                                                    const jobSafety = resolveImportSafety(jobPreview, jobMissingDateLabels, jobParserVersion, inlinePreviewModel?.safety)
                                                    const autoPreviewStatus = resolveImportJobAutoPreviewStatus(job)
                                                    const autoConfirmEvaluation = evaluateImportJobAutoConfirm({
                                                        job,
                                                        mode: AUTO_CONFIRM_STAV_IMPORTS_MODE,
                                                        isNewestPrevioStateJob,
                                                        isSupersededPrevioStateJob,
                                                        hasByDate: Boolean(jobByDate),
                                                        hasParsedTabDates: Boolean(jobParsedTabDates),
                                                        safety: jobSafety
                                                    })
                                                    const autoConfirmInfoStyle = autoConfirmEvaluation.wouldConfirm
                                                        ? {
                                                            color: '#166534',
                                                            background: '#ecfdf3',
                                                            border: '1px solid #86efac'
                                                        }
                                                        : {
                                                            color: '#9a3412',
                                                            background: '#fff7ed',
                                                            border: '1px solid #fdba74'
                                                        }
                                                    const hasPreviewSummary = Boolean(asRecord(job.previewSummary))
                                                    const hasParserVersionWarning = hasPreviewSummary && (!jobParserVersion || jobParserVersion !== PREVIO_STAV_PARSER_VERSION)
                                                    const canConfirm = Boolean(
                                                        job.status === 'needs_review'
                                                        && inlinePreviewModel?.byDate
                                                        && inlinePreviewModel?.parsedTabDates
                                                        && !jobSafety?.blocked
                                                        && !isSupersededPrevioStateJob
                                                    )
                                                    const isInlinePreviewOpen = openImportJobPreviewId === job.id
                                                    const inlinePreviewError = importJobPreviewInlineErrors[job.id]
                                                    const rowsExpanded = Boolean(expandedImportJobPreviewRows[job.id])
                                                    const visibleRows = inlinePreviewModel
                                                        ? (rowsExpanded ? inlinePreviewModel.rows : inlinePreviewModel.rows.slice(0, 20))
                                                        : []
                                                    const previewDiagnostics = getImportJobPreviewDiagnostics(job.previewSummary)
                                                    const latestPreviewResponse = lastPreviewRegenerateResponseByJobId[job.id]
                                                    const diagnosticsUseLatestResponse = Boolean(
                                                        latestPreviewResponse
                                                        && previewDiagnostics?.previewRequestId
                                                        && latestPreviewResponse.requestId
                                                        && latestPreviewResponse.requestId === previewDiagnostics.previewRequestId
                                                    )

                                                    return (
                                                        <React.Fragment key={job.id}>
                                                            {showGroupHeading && (
                                                                <div style={{ marginTop: 10, fontSize: 13, fontWeight: 800, color: '#0f172a' }}>
                                                                    {group === 'current' ? 'Aktuální import' : 'Čeká na kontrolu / chyby'}
                                                                </div>
                                                            )}
                                                            <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: 10, background: '#fff' }}>
                                                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                                                    <div style={{ fontWeight: 700 }}>{job.fileName}</div>
                                                                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                                                        {isNewestPrevioStateJob && (
                                                                            <div style={{ background: '#dbeafe', color: '#1e3a8a', border: '1px solid #93c5fd', padding: '4px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
                                                                                Nejnovější import
                                                                            </div>
                                                                        )}
                                                                        {isSupersededPrevioStateJob && (
                                                                            <div style={{ background: '#fff7ed', color: '#9a3412', border: '1px solid #fdba74', padding: '4px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
                                                                                Nahrazeno novějším importem
                                                                            </div>
                                                                        )}
                                                                        <div style={{ ...importJobStatusStyle(job.status), padding: '4px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
                                                                            {importJobStatusLabel(job.status)}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                                <div className="room-meta" style={{ marginTop: 4 }}>
                                                                    Zdroj: {job.source === 'email' ? 'E-mail' : 'Manuální'} • Přijato: {job.receivedAt ? new Date(job.receivedAt).toLocaleString('cs-CZ') : '—'}
                                                                </div>
                                                                <div className="room-meta" style={{ marginTop: 2 }}>
                                                                    Parsováno: {job.parsedAt ? new Date(job.parsedAt).toLocaleString('cs-CZ') : '—'} • Potvrzeno: {job.confirmedAt ? new Date(job.confirmedAt).toLocaleString('cs-CZ') : '—'}
                                                                </div>
                                                                <div className="room-meta" style={{ marginTop: 2 }}>
                                                                    Dní: {job.detectedDaysCount ?? '—'} • Turnover: {job.turnoverCount ?? '—'} • Pobyty: {job.stayoverCount ?? '—'} • Volné: {job.freeCount ?? '—'}
                                                                </div>
                                                                <div className="room-meta" style={{ marginTop: 2 }}>
                                                                    Typ obsahu: {job.contentType || '—'} • Velikost: {formatBytes(job.sizeBytes)} • Storage: {job.storagePath || 'není k dispozici'}
                                                                </div>
                                                                <div className="room-meta" style={{ marginTop: 2 }}>
                                                                    Parser: {jobParserVersion || 'neznámá verze'}
                                                                </div>
                                                                {previewDiagnostics && (
                                                                    <div className="room-meta" style={{ marginTop: 2 }}>
                                                                        Diagnostika: Build {previewDiagnostics.parserBuildId || '—'}
                                                                        {previewDiagnostics.parserFileVersion ? ` • Parser file: ${previewDiagnostics.parserFileVersion}` : ''}
                                                                        {previewDiagnostics.previewGeneratedAt ? ` • Vygenerováno: ${new Date(previewDiagnostics.previewGeneratedAt).toLocaleString('cs-CZ')}` : ' • Vygenerováno: —'}
                                                                        {previewDiagnostics.previewGeneratedBy ? ` • Generátor: ${previewDiagnostics.previewGeneratedBy}` : ''}
                                                                        {previewDiagnostics.sourceStoragePath ? ` • Source: ${previewDiagnostics.sourceStoragePath}` : ''}
                                                                        {previewDiagnostics.previewRequestId ? ` • Request: ${previewDiagnostics.previewRequestId}` : ' • Request: —'}
                                                                        {previewDiagnostics.previewFreshGenerated ? ' • Fresh: ano' : ' • Fresh: ne'}
                                                                        {latestPreviewResponse
                                                                            ? (diagnosticsUseLatestResponse
                                                                                ? ' • UI snapshot: poslední response'
                                                                                : ` • UI snapshot: nesouhlasí (poslední response ${new Date(latestPreviewResponse.receivedAt).toLocaleTimeString('cs-CZ')})`)
                                                                            : ''}
                                                                    </div>
                                                                )}
                                                                {autoPreviewStatus && (
                                                                    <div className="room-meta" style={{ marginTop: 2 }}>
                                                                        Automatický náhled: {importAutoPreviewStatusLabel(autoPreviewStatus.status)}
                                                                        {autoPreviewStatus.checkedAt ? ` • ${new Date(autoPreviewStatus.checkedAt).toLocaleString('cs-CZ')}` : ''}
                                                                    </div>
                                                                )}
                                                                <div className="room-meta" style={{ marginTop: 2 }}>
                                                                    Automatické potvrzení: {importAutoConfirmModeLabel(autoConfirmEvaluation.mode)}
                                                                </div>
                                                                {job.automation?.autoConfirmedAt && (
                                                                    <div className="room-meta" style={{ marginTop: 2, color: '#166534' }}>
                                                                        Automaticky potvrzeno: {new Date(job.automation.autoConfirmedAt).toLocaleString('cs-CZ')}
                                                                        {job.automation.autoConfirmReason ? ` • Důvod: ${job.automation.autoConfirmReason}` : ''}
                                                                    </div>
                                                                )}
                                                                {autoConfirmEvaluation.mode === 'enabled' && job.status !== 'confirmed' && (
                                                                    <div style={{ marginTop: 6, fontSize: 12, borderRadius: 8, padding: 6, ...autoConfirmInfoStyle }}>
                                                                        {autoConfirmEvaluation.wouldConfirm
                                                                            ? 'Automatická kontrola: OK. Import je připraven k automatickému potvrzení.'
                                                                            : 'Automatické potvrzení blokováno:'}
                                                                        {!autoConfirmEvaluation.wouldConfirm && autoConfirmEvaluation.blockedReasons.length > 0 && (
                                                                            <ul style={{ margin: '6px 0 0 16px', fontWeight: 500 }}>
                                                                                {Array.from(new Set(autoConfirmEvaluation.blockedReasons)).slice(0, 6).map((reason) => (
                                                                                    <li key={`${job.id}-auto-block-${reason}`}>{reason}</li>
                                                                                ))}
                                                                            </ul>
                                                                        )}
                                                                    </div>
                                                                )}
                                                                {job.backupSummary && (
                                                                    <div className="room-meta" style={{ marginTop: 2 }}>
                                                                        Snapshot: {new Date(job.backupSummary.createdAt).toLocaleString('cs-CZ')} • Dny: {job.backupSummary.affectedDates.join(', ')} • Pokoje: {job.backupSummary.affectedRoomCount}
                                                                        {job.backupSummary.rolledBackAt ? ` • Vráceno: ${new Date(job.backupSummary.rolledBackAt).toLocaleString('cs-CZ')}` : ''}
                                                                    </div>
                                                                )}
                                                                {showLegacyRollbackHint && (
                                                                    <div className="room-meta" style={{ marginTop: 2, color: '#64748b' }}>
                                                                        Rollback není dostupný pro importy potvrzené starší verzí.
                                                                    </div>
                                                                )}
                                                                {showRollbackChecking && (
                                                                    <div className="room-meta" style={{ marginTop: 2, color: '#64748b' }}>
                                                                        Ověřuji dostupnost rollback snapshotu...
                                                                    </div>
                                                                )}
                                                                {hasParserVersionWarning && (
                                                                    <div style={{ marginTop: 6, fontSize: 12, color: '#92400e', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: 6 }}>
                                                                        Náhled byl vytvořen starší verzí parseru. Doporučujeme přegenerovat.
                                                                    </div>
                                                                )}
                                                                {job.source === 'email' && !job.previewSummary?.byDate && (
                                                                    <div style={{ marginTop: 6, fontSize: 12, color: '#92400e', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: 6 }}>
                                                                        PDF je přijaté, ale náhled ještě není dostupný. Import čeká na serverové zpracování PDF.
                                                                    </div>
                                                                )}
                                                                {job.source === 'email' && Boolean(job.previewSummary?.byDate) && Boolean(jobSafety?.blocked) && (
                                                                    <div style={{ marginTop: 6, fontSize: 12, color: '#9a3412', background: '#fff7ed', border: '1px solid #fdba74', borderRadius: 8, padding: 6 }}>
                                                                        Náhled vytvořen, ale import je podezřelý.
                                                                    </div>
                                                                )}
                                                                {job.warnings.length > 0 && (
                                                                    <div style={{ marginTop: 6, fontSize: 12, color: '#92400e', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: 6 }}>
                                                                        {job.warnings.slice(0, 4).map((warning) => (
                                                                            <div key={`${job.id}-${warning}`}>{warning}</div>
                                                                        ))}
                                                                    </div>
                                                                )}
                                                                {job.error && <div style={{ marginTop: 6, fontSize: 12, color: '#991b1b' }}>{job.error}</div>}
                                                                {isSupersededPrevioStateJob && (
                                                                    <div style={{ marginTop: 6, fontSize: 12, color: '#9a3412', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: 6 }}>
                                                                        {IMPORT_CONFIRM_SUPERSEDED_MESSAGE}
                                                                    </div>
                                                                )}
                                                                <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                                                    {hasPreviewSummary && (
                                                                        <button className="btn" onClick={() => handleShowImportJobPreview(job.id)}>
                                                                            {isInlinePreviewOpen ? 'Skrýt náhled' : 'Zobrazit náhled'}
                                                                        </button>
                                                                    )}
                                                                    {job.source === 'email' && job.storagePath && (
                                                                        <button
                                                                            className="btn"
                                                                            disabled={generatingImportPreviewJobId === job.id}
                                                                            onClick={() => void handleGenerateImportJobPreview(job.id)}
                                                                        >
                                                                            {generatingImportPreviewJobId === job.id
                                                                                ? 'Vytvářím náhled...'
                                                                                : (hasPreviewSummary ? 'Přegenerovat náhled' : 'Vytvořit náhled')}
                                                                        </button>
                                                                    )}
                                                                    <button
                                                                        className="btn"
                                                                        disabled={!canConfirm}
                                                                        onClick={() => void handleConfirmImportJob(job.id)}
                                                                    >
                                                                        Potvrdit import
                                                                    </button>
                                                                    <button className="btn" disabled={job.status === 'confirmed' || job.status === 'cancelled'} onClick={() => handleCancelImportJob(job.id)}>Zrušit</button>
                                                                    <button className="btn danger" disabled={importCleanupInProgress} onClick={() => void handleDeleteImportJob(job.id)}>Smazat import job</button>
                                                                    {isRollbackAvailable && (
                                                                        <button
                                                                            className="btn"
                                                                            disabled={rollingBackJobId === job.id}
                                                                            onClick={() => void handleRollbackImport(job.id)}
                                                                        >
                                                                            {rollingBackJobId === job.id ? 'Provádím rollback...' : 'Vrátit tento import'}
                                                                        </button>
                                                                    )}
                                                                </div>

                                                                {isInlinePreviewOpen && (
                                                                    <div
                                                                        ref={(node) => {
                                                                            importJobPreviewPanelRefs.current[job.id] = node
                                                                        }}
                                                                        style={{ marginTop: 10, border: '1px solid #bae6fd', background: '#f0f9ff', borderRadius: 8, padding: 8, display: 'grid', gap: 8 }}
                                                                    >
                                                                        {inlinePreviewModel ? (
                                                                            <>
                                                                                <div style={{ fontWeight: 800, color: '#0c4a6e' }}>Náhled importu Stav</div>
                                                                                <div className="room-meta" style={{ color: '#0c4a6e' }}>Detekované dny: {inlinePreviewModel.detectedDaysCount} • Turnover pokoje: {inlinePreviewModel.turnoverCount} • Probíhající pobyty: {inlinePreviewModel.stayoverCount} • Odvozené volné pokoje: {inlinePreviewModel.freeCount}</div>
                                                                                {jobSafety && (
                                                                                    <div style={{ fontSize: 12, borderRadius: 8, padding: 8, border: jobSafety.blocked ? '1px solid #fecaca' : '1px solid #86efac', background: jobSafety.blocked ? '#fef2f2' : '#ecfdf3', color: jobSafety.blocked ? '#991b1b' : '#166534', fontWeight: 700 }}>
                                                                                        {jobSafety.blocked ? 'Import je podezřelý – nepotvrzovat' : 'Kontrola importu: OK'}
                                                                                        {(jobSafety.blocks.length > 0 || jobSafety.warnings.length > 0) && (
                                                                                            <ul style={{ margin: '6px 0 0 16px', fontWeight: 500 }}>
                                                                                                {Array.from(new Set([...jobSafety.blocks, ...jobSafety.warnings])).map((warning) => (
                                                                                                    <li key={`${job.id}-safety-${warning}`}>{warning}</li>
                                                                                                ))}
                                                                                            </ul>
                                                                                        )}
                                                                                    </div>
                                                                                )}
                                                                                {inlinePreviewModel.warnings.length > 0 && (
                                                                                    <div style={{ fontSize: 12, color: '#92400e', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: 8 }}>
                                                                                        {inlinePreviewModel.warnings.slice(0, 8).map((warning, innerIndex) => (
                                                                                            <div key={`${job.id}-inline-warning-${innerIndex}`}>{warning}</div>
                                                                                        ))}
                                                                                    </div>
                                                                                )}
                                                                                {inlinePreviewError && (
                                                                                    <div style={{ fontSize: 12, color: '#991b1b', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 8 }}>
                                                                                        {inlinePreviewError}
                                                                                    </div>
                                                                                )}
                                                                                {previewDiagnostics && (
                                                                                    <div style={{ fontSize: 12, color: '#0c4a6e', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: 8 }}>
                                                                                        <div style={{ fontWeight: 700, marginBottom: 4 }}>Debug probe rows</div>
                                                                                        {DEBUG_PROBE_ROW_KEYS.map((key) => {
                                                                                            const probe = previewDiagnostics.debugProbeRows[key]
                                                                                            return (
                                                                                                <div key={`${job.id}-debug-probe-${key}`} style={{ marginTop: 2 }}>
                                                                                                    {key}: {probe
                                                                                                        ? [
                                                                                                            `odj ${probe.departureTime || '—'}`,
                                                                                                            `příj ${probe.arrivalTime || '—'}`,
                                                                                                            `odj.host ${probe.departureGuest || '—'}`,
                                                                                                            `odj.pocet ${typeof probe.departureCount === 'number' ? probe.departureCount : '—'}`,
                                                                                                            `příj.host ${probe.arrivalGuest || '—'}`,
                                                                                                            `příj.pocet ${typeof probe.arrivalCount === 'number' ? probe.arrivalCount : '—'}`,
                                                                                                            `odj.pozn ${(probe.departureNotes || []).length ? probe.departureNotes.join('; ') : '—'}`,
                                                                                                            `příj.pozn ${(probe.arrivalNotes || []).length ? probe.arrivalNotes.join('; ') : '—'}`
                                                                                                        ].join(' | ')
                                                                                                        : 'nenalezeno'}
                                                                                                </div>
                                                                                            )
                                                                                        })}
                                                                                    </div>
                                                                                )}
                                                                                <div style={{ overflowX: 'auto', border: '1px solid #dbeafe', borderRadius: 8, background: '#fff' }}>
                                                                                    <div style={{ maxHeight: 280, overflow: 'auto' }}>
                                                                                        <table style={{ width: '100%', minWidth: 860, borderCollapse: 'collapse', fontSize: 12 }}>
                                                                                            <thead>
                                                                                                <tr style={{ background: '#f8fafc' }}>
                                                                                                    <th style={{ textAlign: 'left', padding: 6 }}>Den</th>
                                                                                                    <th style={{ textAlign: 'left', padding: 6 }}>Pokoj</th>
                                                                                                    <th style={{ textAlign: 'left', padding: 6 }}>Odjezd</th>
                                                                                                    <th style={{ textAlign: 'left', padding: 6 }}>Příjezd</th>
                                                                                                    <th style={{ textAlign: 'left', padding: 6 }}>Odj. host</th>
                                                                                                    <th style={{ textAlign: 'left', padding: 6 }}>Odj. počet</th>
                                                                                                    <th style={{ textAlign: 'left', padding: 6 }}>Příj. host</th>
                                                                                                    <th style={{ textAlign: 'left', padding: 6 }}>Příj. počet</th>
                                                                                                    <th style={{ textAlign: 'left', padding: 6 }}>Odj. pozn.</th>
                                                                                                    <th style={{ textAlign: 'left', padding: 6 }}>Příj. pozn.</th>
                                                                                                </tr>
                                                                                            </thead>
                                                                                            <tbody>
                                                                                                {visibleRows.length > 0 ? visibleRows.map((row, rowIndex) => (
                                                                                                    <tr key={`${job.id}-inline-row-${row.dateIso}-${row.roomNumber}-${rowIndex}`}>
                                                                                                        <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{formatPreviewRowDate(row.dateIso)}</td>
                                                                                                        <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.roomNumber || '—'}</td>
                                                                                                        <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.departureTime || '—'}</td>
                                                                                                        <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.arrivalTime || '—'}</td>
                                                                                                        <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.departureGuestName || '—'}</td>
                                                                                                        <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{typeof row.departureGuestCount === 'number' ? `${row.departureGuestCount}p` : '—'}</td>
                                                                                                        <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.arrivalGuestName || '—'}</td>
                                                                                                        <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{typeof row.arrivalGuestCount === 'number' ? `${row.arrivalGuestCount}p` : '—'}</td>
                                                                                                        <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.departureNotes.length ? row.departureNotes.join('; ') : '—'}</td>
                                                                                                        <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.arrivalNotes.length ? row.arrivalNotes.join('; ') : '—'}</td>
                                                                                                    </tr>
                                                                                                )) : (
                                                                                                    <tr>
                                                                                                        <td colSpan={10} style={{ padding: 8, borderTop: '1px solid #e2e8f0', color: '#475569' }}>
                                                                                                            Náhled je dostupný, ale neobsahuje tabulkové řádky.
                                                                                                        </td>
                                                                                                    </tr>
                                                                                                )}
                                                                                            </tbody>
                                                                                        </table>
                                                                                    </div>
                                                                                </div>
                                                                                {inlinePreviewModel.rows.length > 20 && (
                                                                                    <button
                                                                                        className="btn"
                                                                                        style={{ width: 'fit-content' }}
                                                                                        onClick={() => setExpandedImportJobPreviewRows((prev) => ({
                                                                                            ...prev,
                                                                                            [job.id]: !rowsExpanded
                                                                                        }))}
                                                                                    >
                                                                                        {rowsExpanded ? 'Zobrazit méně' : `Zobrazit vše (${inlinePreviewModel.rows.length})`}
                                                                                    </button>
                                                                                )}
                                                                            </>
                                                                        ) : (
                                                                            <div style={{ fontSize: 12, color: '#991b1b', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 8 }}>
                                                                                {inlinePreviewError || 'Náhled importu není dostupný. Zkuste náhled přegenerovat.'}
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </React.Fragment>
                                                    )
                                                })}
                                                {adminVisibleImportJobs.length === 0 && importJobs.length > 0 && (
                                                    <div className="room-meta">Žádné importy nevyžadují akci.</div>
                                                )}
                                                {confirmedHistoryImportJobs.length > 0 && (
                                                    <div style={{ marginTop: 10, borderTop: '1px solid #e2e8f0', paddingTop: 10, display: 'grid', gap: 8 }}>
                                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                                            <div style={{ fontSize: 13, fontWeight: 800, color: '#0f172a' }}>Historie potvrzených importů</div>
                                                            <button
                                                                type="button"
                                                                className="btn"
                                                                onClick={() => setShowConfirmedImportHistory((prev) => !prev)}
                                                            >
                                                                {showConfirmedImportHistory ? 'Skrýt historii importů' : 'Zobrazit historii importů'}
                                                            </button>
                                                        </div>
                                                        {!showConfirmedImportHistory && (
                                                            <div className="room-meta" style={{ color: '#64748b' }}>
                                                                Skryto {confirmedHistoryImportJobs.length} starších potvrzených importů.
                                                            </div>
                                                        )}
                                                        {showConfirmedImportHistory && confirmedHistoryImportJobs.map((job) => {
                                                            const isNewestPrevioStateJob = newestPrevioStateJob?.id === job.id
                                                            const isSupersededPrevioStateJob = supersededPrevioStateJobIds.has(job.id)
                                                            const inlinePreviewModel = buildImportJobInlinePreviewModel(job)
                                                            const jobByDate = getImportJobByDate(job.previewSummary)
                                                            const jobParsedTabDates = getImportJobParsedTabDates(job.previewSummary)
                                                            const jobPreview = (job.previewSummary?.preview || null) as PrevioStateImportPreview | null
                                                            const jobMissingDateLabels = job.previewSummary?.missingDateLabels || []
                                                            const jobParserVersion = job.previewSummary?.parserVersion || job.parserVersion
                                                            const rollbackAvailability = rollbackAvailabilityByJobId[job.id]
                                                            const isRollbackAvailable = rollbackAvailability === 'available'
                                                            const showLegacyRollbackHint = job.status === 'confirmed'
                                                                && job.type === 'previo-state-pdf'
                                                                && rollbackAvailability === 'legacy'
                                                            const showRollbackChecking = job.status === 'confirmed'
                                                                && job.type === 'previo-state-pdf'
                                                                && rollbackAvailability === 'checking'
                                                            const jobSafety = resolveImportSafety(jobPreview, jobMissingDateLabels, jobParserVersion, inlinePreviewModel?.safety)
                                                            const autoPreviewStatus = resolveImportJobAutoPreviewStatus(job)
                                                            const autoConfirmEvaluation = evaluateImportJobAutoConfirm({
                                                                job,
                                                                mode: AUTO_CONFIRM_STAV_IMPORTS_MODE,
                                                                isNewestPrevioStateJob,
                                                                isSupersededPrevioStateJob,
                                                                hasByDate: Boolean(jobByDate),
                                                                hasParsedTabDates: Boolean(jobParsedTabDates),
                                                                safety: jobSafety
                                                            })
                                                            const autoConfirmInfoStyle = autoConfirmEvaluation.wouldConfirm
                                                                ? {
                                                                    color: '#166534',
                                                                    background: '#ecfdf3',
                                                                    border: '1px solid #86efac'
                                                                }
                                                                : {
                                                                    color: '#9a3412',
                                                                    background: '#fff7ed',
                                                                    border: '1px solid #fdba74'
                                                                }
                                                            const hasPreviewSummary = Boolean(asRecord(job.previewSummary))
                                                            const hasParserVersionWarning = hasPreviewSummary && (!jobParserVersion || jobParserVersion !== PREVIO_STAV_PARSER_VERSION)
                                                            const canConfirm = Boolean(
                                                                job.status === 'needs_review'
                                                                && inlinePreviewModel?.byDate
                                                                && inlinePreviewModel?.parsedTabDates
                                                                && !jobSafety?.blocked
                                                                && !isSupersededPrevioStateJob
                                                            )
                                                            const isInlinePreviewOpen = openImportJobPreviewId === job.id
                                                            const inlinePreviewError = importJobPreviewInlineErrors[job.id]
                                                            const rowsExpanded = Boolean(expandedImportJobPreviewRows[job.id])
                                                            const visibleRows = inlinePreviewModel
                                                                ? (rowsExpanded ? inlinePreviewModel.rows : inlinePreviewModel.rows.slice(0, 20))
                                                                : []
                                                            const previewDiagnostics = getImportJobPreviewDiagnostics(job.previewSummary)
                                                            const latestPreviewResponse = lastPreviewRegenerateResponseByJobId[job.id]
                                                            const diagnosticsUseLatestResponse = Boolean(
                                                                latestPreviewResponse
                                                                && previewDiagnostics?.previewRequestId
                                                                && latestPreviewResponse.requestId
                                                                && latestPreviewResponse.requestId === previewDiagnostics.previewRequestId
                                                            )

                                                            return (
                                                                <div key={job.id} style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: 10, background: '#fff' }}>
                                                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                                                        <div style={{ fontWeight: 700 }}>{job.fileName}</div>
                                                                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                                                            {isNewestPrevioStateJob && (
                                                                                <div style={{ background: '#dbeafe', color: '#1e3a8a', border: '1px solid #93c5fd', padding: '4px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
                                                                                    Nejnovější import
                                                                                </div>
                                                                            )}
                                                                            {isSupersededPrevioStateJob && (
                                                                                <div style={{ background: '#fff7ed', color: '#9a3412', border: '1px solid #fdba74', padding: '4px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
                                                                                    Nahrazeno novějším importem
                                                                                </div>
                                                                            )}
                                                                            <div style={{ ...importJobStatusStyle(job.status), padding: '4px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
                                                                                {importJobStatusLabel(job.status)}
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                    <div className="room-meta" style={{ marginTop: 4 }}>
                                                                        Zdroj: {job.source === 'email' ? 'E-mail' : 'Manuální'} • Přijato: {job.receivedAt ? new Date(job.receivedAt).toLocaleString('cs-CZ') : '—'}
                                                                    </div>
                                                                    <div className="room-meta" style={{ marginTop: 2 }}>
                                                                        Parsováno: {job.parsedAt ? new Date(job.parsedAt).toLocaleString('cs-CZ') : '—'} • Potvrzeno: {job.confirmedAt ? new Date(job.confirmedAt).toLocaleString('cs-CZ') : '—'}
                                                                    </div>
                                                                    <div className="room-meta" style={{ marginTop: 2 }}>
                                                                        Dní: {job.detectedDaysCount ?? '—'} • Turnover: {job.turnoverCount ?? '—'} • Pobyty: {job.stayoverCount ?? '—'} • Volné: {job.freeCount ?? '—'}
                                                                    </div>
                                                                    <div className="room-meta" style={{ marginTop: 2 }}>
                                                                        Typ obsahu: {job.contentType || '—'} • Velikost: {formatBytes(job.sizeBytes)} • Storage: {job.storagePath || 'není k dispozici'}
                                                                    </div>
                                                                    <div className="room-meta" style={{ marginTop: 2 }}>
                                                                        Parser: {jobParserVersion || 'neznámá verze'}
                                                                    </div>
                                                                    {previewDiagnostics && (
                                                                        <div className="room-meta" style={{ marginTop: 2 }}>
                                                                            Diagnostika: Build {previewDiagnostics.parserBuildId || '—'}
                                                                            {previewDiagnostics.parserFileVersion ? ` • Parser file: ${previewDiagnostics.parserFileVersion}` : ''}
                                                                            {previewDiagnostics.previewGeneratedAt ? ` • Vygenerováno: ${new Date(previewDiagnostics.previewGeneratedAt).toLocaleString('cs-CZ')}` : ' • Vygenerováno: —'}
                                                                            {previewDiagnostics.previewGeneratedBy ? ` • Generátor: ${previewDiagnostics.previewGeneratedBy}` : ''}
                                                                            {previewDiagnostics.sourceStoragePath ? ` • Source: ${previewDiagnostics.sourceStoragePath}` : ''}
                                                                            {previewDiagnostics.previewRequestId ? ` • Request: ${previewDiagnostics.previewRequestId}` : ' • Request: —'}
                                                                            {previewDiagnostics.previewFreshGenerated ? ' • Fresh: ano' : ' • Fresh: ne'}
                                                                            {latestPreviewResponse
                                                                                ? (diagnosticsUseLatestResponse
                                                                                    ? ' • UI snapshot: poslední response'
                                                                                    : ` • UI snapshot: nesouhlasí (poslední response ${new Date(latestPreviewResponse.receivedAt).toLocaleTimeString('cs-CZ')})`)
                                                                                : ''}
                                                                        </div>
                                                                    )}
                                                                    {autoPreviewStatus && (
                                                                        <div className="room-meta" style={{ marginTop: 2 }}>
                                                                            Automatický náhled: {importAutoPreviewStatusLabel(autoPreviewStatus.status)}
                                                                            {autoPreviewStatus.checkedAt ? ` • ${new Date(autoPreviewStatus.checkedAt).toLocaleString('cs-CZ')}` : ''}
                                                                        </div>
                                                                    )}
                                                                    <div className="room-meta" style={{ marginTop: 2 }}>
                                                                        Automatické potvrzení: {importAutoConfirmModeLabel(autoConfirmEvaluation.mode)}
                                                                    </div>
                                                                    {job.automation?.autoConfirmedAt && (
                                                                        <div className="room-meta" style={{ marginTop: 2, color: '#166534' }}>
                                                                            Automaticky potvrzeno: {new Date(job.automation.autoConfirmedAt).toLocaleString('cs-CZ')}
                                                                            {job.automation.autoConfirmReason ? ` • Důvod: ${job.automation.autoConfirmReason}` : ''}
                                                                        </div>
                                                                    )}
                                                                    {autoConfirmEvaluation.mode === 'enabled' && job.status !== 'confirmed' && (
                                                                        <div style={{ marginTop: 6, fontSize: 12, borderRadius: 8, padding: 6, ...autoConfirmInfoStyle }}>
                                                                            {autoConfirmEvaluation.wouldConfirm
                                                                                ? 'Automatická kontrola: OK. Import je připraven k automatickému potvrzení.'
                                                                                : 'Automatické potvrzení blokováno:'}
                                                                            {!autoConfirmEvaluation.wouldConfirm && autoConfirmEvaluation.blockedReasons.length > 0 && (
                                                                                <ul style={{ margin: '6px 0 0 16px', fontWeight: 500 }}>
                                                                                    {Array.from(new Set(autoConfirmEvaluation.blockedReasons)).slice(0, 6).map((reason) => (
                                                                                        <li key={`${job.id}-auto-block-${reason}`}>{reason}</li>
                                                                                    ))}
                                                                                </ul>
                                                                            )}
                                                                        </div>
                                                                    )}
                                                                    {job.backupSummary && (
                                                                        <div className="room-meta" style={{ marginTop: 2 }}>
                                                                            Snapshot: {new Date(job.backupSummary.createdAt).toLocaleString('cs-CZ')} • Dny: {job.backupSummary.affectedDates.join(', ')} • Pokoje: {job.backupSummary.affectedRoomCount}
                                                                            {job.backupSummary.rolledBackAt ? ` • Vráceno: ${new Date(job.backupSummary.rolledBackAt).toLocaleString('cs-CZ')}` : ''}
                                                                        </div>
                                                                    )}
                                                                    {showLegacyRollbackHint && (
                                                                        <div className="room-meta" style={{ marginTop: 2, color: '#64748b' }}>
                                                                            Rollback není dostupný pro importy potvrzené starší verzí.
                                                                        </div>
                                                                    )}
                                                                    {showRollbackChecking && (
                                                                        <div className="room-meta" style={{ marginTop: 2, color: '#64748b' }}>
                                                                            Ověřuji dostupnost rollback snapshotu...
                                                                        </div>
                                                                    )}
                                                                    {hasParserVersionWarning && (
                                                                        <div style={{ marginTop: 6, fontSize: 12, color: '#92400e', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: 6 }}>
                                                                            Náhled byl vytvořen starší verzí parseru. Doporučujeme přegenerovat.
                                                                        </div>
                                                                    )}
                                                                    {job.source === 'email' && !job.previewSummary?.byDate && (
                                                                        <div style={{ marginTop: 6, fontSize: 12, color: '#92400e', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: 6 }}>
                                                                            PDF je přijaté, ale náhled ještě není dostupný. Import čeká na serverové zpracování PDF.
                                                                        </div>
                                                                    )}
                                                                    {job.warnings.length > 0 && (
                                                                        <div style={{ marginTop: 6, fontSize: 12, color: '#92400e', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: 6 }}>
                                                                            {job.warnings.slice(0, 4).map((warning) => (
                                                                                <div key={`${job.id}-${warning}`}>{warning}</div>
                                                                            ))}
                                                                        </div>
                                                                    )}
                                                                    {job.error && <div style={{ marginTop: 6, fontSize: 12, color: '#991b1b' }}>{job.error}</div>}
                                                                    {isSupersededPrevioStateJob && (
                                                                        <div style={{ marginTop: 6, fontSize: 12, color: '#9a3412', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: 6 }}>
                                                                            {IMPORT_CONFIRM_SUPERSEDED_MESSAGE}
                                                                        </div>
                                                                    )}
                                                                    <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                                                        {hasPreviewSummary && (
                                                                            <button className="btn" onClick={() => handleShowImportJobPreview(job.id)}>
                                                                                {isInlinePreviewOpen ? 'Skrýt náhled' : 'Zobrazit náhled'}
                                                                            </button>
                                                                        )}
                                                                        {job.source === 'email' && job.storagePath && (
                                                                            <button
                                                                                className="btn"
                                                                                disabled={generatingImportPreviewJobId === job.id}
                                                                                onClick={() => void handleGenerateImportJobPreview(job.id)}
                                                                            >
                                                                                {generatingImportPreviewJobId === job.id
                                                                                    ? 'Vytvářím náhled...'
                                                                                    : (hasPreviewSummary ? 'Přegenerovat náhled' : 'Vytvořit náhled')}
                                                                            </button>
                                                                        )}
                                                                        <button
                                                                            className="btn"
                                                                            disabled={!canConfirm}
                                                                            onClick={() => void handleConfirmImportJob(job.id)}
                                                                        >
                                                                            Potvrdit import
                                                                        </button>
                                                                        <button className="btn" disabled={job.status === 'confirmed' || job.status === 'cancelled'} onClick={() => handleCancelImportJob(job.id)}>Zrušit</button>
                                                                        <button className="btn danger" disabled={importCleanupInProgress} onClick={() => void handleDeleteImportJob(job.id)}>Smazat import job</button>
                                                                        {isRollbackAvailable && (
                                                                            <button
                                                                                className="btn"
                                                                                disabled={rollingBackJobId === job.id}
                                                                                onClick={() => void handleRollbackImport(job.id)}
                                                                            >
                                                                                {rollingBackJobId === job.id ? 'Provádím rollback...' : 'Vrátit tento import'}
                                                                            </button>
                                                                        )}
                                                                    </div>

                                                                    {isInlinePreviewOpen && (
                                                                        <div
                                                                            ref={(node) => {
                                                                                importJobPreviewPanelRefs.current[job.id] = node
                                                                            }}
                                                                            style={{ marginTop: 10, border: '1px solid #bae6fd', background: '#f0f9ff', borderRadius: 8, padding: 8, display: 'grid', gap: 8 }}
                                                                        >
                                                                            {inlinePreviewModel ? (
                                                                                <>
                                                                                    <div style={{ fontWeight: 800, color: '#0c4a6e' }}>Náhled importu Stav</div>
                                                                                    <div className="room-meta" style={{ color: '#0c4a6e' }}>Detekované dny: {inlinePreviewModel.detectedDaysCount} • Turnover pokoje: {inlinePreviewModel.turnoverCount} • Probíhající pobyty: {inlinePreviewModel.stayoverCount} • Odvozené volné pokoje: {inlinePreviewModel.freeCount}</div>
                                                                                    {jobSafety && (
                                                                                        <div style={{ fontSize: 12, borderRadius: 8, padding: 8, border: jobSafety.blocked ? '1px solid #fecaca' : '1px solid #86efac', background: jobSafety.blocked ? '#fef2f2' : '#ecfdf3', color: jobSafety.blocked ? '#991b1b' : '#166534', fontWeight: 700 }}>
                                                                                            {jobSafety.blocked ? 'Import je podezřelý – nepotvrzovat' : 'Kontrola importu: OK'}
                                                                                            {(jobSafety.blocks.length > 0 || jobSafety.warnings.length > 0) && (
                                                                                                <ul style={{ margin: '6px 0 0 16px', fontWeight: 500 }}>
                                                                                                    {Array.from(new Set([...jobSafety.blocks, ...jobSafety.warnings])).map((warning) => (
                                                                                                        <li key={`${job.id}-safety-${warning}`}>{warning}</li>
                                                                                                    ))}
                                                                                                </ul>
                                                                                            )}
                                                                                        </div>
                                                                                    )}
                                                                                    {inlinePreviewModel.warnings.length > 0 && (
                                                                                        <div style={{ fontSize: 12, color: '#92400e', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: 8 }}>
                                                                                            {inlinePreviewModel.warnings.slice(0, 8).map((warning, innerIndex) => (
                                                                                                <div key={`${job.id}-inline-warning-${innerIndex}`}>{warning}</div>
                                                                                            ))}
                                                                                        </div>
                                                                                    )}
                                                                                    {inlinePreviewError && (
                                                                                        <div style={{ fontSize: 12, color: '#991b1b', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 8 }}>
                                                                                            {inlinePreviewError}
                                                                                        </div>
                                                                                    )}
                                                                                    {previewDiagnostics && (
                                                                                        <div style={{ fontSize: 12, color: '#0c4a6e', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: 8 }}>
                                                                                            <div style={{ fontWeight: 700, marginBottom: 4 }}>Debug probe rows</div>
                                                                                            {DEBUG_PROBE_ROW_KEYS.map((key) => {
                                                                                                const probe = previewDiagnostics.debugProbeRows[key]
                                                                                                return (
                                                                                                    <div key={`${job.id}-debug-probe-${key}`} style={{ marginTop: 2 }}>
                                                                                                        {key}: {probe
                                                                                                            ? [
                                                                                                                `odj ${probe.departureTime || '—'}`,
                                                                                                                `příj ${probe.arrivalTime || '—'}`,
                                                                                                                `odj.host ${probe.departureGuest || '—'}`,
                                                                                                                `odj.pocet ${typeof probe.departureCount === 'number' ? probe.departureCount : '—'}`,
                                                                                                                `příj.host ${probe.arrivalGuest || '—'}`,
                                                                                                                `příj.pocet ${typeof probe.arrivalCount === 'number' ? probe.arrivalCount : '—'}`,
                                                                                                                `odj.pozn ${(probe.departureNotes || []).length ? probe.departureNotes.join('; ') : '—'}`,
                                                                                                                `příj.pozn ${(probe.arrivalNotes || []).length ? probe.arrivalNotes.join('; ') : '—'}`
                                                                                                            ].join(' | ')
                                                                                                            : 'nenalezeno'}
                                                                                                    </div>
                                                                                                )
                                                                                            })}
                                                                                        </div>
                                                                                    )}
                                                                                    <div style={{ overflowX: 'auto', border: '1px solid #dbeafe', borderRadius: 8, background: '#fff' }}>
                                                                                        <div style={{ maxHeight: 280, overflow: 'auto' }}>
                                                                                            <table style={{ width: '100%', minWidth: 860, borderCollapse: 'collapse', fontSize: 12 }}>
                                                                                                <thead>
                                                                                                    <tr style={{ background: '#f8fafc' }}>
                                                                                                        <th style={{ textAlign: 'left', padding: 6 }}>Den</th>
                                                                                                        <th style={{ textAlign: 'left', padding: 6 }}>Pokoj</th>
                                                                                                        <th style={{ textAlign: 'left', padding: 6 }}>Odjezd</th>
                                                                                                        <th style={{ textAlign: 'left', padding: 6 }}>Příjezd</th>
                                                                                                        <th style={{ textAlign: 'left', padding: 6 }}>Odj. host</th>
                                                                                                        <th style={{ textAlign: 'left', padding: 6 }}>Odj. počet</th>
                                                                                                        <th style={{ textAlign: 'left', padding: 6 }}>Příj. host</th>
                                                                                                        <th style={{ textAlign: 'left', padding: 6 }}>Příj. počet</th>
                                                                                                        <th style={{ textAlign: 'left', padding: 6 }}>Odj. pozn.</th>
                                                                                                        <th style={{ textAlign: 'left', padding: 6 }}>Příj. pozn.</th>
                                                                                                    </tr>
                                                                                                </thead>
                                                                                                <tbody>
                                                                                                    {visibleRows.length > 0 ? visibleRows.map((row, rowIndex) => (
                                                                                                        <tr key={`${job.id}-inline-row-${row.dateIso}-${row.roomNumber}-${rowIndex}`}>
                                                                                                            <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{formatPreviewRowDate(row.dateIso)}</td>
                                                                                                            <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.roomNumber || '—'}</td>
                                                                                                            <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.departureTime || '—'}</td>
                                                                                                            <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.arrivalTime || '—'}</td>
                                                                                                            <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.departureGuestName || '—'}</td>
                                                                                                            <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{typeof row.departureGuestCount === 'number' ? `${row.departureGuestCount}p` : '—'}</td>
                                                                                                            <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.arrivalGuestName || '—'}</td>
                                                                                                            <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{typeof row.arrivalGuestCount === 'number' ? `${row.arrivalGuestCount}p` : '—'}</td>
                                                                                                            <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.departureNotes.length ? row.departureNotes.join('; ') : '—'}</td>
                                                                                                            <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.arrivalNotes.length ? row.arrivalNotes.join('; ') : '—'}</td>
                                                                                                        </tr>
                                                                                                    )) : (
                                                                                                        <tr>
                                                                                                            <td colSpan={10} style={{ padding: 8, borderTop: '1px solid #e2e8f0', color: '#475569' }}>
                                                                                                                Náhled je dostupný, ale neobsahuje tabulkové řádky.
                                                                                                            </td>
                                                                                                        </tr>
                                                                                                    )}
                                                                                                </tbody>
                                                                                            </table>
                                                                                        </div>
                                                                                    </div>
                                                                                    {inlinePreviewModel.rows.length > 20 && (
                                                                                        <button
                                                                                            className="btn"
                                                                                            style={{ width: 'fit-content' }}
                                                                                            onClick={() => setExpandedImportJobPreviewRows((prev) => ({
                                                                                                ...prev,
                                                                                                [job.id]: !rowsExpanded
                                                                                            }))}
                                                                                        >
                                                                                            {rowsExpanded ? 'Zobrazit méně' : `Zobrazit vše (${inlinePreviewModel.rows.length})`}
                                                                                        </button>
                                                                                    )}
                                                                                </>
                                                                            ) : (
                                                                                <div style={{ fontSize: 12, color: '#991b1b', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 8 }}>
                                                                                    {inlinePreviewError || 'Náhled importu není dostupný. Zkuste náhled přegenerovat.'}
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            )
                                                        })}
                                                    </div>
                                                )}
                                            </div>

                                            <div className="room-card" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, marginTop: 8, border: '1px solid #dbeafe', background: '#f8fbff' }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                                    <div style={{ fontSize: 13, color: '#0c4a6e', fontWeight: 800 }}>Ruční import PDF (nouzově)</div>
                                                    <button
                                                        type="button"
                                                        className="btn"
                                                        onClick={() => setShowManualPrevioImportSection((prev) => !prev)}
                                                    >
                                                        {showManualPrevioImportSection ? 'Skrýt ruční import' : 'Zobrazit ruční import'}
                                                    </button>
                                                </div>
                                                <div className="room-meta" style={{ color: '#64748b' }}>
                                                    Použijte jen pokud nepřišel automatický e-mail z Previa nebo potřebujete testovat PDF.
                                                </div>

                                                {showManualPrevioImportSection && (
                                                    <>
                                                        <div className="room-card" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, border: '1px solid #bae6fd', background: '#f0f9ff' }}>
                                                            <label style={{ fontSize: 13, color: '#0c4a6e', fontWeight: 800 }}>Nahrát Stav (preferováno XLS/XLSX, fallback PDF)</label>
                                                            <div className="room-meta" style={{ color: '#0c4a6e' }}>XLS/XLSX je preferovaná cesta pro denní přehled, PDF zůstává jako fallback.</div>
                                                            <input
                                                                type="file"
                                                                accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/pdf,.pdf"
                                                                onChange={(e) => {
                                                                    const nextFile = e.target.files?.[0] || null
                                                                    void handlePrevioStateImportSelected(nextFile)
                                                                }}
                                                            />
                                                            {stateImportPdfStatus === 'loading' && <div className="room-meta">Načítám import Stav...</div>}
                                                            {stateImportPdfStatus === 'loaded' && <div className="room-meta" style={{ color: '#166534' }}>Import Stav načten</div>}
                                                            {stateImportPdfStatus === 'error' && <div className="room-meta" style={{ color: '#b91c1c' }}>{stateImportPdfError || 'Import Stav se nepodařilo načíst.'}</div>}
                                                        </div>

                                                        {stateImportPreviewForUi && (
                                                            <div className="room-card" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, marginTop: 8 }}>
                                                                <div style={{ fontWeight: 800 }}>Náhled importu Stav</div>
                                                                <div className="room-meta">Parser: {stateImportParserVersionForUi || 'neznámá verze'}</div>
                                                                <div className="room-meta">Detekované dny: {stateImportPreviewForUi.days.length}</div>
                                                                <div className="room-meta">Turnover pokoje: {stateImportPreviewForUi.turnoverCount}</div>
                                                                <div className="room-meta">Probíhající pobyty: {stateImportPreviewForUi.stayoverCount}</div>
                                                                <div className="room-meta">Odvozené potvrzeně volné pokoje: {stateImportPreviewForUi.derivedFreeCount}</div>
                                                                <div className="room-meta">Mimo seznam pokojů: {stateImportPreviewForUi.unknownRooms.length ? stateImportPreviewForUi.unknownRooms.join(', ') : 'žádné'}</div>
                                                                {stateImportSafetyForUi && (
                                                                    <div style={{ fontSize: 12, borderRadius: 8, padding: 8, border: stateImportSafetyForUi.blocked ? '1px solid #fecaca' : '1px solid #86efac', background: stateImportSafetyForUi.blocked ? '#fef2f2' : '#ecfdf3', color: stateImportSafetyForUi.blocked ? '#991b1b' : '#166534', fontWeight: 700 }}>
                                                                        {stateImportSafetyForUi.blocked ? 'Import je podezřelý – nepotvrzovat' : 'Kontrola importu: OK'}
                                                                        {(stateImportSafetyForUi.blocks.length > 0 || stateImportSafetyForUi.warnings.length > 0) && (
                                                                            <ul style={{ margin: '6px 0 0 16px', fontWeight: 500 }}>
                                                                                {Array.from(new Set([...stateImportSafetyForUi.blocks, ...stateImportSafetyForUi.warnings])).map((warning) => (
                                                                                    <li key={`state-safety-${warning}`}>{warning}</li>
                                                                                ))}
                                                                            </ul>
                                                                        )}
                                                                    </div>
                                                                )}
                                                                {stateImportActionMessage && (
                                                                    <div style={{ fontSize: 12, color: '#166534', background: '#ecfdf3', border: '1px solid #86efac', borderRadius: 8, padding: 8 }}>
                                                                        {stateImportActionMessage}
                                                                    </div>
                                                                )}
                                                                {stateImportWarningsForUi.length > 0 && (
                                                                    <div style={{ fontSize: 12, color: '#92400e', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: 8 }}>
                                                                        {stateImportWarningsForUi.slice(0, 10).map((warning) => (
                                                                            <div key={`state-warning-${warning}`}>{warning}</div>
                                                                        ))}
                                                                    </div>
                                                                )}

                                                                {selectedImportJobIsSuperseded && (
                                                                    <div style={{ fontSize: 12, color: '#9a3412', background: '#fff7ed', border: '1px solid #fdba74', borderRadius: 8, padding: 8, fontWeight: 700 }}>
                                                                        {IMPORT_CONFIRM_SUPERSEDED_MESSAGE}
                                                                    </div>
                                                                )}

                                                                {stateImportRawText && (
                                                                    <details>
                                                                        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Debug text Stav (PDF/XLSX)</summary>
                                                                        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                                                                            <button className="btn" onClick={() => void handleCopyStateImportDebugText()}>Kopírovat</button>
                                                                            <button className="btn" onClick={handleDownloadStateImportDebugText}>Stáhnout TXT</button>
                                                                        </div>
                                                                        <div className="room-meta" style={{ marginTop: 8 }}>
                                                                            Délka textu: {stateImportRawText.length} znaků, řádků: {stateImportParseResult?.lineCount || 0}
                                                                        </div>
                                                                        <pre style={{ marginTop: 8, maxHeight: 240, overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: 8, padding: 8, background: '#f8fafc', fontSize: 12, whiteSpace: 'pre-wrap' }}>
                                                                            {stateImportRawText.slice(0, 5000)}
                                                                        </pre>
                                                                    </details>
                                                                )}

                                                                <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: 8 }}>
                                                                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                                                        <thead>
                                                                            <tr style={{ background: '#f8fafc' }}>
                                                                                <th style={{ textAlign: 'left', padding: 6 }}>Den</th>
                                                                                <th style={{ textAlign: 'left', padding: 6 }}>Turnover</th>
                                                                                <th style={{ textAlign: 'left', padding: 6 }}>Probíhající</th>
                                                                                <th style={{ textAlign: 'left', padding: 6 }}>Volné (odvozené)</th>
                                                                                <th style={{ textAlign: 'left', padding: 6 }}>Kompletní</th>
                                                                            </tr>
                                                                        </thead>
                                                                        <tbody>
                                                                            {stateImportPreviewForUi.days.map((day) => (
                                                                                <tr key={`state-day-${day.dateIso}`}>
                                                                                    <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{day.dateLabel}</td>
                                                                                    <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{day.turnoverCount}</td>
                                                                                    <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{day.stayoverCount}</td>
                                                                                    <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{day.derivedFreeRooms.length}</td>
                                                                                    <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{day.complete ? 'ano' : 'ne'}</td>
                                                                                </tr>
                                                                            ))}
                                                                        </tbody>
                                                                    </table>
                                                                </div>

                                                                <div style={{ overflowX: 'auto', border: '1px solid #dbeafe', borderRadius: 8, background: '#fff' }}>
                                                                    <div style={{ maxHeight: 280, overflow: 'auto' }}>
                                                                        <table style={{ width: '100%', minWidth: 860, borderCollapse: 'collapse', fontSize: 12 }}>
                                                                            <thead>
                                                                                <tr style={{ background: '#f8fafc' }}>
                                                                                    <th style={{ textAlign: 'left', padding: 6 }}>Den</th>
                                                                                    <th style={{ textAlign: 'left', padding: 6 }}>Pokoj</th>
                                                                                    <th style={{ textAlign: 'left', padding: 6 }}>Odjezd</th>
                                                                                    <th style={{ textAlign: 'left', padding: 6 }}>Příjezd</th>
                                                                                    <th style={{ textAlign: 'left', padding: 6 }}>Odj. host</th>
                                                                                    <th style={{ textAlign: 'left', padding: 6 }}>Odj. počet</th>
                                                                                    <th style={{ textAlign: 'left', padding: 6 }}>Příj. host</th>
                                                                                    <th style={{ textAlign: 'left', padding: 6 }}>Příj. počet</th>
                                                                                    <th style={{ textAlign: 'left', padding: 6 }}>Odj. pozn.</th>
                                                                                    <th style={{ textAlign: 'left', padding: 6 }}>Příj. pozn.</th>
                                                                                </tr>
                                                                            </thead>
                                                                            <tbody>
                                                                                {stateImportPreviewForUi.days.flatMap((day) => (
                                                                                    day.rows.map((row, index) => (
                                                                                        <tr key={`state-detail-${day.dateIso}-${row.roomNumber}-${index}`}>
                                                                                            <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{formatPreviewRowDate(day.dateIso)}</td>
                                                                                            <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.roomNumber}</td>
                                                                                            <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.departureTime || '—'}</td>
                                                                                            <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.arrivalTime || '—'}</td>
                                                                                            <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.departureGuestName || (row.isStayover ? row.stayoverGuestName || '—' : '—')}</td>
                                                                                            <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{typeof row.departureGuestCount === 'number' ? `${row.departureGuestCount}p` : '—'}</td>
                                                                                            <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.arrivalGuestName || '—'}</td>
                                                                                            <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{typeof row.arrivalGuestCount === 'number' ? `${row.arrivalGuestCount}p` : '—'}</td>
                                                                                            <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.departureNotes.length ? row.departureNotes.join('; ') : '—'}</td>
                                                                                            <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.arrivalNotes.length ? row.arrivalNotes.join('; ') : '—'}</td>
                                                                                        </tr>
                                                                                    ))
                                                                                ))}
                                                                            </tbody>
                                                                        </table>
                                                                    </div>
                                                                </div>

                                                                <div style={{ display: 'flex', gap: 8 }}>
                                                                    <button
                                                                        className="btn"
                                                                        disabled={stateImportBlockedForUi || selectedImportJobIsSuperseded}
                                                                        onClick={() => {
                                                                            if (selectedImportJob?.id) {
                                                                                void handleConfirmImportJob(selectedImportJob.id)
                                                                                return
                                                                            }
                                                                            void handleConfirmPrevioStateImport()
                                                                        }}
                                                                    >
                                                                        Potvrdit import Stav
                                                                    </button>
                                                                    <button className="btn" onClick={handleCancelPrevioStateImport}>Zrušit</button>
                                                                </div>
                                                            </div>
                                                        )}

                                                        <div className="room-card" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                                                            <label style={{ fontSize: 13, color: '#334155', fontWeight: 700 }}>Nahrát PDF příjezdy/odjezdy</label>
                                                            <input
                                                                type="file"
                                                                accept="application/pdf,.pdf"
                                                                onChange={(e) => {
                                                                    const nextFile = e.target.files?.[0] || null
                                                                    void handlePrevioPdfSelected(nextFile)
                                                                }}
                                                            />
                                                            {importPdfStatus === 'loading' && <div className="room-meta">Načítám PDF...</div>}
                                                            {importPdfStatus === 'loaded' && <div className="room-meta" style={{ color: '#166534' }}>PDF načteno</div>}
                                                            {importPdfStatus === 'error' && <div className="room-meta" style={{ color: '#b91c1c' }}>{importPdfError || 'PDF se nepodařilo načíst.'}</div>}
                                                        </div>

                                                        {importPreview && (
                                                            <div className="room-card" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, marginTop: 8 }}>
                                                                <div style={{ fontWeight: 800 }}>Náhled importu</div>
                                                                <div className="room-meta">Počet rozpoznaných řádků: {importPreview.parsedRows}</div>
                                                                <div className="room-meta">Řádků bez času: {importPreview.rowsWithoutTimes}</div>
                                                                <div className="room-meta">Mimo seznam pokojů: {importPreview.unknownRooms.length ? importPreview.unknownRooms.join(', ') : 'žádné'}</div>
                                                                <div className="room-meta">Bez příjezdu/odjezdu: {importPreview.noTurnoverRooms.length}</div>
                                                                {importPreview.confidenceLow && (
                                                                    <div style={{ fontSize: 12, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 8, fontWeight: 700 }}>
                                                                        Import není bezpečný – parser našel málo pokojů nebo příliš mnoho řádků bez času. Import nepotvrzovat.
                                                                    </div>
                                                                )}
                                                                {importPreview.warnings.length > 0 && (
                                                                    <div style={{ fontSize: 12, color: '#92400e', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: 8 }}>
                                                                        {importPreview.warnings.slice(0, 8).map((warning) => (
                                                                            <div key={warning}>{warning}</div>
                                                                        ))}
                                                                    </div>
                                                                )}

                                                                {importRawText && (
                                                                    <details>
                                                                        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Debug text z PDF</summary>
                                                                        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                                                                            <button className="btn" onClick={() => void handleCopyImportDebugText()}>Kopírovat</button>
                                                                            <button className="btn" onClick={handleDownloadImportDebugText}>Stáhnout TXT</button>
                                                                        </div>
                                                                        <div className="room-meta" style={{ marginTop: 8 }}>
                                                                            Délka textu: {importRawText.length} znaků, řádků: {importParseResult?.lineCount || 0}
                                                                        </div>
                                                                        <pre style={{ marginTop: 8, maxHeight: 240, overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: 8, padding: 8, background: '#f8fafc', fontSize: 12, whiteSpace: 'pre-wrap' }}>
                                                                            {importRawText.slice(0, 5000)}
                                                                        </pre>
                                                                    </details>
                                                                )}

                                                                {importParseResult && (
                                                                    <details>
                                                                        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Debug parseru</summary>
                                                                        <div style={{ marginTop: 8, maxHeight: 280, overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: 8, padding: 8, background: '#f8fafc', fontSize: 12 }}>
                                                                            {importParseResult.lineDebug.map((dbg) => (
                                                                                <div key={`dbg-${dbg.index}-${dbg.room || 'none'}`} style={{ borderBottom: '1px solid #e2e8f0', paddingBottom: 6, marginBottom: 6 }}>
                                                                                    <div><strong>Blok {dbg.index}:</strong> Strana: {dbg.page} | Den: {dbg.pageDate || '—'} | Pokoj: {dbg.room || '—'} | Předchozí: {dbg.previousRoom || '—'} | Následující: {dbg.nextRoom || '—'} | Rozsah řádků: {dbg.blockStartLine}-{dbg.blockEndLine} | Y: {dbg.yStart.toFixed(1)} → {dbg.yEnd.toFixed(1)}</div>
                                                                                    <div>Detekované časy: {dbg.detectedTimes.length ? dbg.detectedTimes.join(', ') : '—'} | Odjezd: {dbg.departureTime || '—'} | Příjezd: {dbg.arrivalTime || '—'}</div>
                                                                                    <div>Odjezd host: {dbg.departureGuestLabel || '—'} | Příjezd host: {dbg.arrivalGuestLabel || '—'}</div>
                                                                                    <div>Sloupec pokoj: {dbg.roomColumnText || '—'}</div>
                                                                                    <div>Sloupec odjezd: {dbg.departureColumnText || '—'}</div>
                                                                                    <div>Sloupec příjezd: {dbg.arrivalColumnText || '—'}</div>
                                                                                    <div>Sloupec odjezd pozn.: {dbg.departureNoteColumnText || '—'}</div>
                                                                                    <div>Sloupec příjezd pozn.: {dbg.arrivalNoteColumnText || '—'}</div>
                                                                                    <div>Skupiny poznámek: {dbg.noteGroups.length ? dbg.noteGroups.join(' || ') : '—'}</div>
                                                                                    <div>Odjezd pozn.: {dbg.departureNotes.length ? dbg.departureNotes.join(', ') : '—'}</div>
                                                                                    <div>Příjezd pozn.: {dbg.arrivalNotes.length ? dbg.arrivalNotes.join(', ') : '—'}</div>
                                                                                    <div>Obecné pozn.: {dbg.generalNotes.length ? dbg.generalNotes.join(', ') : '—'}</div>
                                                                                    <div>Varování: {dbg.warnings.length ? dbg.warnings.join(' | ') : '—'}</div>
                                                                                    <pre style={{ marginTop: 6, maxHeight: 120, overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: 6, padding: 6, background: '#fff', whiteSpace: 'pre-wrap' }}>{dbg.rawBlock}</pre>
                                                                                </div>
                                                                            ))}
                                                                        </div>
                                                                    </details>
                                                                )}

                                                                <div style={{ maxHeight: 240, overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: 8 }}>
                                                                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                                                        <thead>
                                                                            <tr style={{ background: '#f8fafc' }}>
                                                                                <th style={{ textAlign: 'left', padding: 6 }}>Datum</th>
                                                                                <th style={{ textAlign: 'left', padding: 6 }}>Pokoj</th>
                                                                                <th style={{ textAlign: 'left', padding: 6 }}>Odjezd</th>
                                                                                <th style={{ textAlign: 'left', padding: 6 }}>Příjezd</th>
                                                                                <th style={{ textAlign: 'left', padding: 6 }}>Odj. host</th>
                                                                                <th style={{ textAlign: 'left', padding: 6 }}>Příj. host</th>
                                                                                <th style={{ textAlign: 'left', padding: 6 }}>Odjezd pozn.</th>
                                                                                <th style={{ textAlign: 'left', padding: 6 }}>Příjezd pozn.</th>
                                                                                <th style={{ textAlign: 'left', padding: 6 }}>Obecné pozn.</th>
                                                                            </tr>
                                                                        </thead>
                                                                        <tbody>
                                                                            {importPreview.previewRows.map((row) => (
                                                                                <tr key={`${row.tab}-${row.roomNumber}-${row.departureTime || '-'}-${row.arrivalTime || '-'}`}>
                                                                                    <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.dateLabel}</td>
                                                                                    <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.roomNumber}</td>
                                                                                    <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.departureTime || '—'}</td>
                                                                                    <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.arrivalTime || '—'}</td>
                                                                                    <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.departureGuestName || '—'}</td>
                                                                                    <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.arrivalGuestName || '—'}</td>
                                                                                    <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.departureNotesLabel || '—'}</td>
                                                                                    <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.arrivalNotesLabel || '—'}</td>
                                                                                    <td style={{ padding: 6, borderTop: '1px solid #e2e8f0' }}>{row.generalNotesLabel || '—'}</td>
                                                                                </tr>
                                                                            ))}
                                                                        </tbody>
                                                                    </table>
                                                                </div>

                                                                <div style={{ display: 'flex', gap: 8 }}>
                                                                    <button className="btn" disabled={importPreview.confidenceLow} onClick={() => void handleConfirmPrevioImport()}>Potvrdit import</button>
                                                                    <button className="btn" onClick={handleCancelPrevioImport}>Zrušit</button>
                                                                </div>
                                                            </div>
                                                        )}
                                                    </>
                                                )}
                                            </div>

                                            <h3 style={{ marginTop: 14 }}>Údržba dat / Nebezpečné akce</h3>

                                            <div className="room-card" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, marginTop: 8 }}>
                                                <div style={{ fontSize: 13, color: '#334155', fontWeight: 700 }}>Údržba úkolů</div>
                                                {!cleanupConfirm ? (
                                                    <button className="btn danger" style={{ width: 'fit-content' }} onClick={() => setCleanupConfirm(true)}>Vyčistit testovací úkoly</button>
                                                ) : (
                                                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                                        <button className="btn danger" onClick={handleCleanupTestTasks}>Opravdu vyčistit?</button>
                                                        <button className="btn" onClick={() => setCleanupConfirm(false)}>Zrušit</button>
                                                    </div>
                                                )}
                                                {cleanupResult && <div className="room-meta" style={{ color: '#475569' }}>{cleanupResult}</div>}
                                            </div>

                                            <div className="room-card" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, marginTop: 8, border: '1px solid #fecaca', background: '#fff7f7' }}>
                                                <div style={{ fontSize: 13, color: '#7f1d1d', fontWeight: 700 }}>Údržba plánu pokojů</div>
                                                <div className="room-meta" style={{ color: '#7f1d1d' }}>Vyčistí staré demo rezervace a stavy pokojů před novým importem Stav. Úkoly, nákupy a údržba zůstanou beze změny.</div>
                                                {!planCleanupConfirm ? (
                                                    <button className="btn danger" style={{ width: 'fit-content' }} onClick={() => setPlanCleanupConfirm(true)}>Vyčistit plán pokojů</button>
                                                ) : (
                                                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                                        <button className="btn danger" onClick={handleClearDemoPlan}>Opravdu vyčistit plán?</button>
                                                        <button className="btn" onClick={() => setPlanCleanupConfirm(false)}>Zrušit</button>
                                                    </div>
                                                )}
                                                {planCleanupResult && <div className="room-meta" style={{ color: '#475569' }}>{planCleanupResult}</div>}
                                            </div>

                                            {enableDangerousReset && (
                                                <div className="room-card" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, marginTop: 8, border: '1px solid #fca5a5', background: '#fff1f2' }}>
                                                    <div style={{ fontSize: 13, color: '#991b1b', fontWeight: 800 }}>Nebezpečné akce</div>
                                                    <div className="room-meta" style={{ color: '#991b1b' }}>
                                                        Používejte jen při podpoře nebo vývoji. Akce může změnit data ve Firebase.
                                                    </div>
                                                    <button className="btn danger" style={{ width: 'fit-content' }} onClick={() => void handleDangerousReset()}>
                                                        {runtimeMode === 'online' ? 'Reset online dat' : 'Reset demo dat'}
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </>
                            )}
                            {view === 'maintenance' && (
                                <MaintenanceView
                                    role={(effectiveRole || 'cleaner') as UserRole}
                                    currentUserId={userId}
                                    t={t}
                                    maintenanceItems={maintenanceItems}
                                    tasks={maintenanceTasks}
                                    onCreateMaintenance={handleCreateMaintenanceItem}
                                    onCreateSelfTask={handleCreateMaintenanceSelfTask}
                                    onUpdateMaintenance={handleUpdateMaintenanceItem}
                                    onMaterialNeeded={handleMaterialNeeded}
                                    onAcknowledgeTask={handleAcknowledgeMaintenanceTask}
                                    onAcknowledgeMaintenanceItem={handleAcknowledgeMaintenanceItem}
                                    onTaskAction={handleMaintenanceTaskAction}
                                    onRequestMaterial={handleRequestMaterial}
                                    onJumpToRoom={handleJumpToRoomFromMaintenance}
                                    focusRequest={maintenanceFocusRequest}
                                    onFocusResult={handleMaintenanceFocusResult}
                                />
                            )}
                            {view === 'supplies' && (
                                <SuppliesView
                                    userName={currentUser?.name || 'Uživatel'}
                                    role={(effectiveRole || 'cleaner') as UserRole}
                                    t={t}
                                    requests={visibleSupplies}
                                    customChips={customSupplyChips}
                                    onCreateRequest={handleCreateSupplyRequest}
                                    onSaveCustomChip={handleSaveCustomSupplyChip}
                                    onCancelRequest={handleCancelSupplyRequest}
                                    onSetRequestStatus={handleSetSupplyRequestStatus}
                                />
                            )}
                        </div>

                        {unacknowledgedLateTodayCount > 0 && (
                            <button
                                type="button"
                                className="late-task-fab"
                                style={unacknowledgedMaintenanceCount > 0 ? { top: 'calc(84px + env(safe-area-inset-top))' } : undefined}
                                onClick={handleJumpToLateTaskRoom}
                                title="Přejít na nový úkol po kontrole"
                                aria-label="Přejít na nový úkol po kontrole"
                            >
                                {unacknowledgedLateTodayCount === 1
                                    ? '1 nový úkol'
                                    : `${unacknowledgedLateTodayCount} nových úkolů`}
                            </button>
                        )}

                        {(unacknowledgedMaintenanceCount > 0 && (isMaintenanceRole(currentUser?.role) || isAdminUser)) && (
                            <button
                                type="button"
                                className="maintenance-task-fab"
                                style={unacknowledgedLateTodayCount > 0 ? { top: 'calc(136px + env(safe-area-inset-top))' } : undefined}
                                onClick={handleJumpToMaintenanceAttention}
                                title="Přejít na nový úkol údržby"
                                aria-label="Přejít na nový úkol údržby"
                            >
                                {unacknowledgedMaintenanceCount === 1
                                    ? '1 nový problém'
                                    : `${unacknowledgedMaintenanceCount} úkolů údržby`}
                            </button>
                        )}
                    </>
                )}
            </div>
        </div>
    )
}
