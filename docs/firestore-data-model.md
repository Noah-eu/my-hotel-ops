# Firestore Data Model (Draft)

This document describes the planned shared data model for My Hotel Ops.

## Root Collection

### hotels
- Document ID: hotelId (for example `demo-hotel`)
- Fields:
  - name: string
  - timezone: string
  - createdAt: timestamp
  - updatedAt: timestamp

## Subcollections under hotels/{hotelId}

### staff
- Document ID: staffId (for example `david`, `iryna`, `serhii`)
- Fields:
  - id: string
  - name: string
  - role: `admin` | `lead` | `cleaner` | `maintenance`
  - availability: `dnes_pracuji` | `dnes_nepracuji` | `jen_urgentni`

### roomPlans
- Document ID: `${day}-${roomId}` (for example `Dnes-r001`)
- Fields (from RoomPlan):
  - id: string
  - number: string
  - situation: `odjezd` | `prijezd` | `odjezd_prijezd` | `volny`
  - departure: { time, guestCount?, guestLabel? }
  - arrival: { time, guestCount?, guestLabel?, box?, notes?[] }
  - nextArrivalPreview: { day, time }
  - departureTime?: string
  - arrivalTime?: string
  - guestCount?: number
  - box?: string
  - notes?: string[]
  - status: `ceka` | `problem` | `prevzato` | `probihá` | `odhad` | `hotovo` | `neni`
  - assigned?: string
  - estimatedReady?: string
  - estimateSetAt?: string
  - statusNote?: string
  - checkoutException?: boolean
  - day: `Dnes` | `Zitra` | `Pozitri`

### tasks
- Document ID: taskId
- Fields (from Task):
  - id: string
  - roomNumber: string
  - title: string
  - category: `cleaning` | `maintenance` | `guest_request` | `supplies` | `other`
  - priority: `normal` | `urgent`
  - assignedToRole: `admin` | `lead` | `cleaner` | `maintenance`
  - assignedToName?: string
  - status: `new` | `read` | `accepted` | `in_progress` | `done` | `problem` | `cancelled`
  - note?: string
  - createdBy: string
  - createdAt: string

### maintenanceItems
- Document ID: maintenanceItemId
- Fields (from MaintenanceItem):
  - id: string
  - roomNumber?: string
  - title: string
  - category: `water` | `drain` | `electricity` | `lock` | `safe` | `tv_wifi` | `heating` | `furniture` | `appliance` | `other`
  - priority: `normal` | `urgent`
  - status: `new` | `accepted` | `in_progress` | `waiting_material` | `done` | `cannot_today` | `cancelled`
  - note?: string
  - reportedBy: string
  - assignedTo?: string
  - createdAt: string
  - updatedAt?: string
  - materialNeeded?: string

### supplyRequests
- Document ID: supplyRequestId
- Fields (from SupplyRequest):
  - id: string
  - itemName: string
  - category: `cleaning` | `laundry` | `bathroom` | `kitchen` | `maintenance` | `other`
  - quantityLevel: `low` | `medium` | `high` | `custom`
  - customQuantity?: string
  - roomNumber?: string
  - note?: string
  - requestedBy: string
  - requestedByRole: `admin` | `lead` | `cleaner` | `maintenance`
  - createdAt: string
  - status: `new` | `approved` | `ordered` | `delivered` | `handed_over` | `cancelled`
  - priority: `normal` | `urgent`

### dailyAvailability
- Document ID: staffId
- Fields:
  - staffId: string
  - day: `Dnes` | `Zitra` | `Pozitri` | ISO date string
  - availability: `dnes_pracuji` | `dnes_nepracuji` | `jen_urgentni`
  - updatedAt: timestamp

## Notes
- This is a draft model for incremental migration from local demo mode.
- Existing localStorage key remains `mho_demo_state_v1` for offline/demo fallback.
