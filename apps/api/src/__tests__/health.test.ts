// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, it, expect } from 'vitest';
import request from 'supertest';

import { buildTestApp } from './_test-app';

describe('GET /health', () => {
  it('returns ok status', async () => {
    const { app } = await buildTestApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('vibe-time-billing-api');
  });

  it('reports the portal as enabled (no license token since the PSBL relicense)', async () => {
    const { app } = await buildTestApp();
    const res = await request(app).get('/health');
    expect(res.body.portalEnabled).toBe(true);
  });
});
