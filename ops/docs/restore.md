# Database restore — technical reference

**Start here instead:** `ops/scripts/restore.sh` is the supported restore
path (guided, handles encrypted dumps, snapshots first, fixes DB settings,
restarts the app). `ops/docs/DISASTER-RECOVERY.md` is the owner-facing
guide with the full-machine-rebuild procedure. This document is the
reference for what those automate, plus the manual equivalents.

## What a backup run produces

See `ops/scripts/backup.sh` (the executor; schedule/destination/retention
are configured in Admin → Operations → Backup, stored in
`vibetb.backup_config`, run history in `vibetb.backup_run`):

- `vibe-tb-YYYY-MM-DD-HHMMSS.sql.gz.gpg` — full `pg_dump` of the
  appliance database, gzip + **AES-256 encrypted** under
  `BACKUP_KEYS_PASSPHRASE`. (Plain `.sql.gz` when no passphrase is set —
  the log says so loudly.)
- `vibe-tb-keys-YYYY-MM-DD-HHMMSS.tar.gz.gpg` — encrypted app-key bundle:
  `keys.env` (KMS_KEY, both JWT secrets, POSTGRES_PASSWORD, VAPID pair,
  OpenSign master key…), `firm-key.seal` (the sealed-on-disk KEK), and a
  verbatim copy of every `*.env` in the mounted `/secrets` dir (set
  `APPLIANCE_SECRETS_DIR` on the backup sidecar — this captures the
  complete `vibe-build.env`, which is the authoritative secret set).
- If the destination is under `/mnt` or `/media` and that drive is **not
  mounted**, the run **fails loudly** (visible in the Backup tab) rather
  than silently writing to the internal disk. Override:
  `BACKUP_ALLOW_UNMOUNTED=1`.

## Why the key bundle is REQUIRED for a working restore

A database dump alone is **not** restorable to a functioning appliance:

- The firm's Master Firm Key envelope is *in* the DB, but unwrapping it
  needs `firm-key.seal` (sealed-on-disk mode) or the admin passphrase.
  Without the MFK, the B2/MinIO file-storage credentials, Cloudflare
  tunnel token, and calendar secrets in the DB are unreadable.
- `KMS_KEY` (env) encrypts the other DB-stored secrets: Stripe keys,
  mail/SMS provider config, TOTP secrets.
- `STAFF_JWT_SECRET` / `PORTAL_JWT_SECRET` sign sessions;
  `PROPOSAL_SIGNATURE_HMAC_SEED` verifies existing proposal signatures.

All of these are in the key bundle (given a `/secrets` mount). Recover
them on a fresh machine with:

```sh
ops/scripts/restore.sh --keys /backups/vibe-tb-keys-<ts>.tar.gz.gpg
```

The seal must land at `/data/firm-key/.firm-key.seal` (mode 0400) inside
the `firm-key` volume **before** first app start; the env values become
the compose `--env-file`.

## Standard restore (same appliance)

```sh
ops/scripts/restore.sh              # newest backup, guided
ops/scripts/restore.sh --file <f>   # a specific backup
ops/scripts/restore.sh --check      # NON-destructive verify (scratch DB)
```

`--check` is also run automatically every night by the appliance staging
cron; look for `RESTORE TEST PASSED` in the staging/backup logs.

## Manual restore (what the script does)

```sh
# 0. Decrypt if needed (passphrase = BACKUP_KEYS_PASSPHRASE)
gpg --batch --decrypt --passphrase "$P" vibe-tb-<ts>.sql.gz.gpg > /tmp/r.sql.gz

# 1. Safety snapshot of current state
docker exec vibe-tb-postgres pg_dump -U vibe -d vibe_tb --no-owner --no-acl \
  --clean --if-exists --quote-all-identifiers | gzip > pre-restore-snapshot.sql.gz

# 2. Stop the app (NOT the database); kill lingering connections
docker stop vibe-tb-api vibe-tb-worker
docker exec vibe-tb-postgres psql -U vibe -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='vibe_tb' AND pid<>pg_backend_pid();"

# 3. Recreate and load
docker exec vibe-tb-postgres psql -U vibe -d postgres -c "DROP DATABASE IF EXISTS vibe_tb;"
docker exec vibe-tb-postgres psql -U vibe -d postgres -c "CREATE DATABASE vibe_tb OWNER vibe;"
gunzip -c /tmp/r.sql.gz | docker exec -i vibe-tb-postgres psql -U vibe -d vibe_tb -q

# 4. Reapply the database-level setting pg_dump does NOT carry
docker exec vibe-tb-postgres psql -U vibe -d postgres -c \
  "ALTER DATABASE vibe_tb SET search_path = vibetb, public;"

# 5. Clear stale queue state, restart, verify
docker exec vibe-tb-redis redis-cli FLUSHDB
docker start vibe-tb-api vibe-tb-worker
curl -fsS http://localhost:3001/health
```

Notes:

- **Do not** `REFRESH MATERIALIZED VIEW` by hand — the dump repopulates
  `vibetb.realization_view` / `utilization_view` / `profitability_view`
  itself (they restore with `ispopulated = t`).
- All application tables are in the **`vibetb` schema**. Until step 4 is
  applied, unqualified names (`SELECT … FROM time_entry`) fail — that's
  the missing `search_path`, not a bad restore.
- Migrations bookkeeping (`vibetb.schema_migrations`) is inside the dump;
  the api entrypoint will apply only migrations newer than the dump.

## Verification queries (post-restore)

```sql
-- run in: docker exec -it vibe-tb-postgres psql -U vibe -d vibe_tb
SELECT max(occurred_at) FROM vibetb.audit_log;             -- ≤ backup time
SELECT count(*) FROM vibetb.firm_key_envelope;             -- = 1
SELECT te.id FROM vibetb.time_entry te                     -- 0 rows
  LEFT JOIN vibetb.engagement e ON e.id = te.engagement_id
  WHERE e.id IS NULL LIMIT 10;
```

## Data-loss window & follow-ups

Nightly dumps mean up to 24h of entries can be lost; there is no
point-in-time recovery in v1 (upgrade path: WAL archiving). After any
restore: notify staff of the cutoff, re-run the day's billing batch if
applicable, and reconcile Stripe dashboard payments received during the
gap (webhooks delivered meanwhile are not in the restored DB).

## If the restore fails

1. Keep the error output.
2. Try the previous night's file (`restore.sh --file …`) — corruption can
   make it into the newest backup.
3. The pre-restore snapshot from step 1 is the last-known state; engage
   maintainer support before field surgery.

## Related state NOT covered by the DB dump

| State | Where it's backed up |
|---|---|
| Client documents | Live in B2 (`storage_settings`); credentials restore with DB + seal |
| OpenSign (e-sign) Mongo + files + signing cert env | Appliance staging cron + off-site (Duplicati); see DISASTER-RECOVERY.md §5.6 |
| Redis/BullMQ queues | Deliberately not backed up — flush on restore |
| Caddy internal CA | Regenerates; browsers re-trust on next visit |
