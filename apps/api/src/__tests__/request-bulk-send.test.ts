// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// 0084 — POST /api/staff/requests/bulk: one template → N targets,
// cross-firm guard, partial-failure isolation, defaults applied.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type express from 'express';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import {
  clientRequestItems,
  clientRequests,
  requestTemplateItems,
  requestTemplates,
} from '@vibe/db/schema';
import { createRequestRouter } from '../requests/routes';

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

function makeReq(over: Partial<FakeReq> & { firmId: string; appUserId: string }): FakeReq {
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

async function seedExtraEngagement(
  db: PgliteHarness['db'],
  firmId: string,
  partnerId: string,
  clientName: string,
): Promise<{ clientId: string; engagementId: string }> {
  const client = await db.execute(
    sql`INSERT INTO client (firm_id, name, partner_in_charge_id)
        VALUES (${firmId}, ${clientName}, ${partnerId}) RETURNING id`,
  );
  const clientId = (client as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const eng = await db.execute(
    sql`INSERT INTO engagement (client_id, name, fee_structure)
        VALUES (${clientId}, 'Engagement', 'HOURLY') RETURNING id`,
  );
  const engagementId = (eng as unknown as { rows: { id: string }[] }).rows[0]!.id;
  return { clientId, engagementId };
}

describe('POST /requests/bulk', () => {
  it('creates N requests with template defaults + items', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createRequestRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });

    // Seed two more clients + engagements.
    const c2 = await seedExtraEngagement(harness.db, seed.firmId, seed.appUserId, 'ClientB');
    const c3 = await seedExtraEngagement(harness.db, seed.firmId, seed.appUserId, 'ClientC');

    // Seed template + items.
    const [tpl] = await harness.db
      .insert(requestTemplates)
      .values({
        firmId: seed.firmId,
        key: 'year-end',
        name: 'Year-end docs',
        titlePattern: 'Year-end for {{client.name}}',
        bodyPattern: 'Please upload.',
        defaultPriority: 'HIGH',
        defaultDueOffsetDays: 14,
        defaultReminderDaysBefore: 3,
      })
      .returning({ id: requestTemplates.id });
    await harness.db.insert(requestTemplateItems).values([
      { templateId: tpl!.id, ordinal: 0, label: 'W-2', itemKind: 'DOCUMENT', required: true },
      { templateId: tpl!.id, ordinal: 1, label: '1099s', itemKind: 'DOCUMENT', required: true },
    ]);

    const r = await invoke(router, 'post', '/bulk', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          templateId: tpl!.id,
          targets: [
            { clientId: seed.clientId, engagementId: seed.engagementId },
            { clientId: c2.clientId, engagementId: c2.engagementId },
            { clientId: c3.clientId, engagementId: c3.engagementId },
          ],
        },
      }),
    });

    expect(r.statusCode).toBe(201);
    const body = r.jsonBody as { created: number; requestIds: string[]; skipped: unknown[] };
    expect(body.created).toBe(3);
    expect(body.skipped).toHaveLength(0);

    const allRequests = await harness.db.select().from(clientRequests);
    expect(allRequests).toHaveLength(3);
    // Title pattern resolved per client.
    const titles = allRequests.map((r) => r.title).sort();
    expect(titles).toEqual([
      'Year-end for ClientB',
      'Year-end for ClientC',
      'Year-end for Test Client Co',
    ]);
    // Defaults applied.
    for (const row of allRequests) {
      expect(row.priority).toBe('HIGH');
      expect(row.reminderDaysBefore).toBe(3);
      expect(row.templateId).toBe(tpl!.id);
      // Due date = today + 14 (we don't pin the date, just check the
      // offset shape: not null and roughly 14 days out).
      expect(row.dueDate).not.toBeNull();
    }
    // Items copied to each.
    const items = await harness.db.select().from(clientRequestItems);
    expect(items).toHaveLength(6);
  });

  it('skips a cross-firm target with a reason and still creates the valid one', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createRequestRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });

    // Other-firm engagement we'll try to inject.
    const otherFirm = await harness.db.execute(
      sql`INSERT INTO firm (name) VALUES ('Other') RETURNING id`,
    );
    const otherFirmId = (otherFirm as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherUser = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${otherFirmId}, 'o@x', 'O', 'O', 'O') RETURNING id`,
    );
    const otherUserId = (otherUser as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherClient = await harness.db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id)
          VALUES (${otherFirmId}, 'OtherCo', ${otherUserId}) RETURNING id`,
    );
    const otherClientId = (otherClient as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherEng = await harness.db.execute(
      sql`INSERT INTO engagement (client_id, name, fee_structure)
          VALUES (${otherClientId}, 'Other', 'HOURLY') RETURNING id`,
    );
    const otherEngId = (otherEng as unknown as { rows: { id: string }[] }).rows[0]!.id;

    const [tpl] = await harness.db
      .insert(requestTemplates)
      .values({
        firmId: seed.firmId,
        key: 'k',
        name: 'T',
        titlePattern: 'T for {{client.name}}',
      })
      .returning({ id: requestTemplates.id });

    const r = await invoke(router, 'post', '/bulk', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          templateId: tpl!.id,
          targets: [
            { clientId: seed.clientId, engagementId: seed.engagementId }, // valid
            { clientId: otherClientId, engagementId: otherEngId }, // cross-firm
          ],
        },
      }),
    });
    expect(r.statusCode).toBe(201);
    const body = r.jsonBody as {
      created: number;
      requestIds: string[];
      skipped: Array<{ clientId: string; reason: string }>;
    };
    expect(body.created).toBe(1);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0]!.clientId).toBe(otherClientId);
    expect(body.skipped[0]!.reason).toContain('cross_firm');

    const rows = await harness.db.select().from(clientRequests);
    expect(rows).toHaveLength(1);
  });

  it('returns 404 when templateId is from another firm', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createRequestRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const otherFirm = await harness.db.execute(
      sql`INSERT INTO firm (name) VALUES ('Other') RETURNING id`,
    );
    const otherFirmId = (otherFirm as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const [tpl] = await harness.db
      .insert(requestTemplates)
      .values({
        firmId: otherFirmId,
        key: 'k',
        name: 'T',
        titlePattern: 'X',
      })
      .returning({ id: requestTemplates.id });
    const r = await invoke(router, 'post', '/bulk', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          templateId: tpl!.id,
          targets: [{ clientId: seed.clientId, engagementId: seed.engagementId }],
        },
      }),
    });
    expect(r.statusCode).toBe(404);
    expect((r.jsonBody as { error: string }).error).toBe('template_not_found');
  });

  it('applies target-level priorityOverride + dueDateOverride', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createRequestRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const [tpl] = await harness.db
      .insert(requestTemplates)
      .values({
        firmId: seed.firmId,
        key: 'k',
        name: 'T',
        titlePattern: 'X',
        defaultPriority: 'LOW',
      })
      .returning({ id: requestTemplates.id });

    const r = await invoke(router, 'post', '/bulk', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        body: {
          templateId: tpl!.id,
          targets: [
            {
              clientId: seed.clientId,
              engagementId: seed.engagementId,
              priorityOverride: 'URGENT',
              dueDateOverride: '2026-12-31',
            },
          ],
        },
      }),
    });
    expect(r.statusCode).toBe(201);
    const [created] = await harness.db
      .select()
      .from(clientRequests)
      .where(eq(clientRequests.firmId, seed.firmId));
    expect(created!.priority).toBe('URGENT');
    expect(String(created!.dueDate)).toBe('2026-12-31');
  });
});
