# 03 - Room Status Flow

## Operational Statuses
- `ceka`, `prevzato`, `probihá`, `odhad`, `hotovo`, `problem`, `neni`

## Confirmation Merge Behavior
When confirming a new import, imported reservation facts are merged with existing operational state:
- preserve status
- preserve assignment
- preserve estimate fields
- preserve problem note/checkout exception
- preserve carry-over resolved marker
- preserve only operational state for the same normalized date + room; previous-day `hotovo` must not carry into today

This merge is implemented in `src/lib/importOperationalMerge.ts` and used by import confirmation paths.

## Diagnostics
Confirmation must persist merge counters in job metadata:
- `confirmationDiagnostics.operationalMerge`
- mirrored into `previewSummary.diagnostics.operationalMerge`

## Plachta Invariant
- For primary selector days (`Dnes`, `Zitra`, `Pozitri`), `RoomSheetView` must resolve from the same UI-facing operational state as `DashboardToday` (`roomsByDay`) before falling back to imported snapshots.
- Imported snapshots remain the fallback for extra imported dates that are outside the primary day tabs.
- Plachta must not resurrect stale stayover / occupied guest data over a confirmed free operational room state.
- Avoid synthetic cross-day occupancy interpolation that can resurrect moved/cancelled stays.

## Date Tab Identity
- Primary and extra operational day tabs must dedupe and sort by normalized ISO date (`YYYY-MM-DD`), not by rendered label text.
- Relative labels (`Dnes`, `Zitra`, `Pozitri`, Ukrainian equivalents) are display-only; translated text must never affect date identity, sorting, or selection.

## Carry-over Invariant
- `Nedokončeno z ...` is a UI-facing carry-over alert for an otherwise eligible room (no departure, no arrival, not occupied).
- The alert must stay actionable even when the current room state is free.
- Resolving the alert must persist `carryOverResolvedAt` so the badge stays hidden across rerenders and import refreshes.

## Reset-to-Waiting Invariant
- `Zpět na čeká` / Ukrainian equivalent is date-scoped and only clears the visible cleaning completion state for the selected room day.
- Reset must not delete reservation facts, guest/box/Previo notes, manual tasks, supply requests, or maintenance tickets.

## Maintenance Self-Task Flow
- Maintenance (and admin) can create self-assigned maintenance tasks from the Maintenance screen; creators are stored in task metadata (`createdByUid`, `createdByName`, `createdByRole`, `createdSource=maintenance_self`).
- Self-created maintenance tasks use the same task lifecycle as other maintenance tasks; when marked `done`, they move to the same `Hotovo` list and persist completion metadata (`completedAt`, `completedByUid`, `completedByName`).
