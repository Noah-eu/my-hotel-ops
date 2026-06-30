# 06 - Known Invariants

## Source Invariants
- XLS/XLSX should be treated as authoritative primary state source.
- PDF is overlay-only (arrival-time enrichment), not authoritative baseline.

## Identity Invariants
- Merge and preservation must resolve rooms by stable date + room identity.
- Room number normalization is required where number formatting differs.
- Operational cleaning state is date-scoped; a previous-day `hotovo` state must not be reused for a new operational date.
- Unresolved manual room tasks are room-scoped open operational state and must not be hidden or dropped by date-tab changes or import merges.
- Room-task alerts must be computed from unresolved/alert-eligible tasks plus role/date/room filters, never from `room.status === hotovo` gating.

## Processing Invariants
- Fresh ingest and regeneration must share the same parser + preview artifact builder.
- Provenance metadata must expose endpoint/path/build/input markers.

## Safety Invariants
- `needs_review` only when preview passes safety checks and no blocking mismatch exists.
- Blocked/suspicious previews must not auto-confirm.
- Automatic and manual confirmation must go through the same confirm/apply path.
