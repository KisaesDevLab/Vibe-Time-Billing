// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0083 — engagement-recurrence router CRUD + run-now + cross-firm
// guards.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type express from 'express';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { engagementRecurrences, engagementTemplates, engagements } from '@vibe/db/schema';
import { createEngagementRecurrenceRouter } from '../engagements/recurrence';

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
  method: 'get' | 'post' | 'patch' | 'delete',
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

async function seedTemplate(firmId: string): Promise<string> {
  const [row] = await harness.db
    .insert(engagementTemplates)
    .values({
      firmId,
      key: 'monthly-books',
      name: 'Monthly Bookkeeping',
      defaultFeeStructure: 'FIXED_FEE',
      namePattern: 'Bookkeeping {{period.month}}/{{period.year}}',
    })
    .returning({ id: engagementTemplates.id });
  return row!.id;
}

function req(over: Partial<FakeReq> & { firmId: string; appUserId: string }): FakeReq {
  return {
    body: {},
    params: {},
    query: {},
    headers: {},
    staffSession: { firmId: over.firmId, appUserId: over.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
    ...over,
  };
}

describe('engagement-recurrence router', () => {
  it('POST creates a SCHEDULE recurrence', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tplId = await seedTemplate(seed.firmId);
    const router = createEngagementRecurrenceRouter({
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
          frequency: 'MONTHLY',
          triggerMode: 'SCHEDULE',
          nextRunDate: '2026-06-01',
          seedPeriodYear: 2026,
          seedPeriodMonth: 5,
        },
      }),
    });
    expect(r.statusCode).toBe(201);
    const [row] = await harness.db
      .select()
      .from(engagementRecurrences)
      .where(eq(engagementRecurrences.id, (r.jsonBody as { id: string }).id));
    expect(row!.frequency).toBe('MONTHLY');
    expect(row!.triggerMode).toBe('SCHEDULE');
    expect(row!.status).toBe('ACTIVE');
  });

  it('POST 400 when SCHEDULE missing nextRunDate', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tplId = await seedTemplate(seed.firmId);
    const router = createEngagementRecurrenceRouter({
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
          frequency: 'MONTHLY',
          triggerMode: 'SCHEDULE',
        },
      }),
    });
    expect(r.statusCode).toBe(400);
  });

  it('POST creates ON_COMPLETION without nextRunDate', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tplId = await seedTemplate(seed.firmId);
    const router = createEngagementRecurrenceRouter({
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
          frequency: 'MONTHLY',
          triggerMode: 'ON_COMPLETION',
        },
      }),
    });
    expect(r.statusCode).toBe(201);
  });

  it("GET lists only the firm's rows", async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tplId = await seedTemplate(seed.firmId);
    await harness.db.insert(engagementRecurrences).values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      templateId: tplId,
      frequency: 'MONTHLY',
      triggerMode: 'SCHEDULE',
      nextRunDate: '2026-06-01',
      createdById: seed.appUserId,
    });
    // Cross-firm row that should NOT appear.
    const other = await harness.db.execute(
      sql`INSERT INTO firm (name) VALUES ('Other') RETURNING id`,
    );
    const otherFirmId = (other as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherUser = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${otherFirmId}, 'o@example.com', 'O', 'O', 'O') RETURNING id`,
    );
    const otherUserId = (otherUser as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherOffice = await harness.db.execute(
      sql`INSERT INTO office (firm_id, name, timezone, is_default)
          VALUES (${otherFirmId}, 'HQ', 'America/Chicago', true) RETURNING id`,
    );
    const otherOfficeId = (otherOffice as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherClient = await harness.db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
          VALUES (${otherFirmId}, 'Other Client', ${otherUserId}, ${otherOfficeId}) RETURNING id`,
    );
    const otherClientId = (otherClient as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherTplId = await seedTemplate(otherFirmId);
    await harness.db.insert(engagementRecurrences).values({
      firmId: otherFirmId,
      clientId: otherClientId,
      templateId: otherTplId,
      frequency: 'ANNUAL',
      triggerMode: 'SCHEDULE',
      nextRunDate: '2026-12-31',
      createdById: otherUserId,
    });
    const router = createEngagementRecurrenceRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'get', '/', {
      ...req({ firmId: seed.firmId, appUserId: seed.appUserId }),
    });
    const body = r.jsonBody as { items: Array<{ id: string; clientName: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.clientName).toBe('Test Client Co');
  });

  it('PATCH pauses + resumes', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tplId = await seedTemplate(seed.firmId);
    const [row] = await harness.db
      .insert(engagementRecurrences)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        templateId: tplId,
        frequency: 'MONTHLY',
        triggerMode: 'SCHEDULE',
        nextRunDate: '2026-06-01',
        createdById: seed.appUserId,
      })
      .returning({ id: engagementRecurrences.id });
    const router = createEngagementRecurrenceRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const pause = await invoke(router, 'patch', '/:id', {
      ...req({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        params: { id: row!.id },
        body: { status: 'PAUSED' },
      }),
    });
    expect(pause.statusCode).toBe(200);
    const [paused] = await harness.db
      .select()
      .from(engagementRecurrences)
      .where(eq(engagementRecurrences.id, row!.id));
    expect(paused!.status).toBe('PAUSED');
    const resume = await invoke(router, 'patch', '/:id', {
      ...req({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        params: { id: row!.id },
        body: { status: 'ACTIVE' },
      }),
    });
    expect(resume.statusCode).toBe(200);
  });

  it('DELETE soft-cancels (row stays, status=CANCELLED)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tplId = await seedTemplate(seed.firmId);
    const [row] = await harness.db
      .insert(engagementRecurrences)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        templateId: tplId,
        frequency: 'ANNUAL',
        triggerMode: 'SCHEDULE',
        nextRunDate: '2026-06-01',
        createdById: seed.appUserId,
      })
      .returning({ id: engagementRecurrences.id });
    const router = createEngagementRecurrenceRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'delete', '/:id', {
      ...req({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        params: { id: row!.id },
      }),
    });
    expect(r.statusCode).toBe(200);
    const [cancelled] = await harness.db
      .select()
      .from(engagementRecurrences)
      .where(eq(engagementRecurrences.id, row!.id));
    expect(cancelled!.status).toBe('CANCELLED');
  });

  it('cross-firm PATCH → 404', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tplId = await seedTemplate(seed.firmId);
    const [row] = await harness.db
      .insert(engagementRecurrences)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        templateId: tplId,
        frequency: 'MONTHLY',
        triggerMode: 'SCHEDULE',
        nextRunDate: '2026-06-01',
        createdById: seed.appUserId,
      })
      .returning({ id: engagementRecurrences.id });
    const other = await harness.db.execute(
      sql`INSERT INTO firm (name) VALUES ('Other') RETURNING id`,
    );
    const otherFirmId = (other as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherUser = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${otherFirmId}, 'o@x.example', 'O', 'O', 'O') RETURNING id`,
    );
    const otherUserId = (otherUser as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const router = createEngagementRecurrenceRouter({
      db: harness.db,
      fakeUserRoles: new Map([[otherUserId, ['partner']]]),
    });
    const r = await invoke(router, 'patch', '/:id', {
      ...req({
        firmId: otherFirmId,
        appUserId: otherUserId,
        params: { id: row!.id },
        body: { status: 'PAUSED' },
      }),
    });
    expect(r.statusCode).toBe(404);
  });

  it('run-now spawns when no previous engagement exists', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tplId = await seedTemplate(seed.firmId);
    const [row] = await harness.db
      .insert(engagementRecurrences)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        templateId: tplId,
        frequency: 'MONTHLY',
        triggerMode: 'SCHEDULE',
        nextRunDate: '2026-06-01',
        seedPeriodYear: 2026,
        seedPeriodMonth: 4,
        createdById: seed.appUserId,
      })
      .returning({ id: engagementRecurrences.id });
    const router = createEngagementRecurrenceRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/:id/run-now', {
      ...req({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        params: { id: row!.id },
      }),
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as { kind: string; name?: string };
    expect(body.kind).toBe('spawned');
    expect(body.name).toBe('Bookkeeping 4/2026');
  });

  it('applies the recurrence spawn_status to the spawned engagement', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const tplId = await seedTemplate(seed.firmId);
    const [row] = await harness.db
      .insert(engagementRecurrences)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        templateId: tplId,
        frequency: 'MONTHLY',
        triggerMode: 'SCHEDULE',
        nextRunDate: '2026-06-01',
        seedPeriodYear: 2026,
        seedPeriodMonth: 4,
        // Override the historical hardcoded 'ACTIVE'.
        spawnStatus: 'PROPOSED',
        createdById: seed.appUserId,
      })
      .returning({ id: engagementRecurrences.id });
    const router = createEngagementRecurrenceRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/:id/run-now', {
      ...req({ firmId: seed.firmId, appUserId: seed.appUserId, params: { id: row!.id } }),
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as { kind: string; engagementId?: string };
    expect(body.kind).toBe('spawned');
    const [eng] = await harness.db
      .select({ status: engagements.status })
      .from(engagements)
      .where(eq(engagements.id, body.engagementId!));
    expect(eng!.status).toBe('PROPOSED');
  });
});
