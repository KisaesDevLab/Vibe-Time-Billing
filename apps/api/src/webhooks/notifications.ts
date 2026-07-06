// SPDX-License-Identifier: Elastic-2.0
//
// Connect H.8 follow-up — receive delivery callbacks from mail + SMS
// providers and update notification_log.status from 'sent' to
// 'delivered' / 'bounced' / 'complained' / 'opened' / 'failed'.
//
// Three receivers, one router:
//   POST /api/webhooks/notifications/postmark   — Postmark
//   POST /api/webhooks/notifications/resend     — Resend
//   POST /api/webhooks/notifications/twilio     — Twilio (SMS)
//
// Each receiver:
//   1. Verifies a shared-secret header (env var per provider). 401 on
//      mismatch.
//   2. Parses the provider-specific event shape.
//   3. Looks up the notification_log row by provider_message_id.
//   4. Updates status + delivery_updated_at. Idempotent — bumping
//      'delivered' twice is a no-op.
//
// Status mapping (provider → notification_log.status):
//   Postmark Delivery     → delivered
//   Postmark Bounce       → bounced
//   Postmark SpamComplaint → complained
//   Postmark Open         → opened
//   Resend  email.delivered → delivered
//   Resend  email.bounced  → bounced
//   Resend  email.complained → complained
//   Resend  email.opened   → opened
//   Twilio  MessageStatus=delivered → delivered
//   Twilio  MessageStatus=failed|undelivered → bounced

import { timingSafeEqual } from 'node:crypto';

import express, { type Request, type Response, type Router } from 'express';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { notificationLog } from '@vibe/db/schema';

import { resolveWebhookSecret } from './webhook-keys';

// Constant-time shared-secret comparison so a wrong token can't be probed
// byte-by-byte via response timing.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface NotificationWebhookDeps {
  db: Database | null;
  log: Logger;
  /** Env-var fallbacks per provider. Each receiver prefers the firm's
   *  DB-stored secret (Admin → Webhook keys) and falls back to these.
   *  No secret from either source ⇒ receiver rejects with 503 (fail closed). */
  postmarkSecret?: string | null;
  resendSecret?: string | null;
  twilioSecret?: string | null;
  textlinkSecret?: string | null;
}

type NewStatus = 'delivered' | 'bounced' | 'complained' | 'opened' | 'failed';

async function updateStatus(
  deps: NotificationWebhookDeps,
  providerMessageId: string,
  newStatus: NewStatus,
  errorMessage?: string | null,
): Promise<boolean> {
  if (!deps.db || !providerMessageId) return false;
  const patch: Record<string, unknown> = {
    status: newStatus,
    deliveryUpdatedAt: new Date(),
  };
  if (errorMessage) patch['errorMessage'] = errorMessage;
  const r = await deps.db
    .update(notificationLog)
    .set(patch)
    .where(eq(notificationLog.providerMessageId, providerMessageId))
    .returning({ id: notificationLog.id });
  if (r.length === 0) {
    deps.log.info(
      { providerMessageId, newStatus },
      'notification webhook: no matching log row (older than table?)',
    );
  }
  return r.length > 0;
}

export function createNotificationWebhookRouter(deps: NotificationWebhookDeps): Router {
  const router = express.Router();

  // ----- Postmark -----------------------------------------------------
  // Postmark posts a single event per request. The signature header
  // varies by Postmark plan; we use a simple shared-secret in the
  // X-Webhook-Token header so the firm can rotate it independently of
  // the Postmark dashboard. (Postmark itself recommends a custom
  // webhook-URL token, which this matches.)
  router.post('/postmark', async (req: Request, res: Response) => {
    const secret = await resolveWebhookSecret(deps.db, 'postmark', deps.postmarkSecret);
    if (!secret) {
      res.status(503).json({ error: 'not_configured' });
      return;
    }
    const provided = req.header('x-webhook-token') ?? '';
    if (!secret || !safeEqual(provided, secret)) {
      res.status(401).json({ error: 'bad_signature' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const type = String(body['RecordType'] ?? '');
    const messageId = String(body['MessageID'] ?? '');
    const mapping: Record<string, NewStatus> = {
      Delivery: 'delivered',
      Bounce: 'bounced',
      SpamComplaint: 'complained',
      Open: 'opened',
    };
    const newStatus = mapping[type];
    if (!newStatus || !messageId) {
      res.json({ ok: true, ignored: true });
      return;
    }
    const errMsg = type === 'Bounce' ? String(body['Description'] ?? '') || null : null;
    const updated = await updateStatus(deps, messageId, newStatus, errMsg);
    res.json({ ok: true, updated });
  });

  // ----- Resend -------------------------------------------------------
  // Resend wraps each event under `{ type: 'email.delivered', data: {
  // id, ... } }`. The signature header is `svix-signature`; v1 of
  // this receiver uses a simple shared-secret comparison via
  // X-Webhook-Token to stay symmetric with the Postmark path.
  router.post('/resend', async (req: Request, res: Response) => {
    const secret = await resolveWebhookSecret(deps.db, 'resend', deps.resendSecret);
    if (!secret) {
      res.status(503).json({ error: 'not_configured' });
      return;
    }
    const provided = req.header('x-webhook-token') ?? '';
    if (!secret || !safeEqual(provided, secret)) {
      res.status(401).json({ error: 'bad_signature' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const type = String(body['type'] ?? '');
    const data = (body['data'] ?? {}) as Record<string, unknown>;
    const messageId = String(data['email_id'] ?? data['id'] ?? '');
    const mapping: Record<string, NewStatus> = {
      'email.delivered': 'delivered',
      'email.bounced': 'bounced',
      'email.complained': 'complained',
      'email.opened': 'opened',
    };
    const newStatus = mapping[type];
    if (!newStatus || !messageId) {
      res.json({ ok: true, ignored: true });
      return;
    }
    const updated = await updateStatus(deps, messageId, newStatus);
    res.json({ ok: true, updated });
  });

  // ----- Twilio (SMS) -------------------------------------------------
  // Twilio posts URL-encoded form bodies (express.urlencoded is wired
  // upstream). Validation uses a shared-secret header — Twilio's own
  // signature requires the raw URL + body, which is fine for v2; v1
  // uses the same X-Webhook-Token convention.
  router.post('/twilio', async (req: Request, res: Response) => {
    const secret = await resolveWebhookSecret(deps.db, 'twilio', deps.twilioSecret);
    if (!secret) {
      res.status(503).json({ error: 'not_configured' });
      return;
    }
    const provided = req.header('x-webhook-token') ?? '';
    if (!secret || !safeEqual(provided, secret)) {
      res.status(401).json({ error: 'bad_signature' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const messageId = String(body['MessageSid'] ?? body['SmsSid'] ?? '');
    const twilioStatus = String(body['MessageStatus'] ?? body['SmsStatus'] ?? '');
    const mapping: Record<string, NewStatus> = {
      delivered: 'delivered',
      undelivered: 'bounced',
      failed: 'failed',
    };
    const newStatus = mapping[twilioStatus];
    if (!newStatus || !messageId) {
      res.json({ ok: true, ignored: true });
      return;
    }
    const errMsg = body['ErrorMessage'] ? String(body['ErrorMessage']) : null;
    const updated = await updateStatus(deps, messageId, newStatus, errMsg);
    res.json({ ok: true, updated });
  });

  // ----- TextLink (SMS) -----------------------------------------------
  // TextLink posts a JSON delivery callback. Field names vary by account;
  // accept the common shapes ({ messageId|id|sid, status }). Same
  // X-Webhook-Token shared-secret convention as the other receivers.
  router.post('/textlink', async (req: Request, res: Response) => {
    const secret = await resolveWebhookSecret(deps.db, 'textlink', deps.textlinkSecret);
    if (!secret) {
      res.status(503).json({ error: 'not_configured' });
      return;
    }
    const provided = req.header('x-webhook-token') ?? '';
    if (!secret || !safeEqual(provided, secret)) {
      res.status(401).json({ error: 'bad_signature' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const messageId = String(body['messageId'] ?? body['id'] ?? body['sid'] ?? '');
    const status = String(body['status'] ?? body['state'] ?? '').toLowerCase();
    const mapping: Record<string, NewStatus> = {
      delivered: 'delivered',
      sent: 'delivered',
      undelivered: 'bounced',
      failed: 'failed',
      error: 'failed',
    };
    const newStatus = mapping[status];
    if (!newStatus || !messageId) {
      res.json({ ok: true, ignored: true });
      return;
    }
    const errMsg = body['error'] ? String(body['error']) : null;
    const updated = await updateStatus(deps, messageId, newStatus, errMsg);
    res.json({ ok: true, updated });
  });

  return router;
}
