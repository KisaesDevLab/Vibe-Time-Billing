# Postgres Bootstrap

## What gets created on a fresh appliance

A single Postgres 16 database (default name `vibe_tb`) with a single application schema named `vibetb`. The default `public` schema exists but is empty — it's reserved for Postgres-managed extension types so nothing TB-owned ever lives there.

This deviates from the original `CONNECT_INTEGRATION_ADDENDUM.md` §3 (D-03) which specified two schemas (`vibetb` for TB, `vibeconnect` for Connect-sourced tables). Per the TB-standalone framing, the absorption put everything into `vibetb`. See `docs/architecture/CONNECT_INTEGRATION.md` for why.

## How the schema gets created

Migration sequence at first boot:

```
0000_init_schema.sql                  → tables in public
0001 … 0056                           → incremental additions, all in public
0057_schema_split.sql                 → ALTER SCHEMA public RENAME TO vibetb;
                                        CREATE SCHEMA public;          (empty placeholder)
                                        ALTER DATABASE … SET search_path = vibetb, public;
                                        ALTER ROLE vibe IN DATABASE … SET search_path = vibetb, public;
0058 … current                        → CREATE TABLE vibetb.<name> (explicitly qualified)
```

After 0057 every connection inherits `search_path = vibetb, public`, so unqualified table references in Drizzle (`pgTable('thread', …)`) resolve to `vibetb.thread`. Drizzle declarations remain bare; new migrations qualify the table name (`CREATE TABLE vibetb.<name>`) for clarity.

## Running the bootstrap

The Docker container (`vibe-time-billing:local`) auto-runs the migrator on every boot via `ops/docker/entrypoint-api.sh`:

```sh
node packages/db/dist/scripts/migrate.js
exec node apps/api/dist/apps/api/src/server.js
```

The migrator (`packages/db/src/scripts/migrate.ts`) tracks applied filenames in `vibetb.schema_migrations` (which itself got moved by 0057 — search_path resolves the unqualified name). Re-applying is idempotent: applied files are skipped with a `skip <filename>` log line.

Manual run during local development:

```sh
cd packages/db
pnpm migrate
```

## Verifying the bootstrap

```sql
-- TB-owned tables count
SELECT count(*) FROM information_schema.tables
 WHERE table_schema = 'vibetb';
-- Expect 80+ at the time of this writing

-- public should be empty of TB tables
SELECT count(*) FROM information_schema.tables
 WHERE table_schema = 'public';
-- Expect 0

-- search_path should include vibetb first
SHOW search_path;
-- Expect: "vibetb, public"

-- The migration tracker
SELECT count(*), max(filename) FROM vibetb.schema_migrations;
-- Expect: total count of files in packages/db/migrations/, latest filename
```

## Single-firm assumption

Per CLAUDE.md non-negotiable, one firm per appliance. The `firm` table holds exactly one row in production. Schema includes `firm_id` columns on top-level tables for future-proofing, but no tenant resolver middleware exists. The `bootCrypto` step in `apps/api/src/crypto/boot.ts` resolves the single firm via `SELECT id FROM firm LIMIT 1` and uses that everywhere.

## Roles and grants

Today's setup uses a single `vibe` Postgres role (created by `docker-compose.dev.yml` postgres-init). It owns and accesses `vibetb`. The migration sets:

- `ALTER ROLE vibe IN DATABASE <db> SET search_path = vibetb, public` — guards against forgetting to set search_path on new connections
- The 0001 audit-log immutability migration REVOKES `UPDATE, DELETE ON vibetb.audit_log FROM vibe` (the app role) so the application cannot modify audit history

Test environments use the default `postgres` superuser; the 0057 migration's role-level search_path setter is wrapped in a `DO` block that skips if the `vibe` role doesn't exist:

```sql
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vibe') THEN
    EXECUTE format('ALTER ROLE vibe IN DATABASE %I SET search_path = vibetb, public', current_database());
  END IF;
END $$;
```

## Extensions

The build uses `gen_random_uuid()` from pgcrypto. As of Postgres 13+, this is built-in (no `CREATE EXTENSION pgcrypto` required), so no extension management is part of the bootstrap. If a future Postgres downgrade ever became necessary, that's the one extension to install in `public` post-bootstrap.

## Backups

Per CLAUDE.md non-negotiable #12: nightly `pg_dump` to a mounted `/backups` volume, 30-day retention. The dump command targets the `vibetb` schema explicitly:

```sh
pg_dump --schema=vibetb -Fc -d "$DATABASE_URL" -f "/backups/$(date +%F)-vibetb.dump"
```

`ops/scripts/backup.sh` is the canonical implementation; restore procedure in `docs/ops/restore.md`.

## Cross-references

- `docs/ops/SCHEMA_LAYOUT.md` — rationale for `vibetb` vs. `public`, naming conventions for new tables
- `docs/ops/KEY_ROTATION.md` — `firm_key_envelope` operations
- `packages/db/migrations/0057_schema_split.sql` — the atomic rename
- `packages/db/src/scripts/migrate.ts` — the migrator implementation
