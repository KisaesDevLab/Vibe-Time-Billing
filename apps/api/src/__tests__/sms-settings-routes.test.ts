// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0233 — Settings → SMS inbox routes: settings read/patch with validation,
// line sync from the Messaging Service (add / archive / first-is-default),
// line patch keeps exactly one default, and the test endpoint verifies
// the saved Twilio config against a stubbed Twilio.

import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { crypto as core } from '@vibe/core';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetKeyCacheForTests } from '../messaging/config';
import { syncLines } from '../sms/lines';
import { createSmsSettingsRouter } from '../sms/settings-routes';

const KMS_KEY = 'a'.repeat(64);
const AC = 'AC' + 'a'.repeat(32);
const MG = 'MG' + 'b'.repeat(32);

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  process.env['KMS_KEY'] = KMS_KEY;
  process.env['APP_BASE_URL'] = 'http://localhost:3001';
  resetKeyCacheForTests();
  await harness.db.execute(sql`INSERT INTO firm_settings (firm_id) VALUES (${seed.firmId})`);
});

afterEach(async () => {
  await harness.close();
});

function twilioStub(numbers: string[]): typeof fetch {
  return (async (url: string) => {
    const j = url.includes('/PhoneNumbers')
      ? { phone_numbers: numbers.map((n, i) => ({ sid: `PN${i}`, phone_number: n })), meta: {} }
      : url.includes('/Compliance/Usa2p')
        ? { compliance: [{ campaign_status: 'VERIFIED' }] }
        : url.includes('/v1/Services/')
          ? { sid: MG, friendly_name: 'Firm Service' }
          : { friendly_name: 'Test Account' };
    return { ok: true, status: 200, json: async () => j } as unknown as Response;
  }) as unknown as typeof fetch;
}

function app(fetchImpl: typeof fetch) {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    // reason: test stub — the real middleware attaches a full StaffSession
    req.staffSession = { firmId: seed.firmId, appUserId: seed.appUserId } as never;
    next();
  });
  a.use(
    '/settings',
    createSmsSettingsRouter({
      db: harness.db,
      fetchImpl,
      fakeUserRoles: new Map([[seed.appUserId, ['admin' as const]]]),
    }),
  );
  return a;
}

async function saveTwilioConfig(): Promise<void> {
  const envelope = core.encryptJson(
    { provider: 'twilio', accountSid: AC, authToken: 'token-12345', messagingServiceSid: MG },
    core.resolveKey(KMS_KEY),
  );
  await harness.db.execute(
    sql`UPDATE firm_settings SET sms_config_encrypted = ${envelope} WHERE firm_id = ${seed.firmId}`,
  );
}

describe('SMS inbox settings routes', () => {
  it('GET returns defaults, derived webhook URLs, and providerReady=false without twilio', async () => {
    const r = await request(app(twilioStub([]))).get('/settings');
    expect(r.status).toBe(200);
    expect(r.body.settings.enabled).toBe(false);
    expect(r.body.settings.providerReady).toBe(false);
    expect(r.body.settings.pollIntervalMinutes).toBe(2);
    expect(r.body.settings.webhookUrls.inbound).toBe(
      'http://localhost:3001/api/sms/twilio/inbound',
    );
    expect(r.body.settings.publicBaseUrlSource).toBe('app_base_url');
    expect(r.body.lines).toEqual([]);
  });

  it('PUT validates and persists, and the firm base URL wins for webhook URLs', async () => {
    const a = app(twilioStub([]));
    const bad = await request(a).put('/settings').send({ pollIntervalMinutes: 0 });
    expect(bad.status).toBe(400);
    const r = await request(a)
      .put('/settings')
      .send({ enabled: true, publicBaseUrl: 'https://practice.example/', pollIntervalMinutes: 5 });
    expect(r.status).toBe(200);
    expect(r.body.settings.enabled).toBe(true);
    expect(r.body.settings.publicBaseUrl).toBe('https://practice.example');
    expect(r.body.settings.webhookUrls.status).toBe(
      'https://practice.example/api/sms/twilio/status',
    );
    expect(r.body.settings.publicBaseUrlSource).toBe('firm');
    const audit = await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'sms_settings'`,
    );
    expect((audit as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(1);
  });

  it('syncs lines from the Messaging Service and picks a default', async () => {
    await saveTwilioConfig();
    const a = app(twilioStub(['+12025550100', '(202) 555-0101']));
    const r = await request(a).post('/settings/lines/sync');
    expect(r.status).toBe(200);
    expect(r.body.added).toBe(2);
    expect(r.body.items.map((l: { phoneNumberE164: string }) => l.phoneNumberE164)).toEqual([
      '+12025550100',
      '+12025550101',
    ]);
    expect(r.body.items.filter((l: { isDefault: boolean }) => l.isDefault)).toHaveLength(1);

    // Second sync with one number gone archives it and keeps a default.
    const res = await syncLines(
      harness.db,
      seed.firmId,
      [{ sid: 'PN1', phoneNumber: '+12025550101' }],
      new Date(),
    );
    expect(res.archived).toBe(1);
    const after = await request(a).get('/settings/lines');
    expect(after.body.items).toHaveLength(1);
    expect(after.body.items[0].isDefault).toBe(true);
  });

  it('PATCH line moves the default and archives on DELETE', async () => {
    await saveTwilioConfig();
    const a = app(twilioStub(['+12025550100', '+12025550101']));
    const synced = await request(a).post('/settings/lines/sync');
    const [l1, l2] = synced.body.items as Array<{ id: string; isDefault: boolean }>;
    expect(l1!.isDefault).toBe(true);
    const patched = await request(a).patch(`/settings/lines/${l2!.id}`).send({
      isDefault: true,
      label: 'Front desk',
      ingest: false,
      defaultAssigneeUserId: seed.appUserId,
    });
    expect(patched.status).toBe(200);
    const items = patched.body.items as Array<{
      id: string;
      isDefault: boolean;
      label: string | null;
      ingest: boolean;
      defaultAssigneeName: string | null;
    }>;
    expect(items.find((l) => l.id === l1!.id)!.isDefault).toBe(false);
    const p2 = items.find((l) => l.id === l2!.id)!;
    expect(p2.isDefault).toBe(true);
    expect(p2.label).toBe('Front desk');
    expect(p2.ingest).toBe(false);
    expect(p2.defaultAssigneeName).toBe('Sarah Chen');
    const del = await request(a).delete(`/settings/lines/${l1!.id}`);
    expect(del.status).toBe(200);
    expect((await request(a).get('/settings/lines')).body.items).toHaveLength(1);
  });

  it('POST /test verifies the saved config and reports the Messaging Service', async () => {
    await saveTwilioConfig();
    const r = await request(app(twilioStub(['+12025550100'])))
      .post('/settings/test')
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.accountName).toBe('Test Account');
    expect(r.body.messagingServiceFound).toBe(true);
    expect(r.body.lineCount).toBe(1);
  });

  it('POST /test rejects a non-twilio proposed config', async () => {
    const r = await request(app(twilioStub([])))
      .post('/settings/test')
      .send({ config: { provider: 'textlink', apiKey: 'k'.repeat(12) } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('inbox_requires_twilio');
  });

  it('a2p refresh stores the status', async () => {
    await saveTwilioConfig();
    const a = app(twilioStub([]));
    const r = await request(a).post('/settings/a2p/refresh');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('registered');
    const h = await request(a).get('/settings/health');
    expect(h.body.a2p.status).toBe('registered');
  });
});
