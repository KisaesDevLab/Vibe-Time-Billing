// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import express, { type Express, type Request, type Response } from 'express';
import pinoHttp from 'pino-http';

import { loadConfig } from './config';
import { logger } from './logger';

export function createApp(): Express {
  const config = loadConfig();
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'vibe-time-billing-api',
      env: config.NODE_ENV,
      portalEnabled: Boolean(config.COMMERCIAL_LICENSE_TOKEN),
    });
  });

  return app;
}
