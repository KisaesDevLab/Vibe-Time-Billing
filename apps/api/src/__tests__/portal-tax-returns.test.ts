// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-4 — Portal tax-return viewer route tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { taxReturnReleases, taxReturnSections, taxReturns } from '@vibe/db/schema';
import { createPortalTaxReturnRouter } from '../portal/tax-returns';

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
  portalSession: { portalIdentityId: string; activeClientId: string };
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
async function invoke(
  router: ReturnType<typeof createPortalTaxReturnRouter>,
  method: 'get',
  path: string,
  req: FakeReq,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method.toUpperCase()} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  // Find the actual route handler (skipping requireAuth which is the first one)
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

async function setup(scope: 'FULL' | 'SELECTED'): Promise<{
  clientId: string;
  portalIdentityId: string;
  returnId: string;
  releaseId: string;
  sectionIds: string[];
  router: ReturnType<typeof createPortalTaxReturnRouter>;
}> {
  const seed = await seedMinimalFirm(harness.db);
  // Need a portal identity + client_portal_access for resolveScope.
  const identity = await harness.db.execute(
    sql`INSERT INTO portal_identity (firm_id, full_name, primary_email)
        VALUES (${seed.firmId}, 'Client User', 'client@example.com') RETURNING id`,
  );
  const portalIdentityId = (identity as unknown as { rows: { id: string }[] }).rows[0]!.id;
  await harness.db.execute(
    sql`INSERT INTO client_portal_access (portal_identity_id, client_id, status, role)
        VALUES (${portalIdentityId}, ${seed.clientId}, 'ACTIVE', 'FULL')`,
  );
  const [r] = await harness.db
    .insert(taxReturns)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      taxYear: 2025,
      formCode: '1120-S',
      title: '2025 S-Corp',
      status: 'RELEASED',
      totalPages: 14,
    })
    .returning();
  const s1 = await harness.db
    .insert(taxReturnSections)
    .values({
      returnId: r!.id,
      ordinal: 0,
      rawTitle: 'Form 1120-S',
      normalizedTitle: 'Form 1120-S',
      kind: 'MAIN_FORM',
      startPage: 1,
      endPage: 5,
    })
    .returning({ id: taxReturnSections.id });
  const s2 = await harness.db
    .insert(taxReturnSections)
    .values({
      returnId: r!.id,
      ordinal: 1,
      rawTitle: 'Schedule K-1 — Maya',
      normalizedTitle: 'Schedule K-1 — Maya',
      kind: 'K1',
      recipientName: 'Maya',
      startPage: 6,
      endPage: 7,
    })
    .returning({ id: taxReturnSections.id });
  const s3 = await harness.db
    .insert(taxReturnSections)
    .values({
      returnId: r!.id,
      ordinal: 2,
      rawTitle: 'Worksheets',
      normalizedTitle: 'Worksheets',
      kind: 'WORKSHEET',
      releasable: false,
      startPage: 8,
      endPage: 14,
    })
    .returning({ id: taxReturnSections.id });
  const sectionIds = [s1[0]!.id, s2[0]!.id, s3[0]!.id];
  const [rel] = await harness.db
    .insert(taxReturnReleases)
    .values({
      returnId: r!.id,
      releasedToClientId: seed.clientId,
      scope,
      // FULL means empty; SELECTED includes s1 + s2 (Worksheets withheld)
      sectionIds: scope === 'FULL' ? [] : [sectionIds[0]!, sectionIds[1]!],
      releasedByUserId: seed.appUserId,
    })
    .returning({ id: taxReturnReleases.id });

  // requireAuth in the router is a no-op pass-through in tests.
  const router = createPortalTaxReturnRouter({
    db: harness.db,
    requireAuth: (_req, _res, next) => next(),
  });
  return {
    clientId: seed.clientId,
    portalIdentityId,
    returnId: r!.id,
    releaseId: rel!.id,
    sectionIds,
    router,
  };
}

function makeReq(o: {
  portalIdentityId: string;
  clientId: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
}): FakeReq {
  return {
    body: {},
    params: o.params ?? {},
    query: o.query ?? {},
    portalSession: {
      portalIdentityId: o.portalIdentityId,
      activeClientId: o.clientId,
    },
    ip: '127.0.0.1',
    get: () => undefined,
  };
}

describe('TR-4 — GET /', () => {
  it('lists releases scoped to the caller', async () => {
    const f = await setup('FULL');
    const r = await invoke(f.router, 'get', '/', makeReq(f));
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as { items: { returnId: string; scope: string }[] };
    expect(body.items.length).toBe(1);
    expect(body.items[0]!.returnId).toBe(f.returnId);
    expect(body.items[0]!.scope).toBe('FULL');
  });
});

describe('TR-4 — GET /:returnId/meta', () => {
  it('FULL release shows every section', async () => {
    const f = await setup('FULL');
    const r = await invoke(
      f.router,
      'get',
      '/:returnId/meta',
      makeReq({ ...f, params: { returnId: f.returnId } }),
    );
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as { sections: { id: string }[] };
    expect(body.sections.length).toBe(3);
  });

  it('SELECTED release WITHHOLDS unlisted sections from sidebar', async () => {
    const f = await setup('SELECTED');
    const r = await invoke(
      f.router,
      'get',
      '/:returnId/meta',
      makeReq({ ...f, params: { returnId: f.returnId } }),
    );
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as { sections: { id: string; title: string }[] };
    // Worksheets is the 3rd section and not in the release — must be
    // invisible.
    expect(body.sections.length).toBe(2);
    expect(body.sections.map((s) => s.id)).toEqual([f.sectionIds[0]!, f.sectionIds[1]!]);
    expect(body.sections.map((s) => s.title)).not.toContain('Worksheets');
  });

  it('404 when caller has no release for this return', async () => {
    const f = await setup('FULL');
    // Make a second firm / client / return — caller should not see.
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
          VALUES (${otherFirmId}, 'Other', ${otherUserId}, ${otherOfficeId}) RETURNING id`,
    );
    const otherClientId = (otherClient as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherRet = await harness.db
      .insert(taxReturns)
      .values({
        firmId: otherFirmId,
        clientId: otherClientId,
        taxYear: 2025,
        formCode: '1040',
        title: 'Other firm',
      })
      .returning({ id: taxReturns.id });
    await harness.db.insert(taxReturnReleases).values({
      returnId: otherRet[0]!.id,
      releasedToClientId: otherClientId,
      scope: 'FULL',
      releasedByUserId: otherUserId,
    });
    // Caller is the original firm's client → cannot see the other firm's release.
    const r = await invoke(
      f.router,
      'get',
      '/:returnId/meta',
      makeReq({ ...f, params: { returnId: otherRet[0]!.id } }),
    );
    expect(r.statusCode).toBe(404);
  });

  it('404 when release was revoked', async () => {
    const f = await setup('FULL');
    await harness.db.execute(
      sql`UPDATE tax_return_releases SET revoked_at = NOW() WHERE id = ${f.releaseId}`,
    );
    const r = await invoke(
      f.router,
      'get',
      '/:returnId/meta',
      makeReq({ ...f, params: { returnId: f.returnId } }),
    );
    expect(r.statusCode).toBe(404);
  });
});

describe('TR-4 — GET /:returnId.pdf', () => {
  it('returns 503 (renderer unavailable) with plan metadata, never source bytes', async () => {
    const f = await setup('SELECTED');
    const r = await invoke(
      f.router,
      'get',
      '/:returnId.pdf',
      makeReq({ ...f, params: { returnId: f.returnId } }),
    );
    expect(r.statusCode).toBe(503);
    const body = r.jsonBody as {
      error: string;
      pages: number;
      cacheKey: string;
      watermark: string;
    };
    expect(body.error).toBe('pdf_renderer_unavailable');
    // Released sections s1 (pp 1-5) + s2 (pp 6-7) = 7 pages.
    expect(body.pages).toBe(7);
    expect(body.cacheKey).toMatch(/^[a-f0-9]{64}$/);
    expect(body.watermark).toContain('viewed');
  });

  it('404 when caller has no release', async () => {
    const f = await setup('FULL');
    await harness.db.execute(
      sql`UPDATE tax_return_releases SET revoked_at = NOW() WHERE id = ${f.releaseId}`,
    );
    const r = await invoke(
      f.router,
      'get',
      '/:returnId.pdf',
      makeReq({ ...f, params: { returnId: f.returnId } }),
    );
    expect(r.statusCode).toBe(404);
  });
});
