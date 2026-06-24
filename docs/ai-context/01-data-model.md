# 01 - Data Model

## Firestore Collections
- `hotels/<hotelId>/importJobs`
- `hotels/<hotelId>/importBackups`
- `hotels/<hotelId>/roomPlans`
- `hotels/<hotelId>/tasks`
- `hotels/<hotelId>/supplyRequests`
- `hotels/<hotelId>/maintenanceItems`

## Import Job Shape (Important Fields)
- `status`: `received | parsed | needs_review | confirmed | failed | cancelled`
- `storagePath`: primary file in Storage
- `overlayStoragePath`: optional paired PDF
- `previewSummary`: generated parse artifacts (`byDate`, `preview`, `safety`, diagnostics)
- `confirmationDiagnostics.operationalMerge`: persisted merge preservation stats after confirmation
- `automation.autoPreview` and `automation.autoConfirm`: automation lifecycle metadata

## Preview Summary Diagnostics
- Parser/build marker (`parserVersion`, `parserBuildId`, `parserFileVersion`)
- Provenance marker (`processingPath`, endpoint, source/importer mode)
- Input fingerprints (primary/overlay file metadata + sha256)
- Arrival overlay counters and mismatch rows

## Backup Model
- Confirming imports stores rollback snapshot summary and payload.
- Backups include affected dates and room schedules per date.

## Supply Request UI Lifecycle
- `supplyRequests.status` uses: `new | approved | ordered | delivered | handed_over | cancelled`.
- Bought/archive timestamps use `boughtAt` when present, otherwise `updatedAt`, then a safely parseable `createdAt`.
- Active `Čeká` lists are only `new` and `approved`.
- `Objednáno` is only `ordered`.
- `Koupeno` is `delivered` or `handed_over`.
- Closed / bought requests must not remain visible in active `Čeká` lists.
- Maintenance-request grouping in Nákupy is derived from `linkedTaskId` or `requestedByRole === 'maintenance'`.
- Custom supply chips are stored in `customSupplyChips` as section-prefixed strings (`uklid::`, `vybaveni::`, `ostatni::`).
- Legacy chips without a stored section default to `Ostatní`; if a scoped chip with the same label already exists, the legacy duplicate should not be shown in another category.
