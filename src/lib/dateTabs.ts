import { OpsTab } from '../services/opsStore'

export const PRIMARY_DATE_TABS: OpsTab[] = ['Dnes', 'Zitra', 'Pozitri']

type PrimaryTabLabels = Record<OpsTab, string>

type BuildDateSelectorItemsInput = {
    importedTabDates: Partial<Record<OpsTab, string>>
    importedRoomsByDate: Record<string, unknown>
    selectedImportedDateIso: string | null
    activeTab: OpsTab
    primaryLabels: PrimaryTabLabels
    locale: string
    now?: Date
}

function padDatePart(value: number) {
    return String(value).padStart(2, '0')
}

export function toLocalDateIso(date: Date) {
    return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`
}

export function addLocalDays(date: Date, days: number) {
    const next = new Date(date)
    next.setDate(next.getDate() + days)
    return next
}

export function parseIsoDateForDisplay(dateIso: string) {
    return new Date(`${dateIso}T12:00:00`)
}

export function normalizeDateIso(value?: string | null) {
    if (!value) return null
    const trimmed = String(value).trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed

    const parsed = new Date(trimmed)
    if (Number.isNaN(parsed.getTime())) return null
    return toLocalDateIso(parsed)
}

export function getPrimaryTabDateIso(
    tab: OpsTab,
    importedTabDates: Partial<Record<OpsTab, string>>,
    now: Date = new Date()
) {
    const tabOffsetDays = tab === 'Dnes' ? 0 : tab === 'Zitra' ? 1 : 2
    return normalizeDateIso(importedTabDates[tab]) || toLocalDateIso(addLocalDays(now, tabOffsetDays))
}

export function formatExtraDateLabel(dateIso: string, locale: string) {
    return parseIsoDateForDisplay(dateIso).toLocaleDateString(locale, { day: 'numeric', month: 'numeric' })
}

export function buildDateSelectorItems({
    importedTabDates,
    importedRoomsByDate,
    selectedImportedDateIso,
    activeTab,
    primaryLabels,
    locale,
    now = new Date()
}: BuildDateSelectorItemsInput) {
    const primaryItems = PRIMARY_DATE_TABS.map((tab) => ({
        key: `tab-${tab}`,
        label: primaryLabels[tab],
        kind: 'tab' as const,
        tab,
        dateIso: getPrimaryTabDateIso(tab, importedTabDates, now),
        active: !selectedImportedDateIso && tab === activeTab
    }))

    const primaryDateSet = new Set(primaryItems.map((item) => item.dateIso))
    const primaryUpperBoundIso = primaryItems[primaryItems.length - 1]?.dateIso || toLocalDateIso(addLocalDays(now, 2))

    const extraImportedDates = Array.from(
        new Set(
            Object.keys(importedRoomsByDate)
                .map((dateIso) => normalizeDateIso(dateIso))
                .filter((dateIso): dateIso is string => Boolean(dateIso))
        )
    )
        .filter((dateIso) => !primaryDateSet.has(dateIso) && dateIso > primaryUpperBoundIso)
        .sort()

    const extraItems = extraImportedDates.map((dateIso) => ({
        key: `date-${dateIso}`,
        label: formatExtraDateLabel(dateIso, locale),
        kind: 'date' as const,
        dateIso,
        active: selectedImportedDateIso === dateIso
    }))

    return [...primaryItems, ...extraItems]
}

export function resolveEffectiveDateIso(params: {
    tab: OpsTab
    importedTabDates: Partial<Record<OpsTab, string>>
    importedRoomsByDate: Record<string, unknown>
    selectedImportedDateIso: string | null
    now?: Date
}) {
    const { tab, importedTabDates, importedRoomsByDate, selectedImportedDateIso, now = new Date() } = params
    if (selectedImportedDateIso && importedRoomsByDate[selectedImportedDateIso]) return selectedImportedDateIso
    return getPrimaryTabDateIso(tab, importedTabDates, now)
}