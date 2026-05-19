// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// BullMQ worker entrypoint. Phase 10/11/15/17 wire up scheduled jobs:
// recurring billing, pre-bill rollups, AR aging snapshots, materialized
// view refreshes. This boot file establishes the Redis connection and
// will register queues as those phases land.

import { pino } from 'pino';

const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: { service: 'vibe-tb-worker' },
});

const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

async function main(): Promise<void> {
  logger.info({ redisUrl }, 'vibe-tb-worker booted (no queues registered yet)');
  // Keep the process alive so Docker doesn't restart it. Queue
  // registrations will land in Phase 10.
  await new Promise<void>(() => {});
}

main().catch((err: unknown) => {
  logger.error({ err }, 'worker fatal');
  process.exit(1);
});
