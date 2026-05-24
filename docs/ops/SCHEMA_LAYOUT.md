# Schema Layout

## Why `vibetb` instead of `public`

Migration `0057_schema_split.sql` (May 2026) atomically renames the entire `public` schema to `vibetb` and recreates `public` as an empty namespace. Rationale:

- **Separation from extensions and future neighbors.** `public` is the default home for any Postgres extension (`pgcrypto`, etc.); keeping TB's 80+ tables in a named schema makes it unambiguous what's TB-owned.
- **No confusion with multi-product appliances.** Even though TB ships standalone today, the named schema means a hypothetical future "Vibe Connect on the same Postgres" deployment doesn't have to fight TB for the public namespace.
- **Backup hygiene.** `pg_dump --schema=vibetb` produces a clean per-product dump; `--exclude-schema=vibetb` would let an integrator dump only their additions.

## Search-path setup

Migration 0057 sets the search path two ways for resilience:

```sql
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vibe') THEN
    EXECUTE format('ALTER ROLE vibe IN DATABASE %I SET search_path = vibetb, public', current_database());
  END IF;
END $$;

DO $$ BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = vibetb, public', current_database());
END $$;
```

- `ALTER ROLE vibe IN DATABASE …` covers production (where the app connects as `vibe`).
- `ALTER DATABASE …` covers test environments (pglite, CI containers, etc.) where the connecting role may differ.

The net result: unqualified table references in Drizzle code (`pgTable('thread', …)`) resolve to `vibetb.thread` automatically. No bulk Drizzle migration was needed.

## New tables vs. existing tables

| Table source           | Schema reference                                    | Drizzle declaration                                        |
| ---------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| Pre-0057 (existing TB) | resolved via search_path                            | bare `pgTable('name', …)`                                  |
| 0058+ (new)            | qualified at migration `CREATE TABLE vibetb.<name>` | bare `pgTable('name', …)` — still resolves via search_path |

Both styles coexist cleanly because the search_path includes `vibetb`. The convention going forward: qualify in the SQL migration, leave the Drizzle declaration bare.

## Backup procedure

```bash
# Full backup (one schema)
pg_dump --schema=vibetb -Fc -d "$DATABASE_URL" -f "/backups/$(date +%F)-vibetb.dump"

# Restore
pg_restore -d "$DATABASE_URL" -j 4 "/backups/2026-05-24-vibetb.dump"
```

The default backup script in `ops/scripts/` runs nightly via cron, retains 30 days, and writes to the mounted `/backups` volume per CLAUDE.md non-negotiable.

## Migration tracking

The `schema_migrations` table (created by `packages/db/src/scripts/migrate.ts`) moved into `vibetb` along with the rest of the rename. The migrator's `INSERT INTO schema_migrations …` resolves to `vibetb.schema_migrations` via search_path; no script change was needed.

## Tables added by the Connect-style absorption

| Migration                               | Tables                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `0057_schema_split.sql`                 | (no new tables; just the rename)                                                                                                        |
| `0058_firm_config_and_key_envelope.sql` | `firm_config`, `firm_key_envelope`                                                                                                      |
| `0059_messaging.sql`                    | `thread`, `thread_member`, `engagement_thread_link`, `message`, `message_attachment`, `message_read_receipt`, `time_entry_message_link` |
| `0060_files_escrow_zone.sql`            | (no new tables; extends `files`)                                                                                                        |
| `0061_client_requests.sql`              | `client_request`, `client_request_time_entry_link`                                                                                      |

All live in `vibetb`.

## Why `0057` over a per-table SET SCHEMA

A single `ALTER SCHEMA public RENAME TO vibetb` is atomic in one DDL statement and carries every dependent object — tables, indexes, sequences, constraints, triggers, materialized views, enums — without enumeration. Doing 80+ `ALTER TABLE … SET SCHEMA vibetb` would have left a window where some tables resolved to `public` and others to `vibetb`, and we'd have had to remember to move sequences and types separately.

The rename is reversible by `ALTER SCHEMA vibetb RENAME TO public` if anything goes badly wrong.

## Verification

```sql
-- All TB tables live in vibetb now
SELECT count(*) FROM information_schema.tables WHERE table_schema = 'vibetb';
-- 80+ rows

-- public is empty (or contains only Postgres-managed extension types)
SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';
-- 0 rows
```
