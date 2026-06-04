// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Phase B — public intake router shell. Verifies the health probe, the
// credential-less CORS gate (incl. OPTIONS preflight), and the per-IP
// rate limit's 429 once the window ceiling is exceeded.

import { describe, expect, it, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';

import { createIntakePublicRouter } from '../intake/public-routes';

let redis: Redis;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/public/intake', createIntakePublicRouter({ db: null, redis }));
  return app;
}

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
});

describe('intake public router', () => {
  it('health returns ok', async () => {
    const res = await request(buildApp()).get('/api/public/intake/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('reflects the request Origin without allowing credentials', async () => {
    const res = await request(buildApp())
      .get('/api/public/intake/health')
      .set('Origin', 'https://intake.firm.example');
    expect(res.headers['access-control-allow-origin']).toBe('https://intake.firm.example');
    expect(res.headers['access-control-allow-credentials']).toBe('false');
  });

  it('answers OPTIONS preflight with 204', async () => {
    const res = await request(buildApp())
      .options('/api/public/intake/health')
      .set('Origin', 'https://intake.firm.example');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it('rate-limits a single IP past the window ceiling', async () => {
    const app = buildApp();
    // The router caps at 120/min/IP. Drive past it; supertest reuses a
    // fresh socket each call, so set X-Forwarded-For to pin the IP.
    let saw429 = false;
    for (let i = 0; i < 125; i += 1) {
      const res = await request(app)
        .get('/api/public/intake/health')
        .set('X-Forwarded-For', '203.0.113.7');
      if (res.status === 429) {
        saw429 = true;
        expect(res.body).toEqual({ error: 'rate_limited' });
        expect(res.headers['retry-after']).toBeDefined();
        break;
      }
    }
    expect(saw429).toBe(true);
  });
});
