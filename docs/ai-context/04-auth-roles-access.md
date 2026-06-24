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
