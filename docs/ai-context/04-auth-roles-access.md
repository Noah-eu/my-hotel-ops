# 04 - Auth, Roles, Access

## Role Authority
- Online mode authority comes from authenticated profile (not UI-selected preview role).
- Import management actions are admin-only.

## Import Access
- Firestore rules protect `importJobs` and `importBackups` for admin users.
- Preview regeneration endpoint (`previo-import-preview`) requires admin bearer token.

## Non-admin Behavior
- Non-admin users can continue app usage even if import listeners are not available.
