# Upgrade path

Vibe Time & Billing ships as a versioned Docker image. Major-version upgrades
may include irreversible schema migrations; minor-version upgrades never do.

## Versioning

- `v0.MINOR.PATCH` while in beta. `MINOR` can include schema migrations but
  always with an automatic upgrade path.
- `v1+` will follow semver: major bumps mean **breaking** schema or API
  changes; minor bumps add columns/endpoints; patch bumps fix bugs only.

## Standard upgrade procedure

```bash
# 1. Snapshot the database (the appliance does this nightly; trigger an
#    on-demand backup via the admin → Backup panel or:
docker exec vibe-api node /app/ops/scripts/backup.js

# 2. Pull the new image.
docker compose -f ops/docker/docker-compose.prod.yml pull

# 3. Stop the running app + worker, leaving Postgres + Redis up.
docker compose -f ops/docker/docker-compose.prod.yml stop api worker web portal

# 4. Run pending migrations (idempotent).
docker compose -f ops/docker/docker-compose.prod.yml run --rm api node /app/scripts/migrate.js

# 5. Bring everything back up.
docker compose -f ops/docker/docker-compose.prod.yml up -d

# 6. Verify.
curl https://app.firm.com/health/ready
```

## Migrations folder

Each migration lives at `packages/db/migrations/NNNN_name.sql`. Drizzle
tracks applied migrations in `__drizzle_migrations`. Re-running the
migrator is a no-op for already-applied migrations.

## Rollback

A rollback **always** means restoring the most recent backup taken
**before** the upgrade. SQL migrations are not reversed:

```bash
# Stop everything.
docker compose down

# Restore the backup. See ops/docs/restore.md for the full procedure.
docker run --rm -v $PWD/backups:/backups -v vibe_pgdata:/var/lib/postgresql/data \
  postgres:16 pg_restore --clean --if-exists -d vibe -h localhost ...

# Re-pull the previous image tag and bring it back up.
docker compose pull
docker compose up -d
```

## Compatibility windows

- `v0.x`: each minor (`v0.1` → `v0.2`) supports rollback only via backup.
- Future `v1+` LTS branches will support **N-1 minor rollback** for 12
  months after the next-minor release.

## Health-check policy

After every upgrade, watch:

1. `/health` — should respond 200 within 5 seconds (Docker HEALTHCHECK).
2. `/health/ready` — db + redis ready, providers wired.
3. Recent worker job runs in admin → Jobs (BullMQ stats).
4. The pre-bill totals on the Dashboard match the pre-upgrade baseline
   (within ±1 cent for floating-point rounding).

If any of these regress: stop the app, restore the backup, contact
support with the audit log export from the affected window.
