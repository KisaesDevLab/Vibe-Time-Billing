---
title: 'Backups and restore'
slug: backups
category: deployment
audience: staff
tags: ['backup', 'restore', 'pg_dump', 'data']
---

# Backups & restore

The appliance takes a nightly `pg_dump` of the Postgres database to the `/backups` volume and keeps 30 days by default. In production this runs from a dedicated `backup` container that installs cron and runs `ops/scripts/backup.sh` at 02:00 daily. Restore is a deliberate, documented procedure (`ops/docs/restore.md`) with a helper script (`ops/scripts/restore.sh`). Because backups are nightly, **up to 24 hours of data can be lost** between the last backup and a failure — there is no point-in-time recovery in v1.

## Steps

1. Backups run automatically — the crontab `0 2 * * * /scripts/backup.sh` produces `/backups/vibe-tb-YYYY-MM-DD.sql.gz`.
2. To restore, first stop the app: `docker compose -f ops/docker/docker-compose.prod.yml stop api worker`.
3. Identify the backup — files are named `vibe-tb-YYYY-MM-DD.sql.gz` in `/backups`. Pick the most recent one before the problem.
4. Run the restore helper with `DATABASE_URL` set: `./restore.sh --latest` (or pass a path). It verifies gzip integrity, snapshots the current DB, drops and recreates the database, restores, refreshes materialized views, and runs sanity checks.
5. Confirm at the prompts: answer `yes` to "Have you stopped the api and worker containers?" and type `RESTORE` to proceed.
6. After restore: flush Redis (`docker exec vibe-tb-redis redis-cli FLUSHDB`), restart with `docker compose up -d api worker`, and verify `curl -fsS http://localhost:3001/health`.

## Fields

- `BACKUP_DIR` — backup target; defaults to `/backups`.
- `BACKUP_RETENTION_DAYS` — retention window; defaults to `30`. Older dumps are pruned each run.
- `DATABASE_URL` — required by both `backup.sh` and `restore.sh`.
- `BACKUP_SUCCESS_WEBHOOK` / `BACKUP_FAILURE_WEBHOOK` — optional URLs posted to on success/failure.

## What you'll see

- `backup.sh` logs to `/backups/backup.log`, runs `pg_dump` piped through `gzip --best`, then checks the file is over 1 KB and passes `gunzip -t`.
- `restore.sh` prints a warning banner with the file, size, and target DB; captures a pre-restore snapshot; restores; then prints row counts for key tables and verifies adjustment-allocation sums.
- After restore it warns that records created after the backup's timestamp are not recovered.

## Tips

- Run the monthly restore-verification drill in `ops/docs/restore.md`: restore the latest backup into a throwaway Postgres container and check a row count.
- Mirror `/backups` off-appliance so a hardware loss doesn't take the backups with it.
- The restore script does NOT stop containers or flush Redis for you — do those manually per the procedure.
- Post-restore, reconcile any Stripe payments whose webhooks landed during the gap.
