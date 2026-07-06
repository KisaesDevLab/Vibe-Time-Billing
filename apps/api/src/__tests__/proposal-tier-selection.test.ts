// SPDX-License-Identifier: Elastic-2.0
//
// Proposal tier-selection end-to-end: send snapshots the offered package
// tiers into proposal_packages, the client's selection is captured on accept
// (proposals.selected_package_id + the offer flag + a TIER_SELECTED activity),
// scope-freeze materializes only the SELECTED tier's services, and the staff
// detail endpoint surfaces which tier was chosen.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import {
  engagementScope,
  magicLinks,
  packageServices,
  packages,
  proposalActivity,
  proposalPackages,
  proposals,
  servicesCatalog,
} from '@vibe/db/schema';
import { createProposalRouter } from '../proposals/routes';
import { createAcceptanceRouter } from '../proposals/acceptance';
import { hydrateBrochureForPortal } from '../proposals/portal-hydrate';

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
  router: ReturnType<typeof createProposalRouter>,
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  req: {
    body?: unknown;
    params?: Record<string, string>;
    query?: Record<string, string>;
    firmId: string;
    appUserId: string;
  },
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
  const fakeReq = {
    body: req.body ?? {},
    params: req.params ?? {},
    query: req.query ?? {},
    staffSession: { firmId: req.firmId, appUserId: req.appUserId },
    ip: '127.0.0.1',
    get: () => undefined,
  };
  await (handler as (req: unknown, res: unknown) => Promise<void>)(fakeReq, res);
  return res;
}

interface Seeded {
  firmId: string;
  clientId: string;
  appUserId: string;
  router: ReturnType<typeof createProposalRouter>;
  bronzeId: string;
  goldId: string;
  bronzeSvcId: string;
  goldSvcId: string;
}

/**
 * Seed a firm with one package ("Tax Plan") offering two tiers, each including
 * a distinct service so we can prove the freeze picks the SELECTED tier only.
 */
async function seedFirmWithTiers(): Promise<Seeded> {
  const seed = await seedMinimalFirm(harness.db);
  const router = createProposalRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
  });

  const [bronzeSvc] = await harness.db
    .insert(servicesCatalog)
    .values({
      firmId: seed.firmId,
      name: 'Basic Return',
      category: 'TAX',
      defaultPriceCents: 30000,
    })
    .returning({ id: servicesCatalog.id });
  const [goldSvc] = await harness.db
    .insert(servicesCatalog)
    .values({ firmId: seed.firmId, name: 'Advisory', category: 'TAX', defaultPriceCents: 90000 })
    .returning({ id: servicesCatalog.id });

  const [bronze] = await harness.db
    .insert(packages)
    .values({
      firmId: seed.firmId,
      name: 'Tax Plan',
      tierLabel: 'Bronze',
      position: 0,
      priceOverrideCents: 30000,
    })
    .returning({ id: packages.id });
  const [gold] = await harness.db
    .insert(packages)
    .values({
      firmId: seed.firmId,
      name: 'Tax Plan',
      tierLabel: 'Gold',
      position: 1,
      priceOverrideCents: 120000,
    })
    .returning({ id: packages.id });

  await harness.db.insert(packageServices).values([
    { packageId: bronze!.id, serviceId: bronzeSvc!.id, included: true, sequence: 0 },
    { packageId: gold!.id, serviceId: goldSvc!.id, included: true, sequence: 0 },
  ]);

  return {
    firmId: seed.firmId,
    clientId: seed.clientId,
    appUserId: seed.appUserId,
    router,
    bronzeId: bronze!.id,
    goldId: gold!.id,
    bronzeSvcId: bronzeSvc!.id,
    goldSvcId: goldSvc!.id,
  };
}

function brochureWithSelector(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    blocks: [
      { id: 'b1', type: 'package_selector', position: 0, props: { packageName: 'Tax Plan' } },
    ],
  };
}

async function createSentProposal(s: Seeded): Promise<string> {
  const created = await invoke(s.router, 'post', '/', {
    firmId: s.firmId,
    appUserId: s.appUserId,
    body: { clientId: s.clientId, title: 'Tax Plan Proposal' },
  });
  expect(created.statusCode).toBe(201);
  const proposalId = (created.jsonBody as { id: string }).id;

  const bro = await invoke(s.router, 'post', '/:id/brochure', {
    firmId: s.firmId,
    appUserId: s.appUserId,
    params: { id: proposalId },
    body: { brochureJsonb: brochureWithSelector() },
  });
  expect(bro.statusCode).toBe(200);

  const sent = await invoke(s.router, 'post', '/:id/send', {
    firmId: s.firmId,
    appUserId: s.appUserId,
    params: { id: proposalId },
    body: {},
  });
  expect(sent.statusCode).toBe(200);
  return proposalId;
}

// Mint a valid signer magic link — /accept now requires one (the security
// hardening on the acceptance route). Legacy single-signer proposals carry
// a link with signatureId = null, which the route accepts and mints a
// PRIMARY signature for.
async function mintProposalLink(s: Seeded, proposalId: string): Promise<string> {
  const [ml] = await harness.db
    .insert(magicLinks)
    .values({
      firmId: s.firmId,
      tokenHash: `test-hash-${proposalId}`,
      purpose: 'PROPOSAL',
      proposalId,
      clientId: s.clientId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: magicLinks.id });
  return ml!.id;
}

describe('proposal tier selection — send snapshot', () => {
  it('send populates proposal_packages with one row per offered tier', async () => {
    const s = await seedFirmWithTiers();
    const proposalId = await createSentProposal(s);

    const offered = await harness.db
      .select()
      .from(proposalPackages)
      .where(eq(proposalPackages.proposalId, proposalId));
    expect(offered.length).toBe(2);
    expect(offered.map((o) => o.packageId).sort()).toEqual([s.bronzeId, s.goldId].sort());
    // Nothing selected before acceptance.
    expect(offered.every((o) => !o.selected)).toBe(true);
  });

  it('GET /:id returns offered tiers and a null selection pre-accept', async () => {
    const s = await seedFirmWithTiers();
    const proposalId = await createSentProposal(s);

    const detail = await invoke(s.router, 'get', '/:id', {
      firmId: s.firmId,
      appUserId: s.appUserId,
      params: { id: proposalId },
    });
    const body = detail.jsonBody as {
      offeredPackages: { packageId: string; tierLabel: string }[];
      selectedPackage: unknown;
    };
    expect(body.offeredPackages.length).toBe(2);
    expect(body.offeredPackages.map((o) => o.tierLabel)).toEqual(['Bronze', 'Gold']);
    expect(body.selectedPackage).toBeNull();
  });
});

describe('proposal tier selection — hydration', () => {
  it('hydrates package_selector tiers with their packageId for the portal', async () => {
    const s = await seedFirmWithTiers();
    const out = await hydrateBrochureForPortal(harness.db, {
      firmId: s.firmId,
      clientId: s.clientId,
      brochureJsonb: brochureWithSelector(),
    });
    const block = (out.blocks as { type: string; props: Record<string, unknown> }[])[0]!;
    const tiers = block.props['tiers'] as { packageId: string; tierLabel: string }[];
    expect(tiers.map((t) => t.tierLabel)).toEqual(['Bronze', 'Gold']);
    expect(tiers.map((t) => t.packageId).sort()).toEqual([s.bronzeId, s.goldId].sort());
  });
});

describe('proposal tier selection — accept captures and freezes the chosen tier', () => {
  function buildAcceptApp(): express.Express {
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

  it('accepting with selectedPackageId records it and freezes only that tier', async () => {
    const s = await seedFirmWithTiers();
    const proposalId = await createSentProposal(s);
    const app = buildAcceptApp();

    const magicLinkId = await mintProposalLink(s, proposalId);
    const res = await request(app).post(`/api/portal/proposals/${proposalId}/accept`).send({
      magicLinkId,
      signerName: 'Jane Client',
      signerEmail: 'jane@example.com',
      typedName: 'Jane Client',
      selectedPackageId: s.goldId,
    });
    expect(res.status).toBe(200);
    const engagementId = (res.body as { engagementId: string }).engagementId;
    expect(engagementId).toBeTruthy();

    // Authoritative selection on the proposal row.
    const [p] = await harness.db.select().from(proposals).where(eq(proposals.id, proposalId));
    expect(p!.selectedPackageId).toBe(s.goldId);
    expect(p!.status).toBe('ACCEPTED');

    // Offer flag mirrored onto the chosen tier only.
    const offered = await harness.db
      .select()
      .from(proposalPackages)
      .where(eq(proposalPackages.proposalId, proposalId));
    const gold = offered.find((o) => o.packageId === s.goldId)!;
    const bronze = offered.find((o) => o.packageId === s.bronzeId)!;
    expect(gold.selected).toBe(true);
    expect(gold.selectedAt).not.toBeNull();
    expect(bronze.selected).toBe(false);

    // TIER_SELECTED activity logged.
    const activity = await harness.db
      .select()
      .from(proposalActivity)
      .where(
        and(
          eq(proposalActivity.proposalId, proposalId),
          eq(proposalActivity.kind, 'TIER_SELECTED'),
        ),
      );
    expect(activity.length).toBe(1);
    expect((activity[0]!.payload as { packageId: string }).packageId).toBe(s.goldId);

    // Scope frozen from the GOLD tier's service only (Advisory), not Bronze's.
    const scope = await harness.db
      .select()
      .from(engagementScope)
      .where(eq(engagementScope.engagementId, engagementId));
    const names = scope.map((r) => r.name);
    expect(names).toContain('Advisory');
    expect(names).not.toContain('Basic Return');
  });

  it('staff detail surfaces the selected tier after acceptance', async () => {
    const s = await seedFirmWithTiers();
    const proposalId = await createSentProposal(s);
    const app = buildAcceptApp();
    const magicLinkId = await mintProposalLink(s, proposalId);
    await request(app)
      .post(`/api/portal/proposals/${proposalId}/accept`)
      .send({
        magicLinkId,
        signerName: 'Jane Client',
        signerEmail: 'jane@example.com',
        typedName: 'Jane Client',
        selectedPackageId: s.bronzeId,
      })
      .expect(200);

    const detail = await invoke(s.router, 'get', '/:id', {
      firmId: s.firmId,
      appUserId: s.appUserId,
      params: { id: proposalId },
    });
    const body = detail.jsonBody as {
      selectedPackage: { packageId: string; tierLabel: string; name: string } | null;
    };
    expect(body.selectedPackage).not.toBeNull();
    expect(body.selectedPackage!.packageId).toBe(s.bronzeId);
    expect(body.selectedPackage!.tierLabel).toBe('Bronze');
    expect(body.selectedPackage!.name).toBe('Tax Plan');
  });

  it('rejects a foreign package id (different firm) without freezing it', async () => {
    const s = await seedFirmWithTiers();
    const proposalId = await createSentProposal(s);
    // A package belonging to a DIFFERENT firm.
    const other = await seedMinimalFirm(harness.db);
    const [foreign] = await harness.db
      .insert(packages)
      .values({ firmId: other.firmId, name: 'Other', tierLabel: 'X' })
      .returning({ id: packages.id });

    const app = buildAcceptApp();
    const magicLinkId = await mintProposalLink(s, proposalId);
    await request(app)
      .post(`/api/portal/proposals/${proposalId}/accept`)
      .send({
        magicLinkId,
        signerName: 'Jane Client',
        signerEmail: 'jane@example.com',
        typedName: 'Jane Client',
        selectedPackageId: foreign!.id,
      })
      .expect(200);

    const [p] = await harness.db.select().from(proposals).where(eq(proposals.id, proposalId));
    // Foreign id is ignored — not persisted as the selection.
    expect(p!.selectedPackageId).toBeNull();
  });
});
