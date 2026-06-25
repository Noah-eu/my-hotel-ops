# 04 - Auth, Roles, Access

## Role Authority
- Online mode authority comes from authenticated profile (not UI-selected preview role).
- Import management actions are admin-only.

## Diagnostics / Debug UI
- The Diagnostics panel is not visible to non-admin staff (cleaner, maintenance, lead) and must never be shown based on the preview role. It is only available to real authenticated admins and only when running in development or when an explicit debug flag is enabled (e.g. `import.meta.env.DEV`, `?debug=1` URL flag, or `localStorage.hotelOpsDebug=1`).

## Import Access
- Firestore rules protect `importJobs` and `importBackups` for admin users.
- Preview regeneration endpoint (`previo-import-preview`) requires admin bearer token.

## Non-admin Behavior
- Non-admin users can continue app usage even if import listeners are not available.

## Team Availability
- Team availability is shared hotel-wide state keyed by `dateIso + staff UID`, not viewer/session-local UI state.
- Team counters and staff cards must resolve from the same shared selected-date availability data; they must not depend on the current viewer.
- Only real authenticated admins can change another staff member's availability. Non-admin staff can change only their own availability.
- Preview role must never be used as authority for Team availability writes.

## Staff Language Preference
- Staff-facing UI supports Czech and Ukrainian only; admin/import/debug surfaces may remain Czech.
- The selected language is a viewer-local preference stored in `localStorage` under `hotelOpsLanguage`.
- Missing Ukrainian translation keys must fall back to Czech.
- Translate only UI chrome for staff views; do not translate guest names, room numbers, Previo notes, user-entered free text, quick-task operational labels, or custom supply chip/request item labels.
