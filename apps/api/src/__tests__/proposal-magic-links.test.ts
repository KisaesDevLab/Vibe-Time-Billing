// SPDX-License-Identifier: Elastic-2.0
//
// P17 — Proposal magic-link mint + redeem tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { eq, sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { magicLinks, proposalActivity, proposals } from '@vibe/db/schema';
import { createPortalMagicLinkRouter, createStaffMagicLinkRouter } from '../proposals/magic-links';
import { createProposalRouter } from '../proposals/routes';

let harness: PgliteHarness;
let redis: Redis;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
});

afterEach(async () => {
  await harness.close();
  await redis.quit();
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
function makeReq(o: { firmId?: string; appUserId?: string } & Partial<FakeReq>): FakeReq {
  return {
    body: o.body ?? {},
    params: o.params ?? {},
    query: o.query ?? {},
    staffSession: { firmId: o.firmId ?? '', appUserId: o.appUserId ?? '' },
    ip: o.ip ?? '127.0.0.1',
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
  router: ReturnType<
    | typeof createStaffMagicLinkRouter
    | typeof createPortalMagicLinkRouter
    | typeof createProposalRouter
  >,
  method: 'get' | 'post',
  path: string,
  req: FakeReq,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const route = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return route.path === path && route.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method.toUpperCase()} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

async function setup(): Promise<{
  firmId: string;
  appUserId: string;
  clientId: string;
  proposalId: string;
  staffRouter: ReturnType<typeof createStaffMagicLinkRouter>;
  portalRouter: ReturnType<typeof createPortalMagicLinkRouter>;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const proposalRouter = createProposalRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
  });
  const create = await invoke(proposalRouter, 'post', '/', {
    ...makeReq({ firmId: seed.firmId, appUserId: seed.appUserId }),
    body: { clientId: seed.clientId, title: 'Magic Link Test' },
  });
  const proposalId = (create.jsonBody as { id: string }).id;
  // Send so it's not DRAFT (links still mintable in any non-closed state).
  await invoke(proposalRouter, 'post', '/:id/send', {
    ...makeReq({ firmId: seed.firmId, appUserId: seed.appUserId, params: { id: proposalId } }),
    body: {},
  });
  const staffRouter = createStaffMagicLinkRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    portalBaseUrl: 'https://portal.firm.example',
  });
  const portalRouter = createPortalMagicLinkRouter({
    db: harness.db,
    redis,
  });
  return {
    firmId: seed.firmId,
    appUserId: seed.appUserId,
    clientId: seed.clientId,
    proposalId,
    staffRouter,
    portalRouter,
  };
}

describe('P17 — staff mint', () => {
  it('mints a 256-bit token, hashes in DB, returns URL', async () => {
    const f = await setup();
    const r = await invoke(f.staffRouter, 'post', '/:id/mint-magic-link', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: f.proposalId } }),
      body: {},
    });
    expect(r.statusCode).toBe(201);
    const body = r.jsonBody as { id: string; token: string; url: string; expiresAt: string };
    expect(body.token.length).toBeGreaterThanOrEqual(40); // base64url(32 bytes)
    expect(body.url).toContain('https://portal.firm.example/p/');
    const [row] = await harness.db.select().from(magicLinks).where(eq(magicLinks.id, body.id));
    expect(row!.tokenHash.length).toBe(64); // sha256 hex
    expect(row!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(row!.proposalId).toBe(f.proposalId);
  });

  it('rejects ttlDays outside [1, 180]', async () => {
    const f = await setup();
    const tooLong = await invoke(f.staffRouter, 'post', '/:id/mint-magic-link', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: f.proposalId } }),
      body: { ttlDays: 365 },
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it('supersedes prior unused link on second mint', async () => {
    const f = await setup();
    const first = await invoke(f.staffRouter, 'post', '/:id/mint-magic-link', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: f.proposalId } }),
      body: {},
    });
    const firstId = (first.jsonBody as { id: string }).id;
    const second = await invoke(f.staffRouter, 'post', '/:id/mint-magic-link', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: f.proposalId } }),
      body: {},
    });
    const secondId = (second.jsonBody as { id: string }).id;
    const [oldRow] = await harness.db.select().from(magicLinks).where(eq(magicLinks.id, firstId));
    expect(oldRow!.supersededAt).not.toBeNull();
    expect(oldRow!.supersededById).toBe(secondId);
    // The newly minted one is NOT superseded.
    const [newRow] = await harness.db.select().from(magicLinks).where(eq(magicLinks.id, secondId));
    expect(newRow!.supersededAt).toBeNull();
  });

  it('refuses to mint on closed proposal', async () => {
    const f = await setup();
    await harness.db
      .update(proposals)
      .set({ status: 'CANCELLED' })
      .where(eq(proposals.id, f.proposalId));
    const r = await invoke(f.staffRouter, 'post', '/:id/mint-magic-link', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: f.proposalId } }),
      body: {},
    });
    expect(r.statusCode).toBe(409);
  });

  it('lists firm-side magic-link metadata without exposing hashes', async () => {
    const f = await setup();
    await invoke(f.staffRouter, 'post', '/:id/mint-magic-link', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: f.proposalId } }),
      body: {},
    });
    const list = await invoke(f.staffRouter, 'get', '/:id/magic-links', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: f.proposalId } }),
    });
    const items = (list.jsonBody as { items: { id: string; tokenHash?: string }[] }).items;
    expect(items.length).toBe(1);
    expect(items[0]!.tokenHash).toBeUndefined();
  });
});

describe('P17 — portal redeem', () => {
  async function mint(f: Awaited<ReturnType<typeof setup>>): Promise<string> {
    const r = await invoke(f.staffRouter, 'post', '/:id/mint-magic-link', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: f.proposalId } }),
      body: {},
    });
    return (r.jsonBody as { token: string }).token;
  }

  it('redeems + advances proposal SENT → VIEWED + logs OPENED activity', async () => {
    const f = await setup();
    const token = await mint(f);
    const r = await invoke(f.portalRouter, 'post', '/redeem', {
      ...makeReq({ body: { token }, ip: '203.0.113.7' }),
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as { proposal: { id: string; status: string; title: string } };
    expect(body.proposal.id).toBe(f.proposalId);
    expect(body.proposal.status).toBe('VIEWED');
    const [p] = await harness.db.select().from(proposals).where(eq(proposals.id, f.proposalId));
    expect(p!.status).toBe('VIEWED');
    expect(p!.firstViewedAt).not.toBeNull();
    const activity = await harness.db
      .select()
      .from(proposalActivity)
      .where(eq(proposalActivity.proposalId, f.proposalId));
    expect(activity.find((a) => a.kind === 'OPENED')).toBeTruthy();
  });

  it('returns 404 for unknown token', async () => {
    const f = await setup();
    const r = await invoke(f.portalRouter, 'post', '/redeem', {
      ...makeReq({ body: { token: 'a'.repeat(43) } }),
    });
    expect(r.statusCode).toBe(404);
    expect((r.jsonBody as { error: string }).error).toBe('token_not_found');
  });

  it('returns 410 for expired token', async () => {
    const f = await setup();
    const token = await mint(f);
    // Backdate both created_at and expires_at so the
    // expires_after_creation CHECK stays satisfied (-1d > -2d).
    await harness.db.execute(
      sql`UPDATE magic_links
            SET created_at = now() - interval '2 days',
                expires_at = now() - interval '1 day'
          WHERE proposal_id = ${f.proposalId}`,
    );
    const r = await invoke(f.portalRouter, 'post', '/redeem', {
      ...makeReq({ body: { token } }),
    });
    expect(r.statusCode).toBe(410);
    expect((r.jsonBody as { error: string }).error).toBe('token_expired');
  });

  it('returns 410 for superseded token (resend flow)', async () => {
    const f = await setup();
    const firstToken = await mint(f);
    await mint(f); // Mint a second; supersedes the first.
    const r = await invoke(f.portalRouter, 'post', '/redeem', {
      ...makeReq({ body: { token: firstToken } }),
    });
    expect(r.statusCode).toBe(410);
    expect((r.jsonBody as { error: string }).error).toBe('token_superseded');
  });

  it('rate-limits redeem to 10 attempts per IP per hour', async () => {
    const f = await setup();
    const bad = 'b'.repeat(43);
    for (let i = 0; i < 10; i++) {
      const r = await invoke(f.portalRouter, 'post', '/redeem', {
        ...makeReq({ body: { token: bad }, ip: '198.51.100.5' }),
      });
      expect(r.statusCode).toBe(404);
    }
    // 11th request from same IP → 429
    const r = await invoke(f.portalRouter, 'post', '/redeem', {
      ...makeReq({ body: { token: bad }, ip: '198.51.100.5' }),
    });
    expect(r.statusCode).toBe(429);
  });

  it('subsequent redeem from same token refreshes use info without re-bumping status', async () => {
    const f = await setup();
    const token = await mint(f);
    await invoke(f.portalRouter, 'post', '/redeem', {
      ...makeReq({ body: { token }, ip: '203.0.113.7' }),
    });
    const [first] = await harness.db
      .select()
      .from(magicLinks)
      .where(eq(magicLinks.proposalId, f.proposalId));
    const firstUsedAt = first!.usedAt;
    await invoke(f.portalRouter, 'post', '/redeem', {
      ...makeReq({ body: { token }, ip: '198.51.100.99' }),
    });
    const [second] = await harness.db
      .select()
      .from(magicLinks)
      .where(eq(magicLinks.proposalId, f.proposalId));
    // used_at stays anchored to first redemption time.
    expect(second!.usedAt?.getTime()).toBe(firstUsedAt?.getTime());
    expect(second!.usedFromIp).toBe('198.51.100.99');
  });
});
