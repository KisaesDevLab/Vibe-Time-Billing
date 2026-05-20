# Phase 4 — Firm, office, user administration

## Items completed

- Permission catalog (`@vibe/core/rbac`): 47 namespaced keys.
- Five role templates: admin (all), partner, manager, senior, staff.
- `requirePermission` middleware in `apps/api/src/auth/rbac-middleware.ts`.
- Admin router at `/api/staff/admin/*` with endpoints:
  - `GET/PATCH /firm-settings`
  - `GET/POST /offices`
  - `GET /users`, `POST /users/invite`

UI items (1, 2, 3, 7, 12, 13) deferred until the staff React app receives data routes; tracked in the next UI phase.

## Acceptance criteria

- Permission-gated endpoints reject unauthorized roles (verified — `staff` cannot read firm settings, partner cannot write them).
- CSRF still required on mutating admin endpoints (verified).
- Role permissions can be combined across multiple assignments via `unionPermissions`.

## Validation

- 30 core tests + 20 API tests + 8 schema invariants = 58 total, all passing.
- `pnpm typecheck`, `pnpm lint`, `pnpm prettier --check` all clean.

## Next

Phase 5 — taxonomy CRUD (service lines, work codes, engagement types, reason codes) with starter-pack seed.
