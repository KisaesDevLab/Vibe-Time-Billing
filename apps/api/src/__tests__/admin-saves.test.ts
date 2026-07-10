// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Admin save-path regressions:
//  - PATCH /firm-settings with a MIXED body (firm_settings fields + firm-table
//    fields in one request) must succeed. The dual-parse handler used to use
//    two `.strict()` schemas, which 400'd every mixed save.
//  - POST /api-tokens accepts { name, allowedTools } (FE previously sent
//    `label`, which the schema rejected).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type express from 'express';

import { firms, mcpTokens, officeSettings, offices } from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createAdminRouter } from '../admin/routes';
import { createApiTokenRouter } from '../admin/api-tokens';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

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
  method: 'get' | 'post' | 'patch' | 'put' | 'delete',
  path: string,
  req: Record<string, unknown>,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const chain = route.stack;
  for (let i = 0; i < chain.length - 1; i++) {
    let advanced = false;
    await (chain[i]!.handle as (rq: unknown, rs: unknown, nx: () => void) => unknown)(
      req,
      res,
      () => {
        advanced = true;
      },
    );
    if (!advanced) return res;
  }
  await (chain[chain.length - 1]!.handle as (rq: unknown, rs: unknown) => unknown)(req, res);
  return res;
}

function req(
  opts: { params?: Record<string, string>; body?: unknown } = {},
): Record<string, unknown> {
  return {
    body: opts.body ?? {},
    params: opts.params ?? {},
    query: {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
}

function adminRouter(roles: RoleSlug[] = ['admin']) {
  return createAdminRouter({ db: harness.db, fakeUserRoles: new Map([[seed.appUserId, roles]]) });
}
function tokenRouter(roles: RoleSlug[] = ['admin']) {
  return createApiTokenRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, roles]]),
  });
}

describe('PATCH /firm-settings (mixed body)', () => {
  it('accepts settings-table + firm-table fields in one request', async () => {
    const r = adminRouter();
    const res = await invoke(r, 'patch', '/firm-settings', {
      ...req({
        body: {
          brandDisplayName: 'Acme Brand', // firm_settings field
          name: 'Acme LLP', // firm-table field
          fiscalYearStartMonth: 7, // firm-table field
          defaultTermsDays: 45, // firm-table field
        },
      }),
    });
    expect(res.statusCode).toBe(200);
    expect((res.jsonBody as { ok: boolean }).ok).toBe(true);
    const [firm] = await harness.db.select().from(firms).where(eq(firms.id, seed.firmId));
    expect(firm!.name).toBe('Acme LLP');
    expect(firm!.fiscalYearStartMonth).toBe(7);
    expect(firm!.defaultTermsDays).toBe(45);
  });

  it('accepts a firm-table-only body', async () => {
    const r = adminRouter();
    const res = await invoke(r, 'patch', '/firm-settings', {
      ...req({ body: { name: 'Just Firm' } }),
    });
    expect(res.statusCode).toBe(200);
    const [firm] = await harness.db.select().from(firms).where(eq(firms.id, seed.firmId));
    expect(firm!.name).toBe('Just Firm');
  });

  it('accepts a settings-table-only body', async () => {
    const r = adminRouter();
    const res = await invoke(r, 'patch', '/firm-settings', {
      ...req({ body: { billableTargetHoursPerMonth: 150 } }),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('PUT /offices/:id/settings (per-field merge)', () => {
  it('saving one override field does not wipe sibling overrides', async () => {
    const r = adminRouter();
    const [office] = await harness.db
      .select({ id: offices.id })
      .from(offices)
      .where(eq(offices.firmId, seed.firmId))
      .limit(1);
    const oid = office!.id;
    const put = (body: unknown) =>
      invoke(r, 'put', '/offices/:id/settings', { ...req({ params: { id: oid }, body }) });

    expect((await put({ lateEntryAlertDays: 5 })).statusCode).toBe(200);
    expect((await put({ lateEntryLockoutDays: 30 })).statusCode).toBe(200);

    const [ov] = await harness.db
      .select()
      .from(officeSettings)
      .where(eq(officeSettings.officeId, oid));
    expect(ov!.lateEntryAlertDays).toBe(5); // preserved across the second save
    expect(ov!.lateEntryLockoutDays).toBe(30);
  });
});

describe('POST /api-tokens', () => {
  it('creates a token from { name, allowedTools }', async () => {
    const r = tokenRouter();
    const res = await invoke(r, 'post', '/', {
      ...req({ body: { name: 'Claude Desktop', allowedTools: ['list_engagements'] } }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.jsonBody as { token?: string; name?: string };
    expect(typeof body.token).toBe('string');
    expect(body.name).toBe('Claude Desktop');
    const rows = await harness.db
      .select({ name: mcpTokens.name })
      .from(mcpTokens)
      .where(eq(mcpTokens.firmId, seed.firmId));
    expect(rows.map((x) => x.name)).toContain('Claude Desktop');
  });
});
