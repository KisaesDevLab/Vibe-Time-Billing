// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Q35 — OpenSign completion poll (safety net for the webhook fast path).
//
// Every few minutes we select signatures still PENDING with an OpenSign
// envelope id, ask the sidecar for their status, and complete any that
// have been SIGNED out-of-band (e.g. a webhook delivery that never
// landed). Completion runs through the SAME completeOpenSignEnvelope the
// webhook uses, under a proposal FOR UPDATE lock, so the two paths
// serialize and a double completion is idempotent (no double freeze).
//
// Skips cleanly when OpenSign isn't configured (OPENSIGN_URL unset).

import { and, eq, isNotNull } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { signatures } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import { createOpenSignProvider, type EsignProvider } from '../../../api/src/esign/provider';
import { completeOpenSignEnvelope } from '../../../api/src/esign/opensign-complete';

export interface OpenSignPollResult {
  scanned: number;
  signed: number;
  errors: number;
}

const BATCH = 50;

export async function runOpenSignPollTick(
  db: Database,
  log: Logger,
  args: {
    storage: StorageClient | null;
    provider?: EsignProvider;
    hmacSeed?: string | null;
  },
): Promise<OpenSignPollResult> {
  const result: OpenSignPollResult = { scanned: 0, signed: 0, errors: 0 };

  const baseUrl = process.env['OPENSIGN_URL'];
  if (!baseUrl) {
    log.debug('opensign-poll: OPENSIGN_URL unset — skipping');
    return result;
  }
  if (!args.storage) {
    log.warn('opensign-poll: storage unavailable — skipping');
    return result;
  }
  const hmacSeed =
    args.hmacSeed ??
    process.env['PROPOSAL_SIGNATURE_HMAC_SEED'] ??
    process.env['PORTAL_JWT_SECRET'] ??
    null;
  if (!hmacSeed) {
    log.warn('opensign-poll: no HMAC seed configured — skipping');
    return result;
  }

  const provider =
    args.provider ??
    createOpenSignProvider({
      baseUrl,
      appId: process.env['OPENSIGN_APP_ID'] ?? 'opensign',
      masterKey: process.env['OPENSIGN_MASTER_KEY'] ?? '',
      publicUrl: process.env['OPENSIGN_PUBLIC_URL'],
      apiEmail: process.env['OPENSIGN_API_EMAIL'],
      apiPassword: process.env['OPENSIGN_API_PASSWORD'],
    });

  const pending = await db
    .select({
      id: signatures.id,
      envelopeId: signatures.opensignEnvelopeId,
    })
    .from(signatures)
    .where(
      and(
        eq(signatures.method, 'OPENSIGN'),
        eq(signatures.state, 'PENDING'),
        isNotNull(signatures.opensignEnvelopeId),
      ),
    )
    .limit(BATCH);
  result.scanned = pending.length;

  for (const row of pending) {
    const envelopeId = row.envelopeId!;
    try {
      const status = await provider.getStatus(envelopeId);
      if (status.status !== 'SIGNED') continue;
      const outcome = await completeOpenSignEnvelope(
        { db, provider, storage: args.storage, hmacSeed },
        envelopeId,
      );
      if (outcome.kind === 'advanced') result.signed += 1;
    } catch (err) {
      result.errors += 1;
      log.warn({ err, envelopeId }, 'opensign-poll: completion failed');
    }
  }

  return result;
}
