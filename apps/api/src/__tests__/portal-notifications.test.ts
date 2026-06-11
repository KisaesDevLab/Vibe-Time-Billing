// SPDX-License-Identifier: Elastic-2.0
//
// 0146 — portal in-app notifications. Verifies scoping: a portal
// identity only sees rows addressed to it AND to the session's active
// client (multi-entity identities don't leak notices across entities,
// and identity A can never read or mark identity B's rows).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type express from 'express';

import { clients, portalIdentity, portalNotifications } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createPortalNotificationRouter } from '../portal/notifications';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
}
function makeRes(): FakeRes {
  return {
    statusCode: 200,
    jsonBody: undefined,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.jsonBody = b;
      return this;
    },
  };
}

async function invoke(
  router: express.Router,
  method: 'get' | 'post',
  path: string,
  req: Record<string, unknown>,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const chain = route.stack;
  for (let i = 0; i < chain.length - 1; i++) {
    let advanced = false;
    await (chain[i]!.handle as (rq: unknown, rs: unknown, nx: () => void) => unknown)(
      req,
      res,
      () => {
        advanced = true;
      },
    );
    if (!advanced) return res;
  }
  await (chain[chain.length - 1]!.handle as (rq: unknown, rs: unknown) => unknown)(req, res);
  return res;
}

function portalReq(
  identityId: string,
  activeClientId: string,
  opts: { params?: Record<string, string>; query?: Record<string, string> } = {},
): Record<string, unknown> {
  return {
    body: {},
    params: opts.params ?? {},
    query: opts.query ?? {},
    headers: {},
    portalSession: { portalIdentityId: identityId, activeClientId, firmId: seed.firmId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
}

function router() {
  return createPortalNotificationRouter({
    db: harness.db,
    requireAuth: (_req, _res, next) => next(),
  });
}

async function makeIdentity(name: string): Promise<string> {
  const [i] = await harness.db
    .insert(portalIdentity)
    .values({ firmId: seed.firmId, fullName: name, primaryEmail: `${name}@example.com` })
    .returning({ id: portalIdentity.id });
  return i!.id;
}

async function insertNotification(identityId: string, clientId: string, title: string) {
  const [n] = await harness.db
    .insert(portalNotifications)
    .values({
      firmId: seed.firmId,
      clientId,
      portalIdentityId: identityId,
      type: 'ENGAGEMENT_STATUS',
      title,
      body: 'b',
    })
    .returning({ id: portalNotifications.id });
  return n!.id;
}

describe('portal notifications', () => {
  it('lists only rows for the identity AND active client; unread-count matches', async () => {
    const lisa = await makeIdentity('lisa');
    const bob = await makeIdentity('bob');
    const [otherClient] = await harness.db
      .insert(clients)
      .values({
        firmId: seed.firmId,
        name: 'Second Entity LLC',
        partnerInChargeId: seed.appUserId,
        officeId: (
          await harness.db
            .select({ officeId: clients.officeId })
            .from(clients)
            .where(eq(clients.id, seed.clientId))
        )[0]!.officeId,
      })
      .returning({ id: clients.id });

    await insertNotification(lisa, seed.clientId, 'for lisa / client A');
    await insertNotification(lisa, otherClient!.id, 'for lisa / client B');
    await insertNotification(bob, seed.clientId, 'for bob / client A');

    const r = router();
    const list = await invoke(r, 'get', '/', portalReq(lisa, seed.clientId));
    const items = (list.jsonBody as { items: Array<{ title: string }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('for lisa / client A');

    const count = await invoke(r, 'get', '/unread-count', portalReq(lisa, seed.clientId));
    expect(count.jsonBody).toMatchObject({ count: 1 });
  });

  it('read marks only own rows; cross-identity read 404s', async () => {
    const lisa = await makeIdentity('lisa');
    const bob = await makeIdentity('bob');
    const lisaRow = await insertNotification(lisa, seed.clientId, 'lisa row');

    const r = router();
    const cross = await invoke(
      r,
      'post',
      '/:id/read',
      portalReq(bob, seed.clientId, { params: { id: lisaRow } }),
    );
    expect(cross.statusCode).toBe(404);

    const own = await invoke(
      r,
      'post',
      '/:id/read',
      portalReq(lisa, seed.clientId, { params: { id: lisaRow } }),
    );
    expect(own.statusCode).toBe(200);
    const [row] = await harness.db
      .select()
      .from(portalNotifications)
      .where(eq(portalNotifications.id, lisaRow));
    expect(row!.status).toBe('READ');
    expect(row!.readAt).not.toBeNull();
  });

  it('read-all only touches the active client', async () => {
    const lisa = await makeIdentity('lisa');
    const [otherClient] = await harness.db
      .insert(clients)
      .values({
        firmId: seed.firmId,
        name: 'Second Entity LLC',
        partnerInChargeId: seed.appUserId,
        officeId: (
          await harness.db
            .select({ officeId: clients.officeId })
            .from(clients)
            .where(eq(clients.id, seed.clientId))
        )[0]!.officeId,
      })
      .returning({ id: clients.id });
    await insertNotification(lisa, seed.clientId, 'A');
    await insertNotification(lisa, otherClient!.id, 'B');

    const r = router();
    await invoke(r, 'post', '/read-all', portalReq(lisa, seed.clientId));
    const rows = await harness.db
      .select()
      .from(portalNotifications)
      .where(eq(portalNotifications.portalIdentityId, lisa));
    expect(rows.find((x) => x.title === 'A')!.status).toBe('READ');
    expect(rows.find((x) => x.title === 'B')!.status).toBe('UNREAD');
  });
});
