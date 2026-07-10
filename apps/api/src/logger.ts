// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { pino } from 'pino';

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: { service: 'vibe-tb-api' },
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.token'],
    censor: '[REDACTED]',
  },
});
