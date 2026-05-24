// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Stage 3 — pay-to-unlock file promotion. Called from both the Stripe
// webhook (charge.succeeded) and POST /payments/receive (manual
// payment receipt). When an invoice is marked paid we flip every
// `escrow` file gated by that invoice to `client_visible` and stamp
// promoted_at; on refund/void we revert.
//
// Uses an in-transaction caller-supplied query handle so the file
// flip lands atomically with the payment write.

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { fileVisibilityEvents, files } from '@vibe/db/schema';

import { logger } from '../logger';

type TxOrDb = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Flip every escrow file gated by `invoiceId` to client_visible. Idempotent:
 * already-promoted files are skipped. Returns the list of file ids that
 * actually changed visibility.
 */
export async function promoteEscrowFilesForInvoice(
  tx: TxOrDb,
  args: { firmId: string; invoiceId: string; actorAppUserId?: string | null },
): Promise<string[]> {
  const candidates = await tx
    .select({ id: files.id, visibility: files.visibility })
    .from(files)
    .where(and(eq(files.invoiceId, args.invoiceId), eq(files.firmId, args.firmId)));
  const toPromote = candidates.filter((r) => r.visibility === 'escrow').map((r) => r.id);
  if (toPromote.length === 0) return [];

  await tx
    .update(files)
    .set({
      visibility: 'client_visible',
      promotedAt: new Date(),
      modifiedAt: new Date(),
    })
    .where(and(eq(files.invoiceId, args.invoiceId), eq(files.visibility, 'escrow')));

  for (const fileId of toPromote) {
    await tx.insert(fileVisibilityEvents).values({
      fileId,
      firmId: args.firmId,
      oldValue: 'escrow',
      newValue: 'client_visible',
      changedBy: args.actorAppUserId ?? null,
      reason: `invoice ${args.invoiceId} paid; auto-promote`,
    });
  }
  logger.info(
    { invoiceId: args.invoiceId, count: toPromote.length },
    'escrow files promoted to client_visible',
  );
  return toPromote;
}

/**
 * Revert: flip previously-promoted files (visibility=client_visible,
 * still tagged with invoice_id and a promoted_at) back to escrow when
 * the invoice is refunded or voided. Files manually flipped to
 * client_visible (no invoice_id) are untouched.
 */
export async function revertEscrowFilesForInvoice(
  tx: TxOrDb,
  args: { firmId: string; invoiceId: string; actorAppUserId?: string | null },
): Promise<string[]> {
  const candidates = await tx
    .select({ id: files.id, visibility: files.visibility, promotedAt: files.promotedAt })
    .from(files)
    .where(and(eq(files.invoiceId, args.invoiceId), eq(files.firmId, args.firmId)));
  const toRevert = candidates
    .filter((r) => r.visibility === 'client_visible' && r.promotedAt != null)
    .map((r) => r.id);
  if (toRevert.length === 0) return [];

  await tx
    .update(files)
    .set({ visibility: 'escrow', promotedAt: null, modifiedAt: new Date() })
    .where(and(eq(files.invoiceId, args.invoiceId), eq(files.visibility, 'client_visible')));

  for (const fileId of toRevert) {
    await tx.insert(fileVisibilityEvents).values({
      fileId,
      firmId: args.firmId,
      oldValue: 'client_visible',
      newValue: 'escrow',
      changedBy: args.actorAppUserId ?? null,
      reason: `invoice ${args.invoiceId} refunded/voided; auto-revert`,
    });
  }
  logger.info(
    { invoiceId: args.invoiceId, count: toRevert.length },
    'previously-promoted escrow files reverted',
  );
  return toRevert;
}
