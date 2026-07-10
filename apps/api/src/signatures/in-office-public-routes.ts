// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Public (no-login) in-office signing surface. A printed QR encodes
// `${PORTAL_BASE_URL}/in-office/<token>`; the portal page calls these
// endpoints. The token (HMAC, per signer) is the only credential.
//
//   GET  /api/public/in-office/:token          → meta for the verify screen
//   POST /api/public/in-office/:token/verify    → record the signer's photo-ID
//        attestation (required for KBA 1040s), ensure the signing document
//        exists, and return THAT signer's signing URL.
//
// Per-signer compliance: a KBA-gated 1040's signing URL is only handed back
// after this signer's in-person photo-ID attestation is recorded here — so the
// document can be created once without all attestations up front.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { signatureEvents, signatureRequests, signatureSigners } from '@vibe/db/schema';
import { buildStorageClient, type StorageClient } from '@vibe/storage';

import { openSignClientFromEnv, type OpenSignClient } from '../esign/opensign-client';
import { logger } from '../logger';
import { ensureInOfficeDocument } from './send';
import { formRequiresKba } from './profiles';
import { verifyInOfficeToken } from './in-office-token';

export interface InOfficePublicDeps {
  db: Database | null;
  storageClient?: StorageClient;
  openSignClient?: OpenSignClient;
  expiresInDays?: number;
}

const TERMINAL = new Set(['completed', 'declined', 'expired', 'voided']);

export function createInOfficePublicRouter(deps: InOfficePublicDeps): Router {
  const router = express.Router();

  function getStorage(): StorageClient | null {
    if (deps.storageClient) return deps.storageClient;
    try {
      return buildStorageClient(process.env);
    } catch {
      return null;
    }
  }
  function getOpenSign(): OpenSignClient | null {
    return deps.openSignClient ?? openSignClientFromEnv();
  }

  async function resolve(token: string): Promise<
    | {
        ok: true;
        request: typeof signatureRequests.$inferSelect;
        signer: typeof signatureSigners.$inferSelect;
      }
    | { ok: false; status: number; error: string }
  > {
    const t = verifyInOfficeToken(token);
    if (!t) return { ok: false, status: 404, error: 'invalid_token' };
    if (!deps.db) return { ok: false, status: 503, error: 'db_unavailable' };
    const [request] = await deps.db
      .select()
      .from(signatureRequests)
      .where(eq(signatureRequests.id, t.requestId))
      .limit(1);
    if (!request) return { ok: false, status: 404, error: 'not_found' };
    const [signer] = await deps.db
      .select()
      .from(signatureSigners)
      .where(and(eq(signatureSigners.id, t.signerId), eq(signatureSigners.requestId, request.id)))
      .limit(1);
    if (!signer) return { ok: false, status: 404, error: 'not_found' };
    return { ok: true, request, signer };
  }

  // Meta for the verify screen.
  router.get('/:token', async (req: Request, res: Response) => {
    const r = await resolve(req.params['token']!);
    if (!r.ok) {
      res.status(r.status).json({ error: r.error });
      return;
    }
    res.json({
      signerName: r.signer.name,
      documentTitle: r.request.title,
      formType: r.request.formType,
      requiresAttestation: formRequiresKba(r.request.formType),
      signerStatus: r.signer.status,
      requestStatus: r.request.status,
      terminal: TERMINAL.has(r.request.status),
    });
  });

  // Verify the signer (record the in-person attestation when required) and
  // hand back this signer's signing URL.
  router.post('/:token/verify', async (req: Request, res: Response) => {
    const r = await resolve(req.params['token']!);
    if (!r.ok) {
      res.status(r.status).json({ error: r.error });
      return;
    }
    const { request, signer } = r;
    if (TERMINAL.has(request.status)) {
      res.status(409).json({ error: 'request_terminal', status: request.status });
      return;
    }
    const requiresAttestation = formRequiresKba(request.formType);
    const idType =
      typeof (req.body as { idType?: unknown })?.idType === 'string'
        ? ((req.body as { idType: string }).idType ?? '').trim()
        : '';
    if (requiresAttestation && !idType) {
      res.status(400).json({ error: 'identity_required' });
      return;
    }

    // Append-only attestation for this signer (Pub 1345; no ID numbers).
    if (requiresAttestation && deps.db) {
      await deps.db
        .insert(signatureEvents)
        .values({
          requestId: request.id,
          actor: `signer:${signer.id}`,
          event: 'identity_verified',
          detail: {
            signerId: signer.id,
            signerName: signer.name,
            idType,
            method: 'in_person_photo_id',
            via: 'qr_scan',
          },
        })
        .catch((err: unknown) => logger.warn({ err }, 'in-office verify: event insert failed'));
    }

    const storage = getStorage();
    const client = getOpenSign();
    if (!deps.db || !storage || !client) {
      res.status(503).json({ error: 'signing_unavailable' });
      return;
    }
    const outcome = await ensureInOfficeDocument(
      { db: deps.db, storage, client, expiresInDays: deps.expiresInDays },
      { requestId: request.id, firmId: request.firmId, actor: `signer:${signer.id}` },
    );
    if (outcome.kind !== 'ready') {
      res.status(409).json({ error: outcome.kind });
      return;
    }
    const signingUrl = outcome.signingUrlBySignerId[signer.id];
    if (!signingUrl) {
      res.status(409).json({ error: 'no_signing_url' });
      return;
    }
    res.json({ signingUrl });
  });

  return router;
}
