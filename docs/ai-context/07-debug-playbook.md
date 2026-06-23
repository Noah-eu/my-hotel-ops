# 07 - Debug Playbook

## When Imports Look Inconsistent
1. Inspect latest `importJobs` documents:
   - compare `previewSummary.previewRequestId`
   - compare `previewSummary.diagnostics.processingPath`
   - compare parser/build markers and source file hashes
2. Verify both paths produce identical core artifacts with deterministic validator.
3. Validate XLS/PDF compatibility and overlay mismatch rows.
4. Confirm operational merge diagnostics after confirmation.

## Required Validators
- `npm run validate:previo-import-determinism`
- `npm run validate:previo-import-real-flow`
- `npm run validate:previo-import-preview-runtime`
- `npm run validate:previo-state-xls-pdf-compat`
- `npm run validate:previo-reimport-merge`

## Notes
- If parser fixture files are unavailable locally, validators may skip by design.
- Treat `validate:previo-state` parser failures as separate unless directly linked to current changes.
