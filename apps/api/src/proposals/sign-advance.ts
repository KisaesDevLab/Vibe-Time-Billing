// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Q34 + Q35 — shared signature-advance gating.
//
// This is the load-bearing core that BOTH the synchronous native
// `/accept` path (acceptance.ts) and the asynchronous OpenSign
// completion (webhook + worker poll) call once a signer's roster row
// has been flipped to SIGNED. It owns the multi-signer decision:
//
//   • Count required signers still PENDING.
//   • PARTIAL (some still pending) → proposal IN_PROGRESS (no freeze,
//     no acceptedAt). For SEQUENTIAL, mint + best-effort-email the next
//     signer's portal magic link.
//   • FINAL (all required signers signed) → capture ACH mandate (if
//     supplied), mark the selected package, flip to ACCEPTED, snapshot
//     a proposal_versions row listing every signatureId, and freeze the
//     engagement scope.
//
// The caller MUST already hold a `SELECT … FOR UPDATE` lock on the
// proposal row so native and OpenSign completions serialize on the
// required-remaining computation (no double-freeze under concurrency).
//
// The native path keeps behaving EXACTLY as before — this module is a
// straight extraction of the gating block that lived inline in
// acceptance.ts, parameterized for the OpenSign completion's needs.

import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { magicLinks, proposalVersions, proposals, signatures } from '@vibe/db/schema';
import { contentHash } from '@vibe/core/proposals/server';

import { logger } from '../logger';
import { freezeProposalIntoEngagement } from './scope-freeze';

// Structural mail callback (kept local to avoid importing magic-links.ts,
// whose router uses the Express `req.staffSession` augmentation that the
// worker tsconfig doesn't include — the worker reuses this module via the
// OpenSign poll). Matches magic-links.ts's SendProposalEmail shape.
export type SendProposalEmail = (args: {
  to: string;
  subject: string;
  body: string;
  html?: string;
}) => Promise<void>;

// Drizzle's transaction callback hands back a narrower type than the
// top-level Database; the runtime surface (select/insert/update/for) is
// identical, so we accept either.
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export type ProposalRow = typeof proposals.$inferSelect;

export interface MandateInputs {
  stripeCustomerId?: string | null;
  stripePaymentMethodId?: string | null;
  stripeMandateId?: string | null;
  mandateTextRendered?: string | null;
}

export interface AdvanceArgs {
  tx: Tx;
  // The proposal row — caller must have selected it FOR UPDATE.
  proposal: ProposalRow;
  // The signatures row that was just flipped to SIGNED.
  signatureId: string;
  now: Date;
  // Final-acceptance side effects.
  mandate?: MandateInputs;
  selectedPackageId?: string | null;
  // SEQUENTIAL next-signer best-effort mail (optional — failures never
  // block the signing flow).
  sendProposalEmail?: SendProposalEmail;
  portalBaseUrl?: string;
}

export type AdvanceResult =
  | { kind: 'partial'; signatureId: string; remaining: number; status: 'IN_PROGRESS' }
  | {
      kind: 'final';
      signatureId: string;
      signatureIds: string[];
      engagementId: string | null;
      mandateId: string | null;
      version: number;
      contentHash: string;
    };

function generateRawToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

/**
 * Advance proposal state after one signer row has been marked SIGNED.
 * Idempotent under the proposal FOR UPDATE lock: a second call for an
 * already-ACCEPTED proposal still computes requiredRemaining===0 and
 * the downstream freeze/version steps are themselves guarded
 * (freezeProposalIntoEngagement no-ops when an engagement already
 * exists; the ACCEPTED proposal_versions row uses a unique (proposal,
 * version) index so a concurrent duplicate raises rather than
 * double-freezing).
 */
export async function advanceSignatureToSigned(args: AdvanceArgs): Promise<AdvanceResult> {
  const { tx, proposal, signatureId, now } = args;

  // How many required signers are still pending?
  const remainingRows = await tx
    .select({ id: signatures.id })
    .from(signatures)
    .where(
      and(
        eq(signatures.proposalId, proposal.id),
        eq(signatures.required, true),
        eq(signatures.state, 'PENDING'),
      ),
    );
  const requiredRemaining = remainingRows.length;

  if (requiredRemaining > 0) {
    // Partial: keep the proposal open. Only advance SENT/VIEWED →
    // IN_PROGRESS (don't regress an already-IN_PROGRESS one).
    if (proposal.status === 'SENT' || proposal.status === 'VIEWED') {
      await tx
        .update(proposals)
        .set({ status: 'IN_PROGRESS', updatedAt: now })
        .where(eq(proposals.id, proposal.id));
    }

    // SEQUENTIAL: mint + email the next signer's link.
    if (proposal.signingOrderMode === 'SEQUENTIAL') {
      const roster = await tx
        .select()
        .from(signatures)
        .where(eq(signatures.proposalId, proposal.id))
        .orderBy(asc(signatures.sequence));
      const next = roster.find((s) => s.required && s.state === 'PENDING');
      if (next) {
        const { raw, hash } = generateRawToken();
        const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        await tx.insert(magicLinks).values({
          firmId: proposal.firmId,
          tokenHash: hash,
          purpose: 'PROPOSAL',
          clientId: proposal.clientId,
          proposalId: proposal.id,
          signatureId: next.id,
          expiresAt,
        });
        if (args.sendProposalEmail && args.portalBaseUrl) {
          const url = `${args.portalBaseUrl}/p/${raw}`;
          await args
            .sendProposalEmail({
              to: next.signerEmail,
              subject: `Please review and sign: ${proposal.title}`,
              body: `It's your turn to sign the proposal "${proposal.title}". Open this link:\n\n${url}`,
              html: `<p>It's your turn to sign <strong>${proposal.title}</strong>.</p><p><a href="${url}">Review and sign</a></p>`,
            })
            .catch((err: unknown) =>
              logger.warn({ err, to: next.signerEmail }, 'next-signer email failed'),
            );
        }
      }
    }

    return {
      kind: 'partial' as const,
      signatureId,
      remaining: requiredRemaining,
      status: 'IN_PROGRESS',
    };
  }

  // === Final acceptance: every required signer has signed. ===

  // Capture ACH mandate if present.
  let mandateId: string | null = null;
  const m = args.mandate;
  if (
    m &&
    m.mandateTextRendered &&
    m.stripeMandateId &&
    m.stripeCustomerId &&
    m.stripePaymentMethodId
  ) {
    const { captureAchMandate } = await import('../stripe-connect/setup-intent');
    mandateId = await captureAchMandate({
      db: tx as unknown as Database,
      firmId: proposal.firmId,
      clientId: proposal.clientId,
      proposalId: proposal.id,
      stripeAccountId: '',
      stripeCustomerId: m.stripeCustomerId,
      stripePaymentMethodId: m.stripePaymentMethodId,
      stripeMandateId: m.stripeMandateId,
      mandateTextRendered: m.mandateTextRendered,
    });
  }

  // Mark selected package (if any).
  if (args.selectedPackageId) {
    const { proposalPackages } = await import('@vibe/db/schema');
    await tx
      .update(proposalPackages)
      .set({ selected: true, selectedAt: now })
      .where(
        and(
          eq(proposalPackages.proposalId, proposal.id),
          eq(proposalPackages.packageId, args.selectedPackageId),
        ),
      );
  }

  await tx
    .update(proposals)
    .set({ status: 'ACCEPTED', acceptedAt: now, updatedAt: now })
    .where(eq(proposals.id, proposal.id));

  // All signed signature ids feed the ACCEPTED snapshot.
  const signedRows = await tx
    .select({ id: signatures.id })
    .from(signatures)
    .where(and(eq(signatures.proposalId, proposal.id), eq(signatures.state, 'SIGNED')))
    .orderBy(asc(signatures.sequence));
  const signatureIds = signedRows.map((r) => r.id);

  const priorVersions = await tx
    .select({ version: proposalVersions.version })
    .from(proposalVersions)
    .where(eq(proposalVersions.proposalId, proposal.id))
    .orderBy(asc(proposalVersions.version));
  const nextVersion =
    priorVersions.length === 0 ? 1 : Math.max(...priorVersions.map((v) => v.version)) + 1;
  const acceptanceSnapshot = {
    title: proposal.title,
    brochureJsonb: proposal.brochureJsonb as Record<string, unknown>,
    totalOneTimeCents: Number(proposal.totalOneTimeCents),
    totalRecurringCents: Number(proposal.totalRecurringCents),
    recurringInterval: proposal.recurringInterval,
    signatureIds,
    mandateId,
    acceptedAt: now.toISOString(),
  };
  const acceptanceHash = contentHash(acceptanceSnapshot);
  await tx.insert(proposalVersions).values({
    proposalId: proposal.id,
    version: nextVersion,
    contentJsonb: acceptanceSnapshot as unknown as Record<string, unknown>,
    contentHash: acceptanceHash,
    reason: 'ACCEPTED',
  });

  const freezeResult = await freezeProposalIntoEngagement({
    db: tx as unknown as Database,
    proposalId: proposal.id,
  });

  return {
    kind: 'final' as const,
    signatureId,
    signatureIds,
    engagementId: freezeResult.engagementId,
    mandateId,
    version: nextVersion,
    contentHash: acceptanceHash,
  };
}
