// SPDX-License-Identifier: Elastic-2.0
//
// P22 — Engagement scope freezing.
//
// On proposal acceptance we materialize the proposal's snapshot
// content into a new engagement + engagement_scope rows. The scope
// is frozen — once written it never changes; renewals create a new
// engagement.
//
// Two pure helpers (no HTTP), both transactional via the caller:
//   • createEngagementFromProposal — INSERT engagement linked to
//     the accepted proposal (sets from_proposal_id).
//   • materializeEngagementScope — copy proposal_line_items +
//     selected proposal_packages' package_services into
//     engagement_scope rows, all pinned to the version that was
//     accepted via frozen_from_version_id.
//
// P21 acceptance handler calls both inside a single db.transaction()
// so a partial materialization can never produce a half-frozen
// engagement.

import { and, asc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  engagementScope,
  engagements,
  packageServices,
  proposalLineItems,
  proposalPackages,
  proposalVersions,
  proposals,
  servicesCatalog,
} from '@vibe/db/schema';

export interface FreezeInput {
  db: Database;
  proposalId: string;
  // The acceptance handler decides which fee structure best matches
  // the proposal totals. We accept it as input rather than guessing
  // because the firm may want to override (e.g. a hybrid proposal
  // can map to MIXED_MODE in the existing engagement model).
  feeStructure?:
    | 'HOURLY'
    | 'HOURLY_NTE'
    | 'FIXED_FEE'
    | 'FIXED_FEE_WITH_MILESTONES'
    | 'RECURRING_SUBSCRIPTION';
  // Optional partner override. Defaults to client.partner_in_charge_id
  // which the caller resolves.
  partnerId?: string | null;
  // The user who accepted (logs into engagement.created_at provenance).
  acceptedByPortalUserId?: string | null;
}

export interface FreezeOutput {
  engagementId: string;
  versionId: string;
  scopeRows: number;
}

/**
 * Materialize an accepted proposal into a fresh engagement with a
 * frozen scope copy. Idempotent against re-runs: if from_proposal_id
 * already points at an engagement, returns the existing engagement
 * without re-materializing.
 */
export async function freezeProposalIntoEngagement(input: FreezeInput): Promise<FreezeOutput> {
  const { db, proposalId } = input;

  // Idempotency guard: already-frozen engagement returns directly.
  const [already] = await db
    .select({ id: engagements.id })
    .from(engagements)
    .where(eq(engagements.fromProposalId, proposalId))
    .limit(1);
  if (already) {
    const existing = await db
      .select({ id: engagementScope.id })
      .from(engagementScope)
      .where(eq(engagementScope.engagementId, already.id));
    return {
      engagementId: already.id,
      versionId: '',
      scopeRows: existing.length,
    };
  }

  const [proposal] = await db.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
  if (!proposal) throw new Error('proposal_not_found');
  if (proposal.status !== 'ACCEPTED' && proposal.status !== 'SENT') {
    throw new Error(`proposal_not_acceptable_state:${proposal.status}`);
  }

  // Pick the latest ACCEPTED snapshot, falling back to the latest SENT
  // (the second is the case where the test or caller is freezing right
  // after /send before a real acceptance ever fires).
  const candidates = await db
    .select()
    .from(proposalVersions)
    .where(eq(proposalVersions.proposalId, proposal.id));
  const acceptedVersion =
    candidates.filter((v) => v.reason === 'ACCEPTED').sort((a, b) => b.version - a.version)[0] ??
    candidates.filter((v) => v.reason === 'SENT').sort((a, b) => b.version - a.version)[0];
  if (!acceptedVersion) throw new Error('proposal_has_no_version');

  // 1. Create the engagement row. Fee structure defaults to
  // RECURRING_SUBSCRIPTION if the proposal has any recurring amount,
  // FIXED_FEE if only one-time, HOURLY as fallback for proposals
  // with neither (e.g. an estimate-only proposal).
  const inferredFee: FreezeInput['feeStructure'] =
    Number(proposal.totalRecurringCents) > 0
      ? 'RECURRING_SUBSCRIPTION'
      : Number(proposal.totalOneTimeCents) > 0
        ? 'FIXED_FEE'
        : 'HOURLY';
  const fee = input.feeStructure ?? inferredFee;

  const totalForEngagement =
    Number(proposal.totalOneTimeCents) + Number(proposal.totalRecurringCents);

  const [engagementRow] = await db
    .insert(engagements)
    .values({
      clientId: proposal.clientId,
      name: proposal.title,
      feeStructure: fee,
      feeAmountCents: totalForEngagement,
      partnerId: input.partnerId ?? null,
      status: 'ACTIVE',
      fromProposalId: proposal.id,
      startDate: new Date().toISOString().slice(0, 10),
    })
    .returning({ id: engagements.id });
  if (!engagementRow) throw new Error('engagement_insert_failed');

  // 2. Materialize line items.
  const lines = await db
    .select()
    .from(proposalLineItems)
    .where(eq(proposalLineItems.proposalId, proposal.id))
    .orderBy(asc(proposalLineItems.sequence));

  // 3. Materialize the selected package's services. The acceptance flow
  // records the client's choice authoritatively on proposals.selected_package_id
  // and mirrors it onto proposal_packages.selected; we read the column first and
  // fall back to the offer flag for resilience (or zero if the proposal doesn't
  // offer packages).
  let selectedPackageId = proposal.selectedPackageId ?? null;
  if (!selectedPackageId) {
    const [flagged] = await db
      .select({ packageId: proposalPackages.packageId })
      .from(proposalPackages)
      .where(and(eq(proposalPackages.proposalId, proposal.id), eq(proposalPackages.selected, true)))
      .limit(1);
    selectedPackageId = flagged?.packageId ?? null;
  }
  const packageEntries = selectedPackageId
    ? await db
        .select({
          serviceId: packageServices.serviceId,
          overridePriceCents: packageServices.overridePriceCents,
          included: packageServices.included,
          sequence: packageServices.sequence,
          serviceName: servicesCatalog.name,
          serviceDefaultPriceCents: servicesCatalog.defaultPriceCents,
          serviceBillingType: servicesCatalog.billingType,
          serviceRecurringInterval: servicesCatalog.recurringInterval,
        })
        .from(packageServices)
        .innerJoin(servicesCatalog, eq(servicesCatalog.id, packageServices.serviceId))
        .where(
          and(eq(packageServices.packageId, selectedPackageId), eq(packageServices.included, true)),
        )
        .orderBy(asc(packageServices.sequence))
    : [];

  // Build the engagement_scope rows. Line items come first
  // (preserving their sequence), then package services appended.
  const rowsToInsert: Array<typeof engagementScope.$inferInsert> = [];
  let seq = 0;
  for (const line of lines) {
    rowsToInsert.push({
      engagementId: engagementRow.id,
      serviceId: line.serviceId,
      proposalLineItemId: line.id,
      frozenFromVersionId: acceptedVersion.id,
      name: line.name,
      description: line.description,
      qty: line.qty,
      unitPriceCents: Number(line.unitPriceCents),
      billingType: line.billingType,
      recurringInterval: line.recurringInterval,
      sequence: seq++,
    });
  }
  for (const e of packageEntries) {
    rowsToInsert.push({
      engagementId: engagementRow.id,
      serviceId: e.serviceId,
      frozenFromVersionId: acceptedVersion.id,
      name: e.serviceName,
      description: '',
      qty: '1',
      unitPriceCents: Number(e.overridePriceCents ?? e.serviceDefaultPriceCents),
      billingType: e.serviceBillingType,
      recurringInterval: e.serviceRecurringInterval,
      sequence: seq++,
    });
  }
  if (rowsToInsert.length > 0) {
    await db.insert(engagementScope).values(rowsToInsert);
  }

  return {
    engagementId: engagementRow.id,
    versionId: acceptedVersion.id,
    scopeRows: rowsToInsert.length,
  };
}
