// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
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
import { validatePlacements, type PlacementInput, type ValidationError } from './validation';

const DEFAULT_EXPIRY_DAYS = 30;

export interface SendDeps {
  db: Database;
  storage: StorageClient;
  client: OpenSignClient;
  /** Days until the request expires (default 30). */
  expiresInDays?: number;
}

export type SendOutcome =
  | { kind: 'sent'; opensignDocumentId: string; expiresAt: Date }
  | { kind: 'not_found' }
  | { kind: 'not_draft'; status: string }
  | { kind: 'no_source' }
  | { kind: 'invalid'; errors: ValidationError[] };

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
  args: { requestId: string; firmId: string; actor: string },
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
      detail: { opensignDocumentId: created.opensignDocumentId, signers: signers.length },
    });
  });

  return { kind: 'sent', opensignDocumentId: created.opensignDocumentId, expiresAt };
}
