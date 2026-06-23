# Hotel Ops - Copilot Context

## Purpose
Hotel Ops manages daily cleaning/maintenance operations and imports reservation state from Previo files.

## Current Import Architecture
- Inbound email ingest endpoint: `netlify/functions/previo-import-email.js`
- Preview regeneration endpoint: `netlify/functions/previo-import-preview.js`
- Shared parser/preview path (single source of truth): `netlify/functions/lib/previo-import-processing.js`
- Core parser logic: `netlify/functions/lib/previo-state-preview.js`
- Arrival time overlay-only logic: `netlify/functions/lib/previo-arrival-overlay.js`

## Key Invariants
- Primary source should be XLS/XLSX when available.
- PDF is an optional overlay source for arrival-time enrichment only.
- Room operational merge is keyed by stable `dateIso + roomNumber` identity.
- Import confirmations must preserve operational room state (status/assignment/estimate/problem/carry-over).
- Fresh ingest and preview regeneration must use the same shared processing path for parse + artifact generation.
- Do not change Gmail Apps Script logic unless file selection is proven wrong.
- Gmail importer entrypoint is `runPrevioGmailImporter` in `scripts/previo-gmail-importer.js`.

## Where Diagnostics Live
- Import preview diagnostics: `importJobs/<jobId>.previewSummary.diagnostics`
- Confirmation merge diagnostics: `importJobs/<jobId>.confirmationDiagnostics.operationalMerge`

## Validation Commands
- `npm run validate:previo-import-determinism`
- `npm run validate:previo-import-real-flow`
- `npm run validate:previo-import-preview-runtime`
- `npm run validate:previo-state-xls-pdf-compat`
- `npm run validate:previo-reimport-merge`

## Additional Context Docs
- `docs/ai-context/00-project-overview.md`
- `docs/ai-context/01-data-model.md`
- `docs/ai-context/02-previo-import-flow.md`
- `docs/ai-context/03-room-status-flow.md`
- `docs/ai-context/04-auth-roles-access.md`
- `docs/ai-context/05-gmail-apps-script-flow.md`
- `docs/ai-context/06-known-invariants.md`
- `docs/ai-context/07-debug-playbook.md`