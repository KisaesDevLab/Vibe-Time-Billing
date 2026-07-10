// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Client name is unique within a firm among non-archived clients
// (case-insensitive, trimmed). Create + rename both reject a duplicate
// with 409 duplicate_name; archived names free up; the client-facing
// name is unaffected.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';

import { clients } from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createClientRouter } from '../clients/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

function app(): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  const roles = new Map<string, RoleSlug[]>([[seed.appUserId, ['admin']]]);
  a.use('/api/staff/clients', createClientRouter({ db: harness.db, fakeUserRoles: roles }));
  return a;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('client duplicate-name guard', () => {
  it('creates the first client, then 409s an exact duplicate', async () => {
    const a = app();
    const first = await request(a)
      .post('/api/staff/clients')
      .send({ name: 'Allen, David', partnerInChargeId: seed.appUserId });
    expect(first.status).toBe(201);

    const dup = await request(a)
      .post('/api/staff/clients')
      .send({ name: 'Allen, David', partnerInChargeId: seed.appUserId });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('duplicate_name');
  });

  it('is case-insensitive and trims surrounding whitespace', async () => {
    const a = app();
    await request(a)
      .post('/api/staff/clients')
      .send({ name: 'Acme Co', partnerInChargeId: seed.appUserId });
    const dup = await request(a)
      .post('/api/staff/clients')
      .send({ name: '  acme co  ', partnerInChargeId: seed.appUserId });
    expect(dup.status).toBe(409);
  });

  it('allows reusing a name once the original is archived', async () => {
    const a = app();
    const first = await request(a)
      .post('/api/staff/clients')
      .send({ name: 'Reuse Me', partnerInChargeId: seed.appUserId });
    const id = first.body.id as string;
    await harness.db.update(clients).set({ status: 'ARCHIVED' }).where(eq(clients.id, id));

    const again = await request(a)
      .post('/api/staff/clients')
      .send({ name: 'Reuse Me', partnerInChargeId: seed.appUserId });
    expect(again.status).toBe(201);
  });

  it('rename: 409s when colliding with another client; allows self / unique', async () => {
    const a = app();
    const one = await request(a)
      .post('/api/staff/clients')
      .send({ name: 'One Co', partnerInChargeId: seed.appUserId });
    const two = await request(a)
      .post('/api/staff/clients')
      .send({ name: 'Two Co', partnerInChargeId: seed.appUserId });
    const oneId = one.body.id as string;
    const twoId = two.body.id as string;

    const collide = await request(a).patch(`/api/staff/clients/${twoId}`).send({ name: 'One Co' });
    expect(collide.status).toBe(409);
    expect(collide.body.error).toBe('duplicate_name');

    // Renaming a client to its own name (a no-op-ish change) is fine.
    const self = await request(a).patch(`/api/staff/clients/${oneId}`).send({ name: 'One Co' });
    expect(self.status).toBe(200);

    // A genuinely new unique name is fine.
    const ok = await request(a).patch(`/api/staff/clients/${twoId}`).send({ name: 'Three Co' });
    expect(ok.status).toBe(200);
  });

  it('stores the trimmed name', async () => {
    const a = app();
    const r = await request(a)
      .post('/api/staff/clients')
      .send({ name: '  Spaced Out  ', partnerInChargeId: seed.appUserId });
    const [row] = await harness.db
      .select({ name: clients.name })
      .from(clients)
      .where(eq(clients.id, r.body.id as string));
    expect(row!.name).toBe('Spaced Out');
  });
});
