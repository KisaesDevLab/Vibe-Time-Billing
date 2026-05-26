// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P22 — Scope freezing helper tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import {
  engagementScope,
  engagements,
  packageServices,
  packages,
  proposalLineItems,
  proposalPackages,
  proposalVersions,
  proposals,
  servicesCatalog,
} from '@vibe/db/schema';

import { freezeProposalIntoEngagement } from '../proposals/scope-freeze';

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
  appUserId: string;
  proposalId: string;
  versionId: string;
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
  const [v] = await harness.db
    .insert(proposalVersions)
    .values({
      proposalId: p!.id,
      version: 1,
      contentJsonb: { dummy: 'snapshot' } as unknown as Record<string, unknown>,
      contentHash: 'a'.repeat(64),
      reason: 'SENT',
      createdById: seed.appUserId,
    })
    .returning({ id: proposalVersions.id });
  return {
    firmId: seed.firmId,
    clientId: seed.clientId,
    appUserId: seed.appUserId,
    proposalId: p!.id,
    versionId: v!.id,
  };
}

describe('P22 — freeze line items', () => {
  it('copies proposal_line_items into engagement_scope', async () => {
    const f = await seedSentProposal();
    await harness.db.insert(proposalLineItems).values([
      {
        proposalId: f.proposalId,
        name: 'Federal 1040',
        description: 'tax prep',
        qty: '1',
        unitPriceCents: 80000,
        billingType: 'ONE_TIME',
        recurringInterval: null,
        sequence: 0,
      },
      {
        proposalId: f.proposalId,
        name: 'State return',
        qty: '1',
        unitPriceCents: 20000,
        billingType: 'ONE_TIME',
        recurringInterval: null,
        sequence: 1,
      },
    ]);
    const out = await freezeProposalIntoEngagement({
      db: harness.db,
      proposalId: f.proposalId,
    });
    expect(out.scopeRows).toBe(2);
    const rows = await harness.db
      .select()
      .from(engagementScope)
      .where(eq(engagementScope.engagementId, out.engagementId));
    expect(rows.length).toBe(2);
    expect(rows[0]!.name).toBe('Federal 1040');
    expect(rows[0]!.frozenFromVersionId).toBe(f.versionId);
    expect(Number(rows[0]!.unitPriceCents)).toBe(80000);
  });

  it('also materializes selected package services', async () => {
    const f = await seedSentProposal();
    // Build a package with two included services.
    const [svc1] = await harness.db
      .insert(servicesCatalog)
      .values({
        firmId: f.firmId,
        name: 'Monthly Bookkeeping',
        category: 'BOOKKEEPING',
        defaultPriceCents: 50000,
        billingType: 'RECURRING',
        recurringInterval: 'MONTHLY',
      })
      .returning({ id: servicesCatalog.id });
    const [svc2] = await harness.db
      .insert(servicesCatalog)
      .values({
        firmId: f.firmId,
        name: 'Quarterly review',
        category: 'BOOKKEEPING',
        defaultPriceCents: 20000,
        billingType: 'RECURRING',
        recurringInterval: 'QUARTERLY',
      })
      .returning({ id: servicesCatalog.id });
    const [pkg] = await harness.db
      .insert(packages)
      .values({ firmId: f.firmId, name: 'SMB Bronze', tierLabel: 'Bronze' })
      .returning({ id: packages.id });
    await harness.db.insert(packageServices).values([
      { packageId: pkg!.id, serviceId: svc1!.id, included: true, sequence: 0 },
      {
        packageId: pkg!.id,
        serviceId: svc2!.id,
        overridePriceCents: 25000,
        included: true,
        sequence: 1,
      },
    ]);
    await harness.db.insert(proposalPackages).values({
      proposalId: f.proposalId,
      packageId: pkg!.id,
      selected: true,
      selectedAt: new Date(),
    });
    const out = await freezeProposalIntoEngagement({
      db: harness.db,
      proposalId: f.proposalId,
    });
    expect(out.scopeRows).toBe(2);
    const rows = await harness.db
      .select()
      .from(engagementScope)
      .where(eq(engagementScope.engagementId, out.engagementId));
    const names = rows.map((r) => r.name);
    expect(names).toContain('Monthly Bookkeeping');
    expect(names).toContain('Quarterly review');
    // Override price honored on the second service.
    const quarterly = rows.find((r) => r.name === 'Quarterly review')!;
    expect(Number(quarterly.unitPriceCents)).toBe(25000);
  });

  it('un-included package services are skipped', async () => {
    const f = await seedSentProposal();
    const [svc] = await harness.db
      .insert(servicesCatalog)
      .values({ firmId: f.firmId, name: 'Add-on', category: 'TAX', defaultPriceCents: 10000 })
      .returning({ id: servicesCatalog.id });
    const [pkg] = await harness.db
      .insert(packages)
      .values({ firmId: f.firmId, name: 'P' })
      .returning({ id: packages.id });
    await harness.db
      .insert(packageServices)
      .values({ packageId: pkg!.id, serviceId: svc!.id, included: false });
    await harness.db
      .insert(proposalPackages)
      .values({ proposalId: f.proposalId, packageId: pkg!.id, selected: true });
    const out = await freezeProposalIntoEngagement({
      db: harness.db,
      proposalId: f.proposalId,
    });
    expect(out.scopeRows).toBe(0);
  });
});

describe('P22 — engagement creation', () => {
  it('infers RECURRING_SUBSCRIPTION fee structure from recurring total', async () => {
    const f = await seedSentProposal();
    const out = await freezeProposalIntoEngagement({
      db: harness.db,
      proposalId: f.proposalId,
    });
    const [eng] = await harness.db
      .select()
      .from(engagements)
      .where(eq(engagements.id, out.engagementId));
    expect(eng!.feeStructure).toBe('RECURRING_SUBSCRIPTION');
    expect(eng!.fromProposalId).toBe(f.proposalId);
    expect(eng!.status).toBe('ACTIVE');
    expect(eng!.name).toBe('Annual Tax 2026');
  });

  it('infers FIXED_FEE when only one-time total', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const [p] = await harness.db
      .insert(proposals)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        title: 'One-time work',
        brochureJsonb: { schemaVersion: 1, blocks: [] } as unknown as Record<string, unknown>,
        status: 'SENT',
        totalOneTimeCents: 50000,
        totalRecurringCents: 0,
        createdById: seed.appUserId,
      })
      .returning({ id: proposals.id });
    await harness.db.insert(proposalVersions).values({
      proposalId: p!.id,
      version: 1,
      contentJsonb: { x: 1 } as unknown as Record<string, unknown>,
      contentHash: 'b'.repeat(64),
      reason: 'SENT',
    });
    const out = await freezeProposalIntoEngagement({
      db: harness.db,
      proposalId: p!.id,
    });
    const [eng] = await harness.db
      .select()
      .from(engagements)
      .where(eq(engagements.id, out.engagementId));
    expect(eng!.feeStructure).toBe('FIXED_FEE');
  });

  it('caller can override inferred fee structure', async () => {
    const f = await seedSentProposal();
    const out = await freezeProposalIntoEngagement({
      db: harness.db,
      proposalId: f.proposalId,
      feeStructure: 'HOURLY',
    });
    const [eng] = await harness.db
      .select()
      .from(engagements)
      .where(eq(engagements.id, out.engagementId));
    expect(eng!.feeStructure).toBe('HOURLY');
  });
});

describe('P22 — idempotency', () => {
  it('re-freezing returns existing engagement without duplicating', async () => {
    const f = await seedSentProposal();
    await harness.db.insert(proposalLineItems).values({
      proposalId: f.proposalId,
      name: 'X',
      qty: '1',
      unitPriceCents: 100,
      billingType: 'ONE_TIME',
      sequence: 0,
    });
    const first = await freezeProposalIntoEngagement({
      db: harness.db,
      proposalId: f.proposalId,
    });
    const second = await freezeProposalIntoEngagement({
      db: harness.db,
      proposalId: f.proposalId,
    });
    expect(second.engagementId).toBe(first.engagementId);
    const allEngagements = await harness.db
      .select()
      .from(engagements)
      .where(eq(engagements.fromProposalId, f.proposalId));
    expect(allEngagements.length).toBe(1);
  });
});

describe('P22 — guards', () => {
  it('rejects proposal not in SENT/ACCEPTED state', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const [p] = await harness.db
      .insert(proposals)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        title: 'Draft',
        brochureJsonb: { schemaVersion: 1, blocks: [] } as unknown as Record<string, unknown>,
        status: 'DRAFT',
        createdById: seed.appUserId,
      })
      .returning({ id: proposals.id });
    await expect(
      freezeProposalIntoEngagement({ db: harness.db, proposalId: p!.id }),
    ).rejects.toThrow(/proposal_not_acceptable_state/);
  });

  it('rejects proposal without any versions', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const [p] = await harness.db
      .insert(proposals)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        title: 'No version',
        brochureJsonb: { schemaVersion: 1, blocks: [] } as unknown as Record<string, unknown>,
        status: 'SENT',
        createdById: seed.appUserId,
      })
      .returning({ id: proposals.id });
    await expect(
      freezeProposalIntoEngagement({ db: harness.db, proposalId: p!.id }),
    ).rejects.toThrow(/has_no_version/);
  });
});
