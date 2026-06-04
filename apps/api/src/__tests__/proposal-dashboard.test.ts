// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P28 — Proposal dashboard route tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createProposalDashboardRouter } from '../proposals/dashboard';

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
function makeReq(o: { firmId: string; appUserId: string } & Partial<FakeReq>): FakeReq {
  return {
    body: o.body ?? {},
    params: o.params ?? {},
    query: o.query ?? {},
    staffSession: { firmId: o.firmId, appUserId: o.appUserId },
    ip: '127.0.0.1',
    get: () => undefined,
  };
}
function makeRes(): FakeRes {
  const r: FakeRes = {
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
  return r;
}
async function invoke(
  router: ReturnType<typeof createProposalDashboardRouter>,
  path: string,
  req: FakeReq,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const route = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return route.path === path && route.methods['get'] === true;
  });
  if (!layer) throw new Error(`route not registered: GET ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

async function seedThreeProposals(): Promise<{
  firmId: string;
  appUserId: string;
  router: ReturnType<typeof createProposalDashboardRouter>;
}> {
  const seed = await seedMinimalFirm(harness.db);
  // SENT 5 days ago
  const p1 = await harness.db.execute(
    sql`INSERT INTO proposals
          (firm_id, client_id, status, title, brochure_jsonb,
           total_one_time_cents, total_recurring_cents,
           sent_at, created_by_id, created_at)
        VALUES
          (${seed.firmId}, ${seed.clientId}, 'SENT', 'Plain SENT', '{}',
           100000, 0, NOW() - INTERVAL '5 days', ${seed.appUserId},
           NOW() - INTERVAL '5 days')
        RETURNING id`,
  );
  const p1Id = (p1 as unknown as { rows: { id: string }[] }).rows[0]!.id;
  // VIEWED 15 days ago, no activity since (stale)
  const p2 = await harness.db.execute(
    sql`INSERT INTO proposals
          (firm_id, client_id, status, title, brochure_jsonb,
           total_one_time_cents, total_recurring_cents, recurring_interval,
           sent_at, first_viewed_at, created_by_id, created_at)
        VALUES
          (${seed.firmId}, ${seed.clientId}, 'VIEWED', 'Stale VIEWED', '{}',
           50000, 10000, 'MONTHLY', NOW() - INTERVAL '16 days', NOW() - INTERVAL '15 days',
           ${seed.appUserId}, NOW() - INTERVAL '16 days')
        RETURNING id`,
  );
  const p2Id = (p2 as unknown as { rows: { id: string }[] }).rows[0]!.id;
  await harness.db.execute(
    sql`INSERT INTO proposal_activity (proposal_id, kind, occurred_at)
        VALUES (${p2Id}, 'OPENED', NOW() - INTERVAL '15 days')`,
  );
  // ACCEPTED 1 day ago, with SIGNATURE_STARTED + SIGNATURE_COMPLETED
  const p3 = await harness.db.execute(
    sql`INSERT INTO proposals
          (firm_id, client_id, status, title, brochure_jsonb,
           total_one_time_cents, total_recurring_cents,
           sent_at, first_viewed_at, accepted_at, created_by_id, created_at)
        VALUES
          (${seed.firmId}, ${seed.clientId}, 'ACCEPTED', 'Won', '{}',
           200000, 0, NOW() - INTERVAL '3 days', NOW() - INTERVAL '2 days',
           NOW() - INTERVAL '1 day', ${seed.appUserId},
           NOW() - INTERVAL '3 days')
        RETURNING id`,
  );
  const p3Id = (p3 as unknown as { rows: { id: string }[] }).rows[0]!.id;
  await harness.db.execute(
    sql`INSERT INTO proposal_activity (proposal_id, kind, occurred_at)
        VALUES (${p3Id}, 'SIGNATURE_STARTED', NOW() - INTERVAL '2 days'),
               (${p3Id}, 'SIGNATURE_COMPLETED', NOW() - INTERVAL '1 day')`,
  );
  const router = createProposalDashboardRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
  });
  // touch ids to silence unused-var lint
  void p1Id;
  return { firmId: seed.firmId, appUserId: seed.appUserId, router };
}

describe('P28 — GET /proposals/dashboard', () => {
  it('produces kanban + funnel + stale + summary', async () => {
    const f = await seedThreeProposals();
    const r = await invoke(f.router, '/dashboard', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId }),
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as {
      kanban: { status: string; count: number }[];
      funnel: { stage: string; count: number }[];
      stale: { proposalId: string; daysSince: number }[];
      summary: { totalSent: number; totalAccepted: number; pipelineValueCents: number };
      timeToSign: { sampleSize: number; medianHours: number | null };
    };

    const stages = Object.fromEntries(body.funnel.map((s) => [s.stage, s.count]));
    expect(stages['SENT']).toBe(3);
    expect(stages['VIEWED']).toBe(2);
    expect(stages['SIGNATURE_STARTED']).toBe(1);
    expect(stages['ACCEPTED']).toBe(1);

    const sentBucket = body.kanban.find((k) => k.status === 'SENT')!;
    expect(sentBucket.count).toBe(1);

    expect(body.stale.length).toBe(1);
    expect(body.stale[0]!.daysSince).toBeGreaterThanOrEqual(14);

    expect(body.summary.totalSent).toBe(3);
    expect(body.summary.totalAccepted).toBe(1);
    expect(body.timeToSign.sampleSize).toBe(1);
    // Won proposal: sent 3d ago, accepted 1d ago → 48h.
    expect(body.timeToSign.medianHours).toBeGreaterThan(40);
    expect(body.timeToSign.medianHours).toBeLessThan(56);
  });

  it('respects minValueCents filter', async () => {
    const f = await seedThreeProposals();
    const r = await invoke(f.router, '/dashboard', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        query: { minValueCents: '180000' },
      }),
    });
    const body = r.jsonBody as { summary: { totalSent: number; totalAccepted: number } };
    // Filter cuts to only the Won proposal (200k). Other two: 100k (SENT)
    // and 50k+10k*12=170k (VIEWED) both fall below 180k.
    expect(body.summary.totalSent).toBe(1);
    expect(body.summary.totalAccepted).toBe(1);
  });

  it('respects firm scoping — proposals from another firm are excluded', async () => {
    await seedThreeProposals();
    // Create a second firm with its own proposal.
    const otherFirm = await harness.db.execute(
      sql`INSERT INTO firm (name) VALUES ('Other') RETURNING id`,
    );
    const otherFirmId = (otherFirm as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherUser = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${otherFirmId}, 'o@x.example', 'O', 'O', 'O') RETURNING id`,
    );
    const otherUserId = (otherUser as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherOffice = await harness.db.execute(
      sql`INSERT INTO office (firm_id, name, timezone, is_default)
          VALUES (${otherFirmId}, 'HQ', 'America/Chicago', true) RETURNING id`,
    );
    const otherOfficeId = (otherOffice as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherClient = await harness.db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
          VALUES (${otherFirmId}, 'OC', ${otherUserId}, ${otherOfficeId}) RETURNING id`,
    );
    const otherClientId = (otherClient as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await harness.db.execute(
      sql`INSERT INTO proposals
            (firm_id, client_id, status, title, brochure_jsonb,
             total_one_time_cents, total_recurring_cents, created_by_id)
          VALUES (${otherFirmId}, ${otherClientId}, 'SENT', 'Other firm', '{}',
                  500000, 0, ${otherUserId})`,
    );
    const router2 = createProposalDashboardRouter({
      db: harness.db,
      fakeUserRoles: new Map([[otherUserId, ['partner']]]),
    });
    const r = await invoke(router2, '/dashboard', {
      ...makeReq({ firmId: otherFirmId, appUserId: otherUserId }),
    });
    const body = r.jsonBody as { summary: { totalSent: number } };
    // Only the other firm's one SENT proposal is visible.
    expect(body.summary.totalSent).toBe(0); // sentAt was not set on it
    // We can also assert kanban shows exactly 1 SENT-status row.
    const k = (r.jsonBody as { kanban: { status: string; count: number }[] }).kanban.find(
      (b) => b.status === 'SENT',
    )!;
    expect(k.count).toBe(1);
  });

  it('400 on invalid ownerId', async () => {
    const f = await seedThreeProposals();
    const r = await invoke(f.router, '/dashboard', {
      ...makeReq({
        firmId: f.firmId,
        appUserId: f.appUserId,
        query: { ownerId: 'not-a-uuid' },
      }),
    });
    expect(r.statusCode).toBe(400);
  });
});
