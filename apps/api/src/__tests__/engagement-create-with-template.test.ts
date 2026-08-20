// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0083 — POST /api/staff/engagements with templateId + period. Verifies
// server-side name resolution from template.name_pattern, fallback to
// static template.name, explicit name still overrides, and period
// fields persist regardless.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type express from 'express';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { engagementRecurrences, engagementTemplates, engagements } from '@vibe/db/schema';
import { createEngagementRouter } from '../engagements/routes';
import { spawnNextEngagement } from '../engagements/recurrence-spawn';

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
  headers: Record<string, string>;
  staffSession: { firmId: string; appUserId: string };
  ip: string;
  header(name: string): string | undefined;
  get(name: string): string | undefined;
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
async function invoke(
  router: express.Router,
  method: 'post' | 'get',
  path: string,
  req: FakeReq,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

async function seedTemplate(
  firmId: string,
  patch?: { namePattern?: string | null; name?: string },
): Promise<string> {
  const [row] = await harness.db
    .insert(engagementTemplates)
    .values({
      firmId,
      key: `tpl-${Math.random().toString(36).slice(2, 8)}`,
      name: patch?.name ?? 'Monthly Bookkeeping',
      defaultFeeStructure: 'FIXED_FEE',
      defaultFeeAmountCents: 50000,
      namePattern: patch?.namePattern ?? null,
    })
    .returning({ id: engagementTemplates.id });
  return row!.id;
}

function req(f: { firmId: string; appUserId: string; body: unknown }): FakeReq {
  return {
    body: f.body,
    params: {},
    query: {},
    headers: {},
    staffSession: { firmId: f.firmId, appUserId: f.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
}

describe('POST /api/staff/engagements with templateId + period', () => {
  it('resolves template.name_pattern when no explicit name is sent', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tplId = await seedTemplate(seed.firmId, {
      namePattern: 'Bookkeeping {{period.month}}/{{period.year}} · {{client.name}}',
    });
    const router = createEngagementRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/', {
      ...req({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          clientId: seed.clientId,
          templateId: tplId,
          feeStructure: 'FIXED_FEE',
          period: { year: 2026, month: 4 },
        },
      }),
    });
    expect(r.statusCode).toBe(201);
    const body = r.jsonBody as { id: string };
    const [row] = await harness.db.select().from(engagements).where(eq(engagements.id, body.id));
    expect(row!.name).toBe('Bookkeeping 4/2026 · Test Client Co');
    expect(row!.periodYear).toBe(2026);
    expect(row!.periodMonth).toBe(4);
  });

  it('stamps created_from_template_id; /bulk-existing reports the client for that period', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tplId = await seedTemplate(seed.firmId, {});
    const router = createEngagementRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/', {
      ...req({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          clientId: seed.clientId,
          templateId: tplId,
          feeStructure: 'FIXED_FEE',
          period: { year: 2026 },
        },
      }),
    });
    expect(r.statusCode).toBe(201);
    const body = r.jsonBody as { id: string };
    const [row] = await harness.db.select().from(engagements).where(eq(engagements.id, body.id));
    expect(row!.createdFromTemplateId).toBe(tplId);

    // Same template + same period → the client is reported as existing.
    const hit = await invoke(router, 'get', '/bulk-existing', {
      ...req({ firmId: seed.firmId, appUserId: seed.appUserId, body: {} }),
      query: { templateId: tplId, periodYear: '2026' },
    });
    expect(hit.statusCode).toBe(200);
    expect((hit.jsonBody as { clientIds: string[] }).clientIds).toContain(seed.clientId);

    // Different period year → not reported.
    const miss = await invoke(router, 'get', '/bulk-existing', {
      ...req({ firmId: seed.firmId, appUserId: seed.appUserId, body: {} }),
      query: { templateId: tplId, periodYear: '2027' },
    });
    expect(miss.statusCode).toBe(200);
    expect((miss.jsonBody as { clientIds: string[] }).clientIds).toHaveLength(0);
  });

  it('explicit name overrides template.name_pattern', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tplId = await seedTemplate(seed.firmId, {
      namePattern: 'Bookkeeping {{period.month}}/{{period.year}}',
    });
    const router = createEngagementRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/', {
      ...req({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          clientId: seed.clientId,
          templateId: tplId,
          name: 'Custom Override',
          feeStructure: 'FIXED_FEE',
          period: { year: 2026, month: 4 },
        },
      }),
    });
    expect(r.statusCode).toBe(201);
    const [row] = await harness.db
      .select()
      .from(engagements)
      .where(eq(engagements.id, (r.jsonBody as { id: string }).id));
    expect(row!.name).toBe('Custom Override');
  });

  it('falls back to template.name when template has no name_pattern + no explicit name', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tplId = await seedTemplate(seed.firmId, {
      name: 'Static Template Name',
      namePattern: null,
    });
    const router = createEngagementRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/', {
      ...req({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          clientId: seed.clientId,
          templateId: tplId,
          feeStructure: 'FIXED_FEE',
        },
      }),
    });
    expect(r.statusCode).toBe(201);
    const [row] = await harness.db
      .select()
      .from(engagements)
      .where(eq(engagements.id, (r.jsonBody as { id: string }).id));
    expect(row!.name).toBe('Static Template Name');
  });

  it('cross-firm template → 404', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const other = await harness.db.execute(
      sql`INSERT INTO firm (name) VALUES ('Other Firm') RETURNING id`,
    );
    const otherFirmId = (other as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherTplId = await seedTemplate(otherFirmId, { namePattern: 'X' });
    const router = createEngagementRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/', {
      ...req({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          clientId: seed.clientId,
          templateId: otherTplId,
          feeStructure: 'FIXED_FEE',
          period: { year: 2026, month: 4 },
        },
      }),
    });
    expect(r.statusCode).toBe(404);
  });

  it('400 name_required when no template + no name', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createEngagementRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/', {
      ...req({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: { clientId: seed.clientId, feeStructure: 'FIXED_FEE' },
      }),
    });
    expect(r.statusCode).toBe(400);
    expect((r.jsonBody as { error: string }).error).toBe('name_required');
  });

  it('defaults partner to the client owner when partnerId is omitted', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createEngagementRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/', {
      ...req({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: { clientId: seed.clientId, name: 'No Partner Set', feeStructure: 'HOURLY' },
      }),
    });
    expect(r.statusCode).toBe(201);
    const [row] = await harness.db
      .select()
      .from(engagements)
      .where(eq(engagements.id, (r.jsonBody as { id: string }).id));
    // seedMinimalFirm sets the client's partner_in_charge_id = appUserId.
    expect(row!.partnerId).toBe(seed.appUserId);
  });

  it('respects an explicit partnerId over the client owner', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const u = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${seed.firmId}, 'p2@test.example', 'Partner Two', 'P', 'T') RETURNING id`,
    );
    const otherId = (u as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const router = createEngagementRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/', {
      ...req({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          clientId: seed.clientId,
          name: 'Explicit Partner',
          feeStructure: 'HOURLY',
          partnerId: otherId,
        },
      }),
    });
    expect(r.statusCode).toBe(201);
    const [row] = await harness.db
      .select()
      .from(engagements)
      .where(eq(engagements.id, (r.jsonBody as { id: string }).id));
    expect(row!.partnerId).toBe(otherId);
  });

  it('persists period fields without a template', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createEngagementRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/', {
      ...req({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          clientId: seed.clientId,
          name: 'Manual Engagement',
          feeStructure: 'HOURLY',
          period: { year: 2026, month: 6, label: 'Q2 2026' },
        },
      }),
    });
    expect(r.statusCode).toBe(201);
    const [row] = await harness.db
      .select()
      .from(engagements)
      .where(eq(engagements.id, (r.jsonBody as { id: string }).id));
    expect(row!.periodYear).toBe(2026);
    expect(row!.periodMonth).toBe(6);
    expect(row!.periodLabel).toBe('Q2 2026');
  });
});

describe('recurrence spawn inherits template defaults + client owner', () => {
  it('applies the template toggles and sets partner to the client owner', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const [tpl] = await harness.db
      .insert(engagementTemplates)
      .values({
        firmId: seed.firmId,
        key: `rec-${Math.random().toString(36).slice(2, 8)}`,
        name: 'Recurring BK',
        defaultFeeStructure: 'FIXED_FEE',
        defaultFeeAmountCents: 50000,
        defaultMixedModeEnabled: true,
        defaultFeePassthroughEnabled: true,
        defaultTaxEnabled: true,
        defaultTaxRateBps: 425,
        defaultTaxLabel: 'GET',
        defaultSurchargeEnabled: true,
        defaultSurchargeType: 'PERCENT',
        defaultSurchargeValueBps: 300,
        defaultSurchargeLabel: 'Tech fee',
      })
      .returning({ id: engagementTemplates.id });
    const [rec] = await harness.db
      .insert(engagementRecurrences)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        templateId: tpl!.id,
        frequency: 'MONTHLY',
        triggerMode: 'ON_COMPLETION',
        seedPeriodYear: 2026,
        seedPeriodMonth: 1,
      })
      .returning({ id: engagementRecurrences.id });

    const result = await spawnNextEngagement({
      db: harness.db,
      recurrenceId: rec!.id,
      firmId: seed.firmId,
      actorAppUserId: seed.appUserId,
      now: new Date('2026-01-15T00:00:00Z'),
    });
    expect(result.kind).toBe('spawned');
    const engagementId = (result as { engagementId: string }).engagementId;
    const [eng] = await harness.db
      .select()
      .from(engagements)
      .where(eq(engagements.id, engagementId));
    expect(eng!.partnerId).toBe(seed.appUserId);
    expect(eng!.mixedModeEnabled).toBe(true);
    expect(eng!.feePassthroughEnabled).toBe(true);
    expect(eng!.taxEnabled).toBe(true);
    expect(eng!.taxRateBps).toBe(425);
    expect(eng!.taxLabel).toBe('GET');
    expect(eng!.surchargeEnabled).toBe(true);
    expect(eng!.surchargeValueBps).toBe(300);
  });
});
