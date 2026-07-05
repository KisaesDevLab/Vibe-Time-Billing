// SPDX-License-Identifier: Elastic-2.0
//
// Batched-entry guards on split and self-delete. Both endpoints used to
// archive entries checking only lockedAt/BILLED/LOCKED — an entry claimed
// by a billing batch (still SUBMITTED while the batch is in review) could
// be split, archiving the original while its hours re-entered open WIP as
// fresh unbatched children: the same time billed (and realized) twice.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type express from 'express';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createTimeEntryRouter } from '../time-entries/routes';

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
  method: 'post' | 'delete',
  path: string,
  req: Record<string, unknown>,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method.toUpperCase()} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

function rows<T = { id: string }>(r: unknown): T[] {
  return (r as { rows: T[] }).rows;
}

async function seedEntry(batched: boolean): Promise<string> {
  let batchId: string | null = null;
  if (batched) {
    batchId = rows(
      await harness.db.execute(sql`
        INSERT INTO billing_batch (engagement_id, period_start, period_end, status, created_by_id)
        VALUES (${seed.engagementId}, '2026-01-01', '2026-01-31', 'DRAFT', ${seed.appUserId})
        RETURNING id`),
    )[0]!.id;
  }
  return rows(
    await harness.db.execute(sql`
      INSERT INTO time_entry (engagement_id, app_user_id, work_code_id, entry_date, hours,
        standard_rate_snapshot_cents, standard_amount_cents, billing_batch_id)
      VALUES (${seed.engagementId}, ${seed.appUserId}, ${seed.workCodeId}, '2026-01-15', 2.0,
        50000, 100000, ${batchId})
      RETURNING id`),
  )[0]!.id;
}

function makeReq(id: string, body: unknown = {}): Record<string, unknown> {
  return {
    params: { id },
    body,
    query: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    get: () => undefined,
  };
}

describe('batched time-entry guards', () => {
  it('split refuses an entry claimed by a billing batch (409)', async () => {
    const teId = await seedEntry(true);
    const router = createTimeEntryRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const res = await invoke(
      router,
      'post',
      '/:id/split',
      makeReq(teId, { splits: [{ hours: 1 }, { hours: 1 }] }),
    );
    expect(res.statusCode).toBe(409);
    expect((res.jsonBody as { error: string }).error).toBe('entry_in_billing_batch');
    // The original is untouched — not archived, still batched.
    const [row] = rows<{ status: string }>(
      await harness.db.execute(sql`SELECT status FROM time_entry WHERE id = ${teId}`),
    );
    expect(row!.status).not.toBe('ARCHIVED');
  });

  it('split still works for an unbatched entry', async () => {
    const teId = await seedEntry(false);
    const router = createTimeEntryRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const res = await invoke(
      router,
      'post',
      '/:id/split',
      makeReq(teId, { splits: [{ hours: 1 }, { hours: 1 }] }),
    );
    expect(res.statusCode).toBe(201);
  });

  it('self-delete refuses an entry claimed by a billing batch (409)', async () => {
    const teId = await seedEntry(true);
    const router = createTimeEntryRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    // The first-registered DELETE /:id handler owns this contract: it
    // refuses batched entries with 409 'locked' + the batch id. (A second,
    // shadowed DELETE registration now carries the same guard as
    // defense-in-depth in case registration order ever changes.)
    const res = await invoke(router, 'delete', '/:id', makeReq(teId));
    expect(res.statusCode).toBe(409);
    const body = res.jsonBody as { error: string; billingBatchId?: string | null };
    expect(body.error).toBe('locked');
    expect(body.billingBatchId).toBeTruthy();
  });
});
