// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { createApp } from './app';
import { loadConfig } from './config';
import { logger } from './logger';
import { getRedis } from './auth/redis-client';
import { createSessionStore } from './auth/session-store';
import { createDb } from '@vibe/db';

const config = loadConfig();
const redis = getRedis();
const { db } = createDb({ connectionString: config.DATABASE_URL });
const sessionStore = createSessionStore(redis);

const app = createApp({ db, redis, sessionStore });

app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'vibe-tb-api listening');
});
