---
title: 'Upgrades'
slug: upgrades
category: deployment
audience: staff
tags: ['upgrade', 'version', 'migration']
---

# Upgrades & migrations

Vibe Practice Management ships as a versioned Docker image. Database migrations run automatically at API boot, so a normal upgrade is "pull the new image and restart." Migrations are tracked and idempotent — re-running the migrator skips already-applied files. There is no automated down-migration: rollback always means restoring a backup taken before the upgrade.

## Steps

1. Take an on-demand backup before upgrading (in addition to the nightly job). See _Backups & restore_.
2. Pull the new image: `docker compose -f ops/docker/docker-compose.prod.yml pull` (controlled by the `TAG` env var, default `latest`).
3. Recreate the stack: `docker compose -f ops/docker/docker-compose.prod.yml up -d`. The `api` container's entrypoint applies migrations first, then starts the server; `init-static` re-copies the new dists so Caddy serves the new build.
4. Watch the API logs for the "applying migrations…" then "migrations done. starting server." lines.
5. Verify health: `/health` should return 200 within the Docker healthcheck window.

## Fields

- `TAG` — image tag to deploy; defaults to `latest`.
- `DATABASE_URL` — target the migrator runs against; required.
- `LOG_LEVEL` — set to `debug` for verbose migration output.

## What you'll see

- The migration runner creates a `schema_migrations` table (`filename`, `applied_at`), then applies any `packages/db/migrations/NNNN_name.sql` file not yet recorded, in lexical order. Already-applied files log `skip`; new ones log `apply`.
- Migrations are numbered SQL files (`0000_init_schema.sql` onward) and currently run to the high 0090s.

## Tips

- Migrations run on every boot but are safe to re-run — the `schema_migrations` ledger prevents double-application.
- Zero-data-loss note: the worker waits for the API to be healthy, and the API only serves after migrations complete, so requests never hit a half-migrated schema.
- Rollback: stop the stack, restore the pre-upgrade backup, re-pull the previous `TAG`, and bring it back up. SQL migrations are not reversed.
- After upgrading, spot-check worker jobs and that dashboard totals match the pre-upgrade baseline.
