// SPDX-License-Identifier: Elastic-2.0
//
// Phase 2 — Signatures module document creation against OpenSign.
//
// The proposal flow creates single-signer, field-less envelopes. This
// module's envelopes are arbitrary PDFs with MULTIPLE signers and
// drag-placed FIELDS (Placeholders). It reuses the SAME low-level
// OpenSign client (no duplicate Parse plumbing) and the one coordinate
// adapter (toOpenSignPlaceholder) — so the PDF-point coordinate math lives
// in exactly one place.
//
// Flow (all under the operator session):
//   1. savefile(pdf)                      → source URL
//   2. savecontact(per signer)            → contracts_Contactbook ids
//   3. toOpenSignPlaceholder(...)         → Placeholders (PDF points)
//   4. createdocumentfromapp({Signers, Placeholders, ...}) → document id
//
// Returns the document id + a per-signer signing URL so the request row
// and signer rows can be persisted by the caller (the send pipeline owns
// the transaction + rollback — this function performs no DB writes).

import type { OpenSignClient } from '../esign/opensign-client';
import type { PageGeometry } from './geometry';
import { toOpenSignPlaceholder, type AdapterPlacement, type FieldType } from './adapter';

// Per-signer highlight colors for the OpenSign editor (cycled). Distinct,
// high-contrast hues so multi-signer fields are visually separable.
const SIGNER_COLORS = ['#0a5ad4', '#cc2d2d', '#1f9c4d', '#9436c4', '#d98300', '#0a8f96'];

export interface CreateSignatureDocumentSigner {
  /** Our signer row id (matches placement.signerId). */
  signerId: string;
  name: string;
  email: string;
  role?: string | null;
  phone?: string | null;
  /** 1-based signing order (only meaningful when sendInOrder). */
  order?: number;
}

export interface CreateSignatureDocumentInput {
  title: string;
  /** Raw source PDF bytes (already MFK-decrypted by the caller if needed). */
  pdfBytes: Buffer | Uint8Array;
  signers: CreateSignatureDocumentSigner[];
  placements: Array<{
    signerId: string;
    fieldType: FieldType;
    pageNumber: number;
    nx: number;
    ny: number;
    nw: number;
    nh: number;
    required?: boolean;
  }>;
  geometry: PageGeometry[];
  sendInOrder?: boolean;
  /** Days the signer has to complete — sets OpenSign's TimeToCompleteDays so
   *  its expiry matches our signatureRequests.expiresAt (default 30). */
  expiresInDays?: number;
}

export interface CreatedSignatureSigner {
  signerId: string;
  opensignContactId: string;
  signingUrl: string;
}

export interface CreateSignatureDocumentResult {
  opensignDocumentId: string;
  signers: CreatedSignatureSigner[];
}

function safeFileName(title: string): string {
  return `${title.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'document'}.pdf`;
}

/**
 * Create a multi-signer, field-placed OpenSign document. Performs only
 * OpenSign side effects (file/contact/document) — NO local DB writes, so
 * the caller's send transaction can roll back its own rows on any failure
 * without leaving half-written state on our side.
 */
export async function createSignatureDocument(
  client: OpenSignClient,
  input: CreateSignatureDocumentInput,
): Promise<CreateSignatureDocumentResult> {
  if (input.signers.length === 0) throw new Error('signature_document_no_signers');

  const ctx = await client.ensureSession();

  // 1. Upload the source PDF.
  const base64 = Buffer.from(input.pdfBytes).toString('base64');
  const upload = await client.saveFile({ base64, fileName: safeFileName(input.title) });

  // 2. Resolve a contact per signer (sequentially — savecontact is
  //    idempotent by email and we want stable ordering for colors/order).
  const resolved: Array<{
    signer: CreateSignatureDocumentSigner;
    opensignContactId: string;
    color: string;
  }> = [];
  for (let i = 0; i < input.signers.length; i++) {
    const signer = input.signers[i]!;
    const contact = await client.saveContact({
      name: signer.name,
      email: signer.email,
      phone: signer.phone ?? undefined,
    });
    resolved.push({
      signer,
      opensignContactId: contact.objectId,
      color: SIGNER_COLORS[i % SIGNER_COLORS.length]!,
    });
  }

  // 3. Build Placeholders via the single coordinate adapter.
  const placeholders = toOpenSignPlaceholder(
    resolved.map((r) => ({
      signerId: r.signer.signerId,
      opensignContactId: r.opensignContactId,
      role: r.signer.role ?? undefined,
      color: r.color,
    })),
    input.placements as AdapterPlacement[],
    input.geometry,
  );

  // 4. Create the document with multi-signer pointers + placeholders.
  const document = {
    Name: input.title,
    URL: upload.url,
    ExtUserPtr: client.ptr('contracts_Users', ctx.extUserId),
    CreatedBy: client.ptr('_User', ctx.userId),
    SendinOrder: input.sendInOrder ?? false,
    SentToOthers: true,
    IsEnableOTP: false,
    Signers: resolved.map((r) => client.ptr('contracts_Contactbook', r.opensignContactId)),
    Placeholders: placeholders,
    DocSentAt: { __type: 'Date', iso: new Date().toISOString() },
    // Without this, OpenSign applies its own ~15-day default and the signing
    // page shows an earlier expiry than our Signatures page.
    TimeToCompleteDays: input.expiresInDays ?? 30,
  };
  const created = (await client.callFn('createdocumentfromapp', { document }, 'session')) as {
    objectId?: string;
  };
  const opensignDocumentId = String(created?.objectId ?? '');
  if (!opensignDocumentId) throw new Error('opensign_createdocument_failed: no objectId');

  return {
    opensignDocumentId,
    signers: resolved.map((r) => ({
      signerId: r.signer.signerId,
      opensignContactId: r.opensignContactId,
      // OpenSign UI signing route (same shape the proposal provider uses).
      signingUrl: `${client.publicUrl}/load/recipientSignPdf/${opensignDocumentId}/${r.opensignContactId}`,
    })),
  };
}
