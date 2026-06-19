import React, { useMemo } from 'react'
import { RoomPlan } from '../types'
import { OpsTab } from '../services/opsStore'

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

const PRIMARY_TABS: Array<{ tab: OpsTab; label: string; offset: number }> = [
    { tab: 'Dnes', label: 'Dnes', offset: 0 },
    { tab: 'Zitra', label: 'Zítra', offset: 1 },
    { tab: 'Pozitri', label: 'Pozítří', offset: 2 }
]

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

function shortGuestName(value?: string) {
    if (!value) return ''
    const compact = value.replace(/\s+/g, ' ').trim()
    if (!compact) return ''

    const parts = compact.split(' ')
    const merged = parts.slice(0, 2).join(' ')
    if (merged.length <= 20) return merged
    return `${merged.slice(0, 19)}…`
}

function normalizeGuestKey(value?: string) {
    if (!value) return ''
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
}

function formatGuestCount(value?: number) {
    if (typeof value !== 'number') return ''
    return `${value}p`
}

function extractBoxLabel(raw?: string, notes?: string[]) {
    const direct = String(raw || '').trim()
    if (direct) {
        const match = direct.match(/BOX\s*([A-Z0-9-]+)/i)
        if (match) return `BOX ${match[1].toUpperCase()}`
        return direct
    }

    const joined = (notes || []).join(' | ')
    const fromNotes = joined.match(/BOX\s*([A-Z0-9-]+)/i)
    if (!fromNotes) return ''
    return `BOX ${fromNotes[1].toUpperCase()}`
}

function joinDetailParts(parts: Array<string | undefined>) {
    const cleaned = parts.map((part) => String(part || '').trim()).filter(Boolean)
    if (cleaned.length === 0) return undefined
    return cleaned.join(' • ')
}

function buildCellModel(room?: RoomPlan): SheetCellModel {
    if (!room) return { state: 'unknown', main: '—' }

    const departureTime = room.departureTime || room.departure?.time
    const arrivalTime = room.arrivalTime || room.arrival?.time
    const departureGuest = shortGuestName(room.departure?.guestLabel || room.stayoverGuestName)
    const arrivalGuest = shortGuestName(room.arrival?.guestLabel)
    const departureCount = room.departure?.guestCount
    const arrivalCount = room.arrival?.guestCount
    const departureBox = extractBoxLabel(undefined, room.departure?.notes)
    const arrivalBox = extractBoxLabel(room.arrival?.box || room.box, room.arrival?.notes)

    const hasDeparture = Boolean(departureTime)
    const hasArrival = Boolean(arrivalTime)
    const hasDepartureIdentity = Boolean(departureGuest || typeof departureCount === 'number')
    const hasArrivalIdentity = Boolean(arrivalGuest || typeof arrivalCount === 'number')

    if (hasDeparture && hasArrival) {
        const departureDetail = joinDetailParts([departureGuest, formatGuestCount(departureCount), departureBox])
        const arrivalDetail = joinDetailParts([arrivalGuest, formatGuestCount(arrivalCount), arrivalBox])
        const detail = joinDetailParts([
            departureDetail ? `Odj: ${departureDetail}` : undefined,
            arrivalDetail ? `Příj: ${arrivalDetail}` : undefined
        ])

        return {
            state: hasDepartureIdentity && hasArrivalIdentity ? 'turnover' : 'turnover-incomplete',
            main: `Odj ${departureTime} / Příj ${arrivalTime}`,
            detail: detail || (hasDepartureIdentity || hasArrivalIdentity ? detail : 'Neúplná data hosta')
        }
    }

    if (hasDeparture) {
        return {
            state: hasDepartureIdentity ? 'departure' : 'departure-incomplete',
            main: `Odj ${departureTime}`,
            detail: joinDetailParts([departureGuest, formatGuestCount(departureCount), departureBox]) || 'Neúplná data hosta'
        }
    }

    if (hasArrival) {
        return {
            state: hasArrivalIdentity ? 'arrival' : 'arrival-incomplete',
            main: `Příj ${arrivalTime}`,
            detail: joinDetailParts([arrivalGuest, formatGuestCount(arrivalCount), arrivalBox]) || 'Neúplná data hosta'
        }
    }

    const stayoverRaw = room.stayoverGuestName || room.departure?.guestLabel || room.arrival?.guestLabel
    const stayoverGuest = shortGuestName(stayoverRaw)
    const occupied = Boolean(room.occupiedConfirmed || stayoverGuest)

    if (occupied) {
        return {
            state: 'occupied',
            main: 'Pobyt',
            detail: stayoverGuest || undefined,
            stayoverKey: normalizeGuestKey(stayoverRaw)
        }
    }

    if (room.freeConfirmed) {
        return {
            state: 'free',
            main: 'Volné'
        }
    }

    return { state: 'unknown', main: '—' }
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
    const tabDateEntries = useMemo(() => (
        PRIMARY_TABS.map(({ tab, label, offset }) => ({
            tab,
            label,
            dateIso: importedTabDates[tab] || isoForOffset(offset)
        }))
    ), [importedTabDates])

    const roomsByDate = useMemo(() => {
        const next: Record<string, RoomPlan[]> = {}

        // helper to merge an imported room with the base room from roomsByDay when possible
        function mergeWithBase(tab: OpsTab | null, imported: RoomPlan): RoomPlan {
            const baseList = tab ? roomsByDay[tab] || [] : []
            const base = baseList.find((b) => {
                const bn = normalizeRoomNumber(b.number)
                const rn = normalizeRoomNumber(imported.number)
                if (b.id && imported.id && b.id === imported.id) return true
                if (bn && rn && bn === rn) return true
                return false
            })

            if (!base) return imported

            // merge but do not overwrite base fields with undefined/null from imported
            const result: any = { ...base }
            Object.keys(imported).forEach((key) => {
                const val: any = (imported as any)[key]
                if (typeof val === 'undefined' || val === null) return
                result[key] = val
            })

            // handle nested arrival/departure: prefer imported sub-object when defined
            if ((imported as any).arrival !== undefined && (imported as any).arrival !== null) {
                result.arrival = (imported as any).arrival
            }
            if ((imported as any).departure !== undefined && (imported as any).departure !== null) {
                result.departure = (imported as any).departure
            }

            // Preserve occupancy-related base flags unless import explicitly and positively sets alternatives.
            if (base.occupiedConfirmed) result.occupiedConfirmed = true
            if (base.stayoverGuestName) result.stayoverGuestName = base.stayoverGuestName

            // If occupied is true, ensure freeConfirmed is not set
            if (result.occupiedConfirmed) result.freeConfirmed = false

            return result as RoomPlan
        }

        // populate dates from primary tabs (preserve roomsByDay fallback)
        tabDateEntries.forEach(({ tab, dateIso }) => {
            const imported = importedRoomsByDate[dateIso]
            if (imported && imported.length > 0) {
                next[dateIso] = imported.map((r) => mergeWithBase(tab, r))
            } else {
                next[dateIso] = roomsByDay[tab] || []
            }
        })

        // also ensure any other imported dates (not part of primary tabs) are included, merged with best-effort base
        Object.entries(importedRoomsByDate).forEach(([dateIso, rooms]) => {
            if (!rooms || rooms.length === 0) {
                if (!next[dateIso]) next[dateIso] = []
                return
            }
            // if we already populated this date from primary tabs, skip to avoid overwriting merged results
            if (next[dateIso] && next[dateIso].length > 0) return

            // try to find mapped tab for this date to use its base list, else null
            const mappedEntry = tabDateEntries.find((t) => t.dateIso === dateIso)
            const mappedTab = mappedEntry ? mappedEntry.tab : null
            next[dateIso] = rooms.map((r) => mergeWithBase(mappedTab, r))
        })

        return next
    }, [importedRoomsByDate, roomsByDay, tabDateEntries])

    const dateColumns = useMemo(() => {
        const tabLabelByDate = new Map<string, string>()
        tabDateEntries.forEach(({ dateIso, label }) => {
            if (!tabLabelByDate.has(dateIso)) tabLabelByDate.set(dateIso, label)
        })

        return Object.keys(roomsByDate)
            .sort()
            .map((dateIso) => ({
                dateIso,
                label: formatColumnDate(dateIso),
                tabLabel: tabLabelByDate.get(dateIso)
            }))
    }, [roomsByDate, tabDateEntries])

    const roomNumbers = useMemo(() => {
        const normalizedActive = activeRoomNumbers
            .map((number) => normalizeRoomNumber(number))
            .filter(Boolean)

        const fromImportedData = Object.values(roomsByDate)
            .flatMap((rooms) => rooms.map((room) => normalizeRoomNumber(room.number)))
            .filter(Boolean)

        const ordered = [
            ...DEFAULT_ROOM_ORDER,
            ...normalizedActive,
            ...fromImportedData
        ]

        return ordered.filter((roomNumber, index, all) => all.indexOf(roomNumber) === index)
    }, [activeRoomNumbers, roomsByDate])

    const lookupByDate = useMemo(() => {
        const next: Record<string, Map<string, RoomPlan>> = {}

        Object.entries(roomsByDate).forEach(([dateIso, rooms]) => {
            const byRoom = new Map<string, RoomPlan>()
            rooms.forEach((room) => {
                const roomNumber = normalizeRoomNumber(room.number)
                if (!roomNumber) return
                byRoom.set(roomNumber, room)
            })
            next[dateIso] = byRoom
        })

        return next
    }, [roomsByDate])

    const spanOverlays = useMemo(() => {
        const overlays: Record<string, Map<string, Partial<RoomPlan>>> = {}
        const dates = dateColumns.map((c) => c.dateIso)

        for (let rn = 0; rn < roomNumbers.length; rn++) {
            const roomNumber = roomNumbers[rn]
            const seq = dates.map((dateIso) => lookupByDate[dateIso]?.get(roomNumber) || null)

            for (let i = 0; i < seq.length; i++) {
                const current = seq[i]
                if (!current) continue

                const hasArrival = Boolean(current.arrivalTime || (current.arrival && current.arrival.time))
                if (!hasArrival) continue

                const startGuest = current.arrival?.guestLabel || current.arrivalGuestName || current.stayoverGuestName || ''

                // find next date with a departure for this room
                let end = i
                for (let j = i + 1; j < seq.length; j++) {
                    const next = seq[j]
                    if (next && (next.departureTime || (next.departure && next.departure.time))) {
                        end = j
                        break
                    }
                }

                // mark intermediate days as occupied (stayover)
                for (let k = i + 1; k < end; k++) {
                    const dateIso = dates[k]
                    if (!overlays[dateIso]) overlays[dateIso] = new Map()
                    overlays[dateIso].set(roomNumber, {
                        occupiedConfirmed: true,
                        stayoverGuestName: startGuest
                    })
                }

                i = Math.max(i, end)
            }
        }

        return overlays
    }, [lookupByDate, dateColumns, roomNumbers])

    return (
        <div className="section">
            <h3>Plachta</h3>
            <div className="room-meta sheet-note">Plachta je orientační přehled z posledního potvrzeného Stav importu.</div>

            <div className="sheet-wrap">
                <div className="sheet-scroll" role="region" aria-label="Přehled pokojů napříč importovanými dny">
                    <table className="sheet-table">
                        <thead>
                            <tr>
                                <th className="sheet-head-room">Pokoj</th>
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
                                            const baseRoom = lookupByDate[column.dateIso]?.get(roomNumber)
                                            const importedRoom = (importedRoomsByDate && importedRoomsByDate[column.dateIso])
                                                ? (importedRoomsByDate[column.dateIso].find((r) => normalizeRoomNumber(r.number) === roomNumber) as RoomPlan | undefined)
                                                : undefined
                                            const overlay = spanOverlays[column.dateIso]?.get(roomNumber)
                                            const effectiveRoom = overlay ? { ...(baseRoom || {}), ...overlay } as RoomPlan : baseRoom
                                            const cell = buildCellModel(effectiveRoom)
                                            
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
        </div>
    )
}