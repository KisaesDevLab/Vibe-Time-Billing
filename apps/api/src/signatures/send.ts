// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Phase 6 — the transactional send pipeline.
//
// A send is "build placeholders → create the OpenSign document → persist".
// The local rows are written ONLY after OpenSign confirms the document, so
// a failed create leaves the request a clean draft — there is no orphaned
// `sent` row to reconcile (transactional by construction). The geometry +
// placement rules are re-validated here (the send gate) so a request can
// never go out with fields off-page or a placeless signer, even if the
// draft was mutated out of band.

import { eq } from 'drizzle-orm';
import type { Readable } from 'node:stream';

import type { Database } from '@vibe/db';
import {
  signatureEvents,
  signatureFieldPlacements,
  signatureRequests,
  signatureSigners,
} from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import type { OpenSignClient } from '../esign/opensign-client';
import type { PageGeometry } from './geometry';
import { createSignatureDocument } from './opensign-document';
import { notifySigner, signerSigningUrl, type SignerMailer } from './notify';
import { formRequiresKba } from './profiles';
import { validatePlacements, type PlacementInput, type ValidationError } from './validation';

const DEFAULT_EXPIRY_DAYS = 30;

export interface SendDeps {
  db: Database;
  storage: StorageClient;
  client: OpenSignClient;
  /** Days until the request expires (default 30). */
  expiresInDays?: number;
  /** Delivers each signer their signing link (OpenSign won't). Best-effort;
   *  absent when mail isn't configured. */
  sendEmail?: SignerMailer;
}

export type SendOutcome =
  | { kind: 'sent'; opensignDocumentId: string; expiresAt: Date }
  | { kind: 'not_found' }
  | { kind: 'not_draft'; status: string }
  | { kind: 'no_source' }
  | { kind: 'kba_required'; formType: string }
  | { kind: 'identity_required'; missing: string[] }
  | { kind: 'invalid'; errors: ValidationError[] };

export interface IdentityVerification {
  signerId: string;
  /** Government photo ID type the ERO inspected in person (Pub 1345). */
  idType: string;
}

export interface SendArgs {
  requestId: string;
  firmId: string;
  actor: string;
  /** In-office signing: suppress signer email; with an identity attestation
   *  it satisfies IRS in-person ID verification and bypasses the KBA gate. */
  inPerson?: boolean;
  /** Per-signer in-person ID attestation (required for KBA forms in-person). */
  identityVerifications?: IdentityVerification[];
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/**
 * Send a draft signature request through OpenSign. Idempotency: only a
 * 'draft' request is sendable; once `sent` it returns {not_draft}. The
 * caller (route) is responsible for the audit_log row + the OpenSign
 * client/storage being configured.
 */
export async function sendSignatureRequest(
  deps: SendDeps,
  args: SendArgs,
  now: Date = new Date(),
): Promise<SendOutcome> {
  const { db } = deps;

  const [request] = await db
    .select()
    .from(signatureRequests)
    .where(eq(signatureRequests.id, args.requestId))
    .limit(1);
  if (!request || request.firmId !== args.firmId) return { kind: 'not_found' };
  if (request.status !== 'draft') return { kind: 'not_draft', status: request.status };
  if (!request.sourceFileKey) return { kind: 'no_source' };

  const signers = await db
    .select()
    .from(signatureSigners)
    .where(eq(signatureSigners.requestId, request.id))
    .orderBy(signatureSigners.order);

  // KBA gate. A KBA-gated form (individual 1040 8879) cannot go out remotely
  // (no KBA flow). In-person it's allowed when the ERO has attested to
  // verifying each signer's government photo ID (IRS Pub 1345).
  const idBySigner = new Map(
    (args.identityVerifications ?? []).map((v) => [v.signerId, (v.idType ?? '').trim()]),
  );
  if (formRequiresKba(request.formType)) {
    if (!args.inPerson) return { kind: 'kba_required', formType: request.formType! };
    const missing = signers.filter((s) => !idBySigner.get(s.id)).map((s) => s.id);
    if (missing.length > 0) return { kind: 'identity_required', missing };
  }
  const placements = await db
    .select()
    .from(signatureFieldPlacements)
    .where(eq(signatureFieldPlacements.requestId, request.id));

  const geometry = (request.pageGeometry as PageGeometry[] | null) ?? null;

  // Re-validate at the gate — never trust the draft's stored state blindly.
  const errors = validatePlacements(
    signers.map((s) => s.id),
    placements.map((p) => ({
      signerId: p.signerId,
      fieldType: p.fieldType as PlacementInput['fieldType'],
      pageNumber: p.pageNumber,
      nx: p.nx,
      ny: p.ny,
      nw: p.nw,
      nh: p.nh,
      required: p.required,
    })),
    geometry,
  );
  if (errors.length > 0) return { kind: 'invalid', errors };

  // Fetch the source PDF bytes from our storage (OpenSign never holds our
  // creds — we hand it the bytes).
  const obj = await deps.storage.get(request.sourceFileKey);
  const pdfBytes = await streamToBuffer(obj.body);

  // OpenSign side effects FIRST. A throw here aborts before any local
  // write, leaving the request a clean draft (no rollback needed).
  const created = await createSignatureDocument(deps.client, {
    title: request.title,
    pdfBytes,
    signers: signers.map((s) => ({
      signerId: s.id,
      name: s.name,
      email: s.email,
      role: s.role,
      order: s.order,
    })),
    placements: placements.map((p) => ({
      signerId: p.signerId,
      fieldType: p.fieldType as PlacementInput['fieldType'],
      pageNumber: p.pageNumber,
      nx: p.nx,
      ny: p.ny,
      nw: p.nw,
      nh: p.nh,
      required: p.required,
    })),
    geometry: geometry!,
    sendInOrder: request.sendInOrder,
    // Align OpenSign's own document expiry with our signatureRequests.expiresAt
    // so the signing page and the Signatures page never disagree.
    expiresInDays: deps.expiresInDays ?? DEFAULT_EXPIRY_DAYS,
  });

  const expiresAt = new Date(
    now.getTime() + (deps.expiresInDays ?? DEFAULT_EXPIRY_DAYS) * 24 * 60 * 60 * 1000,
  );
  const contactBySigner = new Map(created.signers.map((s) => [s.signerId, s.opensignContactId]));

  // Persist the sent state. If a concurrent send already flipped the row,
  // the status guard inside the txn makes this a no-op (idempotent).
  await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ status: signatureRequests.status })
      .from(signatureRequests)
      .where(eq(signatureRequests.id, request.id))
      .for('update')
      .limit(1);
    if (!locked || locked.status !== 'draft') return;

    await tx
      .update(signatureRequests)
      .set({
        opensignDocumentId: created.opensignDocumentId,
        status: 'sent',
        signingMode: args.inPerson ? 'in_person' : 'remote',
        sentAt: now,
        expiresAt,
        updatedAt: now,
      })
      .where(eq(signatureRequests.id, request.id));

    for (const signer of signers) {
      const contactId = contactBySigner.get(signer.id);
      if (contactId) {
        await tx
          .update(signatureSigners)
          .set({ opensignSignerId: contactId })
          .where(eq(signatureSigners.id, signer.id));
      }
    }

    await tx.insert(signatureEvents).values({
      requestId: request.id,
      actor: args.actor,
      event: 'sent',
      detail: {
        opensignDocumentId: created.opensignDocumentId,
        signers: signers.length,
        signingMode: args.inPerson ? 'in_person' : 'remote',
      },
    });

    // In-person ID attestation — one append-only audit row per signer the
    // ERO verified (Pub 1345). No ID numbers are stored.
    if (args.inPerson) {
      for (const s of signers) {
        const idType = idBySigner.get(s.id);
        if (idType) {
          await tx.insert(signatureEvents).values({
            requestId: request.id,
            actor: args.actor,
            event: 'identity_verified',
            detail: {
              signerId: s.id,
              signerName: s.name,
              idType,
              method: 'in_person_photo_id',
            },
          });
        }
      }
    }
  });

  // Notify signers of their signing link (OpenSign sends nothing itself).
  // Parallel → all at once; sequential → only the first, the rest are
  // notified from reconcile as each completes. Best-effort: a mail failure
  // never undoes the committed send. In-person sends email NOTHING — the
  // client is in the office and signs on a device / via the QR sheet.
  if (deps.sendEmail && !args.inPerson) {
    const urlBySigner = new Map(created.signers.map((s) => [s.signerId, s.signingUrl]));
    const toNotify = request.sendInOrder ? signers.slice(0, 1) : signers;
    let notified = 0;
    for (const s of toNotify) {
      const url = urlBySigner.get(s.id);
      if (!url) continue;
      if (
        await notifySigner(deps.sendEmail, {
          to: s.email,
          name: s.name,
          title: request.title,
          signingUrl: url,
          db,
          firmId: request.firmId,
        })
      )
        notified += 1;
    }
    await db
      .insert(signatureEvents)
      .values({
        requestId: request.id,
        actor: 'system',
        event: 'signers_notified',
        detail: { notified, sequential: request.sendInOrder },
      })
      .catch(() => undefined);
  }

  return { kind: 'sent', opensignDocumentId: created.opensignDocumentId, expiresAt };
}

export type EnsureInOfficeOutcome =
  | { kind: 'ready'; signingUrlBySignerId: Record<string, string> }
  | { kind: 'not_found' }
  | { kind: 'no_source' }
  | { kind: 'terminal'; status: string }
  | { kind: 'invalid'; errors: ValidationError[] };

/**
 * Ensure the in-person OpenSign document exists for a request, WITHOUT the
 * all-signers attestation gate that sendSignatureRequest enforces. This backs
 * the QR scan flow: the document is created once (in-person, no email), and
 * per-signer photo-ID attestation is enforced separately at the public verify
 * step before that signer's signing URL is handed out — so a KBA-gated 1040
 * still can't be signed without in-person verification. Idempotent: a request
 * already sent just returns the existing per-signer signing URLs.
 */
export async function ensureInOfficeDocument(
  deps: SendDeps,
  args: { requestId: string; firmId: string; actor: string },
  now: Date = new Date(),
): Promise<EnsureInOfficeOutcome> {
  const { db } = deps;
  const [request] = await db
    .select()
    .from(signatureRequests)
    .where(eq(signatureRequests.id, args.requestId))
    .limit(1);
  if (!request || request.firmId !== args.firmId) return { kind: 'not_found' };

  const signers = await db
    .select()
    .from(signatureSigners)
    .where(eq(signatureSigners.requestId, request.id))
    .orderBy(signatureSigners.order);

  // Already live → return the existing per-signer signing URLs.
  if (request.status === 'sent' || request.status === 'partially_signed') {
    const map: Record<string, string> = {};
    if (request.opensignDocumentId) {
      for (const s of signers) {
        if (s.opensignSignerId) {
          map[s.id] = signerSigningUrl(
            deps.client.publicUrl,
            request.opensignDocumentId,
            s.opensignSignerId,
          );
        }
      }
    }
    return { kind: 'ready', signingUrlBySignerId: map };
  }
  if (request.status !== 'draft') return { kind: 'terminal', status: request.status };
  if (!request.sourceFileKey) return { kind: 'no_source' };

  const placements = await db
    .select()
    .from(signatureFieldPlacements)
    .where(eq(signatureFieldPlacements.requestId, request.id));
  const geometry = (request.pageGeometry as PageGeometry[] | null) ?? null;
  const errors = validatePlacements(
    signers.map((s) => s.id),
    placements.map((p) => ({
      signerId: p.signerId,
      fieldType: p.fieldType as PlacementInput['fieldType'],
      pageNumber: p.pageNumber,
      nx: p.nx,
      ny: p.ny,
      nw: p.nw,
      nh: p.nh,
      required: p.required,
    })),
    geometry,
  );
  if (errors.length > 0) return { kind: 'invalid', errors };

  const obj = await deps.storage.get(request.sourceFileKey);
  const pdfBytes = await streamToBuffer(obj.body);
  const created = await createSignatureDocument(deps.client, {
    title: request.title,
    pdfBytes,
    signers: signers.map((s) => ({
      signerId: s.id,
      name: s.name,
      email: s.email,
      role: s.role,
      order: s.order,
    })),
    placements: placements.map((p) => ({
      signerId: p.signerId,
      fieldType: p.fieldType as PlacementInput['fieldType'],
      pageNumber: p.pageNumber,
      nx: p.nx,
      ny: p.ny,
      nw: p.nw,
      nh: p.nh,
      required: p.required,
    })),
    geometry: geometry!,
    sendInOrder: request.sendInOrder,
    // Align OpenSign's own document expiry with our signatureRequests.expiresAt
    // so the signing page and the Signatures page never disagree.
    expiresInDays: deps.expiresInDays ?? DEFAULT_EXPIRY_DAYS,
  });

  const expiresAt = new Date(
    now.getTime() + (deps.expiresInDays ?? DEFAULT_EXPIRY_DAYS) * 24 * 60 * 60 * 1000,
  );
  const contactBySigner = new Map(created.signers.map((s) => [s.signerId, s.opensignContactId]));

  await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ status: signatureRequests.status })
      .from(signatureRequests)
      .where(eq(signatureRequests.id, request.id))
      .for('update')
      .limit(1);
    if (!locked || locked.status !== 'draft') return; // a concurrent ensure/send won
    await tx
      .update(signatureRequests)
      .set({
        opensignDocumentId: created.opensignDocumentId,
        status: 'sent',
        signingMode: 'in_person',
        sentAt: now,
        expiresAt,
        updatedAt: now,
      })
      .where(eq(signatureRequests.id, request.id));
    for (const signer of signers) {
      const contactId = contactBySigner.get(signer.id);
      if (contactId) {
        await tx
          .update(signatureSigners)
          .set({ opensignSignerId: contactId })
          .where(eq(signatureSigners.id, signer.id));
      }
    }
    await tx.insert(signatureEvents).values({
      requestId: request.id,
      actor: args.actor,
      event: 'sent',
      detail: {
        opensignDocumentId: created.opensignDocumentId,
        signers: signers.length,
        signingMode: 'in_person',
        via: 'qr_scan',
      },
    });
  });

  const map: Record<string, string> = {};
  for (const s of created.signers) map[s.signerId] = s.signingUrl;
  return { kind: 'ready', signingUrlBySignerId: map };
}
