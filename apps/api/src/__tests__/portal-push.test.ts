// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0161 — portal Web Push subscription router. Proves: /key reflects config;
// subscribe stores a row bound to the session identity; re-subscribing the same
// endpoint upserts (no duplicate); unsubscribe is scoped to the caller's
// identity; and a bad payload is rejected.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';

import { portalPushSubscription } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createPortalPushRouter } from '../portal/push';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let identityId: string;

function buildApp(opts: { pushEnabled?: boolean } = {}): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { portalSession: unknown }).portalSession = {
      firmId: seed.firmId,
      portalIdentityId: identityId,
      activeClientId: seed.clientId,
    };
    next();
  });
  app.use(
    '/api/portal/push',
    createPortalPushRouter({
      db: harness.db,
      requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
      vapidPublicKey: opts.pushEnabled === false ? undefined : 'TEST_PUBLIC_KEY',
      pushEnabled: opts.pushEnabled !== false,
    }),
  );
  return app;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  const r = await harness.db.execute(
    sql`INSERT INTO portal_identity (firm_id, full_name, primary_email)
        VALUES (${seed.firmId}, 'Pat Client', 'pat@client.example') RETURNING id`,
  );
  identityId = (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
});

afterEach(async () => {
  await harness.close();
});

const SUB = {
  endpoint: 'https://push.example.com/abc123',
  keys: { p256dh: 'pkey', auth: 'akey' },
};

describe('portal push router', () => {
  it('exposes the VAPID key + enabled flag', async () => {
    const res = await request(buildApp()).get('/api/portal/push/key');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, publicKey: 'TEST_PUBLIC_KEY' });

    const off = await request(buildApp({ pushEnabled: false })).get('/api/portal/push/key');
    expect(off.body).toEqual({ enabled: false, publicKey: null });
  });

  it('stores a subscription bound to the session identity', async () => {
    const res = await request(buildApp()).post('/api/portal/push/subscribe').send(SUB);
    expect(res.status).toBe(201);
    const rows = await harness.db.select().from(portalPushSubscription);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.endpoint).toBe(SUB.endpoint);
    expect(rows[0]!.portalIdentityId).toBe(identityId);
    expect(rows[0]!.p256dh).toBe('pkey');
  });

  it('upserts on re-subscribe (no duplicate endpoint)', async () => {
    const app = buildApp();
    await request(app).post('/api/portal/push/subscribe').send(SUB);
    await request(app)
      .post('/api/portal/push/subscribe')
      .send({ ...SUB, keys: { p256dh: 'pkey2', auth: 'akey2' } });
    const rows = await harness.db.select().from(portalPushSubscription);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.p256dh).toBe('pkey2');
  });

  it('unsubscribe removes the row', async () => {
    const app = buildApp();
    await request(app).post('/api/portal/push/subscribe').send(SUB);
    const del = await request(app)
      .delete('/api/portal/push/subscribe')
      .send({ endpoint: SUB.endpoint });
    expect(del.status).toBe(200);
    const rows = await harness.db
      .select()
      .from(portalPushSubscription)
      .where(eq(portalPushSubscription.endpoint, SUB.endpoint));
    expect(rows).toHaveLength(0);
  });

  it('rejects a malformed subscription', async () => {
    const res = await request(buildApp())
      .post('/api/portal/push/subscribe')
      .send({ endpoint: 'not-a-url' });
    expect(res.status).toBe(400);
  });
});
