# Phase 2 — Database schema & migrations

## Items completed

The full 31-table Drizzle schema (`packages/db/src/schema/core.ts` + `portal.ts`) shipped pre-staged in the bootstrap. Phase 2 work focused on wiring it up:

1. `pnpm db:migrate` runner script that applies SQL files from `packages/db/migrations/` in lexical order, tracked in a `schema_migrations` ledger table.
2. `drizzle-kit generate:pg` produces `0000_init_schema.sql` (45 tables, all enums and FKs). The hand-written `0001_audit_log_immutability.sql` and `0002_adjustment_sum_trigger.sql` apply on top.
3. `pnpm db:seed` script populates: firm (Granite Peak CPAs) + firm_settings, two offices, seven staff users, four service lines, twelve work codes, eight engagement types matching the starter pack, seven reason codes, five clients (each with partner-in-charge), and three portal identities — Tom Vance is granted client_portal_access to three different clients (FULL / PAY_ONLY / VIEW_ONLY) to validate the multi-entity invariant.
4. Schema invariant test suite (`packages/db/src/schema/__tests__/schema-invariants.test.ts`) verifies the non-negotiables statically via Drizzle metadata, without needing a live DB:
   - `time_entry.standard_rate_snapshot_cents` is NOT NULL
   - `app_user` and `portal_identity` are distinct tables
   - `adjustment_allocation` carries the (adjustment_id, time_entry_id, app_user_id) grain
   - `audit_log` has both `actor_app_user_id` and `actor_portal_identity_id`
   - `portal_session` carries `active_client_id`
   - `client_portal_access` is the M:N join with role
   - `time_entry_version` is the append-only history
   - Firm-scoped columns present where required
5. `@vibe/db` exports `createDb(opts)` returning a typed `PostgresJsDatabase` with the full schema, plus a `close()` for graceful shutdown.

## Acceptance criteria

- `pnpm typecheck` clean across all 8 workspace projects.
- `pnpm test` runs the 8 schema invariant tests + the 5 API tests, all green.
- `pnpm lint` clean.
- All foreign keys constrained (verified by drizzle-kit generation — every `references()` produces a FK in `0000_init_schema.sql`).
- `standard_rate_snapshot_cents` NOT NULL on `time_entry` (asserted by test).
- `adjustment_allocation` sum constraint enforced by `0002_adjustment_sum_trigger.sql` (deferrable trigger; validates at COMMIT).
- `portal_identity` and `app_user` distinct (asserted by test; constraint enforced by separate tables and separate FK targets).
- Seed exercises the multi-entity portal scenario: one identity, three accesses.

## Decisions deferred

None. The pre-staged schema already reflects every locked decision from QUESTIONS.md.

## Surprises

- Drizzle-kit 0.20 still uses the legacy config schema (`driver: 'pg'`, not `dialect: 'postgresql'`). Reverted `drizzle.config.ts` to match.
- `service_line_category` enum values are lowercase in the schema (e.g. `'tax'` not `'TAX'`); seed adjusted.
- Cannot run `pnpm db:migrate` end-to-end here — Docker is unavailable in this sandbox, so the live application of the generated SQL is verified at first deploy. The schema invariant tests cover everything that can be validated statically.

## Next

Phase 3 — authentication & sessions (staff). Magic-link primary auth + TOTP step-up + Redis-backed sessions + RBAC middleware.
