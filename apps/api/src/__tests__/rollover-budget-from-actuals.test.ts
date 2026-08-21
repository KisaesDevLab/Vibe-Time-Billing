// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0221 — manual /rollover sets the successor's budgeted hours from the
// hours actually logged on the source engagement (falls back to the old
// budget when no time was booked). Shares sumLoggedEffort with the
// recurring spawner and the rollforward batch.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { engagements, timeEntries } from '@vibe/db/schema';
import type { Database } from '@vibe/db';

import { createEngagementRouter } from '../engagements/routes';
import { sumLoggedEffort } from '../engagements/logged-hours';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});

afterEach(async () => {
  await harness.close();
});

async function logTime(hours: number, status: string): Promise<void> {
  await harness.db.insert(timeEntries).values({
    engagementId: seed.engagementId,
    appUserId: seed.appUserId,
    entryDate: '2026-03-01',
    hours: String(hours),
    standardRateSnapshotCents: 20000,
    standardAmountCents: Math.round(hours * 20000),
    status: status as 'SUBMITTED',
  });
}

async function invokeRollover(): Promise<{ statusCode: number; body: unknown }> {
  const router = createEngagementRouter({
    db: harness.db as Database,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
  });
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(n: number) {
      this.statusCode = n;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  const stack = (
    router as unknown as {
      stack: {
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: { handle: (...a: unknown[]) => unknown }[];
        };
      }[];
    }
  ).stack;
  const layer = stack.find(
    (l) => l.route && l.route.path === '/:id/rollover' && l.route.methods['post'],
  );
  if (!layer?.route) throw new Error('rollover route not registered');
  const handler = layer.route.stack[layer.route.stack.length - 1]!.handle;
  const req = {
    body: {},
    params: { id: seed.engagementId },
    query: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
  await (handler as (rq: unknown, rs: unknown) => Promise<void>)(req, res);
  return res;
}

describe('0221 — rollover budget from actuals', () => {
  it('sumLoggedEffort counts logged statuses only', async () => {
    await logTime(3.5, 'SUBMITTED');
    await logTime(2, 'BILLED');
    await logTime(4, 'DRAFT'); // excluded
    const { hours } = await sumLoggedEffort(harness.db, seed.engagementId);
    expect(hours).toBeCloseTo(5.5);
  });

  it('rollover uses logged hours as the new budget', async () => {
    await harness.db
      .update(engagements)
      .set({ budgetHours: '10.00' })
      .where(eq(engagements.id, seed.engagementId));
    await logTime(3.5, 'SUBMITTED');
    await logTime(2, 'BILLED');
    const res = await invokeRollover();
    expect(res.statusCode).toBe(201);
    const newId = (res.body as { id: string }).id;
    const [created] = await harness.db
      .select({
        budgetHours: engagements.budgetHours,
        renewedFrom: engagements.renewedFromEngagementId,
      })
      .from(engagements)
      .where(eq(engagements.id, newId));
    expect(Number(created!.budgetHours)).toBeCloseTo(5.5);
    expect(created!.renewedFrom).toBe(seed.engagementId);
  });

  it('rollover keeps the old budget when no time was logged', async () => {
    await harness.db
      .update(engagements)
      .set({ budgetHours: '12.00' })
      .where(eq(engagements.id, seed.engagementId));
    const res = await invokeRollover();
    expect(res.statusCode).toBe(201);
    const newId = (res.body as { id: string }).id;
    const [created] = await harness.db
      .select({ budgetHours: engagements.budgetHours })
      .from(engagements)
      .where(eq(engagements.id, newId));
    expect(Number(created!.budgetHours)).toBeCloseTo(12);
  });
});

// 0225 — DELETE /engagements/:id: only engagements with no usage.
describe('0225 — delete unused engagement', () => {
  async function invokeDelete(): Promise<{ statusCode: number; body: unknown }> {
    const router = createEngagementRouter({
      db: harness.db as Database,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      status(n: number) {
        this.statusCode = n;
        return this;
      },
      json(b: unknown) {
        this.body = b;
        return this;
      },
    };
    const stack = (
      router as unknown as {
        stack: {
          route?: {
            path: string;
            methods: Record<string, boolean>;
            stack: { handle: (...a: unknown[]) => unknown }[];
          };
        }[];
      }
    ).stack;
    const layer = stack.find(
      (l) => l.route && l.route.path === '/:id' && l.route.methods['delete'],
    );
    if (!layer?.route) throw new Error('delete route not registered');
    const handler = layer.route.stack[layer.route.stack.length - 1]!.handle;
    const req = {
      body: {},
      params: { id: seed.engagementId },
      query: {},
      staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
      ip: '127.0.0.1',
      header: () => undefined,
      get: () => undefined,
    };
    await (handler as (rq: unknown, rs: unknown) => Promise<void>)(req, res);
    return res;
  }

  it('refuses with blockers when time is logged', async () => {
    await logTime(1, 'SUBMITTED');
    const res = await invokeDelete();
    expect(res.statusCode).toBe(409);
    const body = res.body as { error: string; blockers: { label: string; count: number }[] };
    expect(body.error).toBe('engagement_in_use');
    expect(body.blockers.some((b) => b.label === 'time entries' && b.count === 1)).toBe(true);
    const [still] = await harness.db
      .select({ id: engagements.id })
      .from(engagements)
      .where(eq(engagements.id, seed.engagementId));
    expect(still).toBeDefined();
  });

  it('deletes when nothing references it', async () => {
    const res = await invokeDelete();
    expect(res.statusCode).toBe(200);
    const [gone] = await harness.db
      .select({ id: engagements.id })
      .from(engagements)
      .where(eq(engagements.id, seed.engagementId));
    expect(gone).toBeUndefined();
  });
});
