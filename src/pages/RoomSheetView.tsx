import React, { useMemo } from 'react'
import { RoomPlan } from '../types'
import { OpsTab } from '../services/opsStore'
import { buildRoomSheetCellModel, buildSheetRoomsByDate } from '../lib/opsUiInvariants'
import { createTranslator, resolveLanguage, LANGUAGE_STORAGE_KEY } from '../i18n'

const DEFAULT_ROOM_ORDER = [
    '001',
    '101',
    '102',
    '103',
    '104',
    '105',
    '201',
    '202',
    '203',
    '204',
    '205',
    '301',
    '302',
    '303',
    '304',
    '305'
]

const PRIMARY_TABS: Array<{ tab: OpsTab; labelKey: string; offset: number }> = [
    { tab: 'Dnes', labelKey: 'dates.today', offset: 0 },
    { tab: 'Zitra', labelKey: 'dates.tomorrow', offset: 1 },
    { tab: 'Pozitri', labelKey: 'dates.dayAfterTomorrow', offset: 2 }
]

const MAX_VISIBLE_IMPORTED_DAYS = 7

type SheetCellState = 'turnover' | 'turnover-incomplete' | 'departure' | 'departure-incomplete' | 'arrival' | 'arrival-incomplete' | 'occupied' | 'free' | 'unknown'

type SheetCellModel = {
    state: SheetCellState
    main: string
    detail?: string
    stayoverKey?: string
}

function isoForOffset(offset: number) {
    const date = new Date(Date.now() + offset * 24 * 60 * 60 * 1000)
    return date.toISOString().slice(0, 10)
}

function normalizeRoomNumber(value?: string) {
    if (!value) return ''
    const trimmed = String(value).trim()
    const match = trimmed.match(/\b(\d{3})\b/)
    if (match) return match[1]

    const digits = trimmed.replace(/\D/g, '')
    if (digits.length >= 3) return digits.slice(-3)
    return trimmed
}

function formatColumnDate(dateIso: string) {
    return new Date(`${dateIso}T00:00:00`).toLocaleDateString('cs-CZ', {
        weekday: 'short',
        day: 'numeric',
        month: 'numeric'
    })
}

export default function RoomSheetView({
    roomsByDay,
    importedTabDates,
    importedRoomsByDate,
    activeRoomNumbers
}: {
    roomsByDay: Record<OpsTab, RoomPlan[]>
    importedTabDates: Partial<Record<OpsTab, string>>
    importedRoomsByDate: Record<string, RoomPlan[]>
    activeRoomNumbers: string[]
}) {
    const language = useMemo(() => resolveLanguage(typeof window !== 'undefined' ? localStorage.getItem(LANGUAGE_STORAGE_KEY) : undefined), [])
    const t = useMemo(() => createTranslator(language), [language])
    const tabDateEntries = useMemo(() => (
        PRIMARY_TABS.map(({ tab, labelKey, offset }) => ({
            tab,
            labelKey,
            tabLabel: t(labelKey as any),
            dateIso: importedTabDates[tab] || isoForOffset(offset)
        }))
    ), [importedTabDates, t])

    const roomsByDate = useMemo(() => {
        return buildSheetRoomsByDate(tabDateEntries, roomsByDay, importedRoomsByDate)
    }, [importedRoomsByDate, roomsByDay, tabDateEntries])

    const visibleDateIsos = useMemo(() => {
        const todayIso = isoForOffset(0)

        return Object.entries(roomsByDate)
            .filter(([dateIso, rooms]) => dateIso >= todayIso && Array.isArray(rooms) && rooms.length > 0)
            .map(([dateIso]) => dateIso)
            .sort()
            .slice(0, MAX_VISIBLE_IMPORTED_DAYS)
    }, [roomsByDate])

    const hasVisibleImportedDates = visibleDateIsos.length > 0

    const visibleRoomsByDate = useMemo(() => {
        if (!hasVisibleImportedDates) return {}

        return visibleDateIsos.reduce<Record<string, RoomPlan[]>>((acc, dateIso) => {
            acc[dateIso] = roomsByDate[dateIso] || []
            return acc
        }, {})
    }, [hasVisibleImportedDates, roomsByDate, visibleDateIsos])

    const dateColumns = useMemo(() => {
        const tabLabelByDate = new Map<string, string>()
        tabDateEntries.forEach(({ dateIso, label }) => {
            if (!tabLabelByDate.has(dateIso)) tabLabelByDate.set(dateIso, label)
        })

        return visibleDateIsos
            .map((dateIso) => ({
                dateIso,
                label: formatColumnDate(dateIso),
                tabLabel: tabLabelByDate.get(dateIso)
            }))
    }, [tabDateEntries, visibleDateIsos])

    const roomNumbers = useMemo(() => {
        const normalizedActive = activeRoomNumbers
            .map((number) => normalizeRoomNumber(number))
            .filter(Boolean)

        const fromImportedData = Object.values(visibleRoomsByDate)
            .flatMap((rooms) => rooms.map((room) => normalizeRoomNumber(room.number)))
            .filter(Boolean)

        const ordered = [
            ...DEFAULT_ROOM_ORDER,
            ...normalizedActive,
            ...fromImportedData
        ]

        return ordered.filter((roomNumber, index, all) => all.indexOf(roomNumber) === index)
    }, [activeRoomNumbers, visibleRoomsByDate])

    const lookupByDate = useMemo(() => {
        const next: Record<string, Map<string, RoomPlan>> = {}

        Object.entries(visibleRoomsByDate).forEach(([dateIso, rooms]) => {
            const byRoom = new Map<string, RoomPlan>()
            rooms.forEach((room) => {
                const roomNumber = normalizeRoomNumber(room.number)
                if (!roomNumber) return
                byRoom.set(roomNumber, room)
            })
            next[dateIso] = byRoom
        })

        return next
    }, [visibleRoomsByDate])

    return (
        <div className="section">
            <h3>{t('nav.sheet' as any)}</h3>
            <div className="room-meta sheet-note">{t('sheet.help' as any)}</div>

            {!hasVisibleImportedDates && (
                <div className="room-card" style={{ marginTop: 12, borderLeft: '6px solid #dc2626' }}>
                    <div className="room-number">{t('sheet.missingTitle' as any)}</div>
                    <div className="room-meta">{t('sheet.missingDescription' as any)}</div>
                </div>
            )}

            {hasVisibleImportedDates && (
                <div className="sheet-wrap">
                    <div className="sheet-scroll" role="region" aria-label={t('sheet.ariaLabel' as any)}>
                        <table className="sheet-table">
                            <thead>
                                <tr>
                                        <th className="sheet-head-room">{t('rooms.column.room' as any)}</th>
                                    {dateColumns.map((column) => (
                                        <th key={`sheet-head-${column.dateIso}`} className="sheet-head-date">
                                            <div className="sheet-head-date-main">{column.label}</div>
                                                {column.tabLabel && <div className="sheet-head-date-tag">{column.tabLabel}</div>}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {roomNumbers.map((roomNumber) => {
                                    let previousState: SheetCellState = 'unknown'
                                    let previousStayoverKey = ''

                                    return (
                                        <tr key={`sheet-row-${roomNumber}`}>
                                            <th scope="row" className="sheet-room-cell">{roomNumber}</th>
                                            {dateColumns.map((column) => {
                                                const room = lookupByDate[column.dateIso]?.get(roomNumber)
                                                const cell = buildRoomSheetCellModel(room) as SheetCellModel

                                                const keepStayoverColor = Boolean(
                                                    cell.state === 'occupied'
                                                    && previousState === 'occupied'
                                                    && cell.stayoverKey
                                                    && cell.stayoverKey === previousStayoverKey
                                                )

                                                previousState = cell.state
                                                previousStayoverKey = cell.stayoverKey || ''

                                                return (
                                                    <td
                                                        key={`sheet-cell-${roomNumber}-${column.dateIso}`}
                                                        className={`sheet-cell sheet-cell-${cell.state}${keepStayoverColor ? ' sheet-cell-stayover-cont' : ''}`}
                                                    >
                                                        <div className="sheet-cell-main">{cell.main}</div>
                                                        {cell.detail && <div className="sheet-cell-detail">{cell.detail}</div>}
                                                    </td>
                                                )
                                            })}
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    )
}