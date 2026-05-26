// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P19 — Caddy on-demand TLS ask endpoint tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createCaddyRouter } from '../caddy/routes';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

function buildApp(): express.Express {
  const app = express();
  app.use('/v1/internal', createCaddyRouter({ db: harness.db }));
  return app;
}

async function seedFirmWithDomain(domain: string, verified: boolean): Promise<string> {
  const seed = await seedMinimalFirm(harness.db);
  if (verified) {
    await harness.db.execute(
      sql`INSERT INTO firm_settings_proposals (firm_id, custom_domain, custom_domain_verified_at)
          VALUES (${seed.firmId}, ${domain}, NOW())`,
    );
  } else {
    await harness.db.execute(
      sql`INSERT INTO firm_settings_proposals (firm_id, custom_domain)
          VALUES (${seed.firmId}, ${domain})`,
    );
  }
  return seed.firmId;
}

describe('P19 — caddy-ask', () => {
  it('200 when domain is registered + verified', async () => {
    await seedFirmWithDomain('portal.acme-cpa.example.com', true);
    const app = buildApp();
    const r = await request(app).get('/v1/internal/caddy-ask?domain=portal.acme-cpa.example.com');
    expect(r.status).toBe(200);
  });

  it('403 when domain is registered but not verified', async () => {
    await seedFirmWithDomain('portal.unverified.example.com', false);
    const app = buildApp();
    const r = await request(app).get('/v1/internal/caddy-ask?domain=portal.unverified.example.com');
    expect(r.status).toBe(403);
  });

  it('403 on unknown domain', async () => {
    await seedFirmWithDomain('portal.known.example.com', true);
    const app = buildApp();
    const r = await request(app).get('/v1/internal/caddy-ask?domain=portal.attacker.example.com');
    expect(r.status).toBe(403);
  });

  it('400 when domain is missing', async () => {
    const app = buildApp();
    const r = await request(app).get('/v1/internal/caddy-ask');
    expect(r.status).toBe(400);
  });

  it('403 on malformed hostnames', async () => {
    const app = buildApp();
    expect((await request(app).get('/v1/internal/caddy-ask?domain=not-a-domain')).status).toBe(403);
    expect((await request(app).get('/v1/internal/caddy-ask?domain=192.168.1.1')).status).toBe(403);
    expect(
      (await request(app).get('/v1/internal/caddy-ask?domain=evil%20domain.example.com')).status,
    ).toBe(403);
  });

  it('domain matching is case-insensitive', async () => {
    await seedFirmWithDomain('portal.acme.example.com', true);
    const app = buildApp();
    const r = await request(app).get('/v1/internal/caddy-ask?domain=PORTAL.ACME.EXAMPLE.COM');
    expect(r.status).toBe(200);
  });

  it('503 when db is unavailable', async () => {
    const app = express();
    app.use('/v1/internal', createCaddyRouter({ db: null }));
    const r = await request(app).get('/v1/internal/caddy-ask?domain=portal.example.com');
    expect(r.status).toBe(503);
  });
});
