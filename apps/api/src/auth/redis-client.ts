// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { Redis } from 'ioredis';

import { loadConfig } from '../config';
import { logger } from '../logger';

let cached: Redis | null = null;

export function getRedis(): Redis {
  if (cached) return cached;
  const cfg = loadConfig();
  const client = new Redis(cfg.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
  });
  client.on('error', (err) => {
    logger.error({ err }, 'redis error');
  });
  cached = client;
  return cached;
}

export async function disconnectRedis(): Promise<void> {
  if (cached) {
    await cached.quit();
    cached = null;
  }
}
