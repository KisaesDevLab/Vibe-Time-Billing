// SPDX-License-Identifier: Elastic-2.0
//
// P16 — Signature HMAC verification staff route.
//
// Mounted at /api/staff/signatures. The actual signature row creation
// flow (which writes the hmac_signature column) lands with P21
// acceptance + P15 OpenSign. This route is the verification half — a
// firm can post-hoc verify any signature row against its stored
// hmac_signature to detect tampering.
//
//   GET /api/staff/signatures/:id/verify
//     Loads the signature, derives the per-firm HMAC key, recomputes
//     the canonical-record HMAC, compares against stored hmac_signature.
//     Returns { ok, expected, actual, signature: {...selected fields} }
//     so the firm UI can show what was checked.
//
// We also expose:
//   POST /api/staff/signatures/:id/attach-hmac
//     Convenience for the future P21 acceptance handler to back-fill
//     hmac_signature on a row that doesn't have one yet. Requires
//     signature.state === 'SIGNED' and hmac_signature is currently
//     NULL — we never overwrite a stored HMAC.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { proposals, signatures } from '@vibe/db/schema';
import {
  computeSignatureHmac,
  deriveFirmHmacKey,
  verifySignatureHmac,
  type SignatureRecord,
} from '@vibe/core/proposals/server';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface SignatureVerifyDeps extends RbacDeps {
  db: Database | null;
  hmacSeed: string | null;
}

function dbRowToRecord(row: typeof signatures.$inferSelect): SignatureRecord {
  return {
    id: row.id,
    proposalId: row.proposalId,
    role: row.role,
    sequence: row.sequence,
    signerName: row.signerName,
    signerEmail: row.signerEmail,
    signerPhone: row.signerPhone,
    signerIp: row.signerIp,
    signerUa: row.signerUa,
    // method is nullable on PENDING roster rows (0097); a verifiable
    // signature is always SIGNED with a method set, so '' is unreachable
    // here and keeps the HMAC record shape stable.
    method: row.method ?? '',
    state: row.state,
    typedName: row.typedName,
    signatureSvg: row.signatureSvg,
    opensignEnvelopeId: row.opensignEnvelopeId,
    opensignCertificateObjectKey: row.opensignCertificateObjectKey,
    payloadHash: row.payloadHash,
    signedAt: row.signedAt?.toISOString() ?? null,
    declinedAt: row.declinedAt?.toISOString() ?? null,
    declinedReason: row.declinedReason,
  };
}

export function createSignatureVerifyRouter(deps: SignatureVerifyDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get(
    '/:id/verify',
    requirePermission(deps, 'proposal:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      if (!deps.hmacSeed) {
        res.status(503).json({ error: 'hmac_seed_not_configured' });
        return;
      }
      // Verify firm scope by joining through proposals.
      const rows = await deps.db
        .select({ sig: signatures, proposalFirmId: proposals.firmId })
        .from(signatures)
        .innerJoin(proposals, eq(proposals.id, signatures.proposalId))
        .where(eq(signatures.id, req.params['id']!))
        .limit(1);
      const row = rows[0];
      if (!row || row.proposalFirmId !== session.firmId) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const key = deriveFirmHmacKey(deps.hmacSeed, session.firmId);
      const record = dbRowToRecord(row.sig);
      const result = verifySignatureHmac(record, key, row.sig.hmacSignature);
      res.json({
        ok: result.ok,
        expected: result.expected,
        actual: result.actual,
        signature: {
          id: row.sig.id,
          proposalId: row.sig.proposalId,
          state: row.sig.state,
          signedAt: row.sig.signedAt,
          method: row.sig.method,
          signerName: row.sig.signerName,
        },
      });
    },
  );

  router.post(
    '/:id/attach-hmac',
    requirePermission(deps, 'proposal:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      if (!deps.hmacSeed) {
        res.status(503).json({ error: 'hmac_seed_not_configured' });
        return;
      }
      const rows = await deps.db
        .select({ sig: signatures, proposalFirmId: proposals.firmId })
        .from(signatures)
        .innerJoin(proposals, eq(proposals.id, signatures.proposalId))
        .where(eq(signatures.id, req.params['id']!))
        .limit(1);
      const row = rows[0];
      if (!row || row.proposalFirmId !== session.firmId) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.sig.state !== 'SIGNED') {
        res.status(409).json({ error: 'not_signed', state: row.sig.state });
        return;
      }
      if (row.sig.hmacSignature != null) {
        res.status(409).json({ error: 'already_has_hmac' });
        return;
      }
      const key = deriveFirmHmacKey(deps.hmacSeed, session.firmId);
      const record = dbRowToRecord(row.sig);
      const hmac = computeSignatureHmac(record, key);
      await deps.db
        .update(signatures)
        .set({ hmacSignature: hmac })
        .where(and(eq(signatures.id, row.sig.id)));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'signature.hmac',
        entityId: row.sig.id,
        actorAppUserId: session.appUserId,
        after: { hmacSignature: hmac.slice(0, 12) + '…' }, // truncated for the log
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, hmacSignature: hmac });
    },
  );

  return router;
}
