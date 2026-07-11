// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0208 — permanent firm-administrative engagement:
//  - time entries on it are forced non-billable (create ignores
//    billableFlag=true; PATCH refuses flipping it back on)
//  - its lifecycle status can never leave ACTIVE (single + bulk)
//  - the client that owns it can't be archived (single + bulk)

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type express from 'express';
import { eq } from 'drizzle-orm';

import {
  engagements,
  staffRateSnapshotEntries,
  staffRateSnapshots,
  timeEntries,
} from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createTimeEntryRouter } from '../time-entries/routes';
import { createEngagementRouter } from '../engagements/routes';
import { createClientRouter } from '../clients/routes';

let h: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  h = await buildPgliteHarness();
  seed = await seedMinimalFirm(h.db);
  // Flag the seed engagement as the firm-admin engagement and give the
  // user a rate so creates reach the insert.
  await h.db
    .update(engagements)
    .set({ firmAdmin: true, status: 'ACTIVE' })
    .where(eq(engagements.id, seed.engagementId));
  const [snap] = await h.db
    .insert(staffRateSnapshots)
    .values({ appUserId: seed.appUserId, effectiveDate: '2026-01-01', costRateCents: 12000 })
    .returning({ id: staffRateSnapshots.id });
  await h.db.insert(staffRateSnapshotEntries).values({
    snapshotId: snap!.id,
    rateCodeId: seed.rateCodeId,
    billRateCents: 30000,
  });
});
afterEach(async () => {
  await h.close();
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
  method: 'get' | 'post' | 'patch' | 'delete',
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
function req(body: unknown, params: Record<string, string> = {}): Record<string, unknown> {
  return {
    body: body ?? {},
    params,
    query: {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
}
const roles: RoleSlug[] = ['partner'];
const TODAY = new Date().toISOString().slice(0, 10);

function timeRouter() {
  return createTimeEntryRouter({
    db: h.db,
    fakeUserRoles: new Map([[seed.appUserId, roles]]),
  });
}
function engagementRouter() {
  return createEngagementRouter({
    db: h.db,
    fakeUserRoles: new Map([[seed.appUserId, roles]]),
  });
}
function clientRouter() {
  return createClientRouter({
    db: h.db,
    fakeUserRoles: new Map([[seed.appUserId, roles]]),
  });
}

describe('firm-admin engagement — non-billable enforcement', () => {
  it('create forces billableFlag=false even when the caller sends true', async () => {
    const r = await invoke(
      timeRouter(),
      'post',
      '/',
      req({ engagementId: seed.engagementId, entryDate: TODAY, hours: 1, billableFlag: true }),
    );
    expect(r.statusCode).toBe(201);
    const id = (r.jsonBody as { id: string }).id;
    const [row] = await h.db.select().from(timeEntries).where(eq(timeEntries.id, id));
    expect(row!.billableFlag).toBe(false);
  });

  it('PATCH refuses flipping billableFlag back on (409)', async () => {
    const c = await invoke(
      timeRouter(),
      'post',
      '/',
      req({ engagementId: seed.engagementId, entryDate: TODAY, hours: 1 }),
    );
    const id = (c.jsonBody as { id: string }).id;
    const r = await invoke(timeRouter(), 'patch', '/:id', req({ billableFlag: true }, { id }));
    expect(r.statusCode).toBe(409);
    expect((r.jsonBody as { error: string }).error).toBe('firm_admin_non_billable');
    // Other edits still work.
    const ok = await invoke(timeRouter(), 'patch', '/:id', req({ hours: 2 }, { id }));
    expect(ok.statusCode).toBe(200);
  });
});

describe('firm-admin engagement — permanent lifecycle', () => {
  it('single status change away from ACTIVE 409s', async () => {
    const r = await invoke(
      engagementRouter(),
      'patch',
      '/:id/status',
      req({ status: 'PAUSED' }, { id: seed.engagementId }),
    );
    expect(r.statusCode).toBe(409);
    expect((r.jsonBody as { error: string }).error).toBe('firm_admin_protected');
    const [eng] = await h.db
      .select({ status: engagements.status })
      .from(engagements)
      .where(eq(engagements.id, seed.engagementId));
    expect(eng!.status).toBe('ACTIVE');
  });

  it('bulk status change silently skips it', async () => {
    const r = await invoke(
      engagementRouter(),
      'post',
      '/bulk-status',
      req({ ids: [seed.engagementId], status: 'ARCHIVED' }),
    );
    expect(r.statusCode).toBe(200);
    const [eng] = await h.db
      .select({ status: engagements.status })
      .from(engagements)
      .where(eq(engagements.id, seed.engagementId));
    expect(eng!.status).toBe('ACTIVE');
  });
});

describe('firm-admin engagement — owning client is permanent', () => {
  it('single archive 409s', async () => {
    const r = await invoke(clientRouter(), 'patch', '/:id/archive', req({}, { id: seed.clientId }));
    expect(r.statusCode).toBe(409);
    expect((r.jsonBody as { error: string }).error).toBe('firm_admin_client');
  });

  it('bulk archive skips it', async () => {
    const r = await invoke(
      clientRouter(),
      'post',
      '/bulk-status',
      req({ clientIds: [seed.clientId], status: 'ARCHIVED' }),
    );
    expect(r.statusCode).toBe(200);
    expect((r.jsonBody as { updated: number }).updated).toBe(0);
  });
});
