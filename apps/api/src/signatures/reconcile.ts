// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Phase 7 — status reconciliation for signature_requests.
//
// Webhooks are primary; the poll is the safety net. Both funnel through
// this one function so they can't diverge. A webhook event is only a
// TRIGGER — we always re-fetch the authoritative OpenSign document and
// derive state from it, never trusting a partial webhook payload.
//
// Status derivation (request-level):
//   declined        → request 'declined'
//   all signers signed → 'completed' (+ fetch & store the signed PDF)
//   some signed     → 'partially_signed'
//   none / unsigned → no change
//
// Keyed by opensign_document_id, a globally-unique id disjoint from the
// proposal envelope id space — so this never collides with the proposal
// completion path (apps/api/src/esign/opensign-complete.ts).

import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { signatureEvents, signatureRequests, signatureSigners } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import type { OpenSignClient, ParseDoc } from '../esign/opensign-client';
import { notifySigner, signerSigningUrl, type SignerMailer } from './notify';

export interface ReconcileDeps {
  db: Database;
  client: OpenSignClient;
  storage: StorageClient;
  /** For sequential (sendInOrder) requests: notify the next pending signer
   *  once the prior one signs. Best-effort; absent when mail isn't wired
   *  (the poll path passes none — the webhook is primary for this). */
  notify?: SignerMailer;
}

export type ReconcileOutcome =
  | { kind: 'ignored'; reason: 'unknown_document' | 'already_terminal' | 'no_change' }
  | { kind: 'updated'; requestId: string; status: string; signedCount: number };

const TERMINAL = new Set(['completed', 'declined', 'expired', 'voided']);

function signedFileKey(firmId: string, requestId: string): string {
  return `signatures/${firmId}/${requestId}/signed.pdf`;
}

function certFileKey(firmId: string, requestId: string): string {
  return `signatures/${firmId}/${requestId}/certificate.pdf`;
}

// Collect the lower-cased emails that have a 'Signed' audit-trail entry.
function signedEmailsFromDoc(doc: ParseDoc): Set<string> {
  const emails = new Set<string>();
  for (const entry of doc.AuditTrail ?? []) {
    const act = (entry.Activity ?? '').toLowerCase();
    if (act === 'signed') {
      const email = entry.UserPtr?.Email;
      if (email) emails.add(email.toLowerCase());
    }
  }
  return emails;
}

/**
 * Reconcile one request against its OpenSign document. Idempotent + safe
 * to call concurrently (the request row is locked FOR UPDATE and terminal
 * states short-circuit).
 */
export async function reconcileSignatureRequestByDocument(
  deps: ReconcileDeps,
  opensignDocumentId: string,
  now: Date = new Date(),
): Promise<ReconcileOutcome> {
  const { db } = deps;

  const [request] = await db
    .select()
    .from(signatureRequests)
    .where(eq(signatureRequests.opensignDocumentId, opensignDocumentId))
    .limit(1);
  if (!request) return { kind: 'ignored', reason: 'unknown_document' };
  if (TERMINAL.has(request.status)) return { kind: 'ignored', reason: 'already_terminal' };

  // Authoritative state from OpenSign.
  const doc = await deps.client.getDocument(opensignDocumentId);
  const declined = Boolean(doc.IsDeclined);
  const completed = Boolean(doc.IsCompleted);
  const signedEmails = signedEmailsFromDoc(doc);

  const signers = await db
    .select()
    .from(signatureSigners)
    .where(eq(signatureSigners.requestId, request.id))
    .orderBy(signatureSigners.order);

  // A completed doc means everyone signed even if the audit trail is terse.
  const isSigned = (email: string): boolean => completed || signedEmails.has(email.toLowerCase());
  const signedCount = signers.filter((s) => isSigned(s.email)).length;

  // Fetch + store the signed PDF BEFORE the txn (slow I/O off the lock).
  // OpenSign never gets our storage creds — we pull the bytes and write
  // them to our own bucket.
  let signedKey: string | null = null;
  let certKey: string | null = null;
  if (completed) {
    const url = doc.SignedUrl ?? doc.CertificateUrl;
    if (url) {
      const pdf = await deps.client.fetchPdfUrl(url);
      signedKey = signedFileKey(request.firmId, request.id);
      await deps.storage.put(signedKey, pdf.body, { contentType: pdf.contentType });
    }
    // Audit certificate (signer IP, signed date/time, document hash, event
    // trail). Prefer OpenSign's CertificateUrl; generate it on demand if the
    // document didn't surface one. Best-effort — never block completion; the
    // poll re-fetches next tick if this fails.
    try {
      let certUrl = doc.CertificateUrl;
      if (!certUrl) {
        const gen = await deps.client.generateCertificate(opensignDocumentId);
        certUrl = gen?.CertificateUrl;
      }
      if (certUrl) {
        const certPdf = await deps.client.fetchPdfUrl(certUrl);
        certKey = certFileKey(request.firmId, request.id);
        await deps.storage.put(certKey, certPdf.body, { contentType: certPdf.contentType });
      }
    } catch {
      // leave certKey null; a later reconcile tick will retry.
    }
  }

  // Plainly-typed advance flag — set inside the txn closure, then read
  // outside (a union-typed `let` reassigned only in a closure trips TS's
  // control-flow narrowing, so we track the status as a string instead).
  let advancedStatus: string | null = null;
  await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(signatureRequests)
      .where(eq(signatureRequests.id, request.id))
      .for('update')
      .limit(1);
    if (!locked || TERMINAL.has(locked.status)) return;

    // Flip each signed signer (idempotent).
    for (const s of signers) {
      if (isSigned(s.email) && s.status !== 'signed') {
        await tx
          .update(signatureSigners)
          .set({ status: 'signed', signedAt: now })
          .where(eq(signatureSigners.id, s.id));
      }
    }

    let nextStatus = locked.status;
    if (declined) nextStatus = 'declined';
    else if (completed || (signers.length > 0 && signedCount === signers.length))
      nextStatus = 'completed';
    else if (signedCount > 0) nextStatus = 'partially_signed';

    if (nextStatus === locked.status && signedCount === locked.signedCount) {
      return;
    }

    await tx
      .update(signatureRequests)
      .set({
        status: nextStatus,
        signedCount,
        signedFileUrl: signedKey ?? locked.signedFileUrl,
        certificateFileUrl: certKey ?? locked.certificateFileUrl,
        completedAt: nextStatus === 'completed' ? now : locked.completedAt,
        updatedAt: now,
      })
      .where(eq(signatureRequests.id, request.id));

    await tx.insert(signatureEvents).values({
      requestId: request.id,
      actor: 'opensign',
      event: nextStatus,
      detail: { signedCount, signerCount: signers.length },
    });

    advancedStatus = nextStatus;
  });

  // Sequential hand-off: when a signer just signed and the request is still
  // awaiting others, email the next pending signer their link (OpenSign
  // sends nothing). Best-effort; only on a real advance to avoid re-spam.
  if (advancedStatus === 'partially_signed' && request.sendInOrder && deps.notify) {
    const next = signers.find((s) => !isSigned(s.email) && s.opensignSignerId);
    if (next?.opensignSignerId) {
      await notifySigner(deps.notify, {
        to: next.email,
        name: next.name,
        title: request.title,
        signingUrl: signerSigningUrl(
          deps.client.publicUrl,
          opensignDocumentId,
          next.opensignSignerId,
        ),
      });
    }
  }

  return advancedStatus
    ? { kind: 'updated', requestId: request.id, status: advancedStatus, signedCount }
    : { kind: 'ignored', reason: 'no_change' };
}

/**
 * Mark a request expired if its expiry has passed and it's still awaiting
 * signatures. Returns true if it flipped. Called by the poll sweep.
 */
export async function expireSignatureRequestIfDue(
  db: Database,
  requestId: string,
  now: Date = new Date(),
): Promise<boolean> {
  let flipped = false;
  await db.transaction(async (tx) => {
    const [r] = await tx
      .select()
      .from(signatureRequests)
      .where(eq(signatureRequests.id, requestId))
      .for('update')
      .limit(1);
    if (!r) return;
    if (TERMINAL.has(r.status)) return;
    if (!r.expiresAt || r.expiresAt.getTime() > now.getTime()) return;
    await tx
      .update(signatureRequests)
      .set({ status: 'expired', updatedAt: now })
      .where(eq(signatureRequests.id, requestId));
    await tx.insert(signatureEvents).values({
      requestId,
      actor: 'system',
      event: 'expired',
      detail: { expiresAt: r.expiresAt.toISOString() },
    });
    flipped = true;
  });
  return flipped;
}
