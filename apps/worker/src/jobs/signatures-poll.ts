// SPDX-License-Identifier: Elastic-2.0
//
// Phase 7 — Signatures module completion poll (safety net for the webhook)
// + expiry sweep.
//
// Every few minutes we select signature_requests still awaiting signatures
// (sent / partially_signed) that carry an opensign_document_id, ask
// OpenSign for the authoritative document, and reconcile through the SAME
// reconcileSignatureRequestByDocument the webhook uses (so the two paths
// can't diverge; reconcile locks the row FOR UPDATE and is idempotent).
// Past-expiry requests are flipped to 'expired' in the same pass.
//
// Skips cleanly when OpenSign isn't configured (OPENSIGN_URL unset).

import { and, inArray, isNotNull } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { signatureRequests } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import { openSignClientFromEnv } from '../../../api/src/esign/opensign-client';
import {
  reconcileSignatureRequestByDocument,
  expireSignatureRequestIfDue,
} from '../../../api/src/signatures/reconcile';

export interface SignaturesPollResult {
  scanned: number;
  updated: number;
  expired: number;
  errors: number;
}

const BATCH = 50;

export async function runSignaturesPollTick(
  db: Database,
  log: Logger,
  args: { storage: StorageClient | null },
  now: Date = new Date(),
): Promise<SignaturesPollResult> {
  const result: SignaturesPollResult = { scanned: 0, updated: 0, expired: 0, errors: 0 };

  const client = openSignClientFromEnv();
  if (!client) {
    log.debug('signatures-poll: OPENSIGN_URL unset — skipping');
    return result;
  }
  if (!args.storage) {
    log.warn('signatures-poll: storage unavailable — skipping');
    return result;
  }

  const pending = await db
    .select({
      id: signatureRequests.id,
      documentId: signatureRequests.opensignDocumentId,
    })
    .from(signatureRequests)
    .where(
      and(
        inArray(signatureRequests.status, ['sent', 'partially_signed']),
        isNotNull(signatureRequests.opensignDocumentId),
      ),
    )
    .limit(BATCH);
  result.scanned = pending.length;

  for (const row of pending) {
    const documentId = row.documentId!;
    try {
      const outcome = await reconcileSignatureRequestByDocument(
        { db, client, storage: args.storage },
        documentId,
        now,
      );
      if (outcome.kind === 'updated') {
        result.updated += 1;
        // If it didn't reach a terminal state, it may still expire.
        if (outcome.status === 'sent' || outcome.status === 'partially_signed') {
          if (await expireSignatureRequestIfDue(db, row.id, now)) result.expired += 1;
        }
      } else if (await expireSignatureRequestIfDue(db, row.id, now)) {
        result.expired += 1;
      }
    } catch (err) {
      result.errors += 1;
      log.warn({ err, documentId }, 'signatures-poll: reconcile failed');
    }
  }

  return result;
}
