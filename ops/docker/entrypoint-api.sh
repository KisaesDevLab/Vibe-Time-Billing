#!/bin/sh
# SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
#
# Production API entrypoint. Runs migrations once at boot, then starts the
# Express server. Idempotent — `pnpm db:migrate` tracks applied filenames
# in schema_migrations so re-runs are safe.

set -eu

cd /app

# Node 24 ESM needs help resolving the moduleResolution=Bundler output:
#   1. --experimental-transform-types lets it execute the .ts files that
#      workspace packages' package.json `main` fields point at
#      (the repo intentionally doesn't ship pre-compiled package dists).
#   2. --import of the resolve hook adds extension probing for the
#      extensionless relative imports that Bundler resolution preserves.
NODE_FLAGS="--experimental-transform-types --no-warnings=ExperimentalWarning --import /app/ops/docker/esm-resolve-hook.mjs"

echo "vibe-tb-api: applying migrations…"
node $NODE_FLAGS packages/db/dist/scripts/migrate.js
echo "vibe-tb-api: migrations done. starting server."
# tsc's rootDir auto-rises when @vibe/* path aliases pull source from
# other workspace packages, so the api entrypoint lands at
# apps/api/dist/apps/api/src/server.js (not apps/api/dist/server.js).
exec node $NODE_FLAGS apps/api/dist/apps/api/src/server.js
