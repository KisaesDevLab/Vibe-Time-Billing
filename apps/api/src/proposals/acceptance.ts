// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P21 — Proposal acceptance flow (Q34 multi-signer aware).
//
// The integration moment: a single transaction resolves the target
// signature row, computes its HMAC, and — only when every required
// signer has signed — captures the ACH mandate, freezes the engagement
// scope, and bumps proposal status to ACCEPTED + snapshots a final
// proposal_versions row.
//
// Legacy single-signer (no roster) behavior is preserved: with no
// PENDING roster rows the handler inserts a fresh PRIMARY signature and
// flips straight to ACCEPTED in one shot.
//
// Multi-signer:
//   • Each accept resolves the target roster row (via the magic link's
//     signatureId) and marks it SIGNED.
//   • If required signers remain PENDING → proposal goes IN_PROGRESS
//     (no scope freeze, no acceptedAt). SEQUENTIAL mints + emails the
//     next signer's link.
//   • When the last required signer signs → the full ACCEPTED path runs
//     (mandate / package / freeze), idempotent via scope-freeze's guard.
//
// All Stripe interactions are abstracted behind injected helpers so
// this module stays pure data orchestration — no live Stripe calls in
// the trust path.

import { randomUUID } from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { magicLinks, proposalPendingMandate, proposals, signatures } from '@vibe/db/schema';
import {
  computeSignatureHmac,
  contentHash,
  deriveFirmHmacKey,
  type SignatureRecord,
} from '@vibe/core/proposals/server';

import { logger } from '../logger';
import { emitAudit } from '../auth/audit';
import { sanitizeSignatureSvg } from '../portal/signature-svg';
import { createNativeProvider, type EsignProvider } from '../esign/provider';
import { type SendProposalEmail } from './magic-links';
import { advanceSignatureToSigned } from './sign-advance';

// Drizzle's transaction callback hands back a narrower type than the
// top-level Database; the runtime surface used here (select/insert/
// update/for) is identical, so we accept either.
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface AcceptanceDeps {
  db: Database | null;
  hmacSeed: string | null;
  esignProvider?: EsignProvider;
  // Q35 — per-firm provider resolver. When supplied, start-opensign (and
  // any provider-sensitive path) resolves the firm's configured provider
  // (opensign when OPENSIGN_URL is set + firm opted in, else native).
  // Absent → the fixed esignProvider / native default is used. The native
  // /accept path always uses native; OpenSign signs out-of-band.
  resolveEsignProvider?: (firmId: string) => Promise<EsignProvider>;
  portalBaseUrl?: string;
  // Q34 — optional best-effort mail for SEQUENTIAL next-signer links.
  sendProposalEmail?: SendProposalEmail;
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

const DeclineSchema = z.object({
  magicLinkId: z.string().uuid(),
  reason: z.string().max(2_000).nullable().optional(),
});

// Q35 — start-OpenSign payload. Same Stripe-handoff fields as accept
// (stashed for the async completion) plus the magic-link that resolves
// the target signer.
const StartOpenSignSchema = z.object({
  magicLinkId: z.string().uuid(),
  selectedPackageId: z.string().uuid().nullable().optional(),
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
    const hmacSeed = deps.hmacSeed;
    const proposalId = req.params['id']!;

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

    let outcome:
      | { kind: 'partial'; signatureId: string; remaining: number; status: string }
      | {
          kind: 'final';
          signatureId: string;
          signatureIds: string[];
          engagementId: string | null;
          mandateId: string | null;
          version: number;
          contentHash: string;
        }
      | { kind: 'error'; status: number; body: Record<string, unknown> };

    try {
      outcome = await deps.db.transaction(async (tx) => {
        // Lock the proposal row for the duration so concurrent signers
        // serialize on the required-remaining computation.
        const [proposal] = await tx
          .select()
          .from(proposals)
          .where(eq(proposals.id, proposalId))
          .for('update')
          .limit(1);
        if (!proposal) {
          return { kind: 'error' as const, status: 404, body: { error: 'not_found' } };
        }
        if (
          proposal.status !== 'SENT' &&
          proposal.status !== 'VIEWED' &&
          proposal.status !== 'IN_PROGRESS'
        ) {
          return {
            kind: 'error' as const,
            status: 409,
            body: { error: 'not_acceptable', currentStatus: proposal.status },
          };
        }

        // Resolve the target roster row. The magic link (when present)
        // points at the signer being represented.
        let targetSignatureId: string | null = null;
        if (parsed.data.magicLinkId) {
          const [ml] = await tx
            .select({ signatureId: magicLinks.signatureId })
            .from(magicLinks)
            .where(eq(magicLinks.id, parsed.data.magicLinkId))
            .limit(1);
          targetSignatureId = ml?.signatureId ?? null;
        }

        // Mint the e-sign envelope + sign (NativeProvider flips to
        // SIGNED inline).
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
        const method: 'TYPED_NAME' | 'OPENSIGN' =
          envelope.providerId === 'native' ? 'TYPED_NAME' : 'OPENSIGN';

        // Build the canonical record for the signed row. We reuse the
        // resolved roster row's id/role/sequence when present so the
        // HMAC binds to the right signer; otherwise mint a PRIMARY row.
        let rosterRow: typeof signatures.$inferSelect | null = null;
        if (targetSignatureId) {
          const [r] = await tx
            .select()
            .from(signatures)
            .where(
              and(eq(signatures.id, targetSignatureId), eq(signatures.proposalId, proposal.id)),
            )
            .limit(1);
          rosterRow = r ?? null;
          if (rosterRow && rosterRow.state !== 'PENDING') {
            return {
              kind: 'error' as const,
              status: 409,
              body: { error: rosterRow.state === 'SIGNED' ? 'already_signed' : 'declined' },
            };
          }
        }

        const signatureId = rosterRow ? rosterRow.id : randomUUID();
        const role = rosterRow ? rosterRow.role : 'PRIMARY';
        const sequence = rosterRow ? rosterRow.sequence : 0;

        const canonicalRecord: SignatureRecord = {
          id: signatureId,
          proposalId: proposal.id,
          role,
          sequence,
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
        const hmacKey = deriveFirmHmacKey(hmacSeed, proposal.firmId);
        const hmacSignature = computeSignatureHmac(canonicalRecord, hmacKey);

        if (rosterRow) {
          await tx
            .update(signatures)
            .set({
              method,
              state: 'SIGNED',
              signerName: parsed.data.signerName,
              signerEmail: parsed.data.signerEmail,
              signerPhone: parsed.data.signerPhone ?? null,
              signerIp,
              signerUa,
              clientAccountId: parsed.data.clientAccountId ?? null,
              typedName: parsed.data.typedName,
              signatureSvg: parsed.data.drawnSvg ?? null,
              opensignEnvelopeId: envelope.providerId === 'opensign' ? signed.envelopeId : null,
              opensignCertificateObjectKey: signed.certificateObjectKey,
              payloadHash,
              hmacSignature,
              signedAt: now,
            })
            .where(eq(signatures.id, signatureId));
        } else {
          await tx.insert(signatures).values({
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
        }

        // Shared gating: count remaining required signers and either
        // keep the proposal open (partial) or run the full ACCEPTED
        // path (final). Identical logic backs the async OpenSign
        // completion so native + OpenSign serialize on the proposal lock.
        return advanceSignatureToSigned({
          tx,
          proposal,
          signatureId,
          now,
          mandate: {
            stripeCustomerId: parsed.data.stripeCustomerId,
            stripePaymentMethodId: parsed.data.stripePaymentMethodId,
            stripeMandateId: parsed.data.stripeMandateId,
            mandateTextRendered: parsed.data.mandateTextRendered,
          },
          selectedPackageId: parsed.data.selectedPackageId ?? null,
          sendProposalEmail: deps.sendProposalEmail,
          portalBaseUrl: deps.portalBaseUrl,
        });
      });
    } catch (err) {
      logger.error({ err }, 'proposal acceptance failed');
      res.status(500).json({ error: 'acceptance_failed' });
      return;
    }

    if (outcome.kind === 'error') {
      res.status(outcome.status).json(outcome.body);
      return;
    }

    if (outcome.kind === 'partial') {
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'proposal',
        entityId: proposalId,
        after: {
          status: 'IN_PROGRESS',
          signatureId: outcome.signatureId,
          requiredRemaining: outcome.remaining,
        },
        ip: signerIp,
        userAgent: signerUa,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, signatureId: outcome.signatureId, remaining: outcome.remaining });
      return;
    }

    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'proposal',
      entityId: proposalId,
      after: {
        status: 'ACCEPTED',
        signatureIds: outcome.signatureIds,
        engagementId: outcome.engagementId,
        mandateId: outcome.mandateId,
        version: outcome.version,
      },
      ip: signerIp,
      userAgent: signerUa,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

    res.json({
      ok: true,
      signatureId: outcome.signatureId,
      signatureIds: outcome.signatureIds,
      engagementId: outcome.engagementId,
      mandateId: outcome.mandateId,
      version: outcome.version,
      contentHash: outcome.contentHash,
      remaining: 0,
    });
  });

  // Q35 — start an OpenSign signing session (portal, "alongside" flow).
  // The client has already viewed the brochure + confirmed the ACH
  // SetupIntent in OUR portal; this endpoint (a) stashes the mandate
  // inputs + package selection for the async completion, (b) creates the
  // OpenSign envelope, (c) marks the signer row method=OPENSIGN with the
  // envelope id (state stays PENDING — allowed by the CHECK), and (d)
  // returns { signingUrl } for the browser to redirect to. Completion
  // arrives asynchronously via the HMAC webhook + worker poll — never in
  // this request. We never email the raw OpenSign URL.
  router.post('/:id/start-opensign', async (req: Request, res: Response) => {
    const parsed = StartOpenSignSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const proposalId = req.params['id']!;
    const now = new Date();

    type StartResult = {
      kind: 'ok';
      signatureId: string;
      envelopeId: string;
      signingUrl: string | null;
    };

    let result: StartResult;
    try {
      // Resolve the proposal + target signer first (outside the create
      // call) so we don't mint an envelope for an invalid request.
      const [proposal] = await deps.db
        .select()
        .from(proposals)
        .where(eq(proposals.id, proposalId))
        .limit(1);
      if (!proposal) {
        res.status(404).json({ error: 'not_found' });
        return;
      }

      // Resolve this firm's provider. start-opensign only applies to an
      // OpenSign firm — a native firm should use the inline /accept flow.
      const provider = deps.resolveEsignProvider
        ? await deps.resolveEsignProvider(proposal.firmId)
        : esign;
      if (provider.id !== 'opensign') {
        res.status(409).json({ error: 'opensign_not_configured' });
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

      let rosterRow: typeof signatures.$inferSelect | null = null;
      if (parsed.data.magicLinkId) {
        const [ml] = await deps.db
          .select({ signatureId: magicLinks.signatureId })
          .from(magicLinks)
          .where(eq(magicLinks.id, parsed.data.magicLinkId))
          .limit(1);
        if (ml?.signatureId) {
          const [r] = await deps.db
            .select()
            .from(signatures)
            .where(and(eq(signatures.id, ml.signatureId), eq(signatures.proposalId, proposal.id)))
            .limit(1);
          rosterRow = r ?? null;
        }
      }
      if (!rosterRow) {
        res.status(404).json({ error: 'signer_not_found' });
        return;
      }
      if (rosterRow.state !== 'PENDING') {
        res
          .status(409)
          .json({ error: rosterRow.state === 'SIGNED' ? 'already_signed' : 'declined' });
        return;
      }

      // Mint the OpenSign envelope (network call to the sidecar).
      const envelope = await provider.createEnvelope({
        proposalId: proposal.id,
        signerName: rosterRow.signerName,
        signerEmail: rosterRow.signerEmail,
        documentTitle: proposal.title,
        documentHtml: '<p>Engagement letter — rendered via P14 sidecar in production.</p>',
      });

      result = await deps.db.transaction(async (tx: Tx) => {
        // Persist the envelope pointer + method on the signer row. State
        // stays PENDING (the CHECK allows OPENSIGN+envelope id with any
        // state; PENDING is correct until the sidecar reports SIGNED).
        await tx
          .update(signatures)
          .set({ method: 'OPENSIGN', opensignEnvelopeId: envelope.envelopeId })
          .where(eq(signatures.id, rosterRow!.id));

        // Stash the pending mandate context, idempotent per signer.
        await tx
          .insert(proposalPendingMandate)
          .values({
            firmId: proposal.firmId,
            proposalId: proposal.id,
            signatureId: rosterRow!.id,
            selectedPackageId: parsed.data.selectedPackageId ?? null,
            stripeCustomerId: parsed.data.stripeCustomerId ?? null,
            stripePaymentMethodId: parsed.data.stripePaymentMethodId ?? null,
            stripeMandateId: parsed.data.stripeMandateId ?? null,
            mandateTextRendered: parsed.data.mandateTextRendered ?? null,
          })
          .onConflictDoUpdate({
            target: proposalPendingMandate.signatureId,
            set: {
              selectedPackageId: parsed.data.selectedPackageId ?? null,
              stripeCustomerId: parsed.data.stripeCustomerId ?? null,
              stripePaymentMethodId: parsed.data.stripePaymentMethodId ?? null,
              stripeMandateId: parsed.data.stripeMandateId ?? null,
              mandateTextRendered: parsed.data.mandateTextRendered ?? null,
              updatedAt: now,
            },
          });

        return {
          kind: 'ok' as const,
          signatureId: rosterRow!.id,
          envelopeId: envelope.envelopeId,
          signingUrl: envelope.signingUrl,
        };
      });
    } catch (err) {
      logger.error({ err }, 'start-opensign failed');
      res.status(502).json({ error: 'opensign_start_failed' });
      return;
    }

    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'signature.opensign_started',
      entityId: result.signatureId,
      after: { envelopeId: result.envelopeId, proposalId },
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.json({ ok: true, signingUrl: result.signingUrl, signatureId: result.signatureId });
  });

  // Q34 — decline (portal, via magicLinkId). Staff-recoverable: the
  // signer row goes DECLINED, the proposal moves to IN_PROGRESS (never
  // DECLINED), and that signer's outstanding links are superseded so
  // the old link can't be reused. Staff can then replace/re-invite.
  router.post('/:id/decline', async (req: Request, res: Response) => {
    const parsed = DeclineSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const proposalId = req.params['id']!;
    const now = new Date();

    type DeclineResult =
      | { kind: 'error'; status: number; body: Record<string, unknown> }
      | { kind: 'ok'; signatureId: string };
    const result: DeclineResult = await deps.db.transaction(async (tx: Tx) => {
      const [ml] = await tx
        .select({ signatureId: magicLinks.signatureId })
        .from(magicLinks)
        .where(eq(magicLinks.id, parsed.data.magicLinkId))
        .limit(1);
      const signatureId = ml?.signatureId ?? null;
      if (!signatureId) {
        return { kind: 'error', status: 400, body: { error: 'not_a_signer_link' } };
      }
      const [sig] = await tx
        .select()
        .from(signatures)
        .where(and(eq(signatures.id, signatureId), eq(signatures.proposalId, proposalId)))
        .limit(1);
      if (!sig) {
        return { kind: 'error', status: 404, body: { error: 'signer_not_found' } };
      }
      if (sig.state !== 'PENDING') {
        return { kind: 'error', status: 409, body: { error: 'not_pending', state: sig.state } };
      }
      await tx
        .update(signatures)
        .set({ state: 'DECLINED', declinedAt: now, declinedReason: parsed.data.reason ?? null })
        .where(eq(signatures.id, signatureId));
      // Proposal stays alive at IN_PROGRESS so staff can recover.
      await tx
        .update(proposals)
        .set({ status: 'IN_PROGRESS', updatedAt: now })
        .where(eq(proposals.id, proposalId));
      // Supersede this signer's outstanding links.
      await tx
        .update(magicLinks)
        .set({ supersededAt: now })
        .where(and(eq(magicLinks.signatureId, signatureId), isNull(magicLinks.supersededAt)));
      return { kind: 'ok', signatureId };
    });

    if (result.kind === 'error') {
      res.status(result.status).json(result.body);
      return;
    }
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'signature.declined',
      entityId: result.signatureId,
      after: { state: 'DECLINED', proposalStatus: 'IN_PROGRESS' },
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.json({ ok: true, signatureId: result.signatureId, proposalStatus: 'IN_PROGRESS' });
  });

  return router;
}
