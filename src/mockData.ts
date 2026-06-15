import { RoomPlan, UserRole, SupplyRequest } from './types'

export const users: { id: string; name: string; role: UserRole }[] = [
  { id: 'david', name: 'David', role: 'admin' },
  { id: 'iryna', name: 'Iryna', role: 'lead' },
  { id: 'karla', name: 'Uklízečka', role: 'cleaner' },
  { id: 'petr', name: 'Údržbář', role: 'maintenance' }
]

export const roomPlans: RoomPlan[] = [
  {
    id: 'r001',
    number: '001',
    situation: 'odjezd_prijezd',
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
    arrivalTime: '18:30',
    guestCount: 3,
    box: 'BOX C',
    notes: ['late arrival'],
    status: 'odhad',
    estimatedReady: '12:30',
    assigned: 'karla'
  },
  {
    id: 'r103',
    number: '103',
    situation: 'volny',
    status: 'neni'
  },
  {
    id: 'r104',
    number: '104',
    situation: 'odjezd',
    departureTime: '09:30',
    guestCount: 1,
    box: 'BOX D',
    notes: [],
    status: 'probihá',
    assigned: 'karla'
  },
  {
    id: 'r105',
    number: '105',
    situation: 'volny',
    status: 'neni'
  },
  { id: 'r201', number: '201', situation: 'odjezd', departureTime: '10:30', status: 'ceka', box: 'BOX A' },
  { id: 'r202', number: '202', situation: 'prijezd', arrivalTime: '16:00', status: 'ceka', box: 'BOX B' },
  { id: 'r204', number: '204', situation: 'volny', status: 'neni' },
  { id: 'r205', number: '205', situation: 'odjezd_prijezd', departureTime: '08:00', arrivalTime: '18:00', status: 'ceka', box: 'BOX C' },
  { id: 'r301', number: '301', situation: 'odjezd', departureTime: '12:00', status: 'ceka' },
  { id: 'r302', number: '302', situation: 'prijezd', arrivalTime: '20:00', status: 'ceka' },
  { id: 'r304', number: '304', situation: 'volny', status: 'neni' },
  { id: 'r305', number: '305', situation: 'prijezd', arrivalTime: '14:00', status: 'ceka', notes: ['dětská postýlka'], box: 'BOX Z' }
]

export const supplyRequests: SupplyRequest[] = [
  { id: 's1', item: 'Toaletní papír', qty: 12, status: 'open' },
  { id: 's2', item: 'Pytle malé', qty: 5, status: 'open' },
  { id: 's3', item: 'Tablety do myčky', qty: 2, status: 'fulfilled' }
]
