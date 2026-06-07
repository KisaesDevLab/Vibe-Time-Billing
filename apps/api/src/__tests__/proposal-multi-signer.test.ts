// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Q34 — multi-signer proposals. Covers: roster insert at send,
// partial-then-final acceptance, engagement freeze fires exactly once,
// ACCEPTED snapshot lists all signatureIds, staff-recoverable decline,
// SEQUENTIAL turn gating (not_your_turn), the legacy no-roster path, and
// per-signer HMAC verification.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type express from 'express';

import { engagements, magicLinks, proposalVersions, proposals, signatures } from '@vibe/db/schema';
import {
  computeSignatureHmac,
  deriveFirmHmacKey,
  type SignatureRecord,
} from '@vibe/core/proposals/server';
import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createProposalRouter } from '../proposals/routes';
import { createStaffMagicLinkRouter, createPortalMagicLinkRouter } from '../proposals/magic-links';
import { createAcceptanceRouter } from '../proposals/acceptance';

const HMAC_SEED = 'test-hmac-seed-1234567890-abcdef';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
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
  method: 'get' | 'post' | 'patch',
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

function staffReq(
  firmId: string,
  appUserId: string,
  body: unknown,
  params: Record<string, string> = {},
): Record<string, unknown> {
  return {
    body,
    params,
    query: {},
    headers: {},
    staffSession: { firmId, appUserId },
    ip: '127.0.0.1',
    get: () => undefined,
  };
}

function portalReq(body: unknown, params: Record<string, string> = {}): Record<string, unknown> {
  return {
    body,
    params,
    query: {},
    headers: {},
    ip: '203.0.113.7',
    get: () => 'vitest-ua',
  };
}

function staffRouters(appUserId: string, roles: RoleSlug[] = ['partner']) {
  const fakeUserRoles = new Map([[appUserId, roles]]);
  return {
    proposal: createProposalRouter({ db: harness.db, fakeUserRoles }),
    staffLinks: createStaffMagicLinkRouter({
      db: harness.db,
      fakeUserRoles,
      portalBaseUrl: 'https://portal.test.example',
    }),
  };
}

function portalRouters() {
  return {
    redeem: createPortalMagicLinkRouter({ db: harness.db, redis: null }),
    accept: createAcceptanceRouter({
      db: harness.db,
      hmacSeed: HMAC_SEED,
      portalBaseUrl: 'https://portal.test.example',
    }),
  };
}

async function createDraft(firmId: string, clientId: string, appUserId: string): Promise<string> {
  const row = await harness.db.execute(
    sql`INSERT INTO proposals (firm_id, client_id, status, title, brochure_jsonb, created_by_id)
        VALUES (${firmId}, ${clientId}, 'DRAFT', 'Multi-Signer Proposal', '{}', ${appUserId})
        RETURNING id`,
  );
  return (row as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

// Returns the redeem body for a given minted link token, plus a helper
// to accept as that signer.
async function redeemAndAccept(
  routers: ReturnType<typeof portalRouters>,
  proposalId: string,
  token: string,
  signer: { name: string; email: string },
): Promise<{ redeem: FakeRes; accept: FakeRes }> {
  const redeem = await invoke(routers.redeem, 'post', '/redeem', portalReq({ token }));
  const magicLinkId = (redeem.jsonBody as { magicLinkId: string }).magicLinkId;
  const accept = await invoke(
    routers.accept,
    'post',
    '/:id/accept',
    portalReq(
      {
        magicLinkId,
        signerName: signer.name,
        signerEmail: signer.email,
        typedName: signer.name,
      },
      { id: proposalId },
    ),
  );
  return { redeem, accept };
}

describe('Q34 — multi-signer proposals', () => {
  it('send with 3 signers inserts 3 PENDING rows; signing 1 → IN_PROGRESS (no engagement); all → ACCEPTED once + snapshot lists all ids; per-signer HMAC verifies', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = staffRouters(seed.appUserId);
    const portal = portalRouters();
    const pid = await createDraft(seed.firmId, seed.clientId, seed.appUserId);

    const sendRes = await invoke(
      r.proposal,
      'post',
      '/:id/send',
      staffReq(
        seed.firmId,
        seed.appUserId,
        {
          signers: [
            { name: 'Alice Primary', email: 'alice@co.example' },
            { name: 'Bob Cosigner', email: 'bob@co.example' },
            { name: 'Carol Witness', email: 'carol@co.example' },
          ],
        },
        { id: pid },
      ),
    );
    expect(sendRes.statusCode).toBe(200);
    expect((sendRes.jsonBody as { signerCount: number }).signerCount).toBe(3);

    const roster = await harness.db.select().from(signatures).where(eq(signatures.proposalId, pid));
    expect(roster).toHaveLength(3);
    expect(roster.every((s) => s.state === 'PENDING')).toBe(true);
    expect(roster.find((s) => s.sequence === 0)!.role).toBe('PRIMARY');
    expect(roster.filter((s) => s.role === 'COSIGNER')).toHaveLength(2);

    // Mint all links (PARALLEL → 3 links).
    const mintRes = await invoke(
      r.staffLinks,
      'post',
      '/:id/mint-all-magic-links',
      staffReq(seed.firmId, seed.appUserId, {}, { id: pid }),
    );
    expect(mintRes.statusCode).toBe(201);
    const links = (mintRes.jsonBody as { links: { signerEmail: string; url: string }[] }).links;
    expect(links).toHaveLength(3);
    const tokenFor = (email: string): string => {
      const url = links.find((l) => l.signerEmail === email)!.url;
      return url.split('/p/')[1]!;
    };

    // Sign first signer → IN_PROGRESS, no engagement.
    const first = await redeemAndAccept(portal, pid, tokenFor('alice@co.example'), {
      name: 'Alice Primary',
      email: 'alice@co.example',
    });
    expect(first.accept.statusCode).toBe(200);
    expect((first.accept.jsonBody as { remaining: number }).remaining).toBe(2);
    let prop = (await harness.db.select().from(proposals).where(eq(proposals.id, pid)))[0]!;
    expect(prop.status).toBe('IN_PROGRESS');
    expect(prop.acceptedAt).toBeNull();
    let engs = await harness.db
      .select()
      .from(engagements)
      .where(eq(engagements.fromProposalId, pid));
    expect(engs).toHaveLength(0);

    // Sign second.
    const second = await redeemAndAccept(portal, pid, tokenFor('bob@co.example'), {
      name: 'Bob Cosigner',
      email: 'bob@co.example',
    });
    expect(second.accept.statusCode).toBe(200);
    expect((second.accept.jsonBody as { remaining: number }).remaining).toBe(1);
    prop = (await harness.db.select().from(proposals).where(eq(proposals.id, pid)))[0]!;
    expect(prop.status).toBe('IN_PROGRESS');

    // Sign third (final) → ACCEPTED + engagement once.
    const third = await redeemAndAccept(portal, pid, tokenFor('carol@co.example'), {
      name: 'Carol Witness',
      email: 'carol@co.example',
    });
    expect(third.accept.statusCode).toBe(200);
    const finalBody = third.accept.jsonBody as {
      remaining: number;
      engagementId: string | null;
      signatureIds: string[];
    };
    expect(finalBody.remaining).toBe(0);
    expect(finalBody.engagementId).toBeTruthy();
    expect(finalBody.signatureIds).toHaveLength(3);

    prop = (await harness.db.select().from(proposals).where(eq(proposals.id, pid)))[0]!;
    expect(prop.status).toBe('ACCEPTED');
    expect(prop.acceptedAt).not.toBeNull();

    engs = await harness.db.select().from(engagements).where(eq(engagements.fromProposalId, pid));
    expect(engs).toHaveLength(1);

    // ACCEPTED snapshot lists all signature ids.
    const accVersion = (
      await harness.db
        .select()
        .from(proposalVersions)
        .where(and(eq(proposalVersions.proposalId, pid), eq(proposalVersions.reason, 'ACCEPTED')))
    )[0]!;
    const snap = accVersion.contentJsonb as unknown as { signatureIds: string[] };
    expect(snap.signatureIds.sort()).toEqual(finalBody.signatureIds.sort());

    // Per-signer HMAC verifies for every signed row.
    const signedRows = await harness.db
      .select()
      .from(signatures)
      .where(eq(signatures.proposalId, pid));
    const key = deriveFirmHmacKey(HMAC_SEED, seed.firmId);
    for (const row of signedRows) {
      const record: SignatureRecord = {
        id: row.id,
        proposalId: row.proposalId,
        role: row.role,
        sequence: row.sequence,
        signerName: row.signerName,
        signerEmail: row.signerEmail,
        signerPhone: row.signerPhone,
        signerIp: row.signerIp,
        signerUa: row.signerUa,
        method: row.method ?? '',
        state: row.state,
        typedName: row.typedName,
        signatureSvg: row.signatureSvg,
        opensignEnvelopeId: row.opensignEnvelopeId,
        opensignCertificateObjectKey: row.opensignCertificateObjectKey,
        payloadHash: row.payloadHash,
        signedAt: row.signedAt?.toISOString() ?? null,
        declinedAt: row.declinedAt?.toISOString() ?? null,
        declinedReason: row.declinedReason,
      };
      expect(computeSignatureHmac(record, key)).toBe(row.hmacSignature);
    }
  });

  it('required signer declining → IN_PROGRESS, that signer links superseded, no engagement', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = staffRouters(seed.appUserId);
    const portal = portalRouters();
    const pid = await createDraft(seed.firmId, seed.clientId, seed.appUserId);

    await invoke(
      r.proposal,
      'post',
      '/:id/send',
      staffReq(
        seed.firmId,
        seed.appUserId,
        {
          signers: [
            { name: 'Alice', email: 'alice@co.example' },
            { name: 'Bob', email: 'bob@co.example' },
          ],
        },
        { id: pid },
      ),
    );
    const mintRes = await invoke(
      r.staffLinks,
      'post',
      '/:id/mint-all-magic-links',
      staffReq(seed.firmId, seed.appUserId, {}, { id: pid }),
    );
    const links = (mintRes.jsonBody as { links: { signerEmail: string; url: string }[] }).links;
    const bobToken = links.find((l) => l.signerEmail === 'bob@co.example')!.url.split('/p/')[1]!;

    const redeem = await invoke(portal.redeem, 'post', '/redeem', portalReq({ token: bobToken }));
    const magicLinkId = (redeem.jsonBody as { magicLinkId: string }).magicLinkId;
    const declineRes = await invoke(
      portal.accept,
      'post',
      '/:id/decline',
      portalReq({ magicLinkId, reason: 'not interested' }, { id: pid }),
    );
    expect(declineRes.statusCode).toBe(200);

    const bobRow = (
      await harness.db
        .select()
        .from(signatures)
        .where(and(eq(signatures.proposalId, pid), eq(signatures.signerEmail, 'bob@co.example')))
    )[0]!;
    expect(bobRow.state).toBe('DECLINED');
    expect(bobRow.declinedReason).toBe('not interested');

    const prop = (await harness.db.select().from(proposals).where(eq(proposals.id, pid)))[0]!;
    expect(prop.status).toBe('IN_PROGRESS');

    // Bob's links are superseded; Alice's stay live.
    const bobLinks = await harness.db
      .select()
      .from(magicLinks)
      .where(eq(magicLinks.signatureId, bobRow.id));
    expect(bobLinks.every((l) => l.supersededAt != null)).toBe(true);

    const engs = await harness.db
      .select()
      .from(engagements)
      .where(eq(engagements.fromProposalId, pid));
    expect(engs).toHaveLength(0);

    // Staff can replace the declined signer.
    const replaceRes = await invoke(
      r.staffLinks,
      'post',
      '/:id/signers/:signatureId/replace',
      staffReq(
        seed.firmId,
        seed.appUserId,
        { name: 'Bob Two', email: 'bob2@co.example' },
        { id: pid, signatureId: bobRow.id },
      ),
    );
    expect(replaceRes.statusCode).toBe(200);
    const replaced = (
      await harness.db.select().from(signatures).where(eq(signatures.id, bobRow.id))
    )[0]!;
    expect(replaced.state).toBe('PENDING');
    expect(replaced.signerEmail).toBe('bob2@co.example');
    expect(replaced.declinedReason).toBeNull();
  });

  it('SEQUENTIAL: redeeming the second signer before the first returns not_your_turn', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = staffRouters(seed.appUserId);
    const portal = portalRouters();
    const pid = await createDraft(seed.firmId, seed.clientId, seed.appUserId);

    await invoke(
      r.proposal,
      'post',
      '/:id/send',
      staffReq(
        seed.firmId,
        seed.appUserId,
        {
          signingOrderMode: 'SEQUENTIAL',
          signers: [
            { name: 'Alice', email: 'alice@co.example' },
            { name: 'Bob', email: 'bob@co.example' },
          ],
        },
        { id: pid },
      ),
    );

    // SEQUENTIAL mint-all → only the first signer gets a link.
    const mintRes = await invoke(
      r.staffLinks,
      'post',
      '/:id/mint-all-magic-links',
      staffReq(seed.firmId, seed.appUserId, {}, { id: pid }),
    );
    const links = (mintRes.jsonBody as { links: { signerEmail: string }[] }).links;
    expect(links).toHaveLength(1);
    expect(links[0]!.signerEmail).toBe('alice@co.example');

    // Manually mint a link for Bob (sequence 1) to exercise the gate.
    const bob = (
      await harness.db
        .select()
        .from(signatures)
        .where(and(eq(signatures.proposalId, pid), eq(signatures.signerEmail, 'bob@co.example')))
    )[0]!;
    const bobMint = await invoke(
      r.staffLinks,
      'post',
      '/:id/mint-magic-link',
      staffReq(seed.firmId, seed.appUserId, { signatureId: bob.id }, { id: pid }),
    );
    const bobToken = (bobMint.jsonBody as { token: string }).token;

    const redeem = await invoke(portal.redeem, 'post', '/redeem', portalReq({ token: bobToken }));
    expect(redeem.statusCode).toBe(409);
    expect((redeem.jsonBody as { error: string }).error).toBe('not_your_turn');
  });

  it('legacy no-roster path flips ACCEPTED in one shot + freezes an engagement', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = staffRouters(seed.appUserId);
    const portal = portalRouters();
    const pid = await createDraft(seed.firmId, seed.clientId, seed.appUserId);

    const sendRes = await invoke(
      r.proposal,
      'post',
      '/:id/send',
      staffReq(seed.firmId, seed.appUserId, {}, { id: pid }),
    );
    expect(sendRes.statusCode).toBe(200);
    expect((sendRes.jsonBody as { signerCount: number }).signerCount).toBe(0);

    // No roster rows.
    const roster = await harness.db.select().from(signatures).where(eq(signatures.proposalId, pid));
    expect(roster).toHaveLength(0);

    // Mint a proposal-wide link (no signatureId) and accept.
    const mint = await invoke(
      r.staffLinks,
      'post',
      '/:id/mint-magic-link',
      staffReq(seed.firmId, seed.appUserId, {}, { id: pid }),
    );
    const token = (mint.jsonBody as { token: string }).token;
    const redeem = await invoke(portal.redeem, 'post', '/redeem', portalReq({ token }));
    const magicLinkId = (redeem.jsonBody as { magicLinkId: string }).magicLinkId;
    const accept = await invoke(
      portal.accept,
      'post',
      '/:id/accept',
      portalReq(
        {
          magicLinkId,
          signerName: 'Solo Signer',
          signerEmail: 'solo@co.example',
          typedName: 'Solo Signer',
        },
        { id: pid },
      ),
    );
    expect(accept.statusCode).toBe(200);
    const body = accept.jsonBody as { remaining: number; engagementId: string | null };
    expect(body.remaining).toBe(0);
    expect(body.engagementId).toBeTruthy();

    const prop = (await harness.db.select().from(proposals).where(eq(proposals.id, pid)))[0]!;
    expect(prop.status).toBe('ACCEPTED');

    const signed = await harness.db.select().from(signatures).where(eq(signatures.proposalId, pid));
    expect(signed).toHaveLength(1);
    expect(signed[0]!.role).toBe('PRIMARY');
    expect(signed[0]!.state).toBe('SIGNED');
  });

  it('createEngagementOnAccept=false → accepts but creates NO engagement', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = staffRouters(seed.appUserId);
    const portal = portalRouters();
    const pid = await createDraft(seed.firmId, seed.clientId, seed.appUserId);
    await harness.db.execute(
      sql`UPDATE proposals SET create_engagement_on_accept = false WHERE id = ${pid}`,
    );

    await invoke(
      r.proposal,
      'post',
      '/:id/send',
      staffReq(seed.firmId, seed.appUserId, {}, { id: pid }),
    );
    const mint = await invoke(
      r.staffLinks,
      'post',
      '/:id/mint-magic-link',
      staffReq(seed.firmId, seed.appUserId, {}, { id: pid }),
    );
    const token = (mint.jsonBody as { token: string }).token;
    const redeem = await invoke(portal.redeem, 'post', '/redeem', portalReq({ token }));
    const magicLinkId = (redeem.jsonBody as { magicLinkId: string }).magicLinkId;
    const accept = await invoke(
      portal.accept,
      'post',
      '/:id/accept',
      portalReq(
        { magicLinkId, signerName: 'Solo', signerEmail: 'solo@co.example', typedName: 'Solo' },
        { id: pid },
      ),
    );
    expect(accept.statusCode).toBe(200);
    expect((accept.jsonBody as { engagementId: string | null }).engagementId).toBeNull();

    const prop = (await harness.db.select().from(proposals).where(eq(proposals.id, pid)))[0]!;
    expect(prop.status).toBe('ACCEPTED');
    const engs = await harness.db
      .select()
      .from(engagements)
      .where(eq(engagements.fromProposalId, pid));
    expect(engs).toHaveLength(0);
  });

  it('requestTemplateIdOnAccept spawns a request list on the new engagement', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = staffRouters(seed.appUserId);
    const portal = portalRouters();
    const pid = await createDraft(seed.firmId, seed.clientId, seed.appUserId);

    // A request template + one item, then point the proposal at it.
    const tplRow = await harness.db.execute(
      sql`INSERT INTO request_template (firm_id, key, name, title_pattern, body_pattern)
          VALUES (${seed.firmId}, 'onboarding', 'Onboarding', 'Document checklist', 'Please upload:')
          RETURNING id`,
    );
    const tplId = (tplRow as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await harness.db.execute(
      sql`INSERT INTO request_template_item (template_id, ordinal, label, item_kind, required)
          VALUES (${tplId}, 1, 'Prior-year return', 'DOCUMENT', true)`,
    );
    await harness.db.execute(
      sql`UPDATE proposals SET request_template_id_on_accept = ${tplId} WHERE id = ${pid}`,
    );

    await invoke(
      r.proposal,
      'post',
      '/:id/send',
      staffReq(seed.firmId, seed.appUserId, {}, { id: pid }),
    );
    const mint = await invoke(
      r.staffLinks,
      'post',
      '/:id/mint-magic-link',
      staffReq(seed.firmId, seed.appUserId, {}, { id: pid }),
    );
    const token = (mint.jsonBody as { token: string }).token;
    const redeem = await invoke(portal.redeem, 'post', '/redeem', portalReq({ token }));
    const magicLinkId = (redeem.jsonBody as { magicLinkId: string }).magicLinkId;
    const accept = await invoke(
      portal.accept,
      'post',
      '/:id/accept',
      portalReq(
        { magicLinkId, signerName: 'Solo', signerEmail: 'solo@co.example', typedName: 'Solo' },
        { id: pid },
      ),
    );
    expect(accept.statusCode).toBe(200);
    const engagementId = (accept.jsonBody as { engagementId: string | null }).engagementId;
    expect(engagementId).toBeTruthy();

    const reqs = await harness.db.execute(
      sql`SELECT id, title FROM client_request WHERE engagement_id = ${engagementId}`,
    );
    const reqRows = (reqs as unknown as { rows: { id: string; title: string }[] }).rows;
    expect(reqRows).toHaveLength(1);
    expect(reqRows[0]!.title).toBe('Document checklist');
    const items = await harness.db.execute(
      sql`SELECT label FROM client_request_item WHERE client_request_id = ${reqRows[0]!.id}`,
    );
    expect((items as unknown as { rows: unknown[] }).rows).toHaveLength(1);
  });
});
