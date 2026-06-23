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

## Fresh vs Regenerate Marker
- Ingest writes `previewFreshGenerated=true`.
- Regeneration writes `previewFreshGenerated=false`.
