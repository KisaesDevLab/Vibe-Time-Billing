// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CAL-1 — provider config admin API: save encrypts under the firm MFK and
// never returns secrets; secret is preserved on edits when omitted; Test
// Connection drives the provider token probe (mocked).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { calendarProviderConfig } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import { createCalendarAdminRouter } from '../calendar/admin-routes';
import { unwrapCalendarRecordKey, decField } from '../calendar/crypto';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let sealDir: string;

// Mocked provider token endpoints: Microsoft returns a token; Google
// returns invalid_grant (creds accepted) unless the secret is 'bad'.
const mockFetch: typeof fetch = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  const body = String(init?.body ?? '');
  if (u.includes('login.microsoftonline.com')) {
    if (body.includes('client_secret=good')) {
      return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 });
  }
  if (u.includes('oauth2.googleapis.com')) {
    if (body.includes('client_secret=bad')) {
      return new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 });
    }
    return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
  }
  return new Response('{}', { status: 200 });
}) as unknown as typeof fetch;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  app.use(
    '/api/staff/admin/calendar',
    createCalendarAdminRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['admin']]]),
      testFetch: mockFetch,
    }),
  );
  return app;
}

beforeEach(async () => {
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-cal-admin-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  await getFirmKeyManager(harness.db).bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
  setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
});
afterEach(async () => {
  resetFirmKeyManagerForTests();
  await harness.close();
  await rm(sealDir, { recursive: true, force: true });
});

describe('calendar provider admin API (CAL-1)', () => {
  it('saves an encrypted Microsoft config and never returns the secret', async () => {
    const app = buildApp();
    const put = await request(app)
      .put('/api/staff/admin/calendar/providers/microsoft')
      .send({ clientId: 'azure-cid', clientSecret: 'good', tenantId: 'tid', enabled: true });
    expect(put.status).toBe(200);

    const list = await request(app).get('/api/staff/admin/calendar/providers');
    expect(list.status).toBe(200);
    const ms = list.body.providers.find((p: { provider: string }) => p.provider === 'microsoft');
    expect(ms).toMatchObject({ configured: true, enabled: true, hasTenant: true });
    // No secret material in the response.
    expect(JSON.stringify(list.body)).not.toContain('good');
    expect(JSON.stringify(list.body)).not.toContain('azure-cid');

    // Stored ciphertext decrypts back to the inputs.
    const [row] = await harness.db
      .select()
      .from(calendarProviderConfig)
      .where(eq(calendarProviderConfig.firmId, seed.firmId));
    const dek = unwrapCalendarRecordKey(harness.db, seed.firmId, row!.tDekWrapped);
    expect(decField(dek, row!.clientIdEnc)).toBe('azure-cid');
    expect(decField(dek, row!.clientSecretEnc)).toBe('good');
  });

  it('preserves the stored secret when omitted on a later edit', async () => {
    const app = buildApp();
    await request(app)
      .put('/api/staff/admin/calendar/providers/google')
      .send({ clientId: 'g-cid', clientSecret: 'g-secret', enabled: false });
    // Toggle enabled without resending the secret.
    const put2 = await request(app)
      .put('/api/staff/admin/calendar/providers/google')
      .send({ clientId: 'g-cid', enabled: true });
    expect(put2.status).toBe(200);

    const [row] = await harness.db
      .select()
      .from(calendarProviderConfig)
      .where(eq(calendarProviderConfig.firmId, seed.firmId));
    const dek = unwrapCalendarRecordKey(harness.db, seed.firmId, row!.tDekWrapped);
    expect(row!.enabled).toBe(true);
    expect(decField(dek, row!.clientSecretEnc)).toBe('g-secret');
  });

  it('requires a tenant id for Microsoft', async () => {
    const app = buildApp();
    const res = await request(app)
      .put('/api/staff/admin/calendar/providers/microsoft')
      .send({ clientId: 'c', clientSecret: 's' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('tenant_id_required');
  });

  it('Test Connection passes for valid creds and fails for bad ones', async () => {
    const app = buildApp();
    const okMs = await request(app)
      .post('/api/staff/admin/calendar/providers/microsoft/test')
      .send({ clientId: 'c', clientSecret: 'good', tenantId: 't' });
    expect(okMs.body.ok).toBe(true);

    const badMs = await request(app)
      .post('/api/staff/admin/calendar/providers/microsoft/test')
      .send({ clientId: 'c', clientSecret: 'wrong', tenantId: 't' });
    expect(badMs.body.ok).toBe(false);

    const okG = await request(app)
      .post('/api/staff/admin/calendar/providers/google/test')
      .send({ clientId: 'c', clientSecret: 'anything' });
    expect(okG.body.ok).toBe(true);

    const badG = await request(app)
      .post('/api/staff/admin/calendar/providers/google/test')
      .send({ clientId: 'c', clientSecret: 'bad' });
    expect(badG.body.ok).toBe(false);
  });

  it('tests stored creds when the body omits them', async () => {
    const app = buildApp();
    await request(app)
      .put('/api/staff/admin/calendar/providers/microsoft')
      .send({ clientId: 'c', clientSecret: 'good', tenantId: 't', enabled: true });
    const res = await request(app)
      .post('/api/staff/admin/calendar/providers/microsoft/test')
      .send({});
    expect(res.body.ok).toBe(true);
  });
});
