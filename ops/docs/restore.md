# Database restore procedure

This document describes how to restore the Vibe Practice Management database from a `pg_dump` backup. See `ops/scripts/backup.sh` for how backups are created.

## Schedule, destination & retention (configurable)

The backup **schedule, destination path, retention, and "include app keys"** are configured in the app at **Admin → Operations → Backup** and stored in `vibetb.backup_config` (a single appliance-global row). The `backup` sidecar (the only container with both `pg_dump` and the `/backups` volume) polls that row every `BACKUP_POLL_SECONDS` (default 300) and runs when a scheduled run is due or a manual run was requested, recording each run in `vibetb.backup_run`.

Defaults (recommended): **daily** at **02:00 UTC**, **30-day** retention, written to `/backups`. To copy off-appliance, **mount an external drive on the host under `/mnt` or `/media`** (e.g. `/mnt/backup-drive`) — the api binds `/mnt`+`/media` read-only (to enumerate them) and the `backup` sidecar binds them read-write (to write), so the drive appears in the **Backup tab's destination dropdown**. Pick it there and save. Drives hot-plugged after the stack starts propagate in via `rshared`; if a drive doesn't appear, click **Rescan** (or, on hosts without mount propagation, mount it before starting the appliance).

## App keys — REQUIRED for a working restore

A database dump alone is **not** restorable to a functioning appliance. Stripe, email, SMS and webhook credentials are stored **encrypted in the DB under the appliance master key `KMS_KEY`**; staff/portal sessions are signed with `STAFF_JWT_SECRET` / `PORTAL_JWT_SECRET`. Without these keys, the restored DB's encrypted columns are unreadable and no one can sign in.

When **include app keys** is enabled, the sidecar also writes an **encrypted** bundle `vibe-tb-keys-YYYY-MM-DD-HHMMSS.tar.gz.gpg` (gpg symmetric, AES-256) containing `KMS_KEY`, the JWT secrets, `POSTGRES_PASSWORD`, the proposal HMAC seed, VAPID keys, the sealed-on-disk master key (if present), and any operator-mounted `/secrets/*.env`. It is encrypted with `BACKUP_KEYS_PASSPHRASE` — a passphrase **the operator holds and stores off-appliance** (never on the box; it protects the very secrets inside). The last `key_bundle_keep` (default 14) bundles are retained.

To recover the keys before restoring data:

```sh
# Decrypt and inspect the most recent key bundle (needs BACKUP_KEYS_PASSPHRASE)
gpg --batch --decrypt --passphrase "$BACKUP_KEYS_PASSPHRASE" \
  /backups/vibe-tb-keys-2026-05-18-020000.tar.gz.gpg | tar -tzf -

# Extract keys.env and restore each value into the new appliance's env file
# (KMS_KEY, STAFF_JWT_SECRET, PORTAL_JWT_SECRET, POSTGRES_PASSWORD, …) BEFORE
# starting the api/worker — the api exits at boot if KMS_KEY is missing, and a
# mismatched KMS_KEY cannot decrypt the restored DB's secret columns.
```

## When to restore

- Data corruption discovered after a failed migration
- Accidental bulk delete or destructive admin action
- Disaster recovery on a fresh appliance
- Migrating to new hardware

## What restore does NOT recover

A nightly `pg_dump` means **up to 24 hours of data may be lost** between the last backup and the failure point. Time entries created after the most recent backup must be re-entered manually. There is no point-in-time recovery in v1.

If the firm needs zero data loss, document the upgrade path to WAL archiving or streaming replication in a future appliance version.

## Pre-restore checklist

1. **Stop all writes.** Bring the appliance into maintenance mode:
   ```sh
   docker compose -f ops/docker/docker-compose.prod.yml stop api worker
   ```
2. **Notify users.** Email or call partners that the system is in read-only recovery mode.
3. **Snapshot the current (broken) database.** Even if it's corrupted, preserve a forensic copy:
   ```sh
   pg_dump -U vibe -d vibe_tb > /backups/pre-restore-snapshot-$(date +%F).sql
   ```
4. **Identify the backup to restore.** Backups in the destination dir are named `vibe-tb-YYYY-MM-DD-HHMMSS.sql.gz` (the run history in Admin → Operations → Backup lists each with its size). Pick the most recent one before the corruption window.

## Restore procedure

```sh
# 1. Ensure postgres container is running, but app containers are stopped
docker compose -f ops/docker/docker-compose.prod.yml ps

# 2. Drop the live database
docker exec -i vibe-tb-postgres psql -U vibe -d postgres -c "DROP DATABASE IF EXISTS vibe_tb;"
docker exec -i vibe-tb-postgres psql -U vibe -d postgres -c "CREATE DATABASE vibe_tb OWNER vibe;"

# 3. Restore from backup
gunzip -c /backups/vibe-tb-2026-05-18.sql.gz | \
  docker exec -i vibe-tb-postgres psql -U vibe -d vibe_tb

# 4. Verify row counts in critical tables
docker exec -i vibe-tb-postgres psql -U vibe -d vibe_tb -c "
  SELECT 'time_entry' AS t, count(*) FROM time_entry
  UNION ALL SELECT 'invoice', count(*) FROM invoice
  UNION ALL SELECT 'adjustment', count(*) FROM adjustment
  UNION ALL SELECT 'audit_log', count(*) FROM audit_log;
"

# 5. Refresh materialized views
docker exec -i vibe-tb-postgres psql -U vibe -d vibe_tb -c "
  REFRESH MATERIALIZED VIEW CONCURRENTLY realization_view;
  REFRESH MATERIALIZED VIEW CONCURRENTLY utilization_view;
  REFRESH MATERIALIZED VIEW CONCURRENTLY profitability_view;
  REFRESH MATERIALIZED VIEW CONCURRENTLY ar_aging_snapshot;
"

# 6. Restart app and worker
docker compose -f ops/docker/docker-compose.prod.yml up -d api worker

# 7. Sanity check
curl -fsS http://localhost:3001/health
```

## Post-restore tasks

1. **Audit the gap.** Compare the audit log timestamps with the backup time. Any events between backup and failure are lost.
2. **Notify users.** Email staff and (if applicable) clients that data has been restored to a specific point. Be explicit about the gap window.
3. **Re-trigger background jobs.** The BullMQ queue state is in Redis and may have stale entries pointing to restored data. Best practice:
   ```sh
   docker exec -i vibe-tb-redis redis-cli FLUSHDB
   docker compose restart worker
   ```
4. **Re-run today's billing batch generation** if the restore happened during a billing period.
5. **Check pending payments.** Stripe webhooks delivered during the gap will not have updated the database. Reconcile manually using Stripe dashboard.

## Verification queries

After restore, run these queries to confirm data integrity:

```sql
-- Audit log is append-only and intact
SELECT MAX(occurred_at) FROM audit_log;

-- No orphaned time entries (referencing missing engagements)
SELECT te.id FROM time_entry te LEFT JOIN engagement e ON e.id = te.engagement_id
  WHERE e.id IS NULL LIMIT 10;

-- adjustment_allocation sum constraint holds
SELECT a.id, a.total_amount, SUM(aa.adjustment_amount) AS allocated_sum
  FROM adjustment a
  JOIN adjustment_allocation aa ON aa.adjustment_id = a.id
  GROUP BY a.id
  HAVING a.total_amount <> SUM(aa.adjustment_amount);

-- No portal sessions for inactive identities
SELECT ps.id FROM portal_session ps
  JOIN portal_identity pi ON pi.id = ps.portal_identity_id
  WHERE pi.status <> 'ACTIVE' AND ps.revoked_at IS NULL LIMIT 10;
```

All three queries should return zero rows.

## If restore fails

If the restore itself errors out:

1. **Capture the error output.** Save to `/backups/restore-error-$(date +%F-%H%M).log`.
2. **Try the prior backup.** Restore the next-oldest backup; some corruption may have made it into recent backups.
3. **Forensic recovery.** If all recent backups are bad, the pre-restore snapshot from step 3 of the checklist is the last known state. Engage with maintainer support before attempting field repair.

## Backup verification (run monthly)

To make sure backups are restorable before you actually need them:

```sh
# Spin up a sandbox postgres
docker run --rm -d --name vibe-restore-test \
  -e POSTGRES_USER=vibe -e POSTGRES_PASSWORD=vibe -e POSTGRES_DB=vibe_tb \
  -p 5433:5432 postgres:16-alpine

sleep 5

# Restore the most recent backup
gunzip -c /backups/$(ls -t /backups/vibe-tb-*.sql.gz | head -1) | \
  docker exec -i vibe-restore-test psql -U vibe -d vibe_tb

# Verify
docker exec -i vibe-restore-test psql -U vibe -d vibe_tb -c "
  SELECT count(*) FROM time_entry;
"

# Tear down
docker stop vibe-restore-test
```

This should be on the firm's IT calendar monthly.
