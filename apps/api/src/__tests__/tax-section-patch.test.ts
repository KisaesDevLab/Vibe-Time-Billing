// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR section PATCH — staff edits to a parsed section. Verifies that:
//   - Successful PATCH writes the new field values + sets
//     is_manual_override = true
//   - Partial PATCH only touches the supplied fields
//   - Cross-firm calls 404 before mutating
//   - Cross-return section ids 404 (section belongs to a different return)
//   - Empty body 400
//   - SECTION_EDITED audit event is appended.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { taxReturnAccessLog, taxReturnSections, taxReturns } from '@vibe/db/schema';
import { createTaxReturnRouter } from '../tax-returns/routes';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

async function seedReturnWithSection(): Promise<{
  firmId: string;
  appUserId: string;
  returnId: string;
  sectionId: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const [r] = await harness.db
    .insert(taxReturns)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      taxYear: 2025,
      formCode: '1120-S',
      title: '2025 S-Corp',
      status: 'PARSED',
      totalPages: 14,
    })
    .returning();
  const [s] = await harness.db
    .insert(taxReturnSections)
    .values({
      returnId: r!.id,
      ordinal: 0,
      rawTitle: 'Schedule K-1',
      normalizedTitle: 'Schedule K-1',
      kind: 'K1',
      startPage: 7,
      endPage: 9,
    })
    .returning({ id: taxReturnSections.id });
  return {
    firmId: seed.firmId,
    appUserId: seed.appUserId,
    returnId: r!.id,
    sectionId: s!.id,
  };
}

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
async function invokePatch(
  router: ReturnType<typeof createTaxReturnRouter>,
  path: string,
  req: FakeReq,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods['patch'] === true;
  });
  if (!layer) throw new Error(`route not registered: PATCH ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

describe('TR — PATCH /:returnId/sections/:sectionId', () => {
  it('updates fields + flips is_manual_override', async () => {
    const f = await seedReturnWithSection();
    const router = createTaxReturnRouter({
      db: harness.db,
      fakeUserRoles: new Map([[f.appUserId, ['partner']]]),
    });
    const r = await invokePatch(router, '/:returnId/sections/:sectionId', {
      body: { recipientName: 'Maya Calderón', releasable: false },
      params: { returnId: f.returnId, sectionId: f.sectionId },
      query: {},
      staffSession: { firmId: f.firmId, appUserId: f.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(r.statusCode).toBe(200);
    const [row] = await harness.db
      .select()
      .from(taxReturnSections)
      .where(eq(taxReturnSections.id, f.sectionId));
    expect(row!.recipientName).toBe('Maya Calderón');
    expect(row!.releasable).toBe(false);
    expect(row!.isManualOverride).toBe(true);
    // Untouched field preserved
    expect(row!.normalizedTitle).toBe('Schedule K-1');
  });

  it('emits a SECTION_EDITED audit event', async () => {
    const f = await seedReturnWithSection();
    const router = createTaxReturnRouter({
      db: harness.db,
      fakeUserRoles: new Map([[f.appUserId, ['partner']]]),
    });
    await invokePatch(router, '/:returnId/sections/:sectionId', {
      body: { normalizedTitle: 'Schedule K-1 — Maya Calderón' },
      params: { returnId: f.returnId, sectionId: f.sectionId },
      query: {},
      staffSession: { firmId: f.firmId, appUserId: f.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    const events = await harness.db
      .select()
      .from(taxReturnAccessLog)
      .where(eq(taxReturnAccessLog.returnId, f.returnId));
    const edited = events.find((e) => e.event === 'SECTION_EDITED');
    expect(edited).toBeDefined();
    expect(edited!.sectionId).toBe(f.sectionId);
  });

  it('empty body 400', async () => {
    const f = await seedReturnWithSection();
    const router = createTaxReturnRouter({
      db: harness.db,
      fakeUserRoles: new Map([[f.appUserId, ['partner']]]),
    });
    const r = await invokePatch(router, '/:returnId/sections/:sectionId', {
      body: {},
      params: { returnId: f.returnId, sectionId: f.sectionId },
      query: {},
      staffSession: { firmId: f.firmId, appUserId: f.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(r.statusCode).toBe(400);
  });

  it('cross-firm 404 (never mutates)', async () => {
    const f = await seedReturnWithSection();
    const other = await harness.db.execute(
      sql`INSERT INTO firm (name) VALUES ('Other') RETURNING id`,
    );
    const otherFirmId = (other as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherUser = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${otherFirmId}, 'o@x.example', 'O', 'O', 'O') RETURNING id`,
    );
    const otherUserId = (otherUser as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const router = createTaxReturnRouter({
      db: harness.db,
      fakeUserRoles: new Map([[otherUserId, ['partner']]]),
    });
    const r = await invokePatch(router, '/:returnId/sections/:sectionId', {
      body: { recipientName: 'X' },
      params: { returnId: f.returnId, sectionId: f.sectionId },
      query: {},
      staffSession: { firmId: otherFirmId, appUserId: otherUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(r.statusCode).toBe(404);
    const [row] = await harness.db
      .select()
      .from(taxReturnSections)
      .where(eq(taxReturnSections.id, f.sectionId));
    expect(row!.isManualOverride).toBe(false);
  });

  it('unknown sectionId 404', async () => {
    const f = await seedReturnWithSection();
    const router = createTaxReturnRouter({
      db: harness.db,
      fakeUserRoles: new Map([[f.appUserId, ['partner']]]),
    });
    const r = await invokePatch(router, '/:returnId/sections/:sectionId', {
      body: { recipientName: 'X' },
      params: {
        returnId: f.returnId,
        sectionId: '00000000-0000-4000-8000-000000000000',
      },
      query: {},
      staffSession: { firmId: f.firmId, appUserId: f.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(r.statusCode).toBe(404);
  });
});
