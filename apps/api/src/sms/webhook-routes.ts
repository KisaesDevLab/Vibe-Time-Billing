// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// PUBLIC Twilio webhooks for the two-way SMS inbox, mounted at
// /api/sms/twilio (outside auth). Every request is signature-verified
// against the firm's PUBLIC origin candidates (firm override →
// PUBLIC_BASE_URL → APP_BASE_URL) — never the internal request host.
//
//   POST /status    — delivery status callback (Phase 3)
//   POST /inbound   — inbound SMS/MMS (Phase 4)
//
// Twilio posts application/x-www-form-urlencoded. Responses are TwiML so
// Twilio never auto-replies on our behalf.

import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { checkAndIncrement } from '@vibe/core/auth';
import type { Database } from '@vibe/db';
import { firmSettings, persons, smsConversations, smsMessages } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { applyTwilioDeliveryStatus } from '../webhooks/notifications';
import { mergeSmsHealth } from './health';
import { resolveSmsPublicBaseUrlFrom, type SmsPublicUrlConfig } from './public-url';
import {
  createTwilioTokenResolver,
  findValidTwilioUrl,
  twilioUrlCandidates,
} from './twilio-signature';
import type { InboundSms, IngestDeps, IngestResult } from './ingest';

export interface SmsWebhookDeps {
  db: Database | null;
  redis: Redis;
  log: Logger;
  config: SmsPublicUrlConfig;
  /** test seam — bypasses env + DB token resolution */
  authTokens?: string[];
  now?: () => Date;
  /** Phase 4 — inbound ingestion; absent until then (inbound returns 404). */
  ingest?: (
    deps: IngestDeps,
    msg: InboundSms,
    opts: { source: 'webhook' },
  ) => Promise<IngestResult>;
  ingestDeps?: IngestDeps;
}

const IP_WINDOW_SECONDS = 60;
const IP_MAX_PER_WINDOW = 300; // Twilio egress IPs are shared across customers

const OPT_OUT_ERROR_CODE = 21610;
/** Persist the invalid-signature counter every Nth rejection. */
const HEALTH_FLUSH_EVERY = 50;

/**
 * Key for the PRE-AUTHENTICATION rate limiter. X-Forwarded-For is
 * caller-supplied and the deployed Caddyfile only overwrites X-Real-IP,
 * so keying on XFF let anyone mint a fresh bucket per request. X-Real-IP
 * is set by our own ingress; the socket peer is the last resort.
 */
function rateLimitKey(req: Request): string {
  const real = req.headers['x-real-ip'];
  const realIp = Array.isArray(real) ? real[0] : real;
  return (realIp ?? req.socket?.remoteAddress ?? '0.0.0.0').trim();
}

function twiml(res: Response, body = ''): void {
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');
  res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function createSmsWebhookRouter(deps: SmsWebhookDeps): Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));
  const nowFn = deps.now ?? ((): Date => new Date());
  const resolveTokens = createTwilioTokenResolver({
    db: deps.db,
    authTokens: deps.authTokens,
    now: () => nowFn().getTime(),
  });

  // Firm public-URL override, cached with the tokens' cadence.
  let baseCache: { at: number; bases: string[] } | null = null;
  async function resolveBases(): Promise<string[]> {
    const t = nowFn().getTime();
    if (baseCache && t - baseCache.at < 30_000) return baseCache.bases;
    let firmOverride: string | null = null;
    if (deps.db) {
      const [row] = await deps.db
        .select({ v: firmSettings.smsPublicBaseUrl })
        .from(firmSettings)
        .limit(1);
      firmOverride = row?.v ?? null;
    }
    const bases = resolveSmsPublicBaseUrlFrom(firmOverride, deps.config).candidates;
    baseCache = { at: t, bases };
    return bases;
  }

  async function firmIdForHealth(): Promise<string | null> {
    if (!deps.db) return null;
    const [row] = await deps.db.select({ id: firmSettings.firmId }).from(firmSettings).limit(1);
    return row?.id ?? null;
  }

  // Per-IP rate limit.
  router.use((req: Request, res: Response, next: NextFunction) => {
    void checkAndIncrement(deps.redis, {
      key: `rl:sms-twilio:ip:${rateLimitKey(req)}`,
      windowSeconds: IP_WINDOW_SECONDS,
      max: IP_MAX_PER_WINDOW,
    })
      .then((limit) => {
        if (!limit.allowed) {
          res.status(429).send('rate_limited');
          return;
        }
        next();
      })
      .catch((err: unknown) => {
        deps.log.warn({ err }, 'sms webhook rate limiter error; allowing');
        next();
      });
  });

  // Signature gate — try every public base Twilio could have signed.
  router.use((req: Request, res: Response, next: NextFunction) => {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.body ?? {})) {
      if (typeof v === 'string') params[k] = v;
    }
    const header = req.get('X-Twilio-Signature');
    void Promise.all([resolveTokens(), resolveBases()])
      .then(async ([tokens, bases]) => {
        const candidates = twilioUrlCandidates(bases, req.originalUrl);
        const matched = findValidTwilioUrl(tokens, candidates, params, header);
        if (!matched) {
          deps.log.warn(
            { path: req.path, candidates: candidates.length, tokens: tokens.length },
            'sms webhook signature rejected',
          );
          // Count in Redis only. Writing firm_settings here meant every
          // forged request cost an UPDATE on the single hottest row in the
          // schema, unauthenticated — dead-tuple and lock pressure for
          // free. The counter is flushed to sms_health on a sampled basis
          // so a real misconfiguration still surfaces.
          const firmId = await firmIdForHealth();
          if (deps.db && firmId) {
            const key = `sms:health:invalid-sig:${firmId}`;
            const n = await deps.redis.incr(key);
            if (n === 1) await deps.redis.expire(key, 24 * 3600);
            if (n === 1 || n % HEALTH_FLUSH_EVERY === 0) {
              await mergeSmsHealth(deps.db, firmId, 'webhook', { invalidSignature24h: n }).catch(
                () => undefined,
              );
            }
          }
          res.status(403).send('invalid_signature');
          return;
        }
        (req as Request & { twilioMatchedUrl?: string }).twilioMatchedUrl = matched;
        next();
      })
      .catch((err: unknown) => {
        deps.log.warn({ err }, 'sms webhook signature resolution failed');
        res.status(403).send('invalid_signature');
      });
  });

  // --- delivery status callback --------------------------------------
  router.post('/status', async (req: Request, res: Response) => {
    // Ack first; Twilio retries on non-2xx and we never want duplicate work.
    res.status(204).end();
    if (!deps.db) return;
    const db = deps.db;
    const sid = str(req.body?.MessageSid) || str(req.body?.SmsSid);
    const status = str(req.body?.MessageStatus) || str(req.body?.SmsStatus);
    if (!sid || !status) return;
    const errorCodeRaw = str(req.body?.ErrorCode);
    const errorCode = errorCodeRaw ? Number.parseInt(errorCodeRaw, 10) : null;
    const errorMessage = str(req.body?.ErrorMessage) || null;
    try {
      const [msg] = await db
        .select({
          id: smsMessages.id,
          firmId: smsMessages.firmId,
          conversationId: smsMessages.conversationId,
          providerStatus: smsMessages.providerStatus,
          clientId: smsConversations.clientId,
        })
        .from(smsMessages)
        .leftJoin(smsConversations, eq(smsConversations.id, smsMessages.conversationId))
        .where(eq(smsMessages.providerMessageId, sid))
        .limit(1);
      const ts = nowFn();
      if (msg) {
        // Never regress a terminal state on an out-of-order callback.
        const terminal = new Set(['delivered', 'undelivered', 'failed', 'dead_letter']);
        if (!terminal.has(msg.providerStatus) || terminal.has(status)) {
          await db
            .update(smsMessages)
            .set({
              // reason: Twilio's status vocabulary is the CHECK list on the column
              providerStatus: status as 'delivered',
              providerErrorCode: Number.isFinite(errorCode) ? errorCode : null,
              providerErrorMessage: errorMessage,
              providerTimestamp: ts,
            })
            .where(eq(smsMessages.id, msg.id));
        }
        if (errorCode === OPT_OUT_ERROR_CODE) {
          const [conv] = await db
            .select({ personId: smsConversations.personId })
            .from(smsConversations)
            .where(eq(smsConversations.id, msg.conversationId))
            .limit(1);
          if (conv?.personId) {
            await db
              .update(persons)
              .set({
                smsOptOut: true,
                smsOptOutAt: ts,
                smsOptOutSource: 'provider_21610',
                updatedAt: ts,
              })
              .where(and(eq(persons.id, conv.personId), eq(persons.smsOptOut, false)));
            await emitAudit(db, {
              action: 'UPDATE',
              entityType: 'person',
              entityId: conv.personId,
              after: { smsOptOut: true, smsAction: 'opt_out', source: 'provider_21610' },
            }).catch(() => undefined);
          }
        }
        await db
          .update(firmSettings)
          .set({ smsLastStatusWebhookAt: ts })
          .where(eq(firmSettings.firmId, msg.firmId));
        if (deps.ingestDeps?.publish) {
          await deps.ingestDeps
            .publish({
              type: 'sms.message.status',
              firmId: msg.firmId,
              conversationId: msg.conversationId,
              messageId: msg.id,
              // The stream's restricted-client filter is
              // `if (evt.clientId && blocked.has(evt.clientId))`, so an
              // event without it reaches staff blocked from the client.
              clientId: msg.clientId ?? null,
            })
            ?.catch?.(() => undefined);
        }
      }
      // Keep notification_log in sync too (both receivers are idempotent).
      await applyTwilioDeliveryStatus({ db, log: deps.log }, sid, status, errorMessage);
    } catch (err) {
      deps.log.warn({ err, sid }, 'sms status callback processing failed');
    }
  });

  // --- inbound (Phase 4) -----------------------------------------------
  router.post('/inbound', async (req: Request, res: Response) => {
    if (!deps.ingest || !deps.ingestDeps || !deps.db) {
      // Not wired yet: ack so Twilio doesn't retry forever, log loudly.
      deps.log.error('sms inbound webhook hit but ingestion is not configured');
      twiml(res);
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const numMedia = Number.parseInt(str(body['NumMedia']) || '0', 10) || 0;
    const media: InboundSms['media'] = [];
    for (let i = 0; i < numMedia; i++) {
      const url = str(body[`MediaUrl${i}`]);
      if (!url) continue;
      media.push({
        url,
        contentType: str(body[`MediaContentType${i}`]) || 'application/octet-stream',
      });
    }
    const msg: InboundSms = {
      providerMessageId: str(body['MessageSid']) || str(body['SmsSid']),
      from: str(body['From']),
      to: str(body['To']),
      body: str(body['Body']),
      numMedia,
      media,
      optOutType: str(body['OptOutType']) || null,
      providerStatus: str(body['SmsStatus']) || 'received',
    };
    if (!msg.providerMessageId || !msg.from || !msg.to) {
      twiml(res);
      return;
    }
    try {
      await deps.ingest(deps.ingestDeps, msg, { source: 'webhook' });
      twiml(res);
    } catch (err) {
      deps.log.error({ err, sid: msg.providerMessageId }, 'sms inbound ingest failed');
      // 503 → Twilio retries (DB hiccup); anything else was logged and acked.
      res.status(503).send('retry');
    }
  });

  return router;
}
