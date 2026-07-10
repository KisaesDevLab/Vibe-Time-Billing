// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Q35 — OpenSign webhook (fast-path async completion).
//
// The AGPL OpenSign instance signs in its own UI; completion arrives here
// as an HMAC-signed webhook (and, as a safety net, the worker poll — see
// apps/worker/src/jobs/opensign-poll.ts). Both call the SAME
// completeOpenSignEnvelope under a proposal FOR UPDATE lock so they
// serialize and never double-freeze.
//
// Real OpenSign self-host webhook contract (configured in the OpenSign UI
// Settings → Webhook; verified against a running v2.37.0 instance):
//   - header `x-webhook-signature` = HMAC-SHA256(hex) of the RAW body,
//     secret = the 64-char "Webhook Security Key" minted in that UI.
//   - JSON body fields: `event` (created|viewed|signed|completed|declined),
//     `objectId` (the document id), `file` (signed PDF URL), `certificate`
//     (audit-cert URL, on completed), `signers[]`, `signer`/`signedAt`
//     (on signed), `declinedBy`/`declinedReason` (on declined).
//
// Security + correctness:
//   - express.raw body; HMAC-SHA256 over the raw bytes against
//     OPENSIGN_WEBHOOK_SECRET, constant-time compared (401 on mismatch).
//   - Idempotency: OpenSign sends no unique event id, so we synthesize a
//     stable key from `${objectId}:${event}:${signedAt|signer|''}` and
//     store it in opensign_webhook_events. A redelivery is a no-op.
//   - The objectId MUST map to a real signatures row (ownership check);
//     unknown documents are acknowledged + ignored (not an error — avoids
//     retries for events about documents we don't track).
//   - completed → fetch+store cert + advanceSignatureToSigned.
//   - declined  → row DECLINED + proposal IN_PROGRESS (reuses the
//     staff-recoverable decline semantics).
//   - Every mutation is audited.

import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { magicLinks, opensignWebhookEvents, proposals, signatures } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import { emitAudit } from '../auth/audit';
import { logger } from '../logger';
import { completeOpenSignEnvelope } from '../esign/opensign-complete';
import { type SendProposalEmail } from '../proposals/magic-links';
import type { EsignProvider } from '../esign/provider';
import type { OpenSignClient } from '../esign/opensign-client';
import { reconcileSignatureRequestByDocument } from '../signatures/reconcile';
import type { PrintQueue } from '../print-gateway/queue';

export interface OpenSignWebhookDeps {
  db: Database | null;
  // Provider + storage are only needed for the completed path. Null when
  // OpenSign isn't configured (the route then 503s).
  provider: EsignProvider | null;
  storage: StorageClient | null;
  webhookSecret: string | null;
  hmacSeed: string | null;
  sendProposalEmail?: SendProposalEmail;
  portalBaseUrl?: string;
  // Signatures module (0108): low-level client used to reconcile
  // signature_requests by document id. The document-id space is disjoint
  // from proposal envelope ids, so this never collides with the proposal
  // completion path. Null when OpenSign isn't wired.
  openSignClient?: OpenSignClient | null;
  // 0185 — enqueue signature-confirmation auto-print on completion.
  // Optional/injectable so tests run without Redis (default = skip).
  printQueue?: PrintQueue;
}

// Real OpenSign self-host webhook payload (Settings → Webhook).
interface OpenSignWebhookEvent {
  event: string;
  objectId: string;
  file?: string;
  certificate?: string;
  signer?: string | { Email?: string };
  signedAt?: string;
  signers?: Array<{ Email?: string; objectId?: string }>;
  declinedBy?: string;
  declinedReason?: string | null;
}

// Stable idempotency key. OpenSign sends no unique event id, so we derive
// one from the document + event + a per-delivery discriminator.
function idempotencyKey(e: OpenSignWebhookEvent): string {
  const signer = typeof e.signer === 'string' ? e.signer : (e.signer?.Email ?? '');
  const disc = e.signedAt ?? signer ?? '';
  return `${e.objectId}:${e.event}:${disc}`;
}

function verifyHmac(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
  // TODO(security): no replay-window; the OpenSign signature covers only the
  // raw body (no timestamp), so we rely on event-id idempotency instead.
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  // Normalize an optional "sha256=" prefix some senders use.
  const claimed = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(claimed, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createOpenSignWebhookRouter(deps: OpenSignWebhookDeps): Router {
  const router = express.Router();
  // OpenSign needs the raw body to verify the HMAC.
  router.use(express.raw({ type: '*/*', limit: '2mb' }));

  router.post('/', async (req: Request, res: Response) => {
    if (!deps.db || !deps.webhookSecret) {
      res.status(503).json({ error: 'opensign_not_configured' });
      return;
    }
    // Real OpenSign self-host header (Settings → Webhook). Fall back to
    // the legacy names so a mixed deploy still verifies.
    const signatureHeader =
      req.header('x-webhook-signature') ??
      req.header('x-opensign-signature') ??
      req.header('x-signature') ??
      '';
    if (!signatureHeader) {
      res.status(400).json({ error: 'missing_signature' });
      return;
    }
    const rawBody = req.body instanceof Buffer ? req.body : Buffer.from(String(req.body));
    if (!verifyHmac(rawBody, signatureHeader, deps.webhookSecret)) {
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }

    let event: OpenSignWebhookEvent;
    try {
      event = JSON.parse(rawBody.toString('utf8')) as OpenSignWebhookEvent;
    } catch {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    if (!event.event || !event.objectId) {
      res.status(400).json({ error: 'invalid_event' });
      return;
    }

    const envelopeId = event.objectId;
    const eventKey = idempotencyKey(event);

    // Idempotency: claim the synthesized key. A redelivery finds the row
    // already present and we short-circuit.
    const inserted = await deps.db
      .insert(opensignWebhookEvents)
      .values({
        opensignEventId: eventKey,
        eventType: event.event,
        envelopeId,
        payload: event as unknown as Record<string, unknown>,
      })
      .onConflictDoNothing({ target: opensignWebhookEvents.opensignEventId })
      .returning({ id: opensignWebhookEvents.opensignEventId });
    if (inserted.length === 0) {
      // Already seen — no-op.
      res.json({ received: true, duplicate: true });
      return;
    }

    try {
      const handled = await dispatch(deps, event, envelopeId);
      await deps.db
        .update(opensignWebhookEvents)
        .set({ state: handled, processedAt: new Date() })
        .where(eq(opensignWebhookEvents.opensignEventId, eventKey));
    } catch (err) {
      logger.error({ err, eventKey, type: event.event }, 'opensign webhook failed');
      await deps.db
        .update(opensignWebhookEvents)
        .set({ state: 'FAILED', lastError: String(err) })
        .where(eq(opensignWebhookEvents.opensignEventId, eventKey))
        .catch(() => undefined);
      // 5xx so the sidecar retries (the poll fallback also covers it).
      res.status(500).json({ error: 'dispatch_failed' });
      return;
    }
    res.json({ received: true });
  });

  return router;
}

/**
 * Returns the webhook_event state to record: 'PROCESSED' when we acted,
 * 'IGNORED' when the event is about an envelope we don't track or an
 * event type we don't handle.
 */
async function dispatch(
  deps: OpenSignWebhookDeps,
  event: OpenSignWebhookEvent,
  envelopeId: string | null,
): Promise<'PROCESSED' | 'IGNORED'> {
  const db = deps.db!;
  if (!envelopeId) return 'IGNORED';

  // Signatures module first (0108): the document-id space is disjoint from
  // proposal envelope ids, so a match here means this is a Signatures
  // request and we're done. We always re-fetch the authoritative document
  // inside reconcile rather than trusting the webhook payload.
  if (deps.openSignClient && deps.storage) {
    try {
      const r = await reconcileSignatureRequestByDocument(
        {
          db,
          client: deps.openSignClient,
          storage: deps.storage,
          // Reuse the configured mailer to hand off to the next sequential
          // signer, and to send the client a completion confirmation.
          notify: deps.sendProposalEmail,
          sendEmail: deps.sendProposalEmail,
        },
        envelopeId,
      );
      if (r.kind === 'updated') {
        await emitAudit(db, {
          action: 'UPDATE',
          entityType: 'signature_request.reconciled',
          entityId: r.requestId,
          after: {
            status: r.status,
            signedCount: r.signedCount,
            documentId: envelopeId,
            via: 'webhook',
          },
        }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
        // 0185 — auto-print a signature confirmation report on completion.
        // The worker consumer no-ops unless this is a tax-return signature
        // and the firm has the gateway + auto-print enabled.
        if (r.status === 'completed' && deps.printQueue) {
          await deps.printQueue
            .signatureConfirmation({ requestId: r.requestId })
            .catch((err: unknown) => logger.error({ err }, 'sig confirmation enqueue failed'));
        }
        return 'PROCESSED';
      }
      if (r.reason !== 'unknown_document') {
        // It IS a signatures request (terminal/no-change) — don't fall
        // through to the proposal path for the same id.
        return 'IGNORED';
      }
    } catch (err) {
      logger.error({ err, envelopeId }, 'signatures reconcile failed');
      // Fall through: if it wasn't ours, the proposal path may handle it.
    }
  }

  switch (event.event) {
    case 'completed': {
      if (!deps.provider || !deps.storage || !deps.hmacSeed) {
        throw new Error('opensign_completion_deps_unconfigured');
      }
      const outcome = await completeOpenSignEnvelope(
        {
          db,
          provider: deps.provider,
          storage: deps.storage,
          hmacSeed: deps.hmacSeed,
          sendProposalEmail: deps.sendProposalEmail,
          portalBaseUrl: deps.portalBaseUrl,
        },
        envelopeId,
      );
      if (outcome.kind === 'ignored') return 'IGNORED';
      await emitAudit(db, {
        action: 'UPDATE',
        entityType:
          outcome.result.kind === 'final'
            ? 'proposal.opensign_accepted'
            : 'signature.opensign_signed',
        entityId: outcome.signatureId,
        after:
          outcome.result.kind === 'final'
            ? {
                status: 'ACCEPTED',
                envelopeId,
                signatureIds: outcome.result.signatureIds,
                engagementId: outcome.result.engagementId,
              }
            : { state: 'SIGNED', envelopeId, remaining: outcome.result.remaining },
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      return 'PROCESSED';
    }
    case 'declined': {
      return declineEnvelope(db, envelopeId, event.declinedReason ?? null);
    }
    default:
      // created / viewed / signed (partial) — no terminal state change.
      logger.debug({ type: event.event }, 'unhandled opensign event');
      return 'IGNORED';
  }
}

/**
 * envelope.declined → set the signer row DECLINED + proposal IN_PROGRESS
 * (staff-recoverable; never DECLINED), and supersede that signer's
 * outstanding links — mirrors the portal decline path.
 */
async function declineEnvelope(
  db: Database,
  envelopeId: string,
  reason: string | null,
): Promise<'PROCESSED' | 'IGNORED'> {
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [sig] = await tx
      .select()
      .from(signatures)
      .where(eq(signatures.opensignEnvelopeId, envelopeId))
      .limit(1);
    if (!sig || sig.method !== 'OPENSIGN') return null;
    if (sig.state !== 'PENDING') return sig.id; // idempotent — nothing to do
    await tx
      .update(signatures)
      .set({ state: 'DECLINED', declinedAt: now, declinedReason: reason })
      .where(eq(signatures.id, sig.id));
    await tx
      .update(proposals)
      .set({ status: 'IN_PROGRESS', updatedAt: now })
      .where(eq(proposals.id, sig.proposalId));
    await tx
      .update(magicLinks)
      .set({ supersededAt: now })
      .where(and(eq(magicLinks.signatureId, sig.id), isNull(magicLinks.supersededAt)));
    return sig.id;
  });
  if (!result) return 'IGNORED';
  await emitAudit(db, {
    action: 'UPDATE',
    entityType: 'signature.declined',
    entityId: result,
    after: { state: 'DECLINED', proposalStatus: 'IN_PROGRESS', envelopeId, via: 'opensign' },
  }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
  return 'PROCESSED';
}
