// SPDX-License-Identifier: Elastic-2.0
//
// P16 — signature verify route tests. The pure HMAC helpers are
// covered in @vibe/core/proposals/signature-hmac.test.ts; this suite
// exercises the route surface against a pglite-backed signatures
// table.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { proposals, signatures } from '@vibe/db/schema';
import { createSignatureVerifyRouter } from '../proposals/signature-verify';

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
  router: ReturnType<typeof createSignatureVerifyRouter>,
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

const SEED = 'unit-test-seed-32-bytes-long-aaaaaaaa';

async function setup(): Promise<{
  firmId: string;
  appUserId: string;
  clientId: string;
  proposalId: string;
  signatureId: string;
  router: ReturnType<typeof createSignatureVerifyRouter>;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const [proposal] = await harness.db
    .insert(proposals)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      title: 'HMAC Test',
      brochureJsonb: { schemaVersion: 1, blocks: [] } as unknown as Record<string, unknown>,
      createdById: seed.appUserId,
    })
    .returning({ id: proposals.id });
  const [signature] = await harness.db
    .insert(signatures)
    .values({
      proposalId: proposal!.id,
      role: 'PRIMARY',
      sequence: 0,
      signerName: 'Jane Doe',
      signerEmail: 'jane@example.com',
      method: 'TYPED_NAME',
      state: 'SIGNED',
      typedName: 'Jane Doe',
      signedAt: new Date('2026-04-15T15:00:00Z'),
      payloadHash: 'a'.repeat(64),
    })
    .returning({ id: signatures.id });
  const router = createSignatureVerifyRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    hmacSeed: SEED,
  });
  return {
    firmId: seed.firmId,
    appUserId: seed.appUserId,
    clientId: seed.clientId,
    proposalId: proposal!.id,
    signatureId: signature!.id,
    router,
  };
}

describe('P16 — attach-hmac + verify round-trip', () => {
  it('attaches an HMAC then verify reports ok', async () => {
    const f = await setup();
    const attach = await invoke(f.router, 'post', '/:id/attach-hmac', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: f.signatureId } }),
    });
    expect(attach.statusCode).toBe(200);
    expect((attach.jsonBody as { hmacSignature: string }).hmacSignature).toMatch(/^[a-f0-9]{64}$/);
    const verify = await invoke(f.router, 'get', '/:id/verify', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: f.signatureId } }),
    });
    expect(verify.statusCode).toBe(200);
    const body = verify.jsonBody as { ok: boolean; expected: string; actual: string };
    expect(body.ok).toBe(true);
    expect(body.expected).toBe(body.actual);
  });

  it('refuses to attach to a non-SIGNED row', async () => {
    const f = await setup();
    await harness.db
      .update(signatures)
      .set({ state: 'PENDING', signedAt: null, payloadHash: null })
      .where(eq(signatures.id, f.signatureId));
    const r = await invoke(f.router, 'post', '/:id/attach-hmac', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: f.signatureId } }),
    });
    expect(r.statusCode).toBe(409);
    expect((r.jsonBody as { error: string }).error).toBe('not_signed');
  });

  it('refuses to overwrite an existing HMAC', async () => {
    const f = await setup();
    await invoke(f.router, 'post', '/:id/attach-hmac', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: f.signatureId } }),
    });
    const second = await invoke(f.router, 'post', '/:id/attach-hmac', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: f.signatureId } }),
    });
    expect(second.statusCode).toBe(409);
    expect((second.jsonBody as { error: string }).error).toBe('already_has_hmac');
  });

  it('verify reports ok=false when row tampered post-attach', async () => {
    const f = await setup();
    await invoke(f.router, 'post', '/:id/attach-hmac', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: f.signatureId } }),
    });
    // Tamper: change the typed name without recomputing HMAC.
    await harness.db
      .update(signatures)
      .set({ typedName: 'NOT THE ORIGINAL' })
      .where(eq(signatures.id, f.signatureId));
    const verify = await invoke(f.router, 'get', '/:id/verify', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: f.signatureId } }),
    });
    const body = verify.jsonBody as { ok: boolean; expected: string; actual: string };
    expect(body.ok).toBe(false);
    expect(body.expected).not.toBe(body.actual);
  });

  it('verify reports ok=false when hmacSignature column is missing', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'get', '/:id/verify', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: f.signatureId } }),
    });
    const body = r.jsonBody as { ok: boolean; actual: string };
    expect(body.ok).toBe(false);
    expect(body.actual).toBe('');
  });

  it('rejects cross-firm proposal id', async () => {
    const f = await setup();
    // Seed another firm with its own signature and verify the
    // first-firm session gets 404.
    const otherSeed = await seedMinimalFirm(harness.db);
    const [otherProposal] = await harness.db
      .insert(proposals)
      .values({
        firmId: otherSeed.firmId,
        clientId: otherSeed.clientId,
        title: 'Other firm',
        brochureJsonb: { schemaVersion: 1, blocks: [] } as unknown as Record<string, unknown>,
        createdById: otherSeed.appUserId,
      })
      .returning({ id: proposals.id });
    const [otherSig] = await harness.db
      .insert(signatures)
      .values({
        proposalId: otherProposal!.id,
        signerName: 'Foreign',
        signerEmail: 'x@x.com',
        method: 'TYPED_NAME',
        state: 'SIGNED',
        typedName: 'X',
        signedAt: new Date(),
        payloadHash: 'b'.repeat(64),
      })
      .returning({ id: signatures.id });
    const r = await invoke(f.router, 'get', '/:id/verify', {
      ...makeReq({ firmId: f.firmId, appUserId: f.appUserId, params: { id: otherSig!.id } }),
    });
    expect(r.statusCode).toBe(404);
  });

  it('503 when hmacSeed not configured', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createSignatureVerifyRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
      hmacSeed: null,
    });
    const r = await invoke(router, 'get', '/:id/verify', {
      ...makeReq({
        firmId: seed.firmId,
        appUserId: seed.appUserId,
        params: { id: '11111111-1111-1111-1111-111111111111' },
      }),
    });
    expect(r.statusCode).toBe(503);
  });
});
