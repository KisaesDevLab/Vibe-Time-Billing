// SPDX-License-Identifier: Elastic-2.0
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

  it('reports portalEnabled flag based on commercial license token', async () => {
    delete process.env['COMMERCIAL_LICENSE_TOKEN'];
    const { app } = await buildTestApp();
    const res = await request(app).get('/health');
    expect(res.body.portalEnabled).toBe(false);
  });
});
