// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { createApp } from './app';
import { loadConfig } from './config';
import { logger } from './logger';

const config = loadConfig();
const app = createApp();

app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'vibe-tb-api listening');
});
