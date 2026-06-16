import { RoomPlan, UserRole, SupplyRequest } from './types'

export const users: { id: string; name: string; role: UserRole; availability?: 'dnes_pracuji' | 'dnes_nepracuji' | 'jen_urgentni' }[] = [
    { id: 'david', name: 'David', role: 'admin', availability: 'dnes_pracuji' },
    { id: 'iryna', name: 'Iryna', role: 'lead', availability: 'dnes_pracuji' },
    { id: 'ukl2', name: 'Uklízečka 2', role: 'cleaner', availability: 'dnes_nepracuji' },
    { id: 'ukl3', name: 'Uklízečka 3', role: 'cleaner', availability: 'dnes_nepracuji' },
    { id: 'serhii', name: 'Serhii', role: 'maintenance', availability: 'dnes_nepracuji' }
]

const todayPlans: RoomPlan[] = [
    {
        id: 'r001',
        number: '001',
        situation: 'odjezd_prijezd',
        departure: { time: '10:00', guestCount: 2, guestLabel: 'Host A.' },
        arrival: { time: '15:00', guestCount: 2, guestLabel: 'Host B.', box: 'BOX A', notes: ['dětská postýlka'] },
        departureTime: '10:00',
        arrivalTime: '15:00',
        guestCount: 2,
        box: 'BOX A',
        notes: ['dětská postýlka'],
        status: 'ceka',
        assigned: undefined
    },
    {
        id: 'r101',
        number: '101',
        situation: 'odjezd',
        departure: { time: '11:00', guestCount: 2, guestLabel: 'Host C.' },
        nextArrivalPreview: { day: 'zitra', time: '14:00' },
        departureTime: '11:00',
        guestCount: 2,
        box: 'BOX B',
        notes: [],
        status: 'ceka'
    },
    {
        id: 'r102',
        number: '102 Studio',
        situation: 'prijezd',
        arrival: { time: '18:30', guestCount: 3, guestLabel: 'Host D.', box: 'BOX C', notes: ['late arrival', 'gauč'] },
        arrivalTime: '18:30',
        guestCount: 3,
        box: 'BOX C',
        notes: ['late arrival'],
        status: 'odhad',
        estimatedReady: '12:30',
        assigned: 'ukl2'
    },
    {
        id: 'r103',
        number: '103',
        situation: 'volny',
        nextArrivalPreview: { day: 'pozitri', time: '14:00' },
        status: 'neni'
    },
    {
        id: 'r104',
        number: '104',
        situation: 'odjezd',
        departure: { time: '09:30', guestCount: 1, guestLabel: 'Host E.' },
        nextArrivalPreview: { day: 'pozitri', time: '16:00' },
        departureTime: '09:30',
        guestCount: 1,
        box: 'BOX D',
        notes: [],
        status: 'probihá',
        assigned: 'ukl2'
    },
    {
        id: 'r105',
        number: '105',
        situation: 'volny',
        status: 'neni'
    },
    { id: 'r201', number: '201', situation: 'odjezd', departure: { time: '10:30', guestLabel: 'Host F.' }, departureTime: '10:30', status: 'ceka', box: 'BOX A', nextArrivalPreview: { day: 'zitra', time: '13:30' } },
    { id: 'r202', number: '202', situation: 'prijezd', arrival: { time: '16:00', guestLabel: 'Host G.', box: 'BOX B', notes: ['extra ručníky'] }, arrivalTime: '16:00', status: 'ceka', box: 'BOX B' },
    { id: 'r203', number: '203', situation: 'volny', status: 'neni' },
    { id: 'r204', number: '204', situation: 'volny', status: 'neni' },
    { id: 'r205', number: '205', situation: 'odjezd_prijezd', departure: { time: '08:00', guestLabel: 'Host H.' }, arrival: { time: '18:00', guestLabel: 'Host I.', box: 'BOX C', notes: ['late arrival'] }, departureTime: '08:00', arrivalTime: '18:00', status: 'ceka', box: 'BOX C' },
    { id: 'r301', number: '301', situation: 'odjezd', departure: { time: '12:00', guestLabel: 'Host J.' }, departureTime: '12:00', status: 'ceka', nextArrivalPreview: { day: 'zitra', time: '15:00' } },
    { id: 'r302', number: '302', situation: 'prijezd', arrival: { time: '20:00', guestLabel: 'Host K.', box: 'BOX X', notes: ['dětská postýlka'] }, arrivalTime: '20:00', status: 'ceka' },
    { id: 'r303', number: '303', situation: 'volny', status: 'neni' },
    { id: 'r304', number: '304', situation: 'volny', status: 'neni' },
    { id: 'r305', number: '305', situation: 'prijezd', arrival: { time: '14:00', guestLabel: 'Host L.', box: 'BOX Z', notes: ['dětská postýlka'] }, arrivalTime: '14:00', status: 'ceka', notes: ['dětská postýlka'], box: 'BOX Z' }
]

const tomorrowPlans: RoomPlan[] = todayPlans.map((room) => {
    if (room.number === '101') {
        return {
            ...room,
            situation: 'prijezd',
            departure: undefined,
            arrival: { time: '14:00', guestCount: 2, guestLabel: 'Host M.', box: 'BOX B', notes: ['gauč'] },
            status: 'ceka'
        }
    }

    if (room.number === '201') {
        return {
            ...room,
            situation: 'prijezd',
            departure: undefined,
            arrival: { time: '13:30', guestCount: 2, guestLabel: 'Host N.', box: 'BOX A' },
            status: 'ceka'
        }
    }

    return {
        ...room,
        departure: room.arrival ? { time: '10:00', guestCount: room.arrival.guestCount, guestLabel: room.arrival.guestLabel } : undefined,
        arrival: room.arrival ? { ...room.arrival, time: room.arrival.time } : undefined
    }
})

const dayAfterPlans: RoomPlan[] = tomorrowPlans.map((room) => ({
    ...room,
    status: room.status === 'hotovo' ? 'hotovo' : room.status
}))

export const roomPlansByDay: Record<'Dnes' | 'Zitra' | 'Pozitri', RoomPlan[]> = {
    Dnes: todayPlans,
    Zitra: tomorrowPlans,
    Pozitri: dayAfterPlans
}

export const roomPlans: RoomPlan[] = todayPlans

export const supplyRequests: SupplyRequest[] = [
    {
        id: 's1',
        itemName: 'Cif',
        category: 'cleaning',
        quantityLevel: 'medium',
        requestedBy: 'Iryna',
        requestedByRole: 'lead',
        createdAt: '08:45',
        status: 'new',
        priority: 'normal'
    },
    {
        id: 's2',
        itemName: 'Pytle malé',
        category: 'cleaning',
        quantityLevel: 'medium',
        roomNumber: '101',
        requestedBy: 'Uklízečka',
        requestedByRole: 'cleaner',
        createdAt: '09:10',
        status: 'ordered',
        priority: 'urgent'
    },
    {
        id: 's3',
        itemName: 'Tablety do myčky',
        category: 'kitchen',
        quantityLevel: 'low',
        requestedBy: 'David',
        requestedByRole: 'admin',
        createdAt: '07:55',
        status: 'delivered',
        priority: 'normal'
    }
]

export const maintenanceItems: {
    id: string
    roomNumber?: string
    title: string
    category: 'water' | 'drain' | 'electricity' | 'lock' | 'safe' | 'tv_wifi' | 'heating' | 'furniture' | 'appliance' | 'other'
    priority: 'normal' | 'urgent'
    status: 'new' | 'accepted' | 'in_progress' | 'waiting_material' | 'done' | 'cannot_today' | 'cancelled'
    note?: string
    reportedBy: string
    assignedTo?: string
    createdAt: string
    updatedAt?: string
    materialNeeded?: string
}[] = [
        {
            id: 'm1',
            roomNumber: '101',
            title: 'Zasekaná zásuvka',
            category: 'electricity',
            priority: 'urgent',
            status: 'new',
            note: 'Host hlásí jiskření při zapojení nabíječky',
            reportedBy: 'David',
            createdAt: '09:00'
        },
        {
            id: 'm2',
            roomNumber: '205',
            title: 'Protéká záchod',
            category: 'drain',
            priority: 'urgent',
            status: 'new',
            note: 'Nutné ihned zkontrolovat',
            reportedBy: 'Iryna',
            createdAt: '08:50'
        },
        {
            id: 'm3',
            roomNumber: '302',
            title: 'Problém se sejfem',
            category: 'safe',
            priority: 'normal',
            status: 'new',
            note: 'Sejf odmítá přijmout kód',
            reportedBy: 'David',
            createdAt: '08:30'
        },
        {
            id: 'm4',
            roomNumber: 'Chodba 2. patro',
            title: 'Nesvítí světlo',
            category: 'electricity',
            priority: 'normal',
            status: 'new',
            reportedBy: 'Uklízečka 2',
            createdAt: '07:45'
        }
    ]
