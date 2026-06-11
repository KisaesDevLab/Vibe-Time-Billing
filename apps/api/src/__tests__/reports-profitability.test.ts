// SPDX-License-Identifier: Elastic-2.0
//
// Reports / profitability — verifies the per-engagement cost
// subtraction. Previous version of the endpoint returned invoiced
// revenue only despite a comment claiming "invoiced minus a flat-cost
// stub". Now uses time_entry.cost_rate_snapshot_cents to compute real
// profit per engagement.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type express from 'express';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { invoices, timeEntries } from '@vibe/db/schema';
import { createReportRouter } from '../reports/routes';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

interface FakeReq {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  staffSession: { firmId: string; appUserId: string };
  ip: string;
  get(_h: string): string | undefined;
}
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
async function invoke(router: express.Router, path: string, req: FakeReq): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods['get'] === true;
  });
  if (!layer) throw new Error(`route not registered: GET ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

describe('Reports — GET /profitability', () => {
  it('returns billed − cost per engagement', async () => {
    const seed = await seedMinimalFirm(harness.db);

    // 5 hours at $100/hr cost ⇒ 50000 cents cost.
    await harness.db.insert(timeEntries).values({
      engagementId: seed.engagementId,
      appUserId: seed.appUserId,
      workCodeId: seed.workCodeId,
      entryDate: '2026-04-15',
      hours: '5.00',
      standardRateSnapshotCents: 30000,
      standardAmountCents: 150000,
      costRateSnapshotCents: 10000,
    });
    // One invoice for the engagement: $1,500 billed, $1,000 paid.
    await harness.db.insert(invoices).values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      primaryEngagementId: seed.engagementId,
      invoiceNumber: 'INV-1',
      issueDate: '2026-04-15',
      dueDate: '2026-05-15',
      subtotalCents: 150000,
      totalCents: 150000,
      paidCents: 100000,
      status: 'SENT',
    });

    const router = createReportRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, '/profitability', {
      body: {},
      params: {},
      query: {},
      staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as {
      items: Array<{
        engagementId: string;
        billedCents: number;
        paidCents: number;
        costCents: number;
        marginCents: number;
        marginPct: number | null;
      }>;
    };
    const row = body.items.find((i) => i.engagementId === seed.engagementId)!;
    expect(row.billedCents).toBe(150000);
    expect(row.paidCents).toBe(100000);
    expect(row.costCents).toBe(50000);
    expect(row.marginCents).toBe(100000);
    expect(row.marginPct).toBeCloseTo(66.666, 1);
  });

  it('engagement with cost but no invoice → negative margin', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await harness.db.insert(timeEntries).values({
      engagementId: seed.engagementId,
      appUserId: seed.appUserId,
      workCodeId: seed.workCodeId,
      entryDate: '2026-04-15',
      hours: '2.00',
      standardRateSnapshotCents: 30000,
      standardAmountCents: 60000,
      costRateSnapshotCents: 10000,
    });
    const router = createReportRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, '/profitability', {
      body: {},
      params: {},
      query: {},
      staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    const body = r.jsonBody as {
      items: Array<{
        billedCents: number;
        costCents: number;
        marginCents: number;
        marginPct: number | null;
      }>;
    };
    const row = body.items[0]!;
    expect(row.billedCents).toBe(0);
    expect(row.costCents).toBe(20000);
    expect(row.marginCents).toBe(-20000);
    expect(row.marginPct).toBeNull();
  });

  it('cross-firm engagement excluded', async () => {
    // Seed the original firm so its engagement/invoice exist in the DB.
    // The endpoint should NOT return them when scoped to a different firm.
    await seedMinimalFirm(harness.db);
    // Build a second firm with its own engagement + invoice.
    const other = await harness.db.execute(
      sql`INSERT INTO firm (name) VALUES ('Other Firm') RETURNING id`,
    );
    const otherFirmId = (other as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherUser = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${otherFirmId}, 'o@example.com', 'O', 'O', 'O') RETURNING id`,
    );
    const otherUserId = (otherUser as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const router = createReportRouter({
      db: harness.db,
      fakeUserRoles: new Map([[otherUserId, ['partner']]]),
    });
    const r = await invoke(router, '/profitability', {
      body: {},
      params: {},
      query: {},
      staffSession: { firmId: otherFirmId, appUserId: otherUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(r.statusCode).toBe(200);
    // Other firm has no engagements/invoices → empty list.
    expect((r.jsonBody as { items: unknown[] }).items).toEqual([]);
  });
});
