// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { resetConfigForTests } from '../config';

describe('GET /health', () => {
  beforeAll(() => {
    process.env['NODE_ENV'] = 'test';
    process.env['STAFF_JWT_SECRET'] = 'test-staff-secret-1234567890';
    process.env['PORTAL_JWT_SECRET'] = 'test-portal-secret-1234567890';
    process.env['DATABASE_URL'] = 'postgresql://vibe:vibe@localhost:5432/vibe_tb_test';
    resetConfigForTests();
  });

  it('returns ok status', async () => {
    const app = createApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('vibe-time-billing-api');
  });

  it('reports portalEnabled flag based on commercial license token', async () => {
    delete process.env['COMMERCIAL_LICENSE_TOKEN'];
    resetConfigForTests();
    const res = await request(createApp()).get('/health');
    expect(res.body.portalEnabled).toBe(false);
  });
});
