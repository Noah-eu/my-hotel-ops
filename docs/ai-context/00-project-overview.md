# 00 - Project Overview

## Stack
- Frontend: React + TypeScript + Vite.
- Backend: Netlify Functions.
- Data: Firestore + Firebase Storage.

## Main Domains
- Daily room operations (`src/App.tsx`, page components).
- Staff/task/supplies/maintenance workflows.
- Reservation-state import from Previo source files.

## Critical Backend Paths
- `netlify/functions/previo-import-email.js`: receives import payload, stores source files, creates/updates import job.
- `netlify/functions/previo-import-preview.js`: regenerates preview from stored source files.
- `netlify/functions/lib/previo-import-processing.js`: shared parse + preview artifact pipeline.

## Validation-first Workflow
When changing import behavior, run deterministic validators before committing.
