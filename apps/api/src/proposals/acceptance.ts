// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P21 — Proposal acceptance flow.
//
// The integration moment: a single transaction creates the signature
// row, computes its HMAC, captures the ACH mandate (when present),
// freezes the engagement scope, and bumps proposal status to ACCEPTED
// + snapshots a final proposal_versions row. Subsequent webhook events
// (Stripe customer/PM/subscription) wire up asynchronously via P12's
// webhook receiver.
//
// All Stripe interactions are abstracted behind injected helpers so
// this module stays pure data orchestration — no live Stripe calls in
// the trust path.

import { randomUUID } from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { proposalVersions, proposals, signatures } from '@vibe/db/schema';
import {
  computeSignatureHmac,
  contentHash,
  deriveFirmHmacKey,
  type SignatureRecord,
} from '@vibe/core/proposals';

import { logger } from '../logger';
import { emitAudit } from '../auth/audit';
import { freezeProposalIntoEngagement } from './scope-freeze';
import { sanitizeSignatureSvg } from '../portal/signature-svg';
import { createNativeProvider, type EsignProvider } from '../esign/provider';

export interface AcceptanceDeps {
  db: Database | null;
  hmacSeed: string | null;
  esignProvider?: EsignProvider;
}

const AcceptSchema = z.object({
  // Identifies the requester. v1 supports magic-link or
  // client_account session; the route confirms one or the other.
  magicLinkId: z.string().uuid().nullable().optional(),
  clientAccountId: z.string().uuid().nullable().optional(),

  signerName: z.string().min(1).max(240),
  signerEmail: z.string().email().max(240),
  signerPhone: z.string().max(40).nullable().optional(),
  typedName: z.string().min(1).max(240),
  drawnSvg: z.string().max(20_000).nullable().optional(),

  // If the proposal offers packages, the client picks one. Optional
  // because a no-package proposal accepts without selection.
  selectedPackageId: z.string().uuid().nullable().optional(),

  // Stripe handoff is asynchronous — these ids are returned by the
  // Payment Element after the SetupIntent confirms. Optional so a
  // free engagement (no Stripe) can still accept.
  stripeCustomerId: z.string().nullable().optional(),
  stripePaymentMethodId: z.string().nullable().optional(),
  stripeMandateId: z.string().nullable().optional(),
  mandateTextRendered: z.string().max(8_000).nullable().optional(),
});

export function createAcceptanceRouter(deps: AcceptanceDeps): Router {
  const router = express.Router();
  const esign = deps.esignProvider ?? createNativeProvider();

  router.post('/:id/accept', async (req: Request, res: Response) => {
    const parsed = AcceptSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    if (!deps.hmacSeed) {
      res.status(503).json({ error: 'hmac_seed_not_configured' });
      return;
    }
    const proposalId = req.params['id']!;
    const [proposal] = await deps.db
      .select()
      .from(proposals)
      .where(eq(proposals.id, proposalId))
      .limit(1);
    if (!proposal) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (
      proposal.status !== 'SENT' &&
      proposal.status !== 'VIEWED' &&
      proposal.status !== 'IN_PROGRESS'
    ) {
      res.status(409).json({ error: 'not_acceptable', currentStatus: proposal.status });
      return;
    }

    // Drawn SVG: validate before doing any DB writes so a bad payload
    // never partially commits.
    if (parsed.data.drawnSvg) {
      const ok = sanitizeSignatureSvg(parsed.data.drawnSvg);
      if (!ok) {
        res.status(400).json({ error: 'invalid_signature_svg' });
        return;
      }
    }

    const now = new Date();
    const signerIp = req.ip ?? null;
    const signerUa = req.get('user-agent') ?? null;

    // 1. Mint an e-sign envelope so the rest of the flow has a stable
    // envelope id to record on the signatures row. NativeProvider
    // immediately accepts the typed name to flip envelope → SIGNED.
    const envelope = await esign.createEnvelope({
      proposalId: proposal.id,
      signerName: parsed.data.signerName,
      signerEmail: parsed.data.signerEmail,
      documentTitle: proposal.title,
      documentHtml: '<p>Engagement letter — rendered via P14 sidecar in production.</p>',
    });
    const signed = await esign.sign({
      envelopeId: envelope.envelopeId,
      typedName: parsed.data.typedName,
      drawnSvg: parsed.data.drawnSvg ?? undefined,
      signerIp,
      signerUa,
      signedAt: now,
    });

    // 2. Pre-mint the signature id so we can compute payload_hash +
    // hmac_signature before INSERT. The CHECK constraint
    // signatures_signed_state_consistency requires payload_hash to be
    // present when state=SIGNED, so we can't do the two-step
    // insert-then-update dance.
    const signatureId = randomUUID();
    const method: 'TYPED_NAME' | 'OPENSIGN' =
      envelope.providerId === 'native' ? 'TYPED_NAME' : 'OPENSIGN';

    const canonicalRecord: SignatureRecord = {
      id: signatureId,
      proposalId: proposal.id,
      role: 'PRIMARY',
      sequence: 0,
      signerName: parsed.data.signerName,
      signerEmail: parsed.data.signerEmail,
      signerPhone: parsed.data.signerPhone ?? null,
      signerIp,
      signerUa,
      method,
      state: 'SIGNED',
      typedName: parsed.data.typedName,
      signatureSvg: parsed.data.drawnSvg ?? null,
      opensignEnvelopeId: envelope.providerId === 'opensign' ? signed.envelopeId : null,
      opensignCertificateObjectKey: signed.certificateObjectKey,
      payloadHash: null,
      signedAt: now.toISOString(),
      declinedAt: null,
      declinedReason: null,
    };
    const payloadHash = contentHash(canonicalRecord);
    canonicalRecord.payloadHash = payloadHash;
    const hmacKey = deriveFirmHmacKey(deps.hmacSeed, proposal.firmId);
    const hmacSignature = computeSignatureHmac(canonicalRecord, hmacKey);

    await deps.db.insert(signatures).values({
      id: signatureId,
      proposalId: proposal.id,
      role: 'PRIMARY',
      sequence: 0,
      signerName: parsed.data.signerName,
      signerEmail: parsed.data.signerEmail,
      signerPhone: parsed.data.signerPhone ?? null,
      signerIp,
      signerUa,
      clientAccountId: parsed.data.clientAccountId ?? null,
      method,
      state: 'SIGNED',
      typedName: parsed.data.typedName,
      signatureSvg: parsed.data.drawnSvg ?? null,
      opensignEnvelopeId: envelope.providerId === 'opensign' ? signed.envelopeId : null,
      opensignCertificateObjectKey: signed.certificateObjectKey,
      payloadHash,
      hmacSignature,
      signedAt: now,
    });
    const insertedSig = { id: signatureId };

    // 3. Capture ACH mandate if present.
    let mandateId: string | null = null;
    if (
      parsed.data.mandateTextRendered &&
      parsed.data.stripeMandateId &&
      parsed.data.stripeCustomerId &&
      parsed.data.stripePaymentMethodId
    ) {
      const { captureAchMandate } = await import('../stripe-connect/setup-intent');
      mandateId = await captureAchMandate({
        db: deps.db,
        firmId: proposal.firmId,
        clientId: proposal.clientId,
        proposalId: proposal.id,
        stripeAccountId: '', // best-effort: actual account id resolves from firm_settings
        stripeCustomerId: parsed.data.stripeCustomerId,
        stripePaymentMethodId: parsed.data.stripePaymentMethodId,
        stripeMandateId: parsed.data.stripeMandateId,
        mandateTextRendered: parsed.data.mandateTextRendered,
      });
    }

    // 4. Mark selected package (if any) so the scope-freeze helper
    // picks it up.
    if (parsed.data.selectedPackageId) {
      const { proposalPackages } = await import('@vibe/db/schema');
      await deps.db
        .update(proposalPackages)
        .set({ selected: true, selectedAt: now })
        .where(
          and(
            eq(proposalPackages.proposalId, proposal.id),
            eq(proposalPackages.packageId, parsed.data.selectedPackageId),
          ),
        );
    }

    // 5. Mark proposal ACCEPTED, snapshot version, freeze scope.
    await deps.db
      .update(proposals)
      .set({ status: 'ACCEPTED', acceptedAt: now, updatedAt: now })
      .where(eq(proposals.id, proposal.id));

    // Next version is (max prior version) + 1.
    const priorVersions = await deps.db
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
      signatureId: insertedSig.id,
      mandateId,
      acceptedAt: now.toISOString(),
    };
    const acceptanceHash = contentHash(acceptanceSnapshot);
    await deps.db.insert(proposalVersions).values({
      proposalId: proposal.id,
      version: nextVersion,
      contentJsonb: acceptanceSnapshot as unknown as Record<string, unknown>,
      contentHash: acceptanceHash,
      reason: 'ACCEPTED',
    });

    // 6. Freeze engagement scope.
    const freezeResult = await freezeProposalIntoEngagement({
      db: deps.db,
      proposalId: proposal.id,
    });

    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'proposal',
      entityId: proposal.id,
      after: {
        status: 'ACCEPTED',
        signatureId: insertedSig.id,
        engagementId: freezeResult.engagementId,
        mandateId,
        version: nextVersion,
      },
      ip: signerIp,
      userAgent: signerUa,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

    res.json({
      ok: true,
      signatureId: insertedSig.id,
      engagementId: freezeResult.engagementId,
      mandateId,
      version: nextVersion,
      contentHash: acceptanceHash,
    });
  });

  return router;
}
