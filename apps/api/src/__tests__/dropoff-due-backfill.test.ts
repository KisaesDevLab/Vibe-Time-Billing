// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0204 — entering a drop-off date back-fills the engagement's due date when it
// has none: due = drop-off date + firm_settings.dropoff_due_offset_days. It is
// a no-op when the engagement already has a due date, or the offset is unset.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type express from 'express';

import { engagements } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createRequestRouter } from '../requests/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

async function setOffset(days: number | null): Promise<void> {
  await harness.db.execute(
    sql`INSERT INTO firm_settings (firm_id, dropoff_due_offset_days)
        VALUES (${seed.firmId}, ${days})
        ON CONFLICT (firm_id) DO UPDATE SET dropoff_due_offset_days = ${days}`,
  );
}
async function setEngagementDue(date: string | null): Promise<void> {
  await harness.db
    .update(engagements)
    .set({ dueDate: date })
    .where(eq(engagements.id, seed.engagementId));
}
async function engDue(): Promise<string | null> {
  const [e] = await harness.db
    .select({ dueDate: engagements.dueDate })
    .from(engagements)
    .where(eq(engagements.id, seed.engagementId));
  return e?.dueDate ?? null;
}

function makeRes() {
  return {
    statusCode: 200,
    jsonBody: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.jsonBody = b;
      return this;
    },
  };
}
async function createDropOff(dueDate: string): Promise<number> {
  const router: express.Router = createRequestRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
  });
  const layer = (router as unknown as { stack: Array<{ route?: unknown }> }).stack.find((l) => {
    const r = l.route as { path: string; methods: Record<string, boolean> } | undefined;
    return r?.path === '/' && r.methods['post'] === true;
  });
  const route = (layer as { route: { stack: Array<{ handle: (...a: unknown[]) => unknown }> } })
    .route;
  const handler = route.stack[route.stack.length - 1]!.handle;
  const res = makeRes();
  await (handler as (rq: unknown, rs: unknown) => Promise<void>)(
    {
      body: {
        engagementId: seed.engagementId,
        kind: 'DROP_OFF',
        title: 'Docs',
        dueDate,
        reminderDaysBefore: 3,
      },
      params: {},
      query: {},
      headers: {},
      staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
      ip: '127.0.0.1',
      header: () => undefined,
      get: () => undefined,
    },
    res,
  );
  return res.statusCode;
}

describe('drop-off → engagement due date back-fill', () => {
  it('sets due = drop-off + offset when the engagement has no due date', async () => {
    await setOffset(14);
    await setEngagementDue(null);
    expect(await createDropOff('2026-07-01')).toBe(201);
    expect(await engDue()).toBe('2026-07-15');
  });

  it('does not overwrite an existing due date', async () => {
    await setOffset(14);
    await setEngagementDue('2026-09-30');
    expect(await createDropOff('2026-07-01')).toBe(201);
    expect(await engDue()).toBe('2026-09-30');
  });

  it('is a no-op when the offset is unset (feature disabled)', async () => {
    await setOffset(null);
    await setEngagementDue(null);
    expect(await createDropOff('2026-07-01')).toBe(201);
    expect(await engDue()).toBeNull();
  });
});
