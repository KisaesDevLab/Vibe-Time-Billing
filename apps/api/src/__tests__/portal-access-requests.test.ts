// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Self-service portal access requests (0143): the public submission
// endpoint matches a firm person and fans out one PENDING request per
// client (enumeration-safe), and the staff endpoints list / approve (grant
// access) / deny.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { and, eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import {
  clientContacts,
  clientPortalAccess,
  portalAccessRequest,
  portalIdentity,
} from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  type PgliteHarness,
} from './_pglite-harness';
import { createPortalAccessRequestPublicRouter } from '../portal-access-requests/public-routes';
import { createPortalAccessRequestRouter } from '../portal-access-requests/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

// In-memory sliding-window store implementing the RateLimiterDeps surface.
function fakeRedis(): Redis {
  const store = new Map<string, number[]>();
  return {
    zadd: async (k: string, score: number) => {
      const a = store.get(k) ?? [];
      a.push(score);
      store.set(k, a);
      return 1;
    },
    zremrangebyscore: async (k: string, min: number, max: number) => {
      const a = store.get(k) ?? [];
      store.set(
        k,
        a.filter((s) => s < min || s > max),
      );
      return 0;
    },
    zcard: async (k: string) => (store.get(k) ?? []).length,
    expire: async () => 1,
  } as unknown as Redis;
}

function app(): express.Express {
  const a = express();
  a.use(express.json());
  a.use(
    '/api/portal/access-request',
    createPortalAccessRequestPublicRouter({
      db: harness.db,
      redis: fakeRedis(),
    }),
  );
  a.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  const roles = new Map([[seed.appUserId, ['admin' as const]]]);
  a.use(
    '/api/staff/portal-access-requests',
    createPortalAccessRequestRouter({
      db: harness.db,
      fakeUserRoles: roles,
      portalBaseUrl: 'https://portal.example.com',
    }),
  );
  return a;
}

async function secondClient(): Promise<string> {
  const r0 = (await harness.db.execute(
    sql`SELECT office_id FROM client WHERE id = ${seed.clientId}`,
  )) as unknown as { rows: { office_id: string }[] };
  const officeId = r0.rows[0]!.office_id;
  const r = (await harness.db.execute(
    sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
        VALUES (${seed.firmId}, 'Second Client Co', ${seed.appUserId}, ${officeId})
        RETURNING id`,
  )) as unknown as { rows: { id: string }[] };
  return r.rows[0]!.id;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

const submit = (body: Record<string, unknown>) =>
  request(app()).post('/api/portal/access-request').send(body);

describe('portal access request — public submission (0143)', () => {
  it('queues a PENDING request when the email matches a firm person', async () => {
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Al Pott',
      email: 'al@x.com',
    });
    const res = await submit({ contact: 'al@x.com', idType: 'SSN_LAST4', idValue: '1234' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const rows = await harness.db
      .select()
      .from(portalAccessRequest)
      .where(eq(portalAccessRequest.personId, personId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('PENDING');
    expect(rows[0]!.clientId).toBe(seed.clientId);
    expect(rows[0]!.idType).toBe('SSN_LAST4');
    expect(rows[0]!.idValue).toBe('1234');
  });

  it('returns the same generic response and creates nothing for an unmatched contact', async () => {
    const res = await submit({ contact: 'nobody@x.com', idType: 'SSN_LAST4', idValue: '0000' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const rows = await harness.db.select().from(portalAccessRequest);
    expect(rows).toHaveLength(0);
  });

  it('rejects a malformed verification id', async () => {
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Bo Vine',
      email: 'bo@x.com',
    });
    const res = await submit({ contact: 'bo@x.com', idType: 'SSN_LAST4', idValue: '12' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_id');
  });

  it('fans out one request per client the person is a contact of', async () => {
    const c2 = await secondClient();
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Di Vine',
      email: 'di@x.com',
    });
    // Same person is also a contact of c2.
    await harness.db.insert(clientContacts).values({ clientId: c2, personId });

    const res = await submit({ contact: 'di@x.com', idType: 'EIN', idValue: '6789' });
    expect(res.status).toBe(200);

    const rows = await harness.db
      .select({
        clientId: portalAccessRequest.clientId,
        submissionId: portalAccessRequest.submissionId,
      })
      .from(portalAccessRequest)
      .where(eq(portalAccessRequest.personId, personId));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.clientId))).toEqual(new Set([seed.clientId, c2]));
    expect(new Set(rows.map((r) => r.submissionId)).size).toBe(1); // one submission
  });

  it('is idempotent — re-submitting does not duplicate the pending row', async () => {
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Re Peat',
      email: 're@x.com',
    });
    await submit({ contact: 're@x.com', idType: 'SSN_LAST4', idValue: '1111' });
    await submit({ contact: 're@x.com', idType: 'SSN_LAST4', idValue: '1111' });
    const rows = await harness.db
      .select()
      .from(portalAccessRequest)
      .where(eq(portalAccessRequest.personId, personId));
    expect(rows).toHaveLength(1);
  });

  it('matches by phone too', async () => {
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Ph One',
      phone: '+13125550148',
    });
    const res = await submit({ contact: '(312) 555-0148', idType: 'SSN_LAST4', idValue: '4321' });
    expect(res.status).toBe(200);
    const rows = await harness.db
      .select()
      .from(portalAccessRequest)
      .where(eq(portalAccessRequest.personId, personId));
    expect(rows).toHaveLength(1);
  });
});

describe('portal access request — staff review (0143)', () => {
  it('lists pending requests with person + client + id', async () => {
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Lister Lee',
      email: 'lee@x.com',
    });
    await submit({ contact: 'lee@x.com', idType: 'SSN_LAST4', idValue: '9999' });

    const res = await request(app()).get('/api/staff/portal-access-requests');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].personName).toBe('Lister Lee');
    expect(res.body.items[0].clientName).toBe('Test Client Co');
    expect(res.body.items[0].email).toBe('lee@x.com');
    expect(res.body.items[0].idValue).toBe('9999');
  });

  it('approves at a chosen role — grants ACTIVE access to an existing identity', async () => {
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'App Rove',
      email: 'rove@x.com',
    });
    // Existing portal identity → grant is immediate (ACTIVE) rather than invite.
    await harness.db
      .insert(portalIdentity)
      .values({ firmId: seed.firmId, fullName: 'App Rove', primaryEmail: 'rove@x.com', personId });
    await submit({ contact: 'rove@x.com', idType: 'SSN_LAST4', idValue: '2468' });

    const [reqRow] = await harness.db
      .select({ id: portalAccessRequest.id })
      .from(portalAccessRequest)
      .where(eq(portalAccessRequest.personId, personId));
    const res = await request(app())
      .post(`/api/staff/portal-access-requests/${reqRow!.id}/approve`)
      .send({ role: 'VIEW_ONLY' });
    expect(res.status).toBe(200);

    const [updated] = await harness.db
      .select({ status: portalAccessRequest.status })
      .from(portalAccessRequest)
      .where(eq(portalAccessRequest.id, reqRow!.id));
    expect(updated!.status).toBe('APPROVED');

    const access = await harness.db
      .select({ role: clientPortalAccess.role, status: clientPortalAccess.status })
      .from(clientPortalAccess)
      .where(eq(clientPortalAccess.clientId, seed.clientId));
    expect(access).toHaveLength(1);
    expect(access[0]!.status).toBe('ACTIVE');
    expect(access[0]!.role).toBe('VIEW_ONLY');
  });

  it('denies a request without granting access', async () => {
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'De Ny',
      email: 'deny@x.com',
    });
    await submit({ contact: 'deny@x.com', idType: 'SSN_LAST4', idValue: '3690' });
    const [reqRow] = await harness.db
      .select({ id: portalAccessRequest.id })
      .from(portalAccessRequest)
      .where(eq(portalAccessRequest.personId, personId));

    const res = await request(app())
      .post(`/api/staff/portal-access-requests/${reqRow!.id}/deny`)
      .send({});
    expect(res.status).toBe(200);

    const [updated] = await harness.db
      .select({ status: portalAccessRequest.status })
      .from(portalAccessRequest)
      .where(eq(portalAccessRequest.id, reqRow!.id));
    expect(updated!.status).toBe('DENIED');
    const access = await harness.db.select().from(clientPortalAccess);
    expect(access).toHaveLength(0);
  });

  it('409s when deciding an already-decided request', async () => {
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'On Ce',
      email: 'once@x.com',
    });
    await submit({ contact: 'once@x.com', idType: 'EIN', idValue: '9999' });
    const [reqRow] = await harness.db
      .select({ id: portalAccessRequest.id })
      .from(portalAccessRequest)
      .where(eq(portalAccessRequest.status, 'PENDING'));
    await request(app()).post(`/api/staff/portal-access-requests/${reqRow!.id}/deny`).send({});
    const again = await request(app())
      .post(`/api/staff/portal-access-requests/${reqRow!.id}/approve`)
      .send({ role: 'FULL' });
    expect(again.status).toBe(409);
  });

  it('does not queue a client where the person already has active access', async () => {
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Al Ready',
      email: 'ready@x.com',
    });
    const [identity] = await harness.db
      .insert(portalIdentity)
      .values({ firmId: seed.firmId, fullName: 'Al Ready', primaryEmail: 'ready@x.com', personId })
      .returning({ id: portalIdentity.id });
    await harness.db.insert(clientPortalAccess).values({
      portalIdentityId: identity!.id,
      clientId: seed.clientId,
      role: 'FULL',
      status: 'ACTIVE',
    });
    await submit({ contact: 'ready@x.com', idType: 'SSN_LAST4', idValue: '1212' });
    const rows = await harness.db
      .select()
      .from(portalAccessRequest)
      .where(and(eq(portalAccessRequest.personId, personId)));
    expect(rows).toHaveLength(0);
  });
});
