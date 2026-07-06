// SPDX-License-Identifier: Elastic-2.0
//
// P21 — Portal acceptance flow end-to-end test.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import {
  engagementScope,
  engagements,
  magicLinks,
  proposalVersions,
  proposals,
  signatures,
} from '@vibe/db/schema';
import { createAcceptanceRouter } from '../proposals/acceptance';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

async function seedSentProposal(): Promise<{
  firmId: string;
  clientId: string;
  proposalId: string;
  magicLinkId: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const [p] = await harness.db
    .insert(proposals)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      title: 'Annual Tax 2026',
      brochureJsonb: { schemaVersion: 1, blocks: [] } as unknown as Record<string, unknown>,
      status: 'SENT',
      sentAt: new Date(),
      totalOneTimeCents: 50000,
      totalRecurringCents: 100000,
      recurringInterval: 'MONTHLY',
      createdById: seed.appUserId,
    })
    .returning({ id: proposals.id });
  await harness.db.insert(proposalVersions).values({
    proposalId: p!.id,
    version: 1,
    contentJsonb: { dummy: true } as unknown as Record<string, unknown>,
    contentHash: 'a'.repeat(64),
    reason: 'SENT',
  });
  // A valid signer magic link is now the credential for /accept. Legacy
  // single-signer proposals carry a link with signatureId=null, which the
  // route accepts and mints a PRIMARY signature for.
  const [ml] = await harness.db
    .insert(magicLinks)
    .values({
      firmId: seed.firmId,
      tokenHash: `test-hash-${p!.id}`,
      purpose: 'PROPOSAL',
      proposalId: p!.id,
      clientId: seed.clientId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: magicLinks.id });
  return { firmId: seed.firmId, clientId: seed.clientId, proposalId: p!.id, magicLinkId: ml!.id };
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/portal/proposals',
    createAcceptanceRouter({
      db: harness.db,
      hmacSeed: 'unit-test-seed-32-bytes-long-aaaaaaa',
    }),
  );
  return app;
}

describe('P21 — acceptance happy path', () => {
  it('signs + freezes scope + advances proposal status', async () => {
    const f = await seedSentProposal();
    const app = buildApp();
    const res = await request(app).post(`/api/portal/proposals/${f.proposalId}/accept`).send({
      magicLinkId: f.magicLinkId,
      signerName: 'Jane Doe',
      signerEmail: 'jane@example.com',
      typedName: 'Jane Doe',
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      ok: boolean;
      signatureId: string;
      engagementId: string;
      mandateId: string | null;
      version: number;
      contentHash: string;
    };
    expect(body.ok).toBe(true);
    expect(body.signatureId).toBeTruthy();
    expect(body.engagementId).toBeTruthy();
    expect(body.version).toBe(2); // v1 was SENT, v2 is ACCEPTED
    expect(body.contentHash).toMatch(/^[a-f0-9]{64}$/);

    // proposals row advanced to ACCEPTED
    const [p] = await harness.db.select().from(proposals).where(eq(proposals.id, f.proposalId));
    expect(p!.status).toBe('ACCEPTED');
    expect(p!.acceptedAt).not.toBeNull();

    // signatures row written + HMAC stamped
    const [sig] = await harness.db
      .select()
      .from(signatures)
      .where(eq(signatures.id, body.signatureId));
    expect(sig!.state).toBe('SIGNED');
    expect(sig!.method).toBe('TYPED_NAME');
    expect(sig!.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(sig!.hmacSignature).toMatch(/^[a-f0-9]{64}$/);

    // engagement created with from_proposal_id linkage
    const [eng] = await harness.db
      .select()
      .from(engagements)
      .where(eq(engagements.id, body.engagementId));
    expect(eng!.fromProposalId).toBe(f.proposalId);
    expect(eng!.status).toBe('ACTIVE');

    // ACCEPTED version snapshot written
    const versions = await harness.db
      .select()
      .from(proposalVersions)
      .where(eq(proposalVersions.proposalId, f.proposalId));
    const accepted = versions.find((v) => v.reason === 'ACCEPTED');
    expect(accepted).toBeTruthy();
    expect(accepted!.version).toBe(2);
    expect(accepted!.contentHash).toBe(body.contentHash);
  });

  it('captures ACH mandate when Stripe fields supplied', async () => {
    const f = await seedSentProposal();
    const app = buildApp();
    const res = await request(app).post(`/api/portal/proposals/${f.proposalId}/accept`).send({
      magicLinkId: f.magicLinkId,
      signerName: 'Jane',
      signerEmail: 'jane@x.com',
      typedName: 'Jane',
      stripeCustomerId: 'cus_x',
      stripePaymentMethodId: 'pm_x',
      stripeMandateId: 'mandate_x',
      mandateTextRendered: 'I authorize ACME CPAs to debit my account…',
    });
    expect(res.status).toBe(200);
    expect((res.body as { mandateId: string | null }).mandateId).toBeTruthy();
  });
});

describe('P21 — guards', () => {
  it('rejects acceptance on non-SENT proposal (409)', async () => {
    const f = await seedSentProposal();
    await harness.db
      .update(proposals)
      .set({ status: 'DRAFT', sentAt: null })
      .where(eq(proposals.id, f.proposalId));
    const app = buildApp();
    const res = await request(app).post(`/api/portal/proposals/${f.proposalId}/accept`).send({
      signerName: 'Jane',
      signerEmail: 'jane@x.com',
      typedName: 'Jane',
    });
    expect(res.status).toBe(409);
  });

  it('404 on unknown proposal', async () => {
    const app = buildApp();
    const res = await request(app)
      .post(`/api/portal/proposals/11111111-1111-1111-1111-111111111111/accept`)
      .send({
        signerName: 'J',
        signerEmail: 'j@x.com',
        typedName: 'J',
      });
    expect(res.status).toBe(404);
  });

  it('401 without a magic-link credential (accept requires one)', async () => {
    // Regression guard for the acceptance auth-bypass: a request that knows
    // the proposal id but presents no valid signer credential must be
    // rejected and must not mint a signature or engagement.
    const f = await seedSentProposal();
    const app = buildApp();
    const res = await request(app).post(`/api/portal/proposals/${f.proposalId}/accept`).send({
      signerName: 'Mallory',
      signerEmail: 'mallory@evil.example',
      typedName: 'Mallory',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('credential_required');
  });

  it('401 with a superseded magic link', async () => {
    const f = await seedSentProposal();
    await harness.db
      .update(magicLinks)
      .set({ supersededAt: new Date() })
      .where(eq(magicLinks.id, f.magicLinkId));
    const app = buildApp();
    const res = await request(app).post(`/api/portal/proposals/${f.proposalId}/accept`).send({
      magicLinkId: f.magicLinkId,
      signerName: 'Jane',
      signerEmail: 'jane@x.com',
      typedName: 'Jane',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credential');
  });

  it('400 on invalid payload (missing typedName)', async () => {
    const f = await seedSentProposal();
    const app = buildApp();
    const res = await request(app)
      .post(`/api/portal/proposals/${f.proposalId}/accept`)
      .send({ signerName: 'J', signerEmail: 'j@x.com' });
    expect(res.status).toBe(400);
  });

  it('400 on malicious drawn SVG', async () => {
    const f = await seedSentProposal();
    const app = buildApp();
    const res = await request(app).post(`/api/portal/proposals/${f.proposalId}/accept`).send({
      signerName: 'J',
      signerEmail: 'j@x.com',
      typedName: 'J',
      drawnSvg: '<svg><script>alert(1)</script></svg>',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_signature_svg');
  });
});

describe('P21 — engagement_scope materialization', () => {
  it('engagement_scope has the frozen line items', async () => {
    const f = await seedSentProposal();
    const { proposalLineItems } = await import('@vibe/db/schema');
    await harness.db.insert(proposalLineItems).values({
      proposalId: f.proposalId,
      name: 'Federal 1040',
      qty: '1',
      unitPriceCents: 60000,
      billingType: 'ONE_TIME',
      sequence: 0,
    });
    const app = buildApp();
    const res = await request(app).post(`/api/portal/proposals/${f.proposalId}/accept`).send({
      magicLinkId: f.magicLinkId,
      signerName: 'J',
      signerEmail: 'j@x.com',
      typedName: 'J',
    });
    expect(res.status).toBe(200);
    const engagementId = (res.body as { engagementId: string }).engagementId;
    const rows = await harness.db
      .select()
      .from(engagementScope)
      .where(eq(engagementScope.engagementId, engagementId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.name).toBe('Federal 1040');
    expect(Number(rows[0]!.unitPriceCents)).toBe(60000);
  });
});
