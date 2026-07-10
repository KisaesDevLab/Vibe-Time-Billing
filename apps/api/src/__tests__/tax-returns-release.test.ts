// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// TR-3 — Release helper + routes tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { taxReturns, taxReturnReleases, taxReturnSections } from '@vibe/db/schema';
import { createRelease, revokeRelease, ReleaseError } from '../tax-returns/release-helper';
import { createTaxReturnRouter } from '../tax-returns/routes';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

async function seedReturn(): Promise<{
  firmId: string;
  clientId: string;
  appUserId: string;
  returnId: string;
  sectionIds: string[];
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
      rawTitle: 'Schedule L',
      normalizedTitle: 'Schedule L',
      kind: 'SCHEDULE',
      startPage: 10,
      endPage: 10,
    })
    .returning({ id: taxReturnSections.id });
  return {
    firmId: seed.firmId,
    clientId: seed.clientId,
    appUserId: seed.appUserId,
    returnId: r!.id,
    sectionIds: [s1[0]!.id, s2[0]!.id],
  };
}

describe('TR-3 — createRelease helper', () => {
  it('inserts a FULL release and flips return status to RELEASED', async () => {
    const f = await seedReturn();
    const result = await createRelease({
      db: harness.db,
      returnId: f.returnId,
      firmId: f.firmId,
      releasedToClientId: f.clientId,
      scope: 'FULL',
      sectionIds: [],
      clientCanDownload: true,
      coverNote: null,
      releasedByUserId: f.appUserId,
    });
    expect(result.releaseId).toBeTruthy();
    expect(result.supersededReleaseId).toBeNull();
    const [r] = await harness.db.select().from(taxReturns).where(eq(taxReturns.id, f.returnId));
    expect(r!.status).toBe('RELEASED');
    expect(r!.releasedAt).not.toBeNull();
  });

  it('SELECTED with valid section ids succeeds', async () => {
    const f = await seedReturn();
    const result = await createRelease({
      db: harness.db,
      returnId: f.returnId,
      firmId: f.firmId,
      releasedToClientId: f.clientId,
      scope: 'SELECTED',
      sectionIds: [f.sectionIds[1]!], // Schedule L only
      clientCanDownload: false,
      coverNote: 'Please review Schedule L',
      releasedByUserId: f.appUserId,
    });
    expect(result.releaseId).toBeTruthy();
    const [rel] = await harness.db
      .select()
      .from(taxReturnReleases)
      .where(eq(taxReturnReleases.id, result.releaseId));
    expect(rel!.scope).toBe('SELECTED');
    expect(rel!.sectionIds).toEqual([f.sectionIds[1]!]);
    expect(rel!.clientCanDownload).toBe(false);
  });

  it('rejects SELECTED with empty sectionIds', async () => {
    const f = await seedReturn();
    await expect(
      createRelease({
        db: harness.db,
        returnId: f.returnId,
        firmId: f.firmId,
        releasedToClientId: f.clientId,
        scope: 'SELECTED',
        sectionIds: [],
        clientCanDownload: true,
        coverNote: null,
        releasedByUserId: f.appUserId,
      }),
    ).rejects.toThrow(ReleaseError);
  });

  it('rejects unknown section id', async () => {
    const f = await seedReturn();
    await expect(
      createRelease({
        db: harness.db,
        returnId: f.returnId,
        firmId: f.firmId,
        releasedToClientId: f.clientId,
        scope: 'SELECTED',
        sectionIds: ['00000000-0000-4000-8000-000000000000'],
        clientCanDownload: true,
        coverNote: null,
        releasedByUserId: f.appUserId,
      }),
    ).rejects.toThrow(/unknown_section/);
  });

  it('rejects cross-firm release attempt', async () => {
    const f = await seedReturn();
    await expect(
      createRelease({
        db: harness.db,
        returnId: f.returnId,
        firmId: '00000000-0000-4000-8000-000000000000', // different firm
        releasedToClientId: f.clientId,
        scope: 'FULL',
        sectionIds: [],
        clientCanDownload: true,
        coverNote: null,
        releasedByUserId: f.appUserId,
      }),
    ).rejects.toThrow(/forbidden/);
  });

  it('re-release soft-revokes the prior live release', async () => {
    const f = await seedReturn();
    const first = await createRelease({
      db: harness.db,
      returnId: f.returnId,
      firmId: f.firmId,
      releasedToClientId: f.clientId,
      scope: 'FULL',
      sectionIds: [],
      clientCanDownload: true,
      coverNote: null,
      releasedByUserId: f.appUserId,
    });
    const second = await createRelease({
      db: harness.db,
      returnId: f.returnId,
      firmId: f.firmId,
      releasedToClientId: f.clientId,
      scope: 'SELECTED',
      sectionIds: [f.sectionIds[0]!],
      clientCanDownload: true,
      coverNote: null,
      releasedByUserId: f.appUserId,
    });
    expect(second.supersededReleaseId).toBe(first.releaseId);
    const all = await harness.db
      .select()
      .from(taxReturnReleases)
      .where(eq(taxReturnReleases.returnId, f.returnId));
    expect(all.length).toBe(2);
    const liveRows = all.filter((r) => r.revokedAt === null);
    expect(liveRows.length).toBe(1);
    expect(liveRows[0]!.id).toBe(second.releaseId);
  });

  it('rejects release on a superseded return', async () => {
    const f = await seedReturn();
    await harness.db.execute(
      sql`UPDATE tax_returns SET status = 'SUPERSEDED' WHERE id = ${f.returnId}`,
    );
    await expect(
      createRelease({
        db: harness.db,
        returnId: f.returnId,
        firmId: f.firmId,
        releasedToClientId: f.clientId,
        scope: 'FULL',
        sectionIds: [],
        clientCanDownload: true,
        coverNote: null,
        releasedByUserId: f.appUserId,
      }),
    ).rejects.toThrow(/superseded/);
  });
});

describe('TR-3 — revokeRelease', () => {
  it('soft-revokes and is idempotent', async () => {
    const f = await seedReturn();
    const result = await createRelease({
      db: harness.db,
      returnId: f.returnId,
      firmId: f.firmId,
      releasedToClientId: f.clientId,
      scope: 'FULL',
      sectionIds: [],
      clientCanDownload: true,
      coverNote: null,
      releasedByUserId: f.appUserId,
    });
    await revokeRelease(harness.db, result.releaseId, f.appUserId, f.firmId);
    const [row] = await harness.db
      .select()
      .from(taxReturnReleases)
      .where(eq(taxReturnReleases.id, result.releaseId));
    expect(row!.revokedAt).not.toBeNull();
    // Second revoke is a no-op (doesn't bump revoked_at)
    const ts1 = row!.revokedAt!.getTime();
    await revokeRelease(harness.db, result.releaseId, f.appUserId, f.firmId);
    const [row2] = await harness.db
      .select()
      .from(taxReturnReleases)
      .where(eq(taxReturnReleases.id, result.releaseId));
    expect(row2!.revokedAt!.getTime()).toBe(ts1);
  });

  it('rejects cross-firm revoke', async () => {
    const f = await seedReturn();
    const result = await createRelease({
      db: harness.db,
      returnId: f.returnId,
      firmId: f.firmId,
      releasedToClientId: f.clientId,
      scope: 'FULL',
      sectionIds: [],
      clientCanDownload: true,
      coverNote: null,
      releasedByUserId: f.appUserId,
    });
    await expect(
      revokeRelease(
        harness.db,
        result.releaseId,
        f.appUserId,
        '00000000-0000-4000-8000-000000000000',
      ),
    ).rejects.toThrow(/forbidden/);
  });
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
  ended: boolean;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
  end(): FakeRes;
}
function makeRes(): FakeRes {
  return {
    statusCode: 200,
    jsonBody: undefined,
    ended: false,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.jsonBody = b;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}
async function invoke(
  router: ReturnType<typeof createTaxReturnRouter>,
  method: 'get' | 'post' | 'delete',
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
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

describe('TR-3 — routes', () => {
  it('POST /releases creates a release', async () => {
    const f = await seedReturn();
    const router = createTaxReturnRouter({
      db: harness.db,
      fakeUserRoles: new Map([[f.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/:returnId/releases', {
      body: {
        releasedToClientId: f.clientId,
        scope: 'FULL',
        sectionIds: [],
        clientCanDownload: true,
        coverNote: null,
      },
      params: { returnId: f.returnId },
      query: {},
      staffSession: { firmId: f.firmId, appUserId: f.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(r.statusCode).toBe(201);
    expect((r.jsonBody as { releaseId: string }).releaseId).toBeTruthy();
  });

  it('POST /releases 400 on invalid payload', async () => {
    const f = await seedReturn();
    const router = createTaxReturnRouter({
      db: harness.db,
      fakeUserRoles: new Map([[f.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/:returnId/releases', {
      body: { releasedToClientId: 'not-a-uuid', scope: 'FULL', sectionIds: [] },
      params: { returnId: f.returnId },
      query: {},
      staffSession: { firmId: f.firmId, appUserId: f.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(r.statusCode).toBe(400);
  });

  it('DELETE /releases/:id revokes', async () => {
    const f = await seedReturn();
    const router = createTaxReturnRouter({
      db: harness.db,
      fakeUserRoles: new Map([[f.appUserId, ['partner']]]),
    });
    const create = await invoke(router, 'post', '/:returnId/releases', {
      body: { releasedToClientId: f.clientId, scope: 'FULL', sectionIds: [] },
      params: { returnId: f.returnId },
      query: {},
      staffSession: { firmId: f.firmId, appUserId: f.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    const releaseId = (create.jsonBody as { releaseId: string }).releaseId;
    const del = await invoke(router, 'delete', '/:returnId/releases/:releaseId', {
      body: {},
      params: { returnId: f.returnId, releaseId },
      query: {},
      staffSession: { firmId: f.firmId, appUserId: f.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(del.statusCode).toBe(204);
  });

  it('DELETE /:returnId hard-deletes an unreleased return', async () => {
    const f = await seedReturn();
    const router = createTaxReturnRouter({
      db: harness.db,
      fakeUserRoles: new Map([[f.appUserId, ['partner']]]),
    });
    const del = await invoke(router, 'delete', '/:returnId', {
      body: {},
      params: { returnId: f.returnId },
      query: {},
      staffSession: { firmId: f.firmId, appUserId: f.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(del.statusCode).toBe(204);
    const remaining = await harness.db
      .select({ id: taxReturns.id })
      .from(taxReturns)
      .where(eq(taxReturns.id, f.returnId));
    expect(remaining.length).toBe(0);
    // Sections cascade away too.
    const secs = await harness.db
      .select({ id: taxReturnSections.id })
      .from(taxReturnSections)
      .where(eq(taxReturnSections.returnId, f.returnId));
    expect(secs.length).toBe(0);
  });

  it('DELETE /:returnId 404 for another firm', async () => {
    const f = await seedReturn();
    const router = createTaxReturnRouter({
      db: harness.db,
      fakeUserRoles: new Map([[f.appUserId, ['partner']]]),
    });
    const del = await invoke(router, 'delete', '/:returnId', {
      body: {},
      params: { returnId: f.returnId },
      query: {},
      // Wrong firm id → must not find the return.
      staffSession: { firmId: '00000000-0000-0000-0000-000000000000', appUserId: f.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(del.statusCode).toBe(404);
  });

  it('DELETE /:returnId deletes a RELEASED return and cascades its releases', async () => {
    const f = await seedReturn();
    const router = createTaxReturnRouter({
      db: harness.db,
      fakeUserRoles: new Map([[f.appUserId, ['partner']]]),
    });
    await invoke(router, 'post', '/:returnId/releases', {
      body: { releasedToClientId: f.clientId, scope: 'FULL', sectionIds: [] },
      params: { returnId: f.returnId },
      query: {},
      staffSession: { firmId: f.firmId, appUserId: f.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    const del = await invoke(router, 'delete', '/:returnId', {
      body: {},
      params: { returnId: f.returnId },
      query: {},
      staffSession: { firmId: f.firmId, appUserId: f.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(del.statusCode).toBe(204);
    // The return is gone and its releases cascaded away (client loses access).
    const ret = await harness.db
      .select({ id: taxReturns.id })
      .from(taxReturns)
      .where(eq(taxReturns.id, f.returnId));
    expect(ret.length).toBe(0);
    const rel = await harness.db
      .select({ id: taxReturnReleases.id })
      .from(taxReturnReleases)
      .where(eq(taxReturnReleases.returnId, f.returnId));
    expect(rel.length).toBe(0);
  });

  it('DELETE /:returnId 409 when an amendment points at it', async () => {
    const f = await seedReturn();
    // A second return that amends the first.
    await harness.db.insert(taxReturns).values({
      firmId: f.firmId,
      clientId: f.clientId,
      taxYear: 2025,
      formCode: '1120-S',
      title: '2025 S-Corp (amended)',
      status: 'DRAFT',
      releaseKind: 'AMENDED',
      amendsReturnId: f.returnId,
    });
    const router = createTaxReturnRouter({
      db: harness.db,
      fakeUserRoles: new Map([[f.appUserId, ['partner']]]),
    });
    const del = await invoke(router, 'delete', '/:returnId', {
      body: {},
      params: { returnId: f.returnId },
      query: {},
      staffSession: { firmId: f.firmId, appUserId: f.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(del.statusCode).toBe(409);
    expect((del.jsonBody as { error: string }).error).toBe('has_amendments');
  });

  it('GET / lists firm returns only', async () => {
    const f = await seedReturn();
    // Seed a second firm + return that should NOT appear.
    const other = await harness.db.execute(
      sql`INSERT INTO firm (name) VALUES ('Other Firm') RETURNING id`,
    );
    const otherFirmId = (other as unknown as { rows: { id: string }[] }).rows[0]!.id;
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
    await harness.db.insert(taxReturns).values({
      firmId: otherFirmId,
      clientId: otherClientId,
      taxYear: 2024,
      formCode: '1040',
      title: 'Other firm return',
    });
    const router = createTaxReturnRouter({
      db: harness.db,
      fakeUserRoles: new Map([[f.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'get', '/', {
      body: {},
      params: {},
      query: {},
      staffSession: { firmId: f.firmId, appUserId: f.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    const items = (r.jsonBody as { items: { id: string }[] }).items;
    expect(items.length).toBe(1);
    expect(items[0]!.id).toBe(f.returnId);
  });
});
