// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
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
import { fileExistingObjectIntoClientFolder } from '../clients/file-existing';
import { notifySignatureCompleted, type CompletionMailer } from './completion-notify';
import {
  notifySigner,
  notifySignerSms,
  signerSigningUrl,
  wantsEmail,
  wantsSms,
  type NotifyChannel,
  type SignerMailer,
  type SignerTexter,
} from './notify';

// Subfolder the signed package is auto-filed into when the request was
// assembled from a tax return.
const SIGNED_RETURN_SUBFOLDER = 'Tax Returns';
// Where every other client-linked signed document lands. Matches the
// 'Signatures' folder in DEFAULT_FOLDER_TEMPLATE; folders are derived, so a
// firm that removed it from its template still gets the files (the folder
// simply reappears because a file lives under it).
const SIGNED_DOCUMENT_SUBFOLDER = 'Signatures';

export interface ReconcileDeps {
  db: Database;
  client: OpenSignClient;
  storage: StorageClient;
  /** For sequential (sendInOrder) requests: notify the next pending signer
   *  once the prior one signs. Best-effort; absent when mail isn't wired
   *  (the poll path passes none — the webhook is primary for this). */
  notify?: SignerMailer;
  /** 0231 — same hand-off by text, when the request was sent that way. */
  notifySms?: SignerTexter;
  /** Sends the client a confirmation email on completion. Best-effort;
   *  absent when mail isn't wired. Staff in-app notifications fire regardless
   *  (they only need the db). */
  sendEmail?: CompletionMailer;
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
  let signedSize = 0;
  // Kept in scope past the download block so the completion email can attach
  // the client's copy without a second fetch from storage.
  let signedPdf: Buffer | null = null;
  let certKey: string | null = null;
  let certSize = 0;
  if (completed) {
    const url = doc.SignedUrl ?? doc.CertificateUrl;
    let signedBuf: Buffer | null = null;
    if (url) {
      const pdf = await deps.client.fetchPdfUrl(url);
      signedBuf = Buffer.isBuffer(pdf.body) ? pdf.body : Buffer.from(pdf.body);
    }
    // Audit certificate (signer IP, signed date/time, document hash, event
    // trail). Prefer OpenSign's CertificateUrl; generate it on demand if the
    // document didn't surface one. Best-effort — never block completion.
    // Skipped when the "signed" bytes ARE the certificate (no SignedUrl).
    let certBuf: Buffer | null = null;
    if (doc.SignedUrl) {
      try {
        let certUrl = doc.CertificateUrl;
        if (!certUrl) {
          const gen = await deps.client.generateCertificate(opensignDocumentId);
          certUrl = gen?.CertificateUrl;
        }
        if (certUrl) {
          const certPdf = await deps.client.fetchPdfUrl(certUrl);
          certBuf = Buffer.isBuffer(certPdf.body) ? certPdf.body : Buffer.from(certPdf.body);
        }
      } catch {
        // certificate unavailable — store the signed doc alone.
      }
    }
    // Store the signed document and the audit certificate as SEPARATE
    // artifacts: the certificate is its own file so it's downloadable (the
    // Signed Forms report's Certificate link) and gets filed alongside the
    // return (see the auto-file block below). Each is captured best-effort.
    if (signedBuf) {
      signedKey = signedFileKey(request.firmId, request.id);
      signedSize = signedBuf.length;
      signedPdf = signedBuf;
      await deps.storage.put(signedKey, signedBuf, { contentType: 'application/pdf' });
    }
    if (certBuf) {
      certKey = certFileKey(request.firmId, request.id);
      certSize = certBuf.length;
      await deps.storage.put(certKey, certBuf, { contentType: 'application/pdf' });
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
  // awaiting others, send the next pending signer their link (OpenSign
  // sends nothing). Best-effort; only on a real advance to avoid re-spam.
  // 0231 — reuses the channel the request went out on, so a text-only send
  // stays text-only all the way down the signer chain.
  if (
    advancedStatus === 'partially_signed' &&
    request.sendInOrder &&
    (deps.notify || deps.notifySms)
  ) {
    const next = signers.find((s) => !isSigned(s.email) && s.opensignSignerId);
    if (next?.opensignSignerId) {
      const channel = (request.notifyChannel ?? 'EMAIL') as NotifyChannel;
      const notice = {
        to: next.email,
        name: next.name,
        title: request.title,
        signingUrl: signerSigningUrl(
          deps.client.publicUrl,
          opensignDocumentId,
          next.opensignSignerId,
        ),
        phone: next.phone,
        db,
        firmId: request.firmId,
      };
      if (wantsEmail(channel) && deps.notify) await notifySigner(deps.notify, notice);
      if (wantsSms(channel) && deps.notifySms) await notifySignerSms(deps.notifySms, notice);
    }
  }

  // Auto-file the signed package into the client's folder whenever the
  // request names a client — a return-assembled package goes to Tax Returns,
  // anything else to Signatures. Runs once: reconcile short-circuits on an
  // already-terminal request, so only the transition to 'completed' reaches
  // here. Best-effort: a filing failure (e.g. the client folder isn't bound)
  // is recorded but never undoes completion.
  const filingSubfolder = request.taxReturnId ? SIGNED_RETURN_SUBFOLDER : SIGNED_DOCUMENT_SUBFOLDER;
  if (advancedStatus === 'completed' && signedKey && request.clientId && !request.createdBy) {
    // No creator to attribute the upload to (e.g. a request whose author was
    // deleted). Record why nothing was filed instead of failing silently.
    await db
      .insert(signatureEvents)
      .values({
        requestId: request.id,
        actor: 'system',
        event: 'signed_file_skipped',
        detail: { reason: 'no_actor' },
      })
      .catch(() => undefined);
  }
  if (advancedStatus === 'completed' && signedKey && request.clientId && request.createdBy) {
    try {
      const filed = await fileExistingObjectIntoClientFolder(db, deps.storage, {
        firmId: request.firmId,
        clientId: request.clientId,
        actorId: request.createdBy,
        subfolderPath: filingSubfolder,
        originalFilename: `${request.title} (signed).pdf`,
        sourceKey: signedKey,
        mimeType: 'application/pdf',
        sizeBytes: signedSize,
        source: 'signature',
      });
      await db.insert(signatureEvents).values({
        requestId: request.id,
        actor: 'system',
        event: filed.ok ? 'signed_filed' : 'signed_file_skipped',
        detail: filed.ok
          ? {
              fileId: filed.fileId,
              subfolder: filingSubfolder,
              taxReturnId: request.taxReturnId,
            }
          : { reason: filed.code, subfolder: filingSubfolder, taxReturnId: request.taxReturnId },
      });
      // File the audit certificate as its own document alongside the signed
      // copy, so the signing certificate is stored with what it certifies.
      if (certKey) {
        const filedCert = await fileExistingObjectIntoClientFolder(db, deps.storage, {
          firmId: request.firmId,
          clientId: request.clientId,
          actorId: request.createdBy,
          subfolderPath: filingSubfolder,
          originalFilename: `${request.title} (certificate).pdf`,
          sourceKey: certKey,
          mimeType: 'application/pdf',
          sizeBytes: certSize,
          source: 'signature',
        });
        await db.insert(signatureEvents).values({
          requestId: request.id,
          actor: 'system',
          event: filedCert.ok ? 'certificate_filed' : 'certificate_file_skipped',
          detail: filedCert.ok
            ? {
                fileId: filedCert.fileId,
                subfolder: filingSubfolder,
                taxReturnId: request.taxReturnId,
              }
            : {
                reason: filedCert.code,
                subfolder: filingSubfolder,
                taxReturnId: request.taxReturnId,
              },
        });
      }
    } catch (err) {
      await db
        .insert(signatureEvents)
        .values({
          requestId: request.id,
          actor: 'system',
          event: 'signed_file_skipped',
          detail: { reason: String(err) },
        })
        .catch(() => undefined);
    }
  }

  // Completion notifications — staff in-app + a client confirmation email.
  // Best-effort, and only on the single transition to 'completed' (reconcile
  // short-circuits on an already-terminal request), so it fires once.
  if (advancedStatus === 'completed') {
    await notifySignatureCompleted(
      db,
      {
        id: request.id,
        firmId: request.firmId,
        clientId: request.clientId,
        engagementId: request.engagementId,
        createdBy: request.createdBy,
        title: request.title,
      },
      signers.map((s) => s.email),
      deps.sendEmail,
      signedPdf,
    ).catch(() => undefined);
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
