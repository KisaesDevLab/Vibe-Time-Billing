// SPDX-License-Identifier: Elastic-2.0
//
// 0121 — two-way appointment confirmation via Twilio inbound webhooks.
// Mounted PUBLIC at /api/public/appointments/twilio (outside auth). Clients
// confirm by texting back (e.g. "YES") or pressing 1 on the reminder call;
// either flips their participant RSVP to 'confirmed', lighting up the
// Confirmed chips in the staff UI. Every request is Twilio-signature verified.

import crypto from 'node:crypto';

import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { and, asc, eq, gt, lt } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { checkAndIncrement } from '@vibe/core/auth';
import type { Database } from '@vibe/db';
import {
  appointmentParticipants,
  appointments,
  clientContacts,
  firmSettings,
  persons,
} from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { logger } from '../logger';
import { decryptSmsConfig } from '../messaging/config';

/** Decrypt every firm's stored SMS config and collect Twilio auth tokens, for
 *  inbound-webhook signature verification (SMS is configured in the DB, not
 *  env). Single-firm appliance → usually one. Best-effort; skips undecryptable. */
async function loadFirmTwilioAuthTokens(db: Database): Promise<string[]> {
  const rows = await db.select({ enc: firmSettings.smsConfigEncrypted }).from(firmSettings);
  const out: string[] = [];
  for (const r of rows) {
    if (!r.enc) continue;
    try {
      const cfg = decryptSmsConfig(r.enc);
      if (cfg.provider === 'twilio' && cfg.authToken) out.push(cfg.authToken);
    } catch {
      /* skip rows we can't decrypt */
    }
  }
  return out;
}

export interface AppointmentTwilioDeps {
  db: Database | null;
  redis: Redis;
  /** Public origin Twilio called (for signature reconstruction), e.g. APP_BASE_URL. */
  baseUrl: string;
  /** Auth tokens to verify the X-Twilio-Signature against (env SMS/VOICE tokens). */
  authTokens?: string[];
  now?: () => Date;
}

const IP_WINDOW_SECONDS = 60;
const IP_MAX_PER_WINDOW = 30;
const CONFIRM_KEYWORDS = new Set(['YES', 'Y', 'C', 'CONFIRM', 'CONFIRMED']);
const UUID_RE = /^[0-9a-fA-F-]{36}$/;

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
  return (first ?? req.ip ?? '0.0.0.0').trim();
}

function last10(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '').slice(-10);
}

/** Twilio request validation: base64(HMAC-SHA1(token, fullUrl + sorted k+v of POST params)). */
function twilioSignatureValid(
  tokens: string[],
  fullUrl: string,
  params: Record<string, string>,
  header: string | undefined,
): boolean {
  if (!header || tokens.length === 0) return false;
  const sorted = Object.keys(params).sort();
  let data = fullUrl;
  for (const k of sorted) data += k + params[k];
  for (const token of tokens) {
    if (!token) continue;
    const expected = crypto.createHmac('sha1', token).update(data, 'utf8').digest('base64');
    // Constant-time compare on equal-length buffers.
    const a = Buffer.from(expected);
    const b = Buffer.from(header);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

function twiml(res: Response, body: string): void {
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
}

export function createAppointmentTwilioRouter(deps: AppointmentTwilioDeps): Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));
  const nowFn = deps.now ?? ((): Date => new Date());
  const envTokens = [
    process.env['SMS_TWILIO_AUTH_TOKEN'],
    process.env['VOICE_TWILIO_AUTH_TOKEN'],
  ].filter((t): t is string => Boolean(t));

  // Verification tokens = env creds + the firm's DB-configured Twilio auth
  // token(s) (Admin → Messaging). The latter matters because SMS is configured
  // in the DB, not env. Cached briefly to avoid decrypting on every webhook.
  let dbTokenCache: { at: number; tokens: string[] } | null = null;
  async function resolveTokens(): Promise<string[]> {
    if (deps.authTokens) return deps.authTokens; // test seam
    const now = nowFn().getTime();
    if (!dbTokenCache || now - dbTokenCache.at > 30_000) {
      dbTokenCache = { at: now, tokens: deps.db ? await loadFirmTwilioAuthTokens(deps.db) : [] };
    }
    return [...envTokens, ...dbTokenCache.tokens];
  }

  // Per-IP rate limit.
  router.use((req: Request, res: Response, next: NextFunction) => {
    void checkAndIncrement(deps.redis, {
      key: `rl:appt-twilio:ip:${clientIp(req)}`,
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
        logger.warn({ err }, 'twilio webhook rate limiter error; allowing');
        next();
      });
  });

  // Signature gate — reconstruct the URL Twilio signed (origin + originalUrl).
  router.use((req: Request, res: Response, next: NextFunction) => {
    const fullUrl = `${deps.baseUrl.replace(/\/$/, '')}${req.originalUrl}`;
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.body ?? {})) {
      if (typeof v === 'string') params[k] = v;
    }
    const header = req.get('X-Twilio-Signature');
    void resolveTokens()
      .then((toks) => {
        if (!twilioSignatureValid(toks, fullUrl, params, header)) {
          res.status(403).send('invalid_signature');
          return;
        }
        next();
      })
      .catch((err: unknown) => {
        logger.warn({ err }, 'twilio signature token resolution failed');
        res.status(403).send('invalid_signature');
      });
  });

  /** Flip a participant's RSVP to confirmed. Returns true when a row changed. */
  async function confirmParticipant(
    db: Database,
    appointmentId: string,
    contactId: string,
    via: string,
  ): Promise<boolean> {
    const updated = await db
      .update(appointmentParticipants)
      .set({ rsvpStatus: 'confirmed' })
      .where(
        and(
          eq(appointmentParticipants.appointmentId, appointmentId),
          eq(appointmentParticipants.clientContactId, contactId),
        ),
      )
      .returning({ id: appointmentParticipants.id });
    if (updated.length === 0) return false;
    await emitAudit(db, {
      action: 'UPDATE',
      entityType: 'appointment_participant',
      entityId: updated[0]!.id,
      after: { rsvpStatus: 'confirmed', via },
    }).catch(() => undefined);
    return true;
  }

  // --- inbound SMS: client texts a confirm keyword -------------------
  router.post('/sms', async (req: Request, res: Response) => {
    if (!deps.db) {
      twiml(res, '');
      return;
    }
    const db = deps.db;
    const from = typeof req.body?.From === 'string' ? req.body.From : '';
    const bodyText = typeof req.body?.Body === 'string' ? req.body.Body : '';
    const keyword = bodyText.trim().toUpperCase().split(/\s+/)[0] ?? '';
    if (!CONFIRM_KEYWORDS.has(keyword) || !from) {
      twiml(res, ''); // ack, no action
      return;
    }
    const fromKey = last10(from);
    const now = nowFn();
    const horizon = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
    // Upcoming SCHEDULED appts with this person as a participant; match by phone.
    const rows = await db
      .select({
        appointmentId: appointmentParticipants.appointmentId,
        contactId: appointmentParticipants.clientContactId,
        mobile: persons.mobile,
        phone: persons.phone,
        startsAt: appointments.startsAt,
      })
      .from(appointmentParticipants)
      .innerJoin(appointments, eq(appointments.id, appointmentParticipants.appointmentId))
      .innerJoin(clientContacts, eq(clientContacts.id, appointmentParticipants.clientContactId))
      .innerJoin(persons, eq(persons.id, clientContacts.personId))
      .where(
        and(
          eq(appointments.status, 'SCHEDULED'),
          gt(appointments.startsAt, now),
          lt(appointments.startsAt, horizon),
        ),
      )
      .orderBy(asc(appointments.startsAt));
    const match = rows.find((r) => last10(r.mobile) === fromKey || last10(r.phone) === fromKey);
    if (match) {
      await confirmParticipant(db, match.appointmentId, match.contactId, 'sms');
      twiml(res, `<Message>Thanks — you're confirmed.</Message>`);
      return;
    }
    twiml(res, ''); // no match → silent ack
  });

  // --- inbound voice press-1: <Gather> action from the reminder call --
  router.post('/voice-gather', async (req: Request, res: Response) => {
    if (!deps.db) {
      twiml(res, '<Say>Goodbye.</Say>');
      return;
    }
    const a = typeof req.query['a'] === 'string' ? req.query['a'] : '';
    const c = typeof req.query['c'] === 'string' ? req.query['c'] : '';
    const digits = typeof req.body?.Digits === 'string' ? req.body.Digits : '';
    if (digits === '1' && UUID_RE.test(a) && UUID_RE.test(c)) {
      const ok = await confirmParticipant(deps.db, a, c, 'voice');
      twiml(res, ok ? '<Say>Confirmed. Goodbye.</Say>' : '<Say>Goodbye.</Say>');
      return;
    }
    twiml(res, '<Say>Goodbye.</Say>');
  });

  return router;
}
