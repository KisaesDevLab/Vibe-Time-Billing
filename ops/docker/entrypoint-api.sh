#!/bin/sh
# SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
#
# Production API entrypoint. Runs migrations once at boot, then starts the
# Express server. Idempotent — `pnpm db:migrate` tracks applied filenames
# in schema_migrations so re-runs are safe.

set -eu

cd /app
echo "vibe-tb-api: applying migrations…"
node packages/db/dist/scripts/migrate.js
echo "vibe-tb-api: migrations done. starting server."
exec node apps/api/dist/server.js
