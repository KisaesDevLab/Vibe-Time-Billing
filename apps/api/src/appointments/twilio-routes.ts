// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
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
  clientCommunications,
  clientContacts,
  firmSettings,
  persons,
  voiceCalls,
} from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { logger } from '../logger';
import { decryptSmsConfig, decryptVoiceConfig } from '../messaging/config';
import { loadFirmSmsProvider } from '../messaging/sms-resolver';

/** Decrypt every firm's stored SMS + VOICE configs and collect Twilio auth
 *  tokens, for inbound-webhook signature verification (both are configured
 *  in the DB, not env). Single-firm appliance → usually one of each.
 *  Best-effort; skips undecryptable. */
async function loadFirmTwilioAuthTokens(db: Database): Promise<string[]> {
  const rows = await db
    .select({
      enc: firmSettings.smsConfigEncrypted,
      voiceEnc: firmSettings.voiceConfigEncrypted,
    })
    .from(firmSettings);
  const out: string[] = [];
  for (const r of rows) {
    if (r.enc) {
      try {
        const cfg = decryptSmsConfig(r.enc);
        if (cfg.provider === 'twilio' && cfg.authToken) out.push(cfg.authToken);
      } catch {
        /* skip rows we can't decrypt */
      }
    }
    if (r.voiceEnc) {
      try {
        const cfg = decryptVoiceConfig(r.voiceEnc);
        if (cfg.authToken) out.push(cfg.authToken);
      } catch {
        /* skip rows we can't decrypt */
      }
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

  // 0206 — client replies land on the client's Communications timeline as
  // INBOUND rows (they used to be processed and discarded). Best-effort:
  // a reply we can't attribute to a client is still acked to Twilio.
  async function logInboundReply(
    db: Database,
    args: {
      firmId: string;
      clientId: string;
      channel: 'SMS' | 'CALL';
      subject: string;
      body: string;
      relatedEntityType?: string;
      relatedEntityId?: string;
    },
  ): Promise<void> {
    await db
      .insert(clientCommunications)
      .values({
        firmId: args.firmId,
        clientId: args.clientId,
        channel: args.channel,
        direction: 'INBOUND',
        subject: args.subject,
        body: args.body.slice(0, 4000),
        occurredAt: nowFn(),
        relatedEntityType: args.relatedEntityType ?? null,
        relatedEntityId: args.relatedEntityId ?? null,
      })
      .catch((err: unknown) => logger.warn({ err }, 'inbound reply log failed'));
  }

  /** Resolve a sender phone to (firmId, clientId) via the person directory:
   *  last-10-digit match on person.phone/mobile → their first ACTIVE client
   *  contact. Returns null when the number isn't a known contact. */
  async function resolveSenderClient(
    db: Database,
    from: string,
  ): Promise<{ firmId: string; clientId: string } | null> {
    const key = last10(from);
    if (key.length < 7) return null;
    const rows = await db
      .select({
        firmId: persons.firmId,
        clientId: clientContacts.clientId,
        phone: persons.phone,
        mobile: persons.mobile,
        status: clientContacts.status,
      })
      .from(persons)
      .innerJoin(clientContacts, eq(clientContacts.personId, persons.id))
      .where(eq(clientContacts.status, 'ACTIVE'))
      .limit(500);
    const match = rows.find((r) => last10(r.mobile) === key || last10(r.phone) === key);
    return match ? { firmId: match.firmId, clientId: match.clientId } : null;
  }

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
    // 0206 — every inbound text from a known contact lands on the client's
    // Communications timeline, keyword or not (a "can we do 3pm instead?"
    // used to vanish here).
    if (from && bodyText.trim()) {
      const sender = await resolveSenderClient(db, from);
      if (sender) {
        await logInboundReply(db, {
          ...sender,
          channel: 'SMS',
          subject: 'Text message reply',
          body: bodyText.trim(),
        });
      }
    }
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

  // --- inbound voice gather: press-1 confirm / press-9 opt-out ---------
  // Query params: a=appointmentId, c=clientContactId (press-1 target),
  // p=personId (press-9 target for calls without an appointment context),
  // vc=voiceCallId (outcome log row).
  router.post('/voice-gather', async (req: Request, res: Response) => {
    if (!deps.db) {
      twiml(res, '<Say>Goodbye.</Say>');
      return;
    }
    const db = deps.db;
    const a = typeof req.query['a'] === 'string' ? req.query['a'] : '';
    const c = typeof req.query['c'] === 'string' ? req.query['c'] : '';
    const p = typeof req.query['p'] === 'string' ? req.query['p'] : '';
    const vc = typeof req.query['vc'] === 'string' ? req.query['vc'] : '';
    const digits = typeof req.body?.Digits === 'string' ? req.body.Digits : '';
    if (digits === '1' && UUID_RE.test(a) && UUID_RE.test(c)) {
      const ok = await confirmParticipant(db, a, c, 'voice');
      if (ok) {
        const [contact] = await db
          .select({ clientId: clientContacts.clientId, firmId: persons.firmId })
          .from(clientContacts)
          .innerJoin(persons, eq(persons.id, clientContacts.personId))
          .where(eq(clientContacts.id, c))
          .limit(1);
        if (contact) {
          await logInboundReply(db, {
            firmId: contact.firmId,
            clientId: contact.clientId,
            channel: 'CALL',
            subject: 'Voice reply — pressed 1',
            body: 'Confirmed the appointment by phone (pressed 1 on the reminder call).',
            relatedEntityType: 'appointment',
            relatedEntityId: a,
          });
        }
      }
      twiml(res, ok ? '<Say>Confirmed. Goodbye.</Say>' : '<Say>Goodbye.</Say>');
      return;
    }
    if (digits === '9') {
      // 0206 — opt out of automated calls. Resolve the person from ?p= or
      // via the appointment contact, set the global do-not-call flag.
      let personId: string | null = UUID_RE.test(p) ? p : null;
      if (!personId && UUID_RE.test(c)) {
        const [contact] = await db
          .select({ personId: clientContacts.personId })
          .from(clientContacts)
          .where(eq(clientContacts.id, c))
          .limit(1);
        personId = contact?.personId ?? null;
      }
      if (personId) {
        await db
          .update(persons)
          .set({ doNotCall: true, updatedAt: nowFn() })
          .where(eq(persons.id, personId));
        await emitAudit(db, {
          action: 'UPDATE',
          entityType: 'person',
          entityId: personId,
          after: { doNotCall: true, via: 'voice_press_9' },
        }).catch(() => undefined);
        // Timeline entry so staff see the opt-out where they look for
        // client responses.
        const [pc] = await db
          .select({ clientId: clientContacts.clientId, firmId: persons.firmId })
          .from(clientContacts)
          .innerJoin(persons, eq(persons.id, clientContacts.personId))
          .where(and(eq(clientContacts.personId, personId), eq(clientContacts.status, 'ACTIVE')))
          .limit(1);
        if (pc) {
          await logInboundReply(db, {
            firmId: pc.firmId,
            clientId: pc.clientId,
            channel: 'CALL',
            subject: 'Voice reply — pressed 9 (do not call)',
            body: 'Opted out of automated voice calls (pressed 9). Future notices go by text.',
          });
        }
        if (UUID_RE.test(vc)) {
          await db
            .update(voiceCalls)
            .set({ status: 'opted_out', completedAt: nowFn() })
            .where(eq(voiceCalls.id, vc))
            .catch(() => undefined);
        }
        twiml(res, '<Say>You will no longer receive automated calls. Goodbye.</Say>');
        return;
      }
    }
    twiml(res, '<Say>Goodbye.</Say>');
  });

  // --- Twilio status callback for outbound voice calls (0206) ----------
  // ?vc=<voiceCallId>; body carries CallStatus (completed/busy/no-answer/
  // failed/canceled) and AnsweredBy when machine detection ran. Terminal
  // non-connects trigger the stored SMS fallback via the firm's SMS
  // provider (not window-restricted by design).
  router.post('/voice-status', async (req: Request, res: Response) => {
    res.status(204).end(); // ack Twilio immediately; work continues below
    if (!deps.db) return;
    const db = deps.db;
    const vc = typeof req.query['vc'] === 'string' ? req.query['vc'] : '';
    if (!UUID_RE.test(vc)) return;
    const callStatus = typeof req.body?.CallStatus === 'string' ? req.body.CallStatus : '';
    const answeredBy = typeof req.body?.AnsweredBy === 'string' ? req.body.AnsweredBy : '';
    const status =
      callStatus === 'completed'
        ? answeredBy.startsWith('machine')
          ? 'voicemail'
          : 'answered'
        : callStatus === 'busy'
          ? 'busy'
          : callStatus === 'no-answer'
            ? 'no_answer'
            : callStatus === 'canceled'
              ? 'canceled'
              : callStatus === 'failed'
                ? 'failed'
                : null;
    if (!status) return;
    try {
      const [row] = await db.select().from(voiceCalls).where(eq(voiceCalls.id, vc)).limit(1);
      // Don't clobber a press-9 opt-out recorded mid-call.
      if (!row || row.status === 'opted_out') return;
      await db
        .update(voiceCalls)
        .set({ status, completedAt: nowFn() })
        .where(eq(voiceCalls.id, vc));
      const shouldFallback =
        (status === 'busy' || status === 'no_answer' || status === 'failed') &&
        !row.fallbackSmsSent &&
        Boolean(row.fallbackSmsBody);
      if (shouldFallback) {
        const provider = await loadFirmSmsProvider(db, row.firmId, logger);
        if (provider) {
          await provider.send({ to: row.toNumber, body: row.fallbackSmsBody! });
          await db.update(voiceCalls).set({ fallbackSmsSent: true }).where(eq(voiceCalls.id, vc));
        } else {
          logger.warn({ vc }, 'voice fallback SMS skipped: no SMS provider configured');
        }
      }
    } catch (err) {
      logger.warn({ err, vc }, 'voice status callback processing failed');
    }
  });

  return router;
}
