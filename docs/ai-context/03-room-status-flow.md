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

This merge is implemented in `src/lib/importOperationalMerge.ts` and used by import confirmation paths.

## Diagnostics
Confirmation must persist merge counters in job metadata:
- `confirmationDiagnostics.operationalMerge`
- mirrored into `previewSummary.diagnostics.operationalMerge`

## Plachta Invariant
- `RoomSheetView` should reflect the latest confirmed import snapshot directly for schedule occupancy.
- Avoid synthetic cross-day occupancy interpolation that can resurrect moved/cancelled stays.
