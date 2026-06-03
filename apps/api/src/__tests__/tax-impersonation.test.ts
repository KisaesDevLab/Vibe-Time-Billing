// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-5 — Impersonation tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import {
  issueImpersonationToken,
  verifyImpersonationToken,
  ImpersonationTokenError,
  requireReadOnlyDuringImpersonation,
} from '../tax-returns/impersonation';
import { createImpersonationRouter } from '../tax-returns/impersonation-routes';

const SECRET = 'test-staff-secret-please-rotate';

describe('TR-5 — issueImpersonationToken + verify roundtrip', () => {
  it('valid token verifies and exposes the claims', async () => {
    const issued = await issueImpersonationToken({
      staffSecret: SECRET,
      clientId: 'c1',
      accessId: 'a1',
      staffUserId: 's1',
      staffEmail: 'partner@firm.example',
    });
    const claims = await verifyImpersonationToken(SECRET, issued.token);
    expect(claims.kind).toBe('staff_impersonation');
    expect(claims.clientId).toBe('c1');
    expect(claims.accessId).toBe('a1');
    expect(claims.staffUserId).toBe('s1');
    expect(claims.staffEmail).toBe('partner@firm.example');
  });

  it('rejects an expired token', async () => {
    // Issue with a backdated iat.
    const now = Math.floor(Date.now() / 1000) - 3600;
    const issued = await issueImpersonationToken({
      staffSecret: SECRET,
      clientId: 'c1',
      accessId: 'a1',
      staffUserId: 's1',
      staffEmail: 'p@f.example',
      nowSeconds: now,
    });
    await expect(verifyImpersonationToken(SECRET, issued.token)).rejects.toMatchObject({
      code: 'expired',
    });
  });

  it('rejects a token signed with a different secret', async () => {
    const issued = await issueImpersonationToken({
      staffSecret: SECRET,
      clientId: 'c1',
      accessId: 'a1',
      staffUserId: 's1',
      staffEmail: 'p@f.example',
    });
    await expect(verifyImpersonationToken('other-secret-also-16ch', issued.token)).rejects.toThrow(
      ImpersonationTokenError,
    );
  });

  it('rejects a tampered token', async () => {
    const issued = await issueImpersonationToken({
      staffSecret: SECRET,
      clientId: 'c1',
      accessId: 'a1',
      staffUserId: 's1',
      staffEmail: 'p@f.example',
    });
    const tampered = issued.token.slice(0, -2) + 'XX';
    await expect(verifyImpersonationToken(SECRET, tampered)).rejects.toThrow(
      ImpersonationTokenError,
    );
  });
});

describe('TR-5 — requireReadOnlyDuringImpersonation middleware', () => {
  function build(isImpersonation: boolean): express.Express {
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { portalSession: unknown }).portalSession = {
        portalIdentityId: 'p1',
        activeClientId: 'c1',
        isImpersonation,
      };
      next();
    });
    app.use(requireReadOnlyDuringImpersonation);
    app.get('/x', (_req, res) => res.json({ ok: true }));
    app.post('/x', (_req, res) => res.json({ ok: true }));
    app.patch('/x', (_req, res) => res.json({ ok: true }));
    app.delete('/x', (_req, res) => res.json({ ok: true }));
    return app;
  }

  it('allows GET during impersonation', async () => {
    const app = build(true);
    const r = await request(app).get('/x');
    expect(r.status).toBe(200);
  });

  it('blocks POST during impersonation', async () => {
    const app = build(true);
    const r = await request(app).post('/x').send({});
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('impersonation_is_read_only');
  });

  it('blocks PATCH and DELETE during impersonation', async () => {
    const app = build(true);
    expect((await request(app).patch('/x').send({})).status).toBe(403);
    expect((await request(app).delete('/x')).status).toBe(403);
  });

  it('allows POST when NOT impersonating', async () => {
    const app = build(false);
    const r = await request(app).post('/x').send({});
    expect(r.status).toBe(200);
  });
});

// =====================================================================
// Route tests (direct-handler invocation, as elsewhere)
// =====================================================================

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
async function invoke(
  router: ReturnType<typeof createImpersonationRouter>,
  path: string,
  req: FakeReq,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods['post'] === true;
  });
  if (!layer) throw new Error(`route not registered: POST ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

describe('TR-5 — POST /clients/:clientId/impersonate', () => {
  async function setup(): Promise<{
    firmId: string;
    clientId: string;
    appUserId: string;
    accessId: string;
    router: ReturnType<typeof createImpersonationRouter>;
  }> {
    const seed = await seedMinimalFirm(harness.db);
    const identity = await harness.db.execute(
      sql`INSERT INTO portal_identity (firm_id, full_name, primary_email)
          VALUES (${seed.firmId}, 'Client User', 'c@x.example') RETURNING id`,
    );
    const identityId = (identity as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const access = await harness.db.execute(
      sql`INSERT INTO client_portal_access (portal_identity_id, client_id, status, role)
          VALUES (${identityId}, ${seed.clientId}, 'ACTIVE', 'FULL') RETURNING id`,
    );
    const accessId = (access as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const router = createImpersonationRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
      staffSecret: SECRET,
      portalBaseUrl: 'https://portal.example.com',
    });
    return {
      firmId: seed.firmId,
      clientId: seed.clientId,
      appUserId: seed.appUserId,
      accessId,
      router,
    };
  }

  it('issues a 5-min token', async () => {
    const f = await setup();
    const r = await invoke(f.router, '/:clientId/impersonate', {
      body: { accessId: f.accessId },
      params: { clientId: f.clientId },
      query: {},
      staffSession: { firmId: f.firmId, appUserId: f.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(r.statusCode).toBe(201);
    const body = r.jsonBody as {
      token: string;
      expiresAt: string;
      portalUrl: string;
      ttlSeconds: number;
    };
    expect(body.ttlSeconds).toBe(5 * 60);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // URL points to the portal SPA's /auth/impersonate route, which
    // POSTs the token to /api/portal/auth/impersonate-exchange.
    expect(body.portalUrl).toContain('/auth/impersonate?token=');
    // Verify the issued token roundtrips.
    const claims = await verifyImpersonationToken(SECRET, body.token);
    expect(claims.clientId).toBe(f.clientId);
    expect(claims.accessId).toBe(f.accessId);
  });

  it('404 cross-firm clientId', async () => {
    const f = await setup();
    const otherFirm = await harness.db.execute(
      sql`INSERT INTO firm (name) VALUES ('Other') RETURNING id`,
    );
    const otherFirmId = (otherFirm as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherUser = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${otherFirmId}, 'o@x.example', 'O', 'O', 'O') RETURNING id`,
    );
    const otherUserId = (otherUser as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherClient = await harness.db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id)
          VALUES (${otherFirmId}, 'Other', ${otherUserId}) RETURNING id`,
    );
    const otherClientId = (otherClient as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const r = await invoke(f.router, '/:clientId/impersonate', {
      body: { accessId: f.accessId },
      params: { clientId: otherClientId },
      query: {},
      staffSession: { firmId: f.firmId, appUserId: f.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(r.statusCode).toBe(404);
  });

  it('404 when accessId does not match the clientId', async () => {
    const f = await setup();
    const r = await invoke(f.router, '/:clientId/impersonate', {
      body: { accessId: '00000000-0000-4000-8000-000000000000' },
      params: { clientId: f.clientId },
      query: {},
      staffSession: { firmId: f.firmId, appUserId: f.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(r.statusCode).toBe(404);
    expect((r.jsonBody as { error: string }).error).toBe('access_not_found');
  });

  it('400 on missing accessId', async () => {
    const f = await setup();
    const r = await invoke(f.router, '/:clientId/impersonate', {
      body: {},
      params: { clientId: f.clientId },
      query: {},
      staffSession: { firmId: f.firmId, appUserId: f.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(r.statusCode).toBe(400);
  });
});
