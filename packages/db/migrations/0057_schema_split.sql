-- =====================================================================
-- Migration: 0057_schema_split.sql
--
-- Moves every TB-owned object from `public` into a dedicated `vibetb`
-- schema and reserves `public` as an empty namespace. This is the first
-- step of the Connect-style feature absorption: subsequent migrations
-- create new TB tables in `vibetb` explicitly, and the role's
-- search_path picks `vibetb` so existing Drizzle `pgTable('name', ...)`
-- references resolve transparently without any TypeScript edits.
--
-- Why a single RENAME instead of 83 SET-SCHEMA statements:
--   - Atomic in one DDL statement; either the whole rename succeeds or
--     nothing moves.
--   - Carries every dependent object — tables, indexes, sequences,
--     constraints, triggers, materialized views, enums — without
--     enumeration.
--   - Reversible by `ALTER SCHEMA vibetb RENAME TO public`.
--
-- Pre-rename audit (verified for this DB):
--   - No extensions installed in `public` (gen_random_uuid is core in
--     Postgres 13+; we never installed pgcrypto).
--   - No trigger function bodies reference `public.<table>` literally.
--   - 3 materialized views (realization_view, utilization_view,
--     profitability_view) use unqualified table refs — they resolve via
--     search_path after the rename.
--   - schema_migrations tracking table (owned by migrate.ts) is in
--     public; moves with the rename. The migrate.ts INSERT after this
--     migration runs resolves vibetb.schema_migrations via search_path
--     because of the SET below.
-- =====================================================================

-- 1. Rename the schema. Atomic; carries every dependent object.
ALTER SCHEMA public RENAME TO vibetb;

-- 2. Recreate `public` as an empty schema. Some Postgres tooling, dump
--    formats, and future extensions assume `public` exists. We don't
--    put anything in it now; new TB tables go into `vibetb` explicitly.
CREATE SCHEMA public;

-- 3. Reserve `vibeconnect` schema as well? NO — the standalone plan
--    rejects vibeconnect entirely. TB owns its surface; no sibling
--    schema is needed.

-- 4. Persist search_path for the `vibe` role on this database.
--    Future connections (API restart, worker restart, future migrate
--    runs) will resolve unqualified table refs against vibetb first.
--    Wrapped in a DO block so the migration tolerates environments
--    where the `vibe` role doesn't exist (tests use the default
--    `postgres` superuser; SET search_path on the role is a
--    convenience, not a correctness requirement — the SET below + the
--    DATABASE-level set in step 5b cover both cases).
DO $$
DECLARE
  current_db text := current_database();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vibe') THEN
    EXECUTE format('ALTER ROLE vibe IN DATABASE %I SET search_path = vibetb, public', current_db);
  END IF;
END $$;

-- 4b. Also persist search_path at the database level so any role
--     connecting to this database (including `postgres` in tests) picks
--     up the new resolution order. ALTER DATABASE settings cascade to
--     every connection that doesn't override them.
DO $$
DECLARE
  current_db text := current_database();
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = vibetb, public', current_db);
END $$;

-- 5. Apply the new search_path to the CURRENT session so the rest of
--    this migration AND the immediately-following
--    `INSERT INTO schema_migrations` (issued by migrate.ts on the same
--    connection) resolve to vibetb.schema_migrations.
SET search_path = vibetb, public;
