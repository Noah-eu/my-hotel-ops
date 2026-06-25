# 02 - Previo Import Flow

## Fresh Email Ingest
1. Request hits `previo-import-email`.
2. Primary source and optional overlay are validated and stored.
3. Import job is created (`status=received`).
4. Shared processing module parses sources and builds preview artifacts.
5. Job is updated with preview summary, warnings, safety, diagnostics.

## Preview Regeneration
1. Admin calls `previo-import-preview` with `jobId`.
2. Function loads existing source/overlay from Storage.
3. Same shared processing module regenerates artifacts.
4. Job is updated with regenerated preview and diagnostics.

## Shared-path Requirement
Both endpoints must use `lib/previo-import-processing.js` so parse/overlay/preview logic stays identical.

## Guarded Auto-confirm
- Guard flag: `VITE_PREVIO_AUTO_CONFIRM=true` (or legacy fallback `VITE_AUTO_CONFIRM_STAV_IMPORTS=true`).
- Disable switch: set `VITE_PREVIO_AUTO_CONFIRM=false`.
- Auto-confirm only evaluates newest `previo-state-pdf` jobs from `source=email` with `status=needs_review`.
- Mandatory guards:
	- Preview payload exists (`preview`, `byDate`, `parsedTabDates`).
	- Primary source is XLS/XLSX.
	- Parser diagnostics are complete (processing path + parser version).
	- No arrival overlay mismatches (`arrivalOverlayMismatchRows` / `auditMismatches`).
	- Safety status is `ok` and not blocked.
	- No operational merge inconsistency warnings.
	- Job is not superseded, cancelled, confirmed, or test-like.
- Auto-confirm and manual confirm must both call the same handler path (`handleConfirmImportJob`) so backup, merge, diagnostics, and write semantics stay identical.
- If any guard fails, UI shows `Automatické potvrzení blokováno` with reasons and manual confirm stays available.

## Fresh vs Regenerate Marker
- Ingest writes `previewFreshGenerated=true`.
- Regeneration writes `previewFreshGenerated=false`.
