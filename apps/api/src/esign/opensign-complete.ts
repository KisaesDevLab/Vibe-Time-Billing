// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Q35 — OpenSign async completion (shared by the HMAC webhook fast path
// and the worker poll safety net).
//
// When the sidecar reports an envelope SIGNED:
//   1. Resolve the signatures row by opensign_envelope_id (must be a
//      real OPENSIGN row).
//   2. Idempotent guard: if the row is already SIGNED, no-op.
//   3. Fetch the completion-certificate PDF from the sidecar and write
//      it to OUR storage — the sidecar never receives our storage creds.
//   4. In a transaction holding `SELECT … FOR UPDATE` on the proposal
//      (so native + OpenSign completions serialize → no double-freeze):
//        - flip the row to SIGNED with the cert key + per-row HMAC
//        - run advanceSignatureToSigned (partial → IN_PROGRESS /
//          SEQUENTIAL next; final → mandate + ACCEPTED + freeze) using
//          the mandate context stashed at start-opensign time.
//
// DECLINED completions are handled separately (see opensign webhook).

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { proposalPendingMandate, proposals, signatures } from '@vibe/db/schema';
import {
  computeSignatureHmac,
  contentHash,
  deriveFirmHmacKey,
  type SignatureRecord,
} from '@vibe/core/proposals/server';
import type { StorageClient } from '@vibe/storage';

import {
  advanceSignatureToSigned,
  type AdvanceResult,
  type SendProposalEmail,
  type Tx,
} from '../proposals/sign-advance';
import type { EsignProvider } from './provider';

export interface OpenSignCompleteDeps {
  db: Database;
  provider: EsignProvider;
  storage: StorageClient;
  hmacSeed: string;
  sendProposalEmail?: SendProposalEmail;
  portalBaseUrl?: string;
}

export type CompleteOutcome =
  | { kind: 'ignored'; reason: 'unknown_envelope' | 'already_signed' | 'not_opensign' }
  | { kind: 'advanced'; signatureId: string; result: AdvanceResult };

/**
 * Certificate object key layout (per the operator decision):
 *   opensign-certs/<firmId>/<proposalId>/<signatureId>.pdf
 */
export function certObjectKey(firmId: string, proposalId: string, signatureId: string): string {
  return `opensign-certs/${firmId}/${proposalId}/${signatureId}.pdf`;
}

/**
 * Idempotently complete a signed OpenSign envelope. Safe to call
 * concurrently from the webhook + poll: the proposal FOR UPDATE lock
 * serializes them and the already-SIGNED guard makes the second caller a
 * no-op.
 */
export async function completeOpenSignEnvelope(
  deps: OpenSignCompleteDeps,
  envelopeId: string,
  now: Date = new Date(),
): Promise<CompleteOutcome> {
  // Resolve the row + its proposal (firm scope) before any side effects.
  const rows = await deps.db
    .select({ sig: signatures, proposalFirmId: proposals.firmId })
    .from(signatures)
    .innerJoin(proposals, eq(proposals.id, signatures.proposalId))
    .where(eq(signatures.opensignEnvelopeId, envelopeId))
    .limit(1);
  const row = rows[0];
  if (!row) return { kind: 'ignored', reason: 'unknown_envelope' };
  if (row.sig.method !== 'OPENSIGN') return { kind: 'ignored', reason: 'not_opensign' };
  if (row.sig.state === 'SIGNED') return { kind: 'ignored', reason: 'already_signed' };

  const firmId = row.proposalFirmId;
  const proposalId = row.sig.proposalId;
  const signatureId = row.sig.id;

  // Fetch + store the completion certificate. We do this OUTSIDE the txn
  // so a slow sidecar fetch / storage write doesn't hold the proposal
  // lock. If a concurrent completion wins the txn race, our SIGNED guard
  // inside the txn turns this into a no-op (the cert key write is
  // idempotent — same key, same bytes).
  const objectKey = certObjectKey(firmId, proposalId, signatureId);
  const cert = await deps.provider.fetchCertificatePdf(envelopeId);
  await deps.storage.put(objectKey, cert.body, { contentType: cert.contentType });

  let outcome: CompleteOutcome = { kind: 'ignored', reason: 'already_signed' };
  await deps.db.transaction(async (tx: Tx) => {
    // Lock the proposal so native + OpenSign completions serialize.
    const [proposal] = await tx
      .select()
      .from(proposals)
      .where(eq(proposals.id, proposalId))
      .for('update')
      .limit(1);
    if (!proposal) return;

    // Re-read the signer row under the lock; bail if a concurrent
    // completion already signed it (idempotent — no double advance).
    const [sig] = await tx.select().from(signatures).where(eq(signatures.id, signatureId)).limit(1);
    if (!sig || sig.state === 'SIGNED') return;

    // Build the canonical record + per-row HMAC (binds to the OpenSign
    // envelope + cert key so the signature-verify path validates it).
    const canonicalRecord: SignatureRecord = {
      id: sig.id,
      proposalId: sig.proposalId,
      role: sig.role,
      sequence: sig.sequence,
      signerName: sig.signerName,
      signerEmail: sig.signerEmail,
      signerPhone: sig.signerPhone,
      signerIp: sig.signerIp,
      signerUa: sig.signerUa,
      method: 'OPENSIGN',
      state: 'SIGNED',
      typedName: sig.typedName,
      signatureSvg: sig.signatureSvg,
      opensignEnvelopeId: envelopeId,
      opensignCertificateObjectKey: objectKey,
      payloadHash: null,
      signedAt: now.toISOString(),
      declinedAt: null,
      declinedReason: null,
    };
    const payloadHash = contentHash(canonicalRecord);
    canonicalRecord.payloadHash = payloadHash;
    const hmacKey = deriveFirmHmacKey(deps.hmacSeed, firmId);
    const hmacSignature = computeSignatureHmac(canonicalRecord, hmacKey);

    await tx
      .update(signatures)
      .set({
        state: 'SIGNED',
        method: 'OPENSIGN',
        opensignEnvelopeId: envelopeId,
        opensignCertificateObjectKey: objectKey,
        payloadHash,
        hmacSignature,
        signedAt: now,
      })
      .where(eq(signatures.id, signatureId));

    // Pull the stashed mandate context (set at start-opensign time).
    const [pending] = await tx
      .select()
      .from(proposalPendingMandate)
      .where(
        and(
          eq(proposalPendingMandate.signatureId, signatureId),
          eq(proposalPendingMandate.proposalId, proposalId),
        ),
      )
      .limit(1);

    const result = await advanceSignatureToSigned({
      tx,
      proposal,
      signatureId,
      now,
      mandate: pending
        ? {
            stripeCustomerId: pending.stripeCustomerId,
            stripePaymentMethodId: pending.stripePaymentMethodId,
            stripeMandateId: pending.stripeMandateId,
            mandateTextRendered: pending.mandateTextRendered,
          }
        : undefined,
      selectedPackageId: pending?.selectedPackageId ?? null,
      sendProposalEmail: deps.sendProposalEmail,
      portalBaseUrl: deps.portalBaseUrl,
    });

    outcome = { kind: 'advanced', signatureId, result };
  });

  return outcome;
}
