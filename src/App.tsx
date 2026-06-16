import React, { useMemo, useState, useEffect } from 'react'
import type { User } from 'firebase/auth'
import { collection, doc, getDoc, getDocs, setDoc } from 'firebase/firestore'
import { RoleSwitch } from './components/RoleSwitch'
import DashboardToday from './pages/DashboardToday'
import AdminDashboard from './pages/AdminDashboard'
import MaintenanceView from './pages/MaintenanceView'
import SuppliesView from './pages/SuppliesView'
import { roomPlansByDay, users, supplyRequests as initialSupplyRequests, maintenanceItems as initialMaintenanceItems } from './mockData'
import { MaintenanceItem, RoomPlan, SupplyRequest, Task, UserRole } from './types'
import {
    appMode,
    firebaseEnvDiagnostics,
    firestoreDb,
    onFirebaseAuthState,
    signInWithEmailPassword,
    signOutFirebaseUser
} from './lib/firebase'
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
    extractStateTextFromPdfFile,
    MASTER_ROOM_NUMBERS,
    parsePrevioStatePdfText,
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

type RoomAction = 'prevzit' | 'odhad' | 'hotovo' | 'problem' | 'host_zustava' | 'clear_exception'

type RoomActionPayload = {
    estimateTime?: string
    relativeMinutes?: number
}

type CreateTaskInput = {
    title: string
    category: Task['category']
    priority: Task['priority']
    assignedToRole: Extract<UserRole, 'lead' | 'cleaner' | 'maintenance'>
    note?: string
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

function isCleaningDomain(category: SupplyRequest['category']) {
    return category !== 'maintenance'
}

function canViewTask(role: UserRole, task: Task) {
    if (role === 'admin') return true
    if (role === 'lead') return task.category === 'cleaning' || task.assignedToRole === 'lead'
    if (role === 'cleaner') return task.category === 'cleaning' || task.assignedToRole === 'cleaner'
    if (role === 'maintenance') return task.assignedToRole === 'maintenance'
    return false
}

function defaultAssigneeName(role: Task['assignedToRole']) {
    if (role === 'lead') return 'Iryna'
    if (role === 'cleaner') return 'Uklízečka'
    if (role === 'maintenance') return 'Údržbář'
    return undefined
}

function roleLabel(role: UserRole) {
    if (role === 'admin') return 'Admin'
    if (role === 'lead') return 'Iryna'
    if (role === 'cleaner') return 'Úklid'
    return 'Údržba'
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

export default function App() {
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
        tasks: [],
        supplyRequests: initialSupplyRequests,
        maintenanceItems: initialMaintenanceItems,
        customSupplyChips: [],
        staff: users
    }), [])

    const saved = typeof window !== 'undefined'
        ? (appMode === 'online' ? null : localStore.loadInitialState())
        : null

    const [userId, setUserId] = useState<string>(saved?.userId ?? 'david')
    const [tab, setTab] = useState<'Dnes' | 'Zitra' | 'Pozitri'>(saved?.tab ?? 'Dnes')
    const [view, setView] = useState<'today' | 'admin' | 'maintenance' | 'supplies'>(saved?.view ?? 'today')
    const [roomsByDay, setRoomsByDay] = useState(() => saved?.roomsByDay ?? roomPlansByDay)
    const [tasks, setTasks] = useState<Task[]>(() => saved?.tasks ?? [])
    const [supplyRequests, setSupplyRequests] = useState<SupplyRequest[]>(() => saved?.supplyRequests ?? initialSupplyRequests)
    const [maintenanceItems, setMaintenanceItems] = useState<MaintenanceItem[]>(() => saved?.maintenanceItems ?? initialMaintenanceItems)
    const [customSupplyChips, setCustomSupplyChips] = useState<string[]>(() => saved?.customSupplyChips ?? [])
    const [staff, setStaff] = useState<StaffMember[]>(() => saved?.staff ?? users)
    const [resetConfirm, setResetConfirm] = useState(false)
    const [roomCatalog, setRoomCatalog] = useState<RoomCatalogItem[]>(() => getDefaultRoomCatalog())
    const [importPdfStatus, setImportPdfStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
    const [importPdfError, setImportPdfError] = useState<string | null>(null)
    const [importPreview, setImportPreview] = useState<PrevioImportPreview | null>(null)
    const [importRawText, setImportRawText] = useState('')
    const [importParseResult, setImportParseResult] = useState<PrevioParseResult | null>(null)
    const [stateImportPdfStatus, setStateImportPdfStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
    const [stateImportPdfError, setStateImportPdfError] = useState<string | null>(null)
    const [stateImportPreview, setStateImportPreview] = useState<PrevioStateImportPreview | null>(null)
    const [stateImportRawText, setStateImportRawText] = useState('')
    const [stateImportParseResult, setStateImportParseResult] = useState<PrevioStateParseResult | null>(null)
    const [importedTabDates, setImportedTabDates] = useState<Partial<Record<OpsTab, string>>>({})
    const [importedRoomsByDate, setImportedRoomsByDate] = useState<Record<string, typeof roomPlansByDay[OpsTab]>>({})
    const [selectedImportedDateIso, setSelectedImportedDateIso] = useState<string | null>(null)
    const [cleanupConfirm, setCleanupConfirm] = useState(false)
    const [cleanupResult, setCleanupResult] = useState<string | null>(null)
    const [planCleanupConfirm, setPlanCleanupConfirm] = useState(false)
    const [planCleanupResult, setPlanCleanupResult] = useState<string | null>(null)

    const activeStore = runtimeMode === 'online' ? onlineStore : localStore

    const activeRooms = useMemo(
        () => roomCatalog.filter((room) => room.active).sort((a, b) => a.sortOrder - b.sortOrder),
        [roomCatalog]
    )

    const currentUser = runtimeMode === 'online'
        ? (staff.find((u) => u.id === userId) || onlineProfile || null)
        : (users.find((u) => u.id === userId) || null)

    const dayTitle = tab === 'Dnes' ? 'Dnes' : tab === 'Zitra' ? 'Zítra' : 'Pozítří'
    const tabOffsetDays = tab === 'Dnes' ? 0 : tab === 'Zitra' ? 1 : 2
    const fallbackTabDate = new Date(Date.now() + tabOffsetDays * 24 * 60 * 60 * 1000)
    const selectedTabDateIso = importedTabDates[tab] || fallbackTabDate.toISOString().slice(0, 10)
    const selectedTabDate = new Date(selectedTabDateIso)
    const isExtraImportedDay = Boolean(selectedImportedDateIso && importedRoomsByDate[selectedImportedDateIso])
    const effectiveDateIso = selectedImportedDateIso && importedRoomsByDate[selectedImportedDateIso]
        ? selectedImportedDateIso
        : selectedTabDateIso
    const effectiveDate = new Date(effectiveDateIso)
    const showOrientationNote = tab !== 'Dnes' || isExtraImportedDay
    const dayLabelPrefix = isExtraImportedDay ? 'Další den' : dayTitle
    const dayLabel = `${dayLabelPrefix} • ${effectiveDate.toLocaleDateString('cs-CZ', { weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric' })}`
    const displayedRooms = selectedImportedDateIso && importedRoomsByDate[selectedImportedDateIso]
        ? importedRoomsByDate[selectedImportedDateIso]
        : roomsByDay[tab]

    const dateSelectorItems = useMemo(() => {
        const primaryTabs: Array<{ tab: OpsTab; label: string }> = [
            { tab: 'Dnes', label: 'Dnes' },
            { tab: 'Zitra', label: 'Zítra' },
            { tab: 'Pozitri', label: 'Pozítří' }
        ]

        const primaryDateSet = new Set(
            primaryTabs
                .map(({ tab }) => importedTabDates[tab])
                .filter((dateIso): dateIso is string => Boolean(dateIso))
        )

        const extraImportedDates = Object.keys(importedRoomsByDate)
            .filter((dateIso) => !primaryDateSet.has(dateIso))
            .sort()

        const primaryItems = primaryTabs.map(({ tab: tabKey, label }) => ({
            key: `tab-${tabKey}`,
            label,
            kind: 'tab' as const,
            tab: tabKey,
            active: !selectedImportedDateIso && tabKey === tab
        }))

        const extraItems = extraImportedDates.map((dateIso) => ({
            key: `date-${dateIso}`,
            label: new Date(`${dateIso}T00:00:00`).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' }),
            kind: 'date' as const,
            dateIso,
            active: selectedImportedDateIso === dateIso
        }))

        return [...primaryItems, ...extraItems]
    }, [importedRoomsByDate, importedTabDates, selectedImportedDateIso, tab])

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

    const stateImportBlockedByMissingDays = statePreviewMissingDates.length > 0

    const visibleTodayTasks = useMemo(
        () => tasks.filter((task) => canViewTask((currentUser?.role || 'cleaner') as UserRole, task)),
        [tasks, currentUser?.role]
    )

    const maintenanceTasks = useMemo(
        () => tasks.filter((task) => task.assignedToRole === 'maintenance'),
        [tasks]
    )

    const visibleSupplies = useMemo(() => {
        const role = (currentUser?.role || 'cleaner') as UserRole
        // Always hide cancelled requests from visible lists
        if (role === 'admin') return supplyRequests.filter((s) => s.status !== 'cancelled')
        if (role === 'lead' || role === 'cleaner') {
            return supplyRequests.filter((s) => s.status !== 'cancelled' && (s.category !== 'maintenance' || s.requestedByRole === role))
        }
        if (role === 'maintenance') {
            return supplyRequests.filter((s) => s.status !== 'cancelled' && (s.category === 'maintenance' || s.requestedByRole === 'maintenance'))
        }
        return supplyRequests.filter((s) => s.status !== 'cancelled')
    }, [supplyRequests, currentUser?.role])

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

    async function handlePrevioStatePdfSelected(file: File | null) {
        if (!file) return
        const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
        if (!isPdf) {
            setStateImportPdfStatus('error')
            setStateImportPdfError('Soubor musí být ve formátu PDF.')
            setStateImportPreview(null)
            setStateImportRawText('')
            setStateImportParseResult(null)
            return
        }

        setStateImportPdfStatus('loading')
        setStateImportPdfError(null)
        setStateImportPreview(null)
        setStateImportRawText('')
        setStateImportParseResult(null)

        try {
            const extracted = await extractStateTextFromPdfFile(file)
            const parsed = parsePrevioStatePdfText(extracted.rawText, new Date())
            const preview = buildPrevioStateImportPreview(parsed, activeRooms, new Date())
            setStateImportPreview(preview)
            setStateImportRawText(extracted.rawText)
            setStateImportParseResult(parsed)
            setStateImportPdfStatus('loaded')
        } catch (error: any) {
            setStateImportPdfStatus('error')
            setStateImportPdfError(error?.message || 'PDF Stav se nepodařilo načíst.')
            setStateImportPreview(null)
            setStateImportRawText('')
            setStateImportParseResult(null)
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

    function roomIdForNumber(roomNumber: string) {
        return `r${roomNumber}`
    }

    function extractArrivalBoxFromNotes(notes?: string[]) {
        if (!notes || notes.length === 0) return undefined
        const match = notes.join(' ').match(/\bbox\s*([a-z0-9-]+)/i)
        if (!match) return undefined
        return `BOX ${match[1].toUpperCase()}`
    }

    function sameGuestLabel(left?: string, right?: string) {
        return normalizeTaskTitleForCleanup(left || '') === normalizeTaskTitleForCleanup(right || '')
    }

    function shouldPreserveTurnoverOperationalState(base: RoomPlan | undefined, parsed: StateImportDayRow, mergedSituation: RoomPlan['situation']) {
        if (!base) return false
        if (base.stateSource !== 'previo-state-pdf') return false
        if (base.situation !== mergedSituation) return false
        if ((base.departureTime || '') !== (parsed.departureTime || '')) return false
        if ((base.arrivalTime || '') !== (parsed.arrivalTime || '')) return false

        const baseDepartureGuest = base.departure?.guestLabel
        const baseArrivalGuest = base.arrival?.guestLabel

        if (!sameGuestLabel(baseDepartureGuest, parsed.departureGuestName)) return false
        if (!sameGuestLabel(baseArrivalGuest, parsed.arrivalGuestName)) return false

        return true
    }

    function buildImportedBaseRow(base: RoomPlan | undefined, roomNumber: string, displayName: string | undefined, importedAt: string): RoomPlan {
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
            stayoverGuestName: undefined,
            stayoverUntil: undefined
        }
    }

    function buildRoomsForStateDay(dateIso: string, dayPreview: PrevioStateImportPreview['days'][number], importedAt: string) {
        const existingTabs = ['Dnes', 'Zitra', 'Pozitri'] as OpsTab[]
        const currentTabDate = existingTabs.find((day) => importedTabDates[day] === dateIso)
        const sourceRooms = importedRoomsByDate[dateIso] || (currentTabDate ? roomsByDay[currentTabDate] : roomsByDay.Dnes)
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
            const row = buildImportedBaseRow(base, roomNumber, catalogRoom?.displayName || catalogRoom?.roomNumber, importedAt)

            if (!parsed) {
                return {
                    ...row,
                    freeConfirmed: Boolean(dayPreview.complete && dayPreview.derivedFreeRooms.includes(roomNumber))
                }
            }

            const hasDeparture = Boolean(parsed.departureTime)
            const hasArrival = Boolean(parsed.arrivalTime)
            if (!hasDeparture && !hasArrival) {
                return {
                    ...row,
                    occupiedConfirmed: true,
                    stayoverGuestName: parsed.stayoverGuestName || parsed.departureGuestName || parsed.arrivalGuestName,
                    stayoverUntil: parsed.stayoverUntil
                }
            }

            const mergedSituation = hasDeparture && hasArrival
                ? 'odjezd_prijezd'
                : hasDeparture
                    ? 'odjezd'
                    : 'prijezd'

            const preserveOperationalState = shouldPreserveTurnoverOperationalState(base, parsed, mergedSituation)
            const departureNotes = parsed.departureNotes.length ? parsed.departureNotes : undefined
            const arrivalNotes = parsed.arrivalNotes.length ? parsed.arrivalNotes : undefined
            const arrivalBox = extractArrivalBoxFromNotes(arrivalNotes)

            return {
                ...row,
                situation: mergedSituation,
                departure: hasDeparture ? {
                    time: parsed.departureTime as string,
                    guestLabel: parsed.departureGuestName,
                    notes: departureNotes
                } : undefined,
                arrival: hasArrival ? {
                    time: parsed.arrivalTime as string,
                    guestLabel: parsed.arrivalGuestName,
                    box: arrivalBox,
                    notes: arrivalNotes
                } : undefined,
                departureTime: parsed.departureTime,
                arrivalTime: parsed.arrivalTime,
                box: arrivalBox,
                status: preserveOperationalState ? (base?.status || 'ceka') : 'ceka',
                assigned: preserveOperationalState ? base?.assigned : undefined,
                estimatedReady: preserveOperationalState ? base?.estimatedReady : undefined,
                estimateSetAt: preserveOperationalState ? base?.estimateSetAt : undefined,
                statusNote: preserveOperationalState ? base?.statusNote : undefined,
                checkoutException: preserveOperationalState ? Boolean(base?.checkoutException) : false
            }
        })
    }

    function buildMergedPlansFromStateImport(preview: PrevioStateImportPreview, importedAt: string) {
        const next: Record<OpsTab, typeof roomsByDay[OpsTab]> = {
            Dnes: [],
            Zitra: [],
            Pozitri: []
        }

        const byDate: Record<string, typeof roomsByDay[OpsTab]> = {}

        preview.days.forEach((day) => {
            byDate[day.dateIso] = buildRoomsForStateDay(day.dateIso, day, importedAt)
        })

            ; (['Dnes', 'Zitra', 'Pozitri'] as OpsTab[]).forEach((day) => {
                const dateIso = preview.parsedTabDates[day]
                if (!dateIso || !byDate[dateIso]) {
                    next[day] = roomsByDay[day]
                    return
                }
                next[day] = byDate[dateIso]
            })

        return { next, byDate }
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
        if (!stateImportPreview || stateImportPreview.confidenceLow || stateImportBlockedByMissingDays) return
        const importedAt = formatImportTimestamp(new Date())
        const { next, byDate } = buildMergedPlansFromStateImport(stateImportPreview, importedAt)
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
        }

        setStateImportPreview(null)
        setStateImportPdfStatus('idle')
        setStateImportPdfError(null)
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
        setStateImportRawText('')
        setStateImportParseResult(null)
    }

    function handleRoleChange(nextUserId: string) {
        if (runtimeMode === 'online') return
        const nextUser = users.find((u) => u.id === nextUserId)
        setUserId(nextUserId)

        if (nextUser?.role === 'maintenance') {
            setView('maintenance')
        } else if (view === 'maintenance') {
            setView('today')
        }
    }

    function formatNowHHmm(date = new Date()) {
        return date.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hour12: false })
    }

    function addMinutes(base: Date, minutes: number) {
        const next = new Date(base.getTime() + minutes * 60 * 1000)
        return formatNowHHmm(next)
    }

    function handleAction(id: string, action: RoomAction, payload?: RoomActionPayload) {
        const assignedName = currentUser?.name
        const now = new Date()
        const setAt = formatNowHHmm(now)
        const computedEstimate = payload?.estimateTime
            ? payload.estimateTime
            : typeof payload?.relativeMinutes === 'number'
                ? addMinutes(now, payload.relativeMinutes)
                : undefined

        let patch: Partial<any> = {}
        if (action === 'hotovo') patch = { status: 'hotovo' }
        if (action === 'prevzit') patch = { status: 'prevzato', assigned: assignedName }
        if (action === 'odhad') patch = { status: 'odhad', estimatedReady: computedEstimate || '12:30', estimateSetAt: setAt, assigned: assignedName }
        if (action === 'problem') patch = { status: 'problem', statusNote: 'Problém nahlášen' }
        if (action === 'host_zustava') patch = { status: 'problem', statusNote: 'Host neodešel', checkoutException: true }
        if (action === 'clear_exception') patch = { checkoutException: false, statusNote: undefined, status: 'ceka' }
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
                        statusNote: r.checkoutException ? r.statusNote : undefined
                    }
                }
                if (action === 'prevzit') {
                    return {
                        ...r,
                        status: 'prevzato',
                        assigned: assignedName || r.assigned,
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
                        statusNote: r.checkoutException ? r.statusNote : undefined
                    }
                }
                if (action === 'problem') {
                    return {
                        ...r,
                        status: 'problem',
                        statusNote: 'Problém nahlášen'
                    }
                }
                if (action === 'host_zustava') {
                    // TODO: Here we can trigger push notification to admin in future backend integration.
                    return {
                        ...r,
                        status: 'problem',
                        statusNote: 'Host neodešel',
                        checkoutException: true
                    }
                }
                if (action === 'clear_exception') {
                    return {
                        ...r,
                        checkoutException: false,
                        statusNote: r.statusNote === 'Host neodešel' ? undefined : r.statusNote,
                        status: r.status === 'problem' ? 'ceka' : r.status
                    }
                }
                return r
            })
        }))
    }

    function handleUpdateTaskStatus(taskId: string, status: Task['status']) {
        if (runtimeMode === 'online') {
            activeStore.updateTaskStatus(taskId, status)
        }
        setTasks((prev) => prev.map((task) => (task.id === taskId ? { ...task, status } : task)))
    }

    function handleCreateTask(roomId: string, input: CreateTaskInput) {
        const room = roomsByDay[tab].find((r) => r.id === roomId)
        if (!room || !currentUser) return

        const createdAt = formatNowHHmm(new Date())
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
            createdAt
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
                createdAt: newTask.createdAt
            })
        }

        setTasks((prev) => [newTask, ...prev])
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
                stayoverUntil: undefined
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
        if (runtimeMode === 'online') {
            activeStore.updateTaskStatus(taskId, action)
        }
        setTasks((prev) =>
            prev.map((task) => {
                if (task.id !== taskId) return task
                return {
                    ...task,
                    status: action,
                    assignedToName: currentUser?.name || task.assignedToName
                }
            })
        )
    }

    function handleCreateMaintenanceItem(input: { roomNumber?: string; title: string; category: MaintenanceItem['category']; priority: MaintenanceItem['priority']; note?: string }) {
        if (!currentUser) return
        const newItem: MaintenanceItem = {
            id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            roomNumber: formatRoomNumber(input.roomNumber),
            title: input.title.trim(),
            category: input.category,
            priority: input.priority,
            status: 'new',
            note: input.note?.trim() || undefined,
            reportedBy: currentUser.name,
            createdAt: formatNowHHmm(new Date())
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
                createdAt: newItem.createdAt
            })
        }
        setMaintenanceItems((prev) => [newItem, ...prev])
    }

    function handleUpdateMaintenanceItem(itemId: string, patch: Partial<MaintenanceItem>) {
        if (runtimeMode === 'online') {
            activeStore.updateMaintenanceItem(itemId, patch)
        }
        setMaintenanceItems((prev) => prev.map((it) => (it.id === itemId ? { ...it, ...patch, updatedAt: formatNowHHmm(new Date()) } : it)))
    }

    function handleMaterialNeeded(itemId: string, materialText: string) {
        const material = materialText.trim()
        if (!material) return
        const item = maintenanceItems.find((m) => m.id === itemId)
        if (!item) return

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
            priority: item.priority
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
                createdAt: newRequest.createdAt
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
        const canCreate = role === 'admin' || role === 'lead' || role === 'cleaner' || role === 'maintenance'
        if (!canCreate) return

        if (role === 'maintenance' && input.category !== 'maintenance') return

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
            priority: input.priority
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
                createdAt: newRequest.createdAt
            })
        }

        setSupplyRequests((prev) => [newRequest, ...prev])
    }

    function setStaffAvailability(id: string, availability: 'dnes_pracuji' | 'dnes_nepracuji' | 'jen_urgentni') {
        if (runtimeMode === 'online') {
            activeStore.setStaffAvailability(id, availability)
        }
        setStaff((prev) => prev.map((s) => (s.id === id ? { ...s, availability } : s)))
    }

    function handleSetSupplyGroupStatus(itemName: string, status: SupplyRequest['status']) {
        if (!currentUser || currentUser.role !== 'admin') return
        if (runtimeMode === 'online') {
            supplyRequests.filter((s) => s.itemName === itemName).forEach((s) => activeStore.updateSupplyStatus(s.id, status))
        }
        setSupplyRequests((prev) => prev.map((s) => (s.itemName === itemName ? { ...s, status } : s)))
    }

    function handleSaveCustomSupplyChip(name: string) {
        const cleaned = name.trim()
        if (!cleaned) return
        setCustomSupplyChips((prev) => {
            const exists = prev.some((chip) => chip.toLowerCase() === cleaned.toLowerCase())
            if (exists) return prev
            return [...prev, cleaned]
        })
    }

    function canCancelSupplyRequest(request: SupplyRequest) {
        if (!currentUser) return false
        if (currentUser.role === 'admin') return true
        if (currentUser.role === 'lead') return isCleaningDomain(request.category)
        if (currentUser.role === 'cleaner') return request.status === 'new' && request.requestedByRole === 'cleaner' && request.requestedBy === currentUser.name
        if (currentUser.role === 'maintenance') {
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

    // save to localStorage whenever key pieces of state change
    useEffect(() => {
        const toSave = {
            userId,
            tab,
            view,
            roomsByDay,
            tasks,
            supplyRequests,
            maintenanceItems,
            customSupplyChips,
            staff
        }
        activeStore.saveState(toSave)
    }, [userId, tab, view, roomsByDay, tasks, supplyRequests, maintenanceItems, customSupplyChips, staff, activeStore])

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
                if (profile.role === 'maintenance') {
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
                        if (state.tasks) setTasks(state.tasks)
                        if (state.supplyRequests) {
                            setSupplyRequests(state.supplyRequests)
                            setDiagnostics((prev) => ({ ...prev, supplySyncCount: state.supplyRequests?.length || 0 }))
                        }
                        if (state.maintenanceItems) setMaintenanceItems(state.maintenanceItems)
                        if (state.staff) setStaff(state.staff as StaffMember[])
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
        setTasks([])
        setSupplyRequests(initialSupplyRequests)
        setMaintenanceItems(initialMaintenanceItems)
        setCustomSupplyChips([])
        setStaff(users)
        setTab('Dnes')
        setUserId('david')
        setView('today')
        await activeStore.resetDemoState(defaultState)
        setResetConfirm(false)
    }

    return (
        <div className="app">
            <div className="topbar">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div className="title">My Hotel Ops</div>
                    <div style={{ fontSize: 11, color: '#64748b', border: '1px solid #cbd5e1', borderRadius: 999, padding: '2px 8px' }}>
                        {diagnostics.activeMode === 'online' ? 'Online režim' : diagnostics.activeMode === 'fallback' ? 'Fallback režim' : 'Demo režim'}
                    </div>
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
                                <div><strong>Auth status:</strong> {diagnostics.authStatus}{diagnostics.authUid ? ` (${diagnostics.authUid})` : ''}</div>
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
                </div>
                {runtimeMode === 'demo' ? (
                    <RoleSwitch current={userId} onChange={handleRoleChange} />
                ) : (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <div style={{ fontSize: 13, color: '#334155' }}>
                            {onlineProfile ? (
                                <>
                                    <strong>{onlineProfile.name}</strong> • {roleLabel(onlineProfile.role)}
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

                        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                            <button className={`btn ${view === 'today' ? 'active' : ''}`} onClick={() => setView('today')}>Dnes</button>
                            <button className={`btn ${view === 'admin' ? 'active' : ''}`} onClick={() => setView('admin')}>Admin</button>
                            <button className={`btn ${view === 'maintenance' ? 'active' : ''}`} onClick={() => setView('maintenance')}>Údržba</button>
                            <button className={`btn ${view === 'supplies' ? 'active' : ''}`} onClick={() => setView('supplies')}>Nákupy</button>
                        </div>

                        {(currentUser?.id === 'david' || currentUser?.role === 'admin') && (
                            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                                {!resetConfirm ? (
                                    <button className="btn danger" onClick={() => setResetConfirm(true)}>{runtimeMode === 'online' ? 'Reset online dat' : 'Reset demo dat'}</button>
                                ) : (
                                    <>
                                        <button className="btn danger" onClick={() => resetDemoData()}>Opravdu resetovat?</button>
                                        <button className="btn" onClick={() => setResetConfirm(false)}>Zrušit</button>
                                    </>
                                )}
                            </div>
                        )}

                        {showOrientationNote && (
                            <div style={{ marginTop: 10, padding: 10, background: '#fff', borderRadius: 10 }}>Orientační plán – může se změnit novou rezervací.</div>
                        )}

                        <div style={{ marginTop: 12 }}>
                            {view === 'today' && (
                                <DashboardToday
                                    rooms={displayedRooms}
                                    tasks={visibleTodayTasks}
                                    onAction={handleAction}
                                    onCreateTask={handleCreateTask}
                                    onUpdateTaskStatus={handleUpdateTaskStatus}
                                    role={(currentUser?.role || 'cleaner') as UserRole}
                                    dayLabel={dayLabel}
                                    staff={staff}
                                    onSetAvailability={setStaffAvailability}
                                    currentUserId={userId}
                                    currentUserName={currentUser?.name}
                                    readOnly={isExtraImportedDay}
                                />
                            )}
                            {view === 'admin' && (
                                <>
                                    {currentUser?.role === 'admin' && (
                                        <div className="section">
                                            <h3>Import z Previa</h3>
                                            <div className="room-card" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, border: '1px solid #bae6fd', background: '#f0f9ff' }}>
                                                <label style={{ fontSize: 13, color: '#0c4a6e', fontWeight: 800 }}>Nahrát PDF Stav</label>
                                                <div className="room-meta" style={{ color: '#0c4a6e' }}>Doporučeno – obsahuje příjezdy, odjezdy i probíhající pobyty.</div>
                                                <input
                                                    type="file"
                                                    accept="application/pdf,.pdf"
                                                    onChange={(e) => {
                                                        const nextFile = e.target.files?.[0] || null
                                                        void handlePrevioStatePdfSelected(nextFile)
                                                    }}
                                                />
                                                {stateImportPdfStatus === 'loading' && <div className="room-meta">Načítám PDF Stav...</div>}
                                                {stateImportPdfStatus === 'loaded' && <div className="room-meta" style={{ color: '#166534' }}>PDF Stav načteno</div>}
                                                {stateImportPdfStatus === 'error' && <div className="room-meta" style={{ color: '#b91c1c' }}>{stateImportPdfError || 'PDF Stav se nepodařilo načíst.'}</div>}
                                            </div>

                                            {stateImportPreview && (
                                                <div className="room-card" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, marginTop: 8 }}>
                                                    <div style={{ fontWeight: 800 }}>Náhled importu Stav</div>
                                                    <div className="room-meta">Detekované dny: {stateImportPreview.days.length}</div>
                                                    <div className="room-meta">Turnover pokoje: {stateImportPreview.turnoverCount}</div>
                                                    <div className="room-meta">Probíhající pobyty: {stateImportPreview.stayoverCount}</div>
                                                    <div className="room-meta">Odvozené potvrzeně volné pokoje: {stateImportPreview.derivedFreeCount}</div>
                                                    <div className="room-meta">Mimo seznam pokojů: {stateImportPreview.unknownRooms.length ? stateImportPreview.unknownRooms.join(', ') : 'žádné'}</div>
                                                    {stateImportPreview.confidenceLow && (
                                                        <div style={{ fontSize: 12, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 8, fontWeight: 700 }}>
                                                            Import Stav není bezpečný – parser nenašel dost dat. Import nepotvrzovat.
                                                        </div>
                                                    )}
                                                    {stateImportBlockedByMissingDays && (
                                                        <div style={{ fontSize: 12, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 8, fontWeight: 700 }}>
                                                            Import Stav je zablokován: v náhledu chybí dny uprostřed rozsahu ({statePreviewMissingDateLabels.join(', ')}). Nahrajte PDF znovu a potvrďte až po detekci všech dní.
                                                        </div>
                                                    )}
                                                    {stateImportPreview.warnings.length > 0 && (
                                                        <div style={{ fontSize: 12, color: '#92400e', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: 8 }}>
                                                            {stateImportPreview.warnings.slice(0, 10).map((warning) => (
                                                                <div key={`state-warning-${warning}`}>{warning}</div>
                                                            ))}
                                                        </div>
                                                    )}

                                                    {stateImportRawText && (
                                                        <details>
                                                            <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Debug text Stav z PDF</summary>
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
                                                                {stateImportPreview.days.map((day) => (
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

                                                    <div style={{ display: 'flex', gap: 8 }}>
                                                        <button className="btn" disabled={stateImportPreview.confidenceLow || stateImportBlockedByMissingDays} onClick={() => void handleConfirmPrevioStateImport()}>Potvrdit import Stav</button>
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
                                        </div>
                                    )}

                                    <AdminDashboard
                                        rooms={roomsByDay[tab]}
                                        tasks={tasks}
                                        supplyRequests={supplyRequests}
                                        staff={staff}
                                        canManageSupplies={currentUser?.role === 'admin'}
                                        onSetSupplyGroupStatus={handleSetSupplyGroupStatus}
                                    />
                                </>
                            )}
                            {view === 'maintenance' && (
                                <MaintenanceView
                                    role={(currentUser?.role || 'cleaner') as UserRole}
                                    currentUserId={userId}
                                    maintenanceItems={maintenanceItems}
                                    tasks={maintenanceTasks}
                                    onCreateMaintenance={handleCreateMaintenanceItem}
                                    onUpdateMaintenance={handleUpdateMaintenanceItem}
                                    onMaterialNeeded={handleMaterialNeeded}
                                />
                            )}
                            {view === 'supplies' && (
                                <SuppliesView
                                    userName={currentUser?.name || 'Uživatel'}
                                    role={(currentUser?.role || 'cleaner') as UserRole}
                                    requests={visibleSupplies}
                                    customChips={customSupplyChips}
                                    onCreateRequest={handleCreateSupplyRequest}
                                    onSaveCustomChip={handleSaveCustomSupplyChip}
                                    onCancelRequest={handleCancelSupplyRequest}
                                />
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    )
}
