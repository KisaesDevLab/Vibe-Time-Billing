// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0234 — SmsSendService: the single outbound SMS path (addendum Phase 3).
// Reminder, booking, client-request, notification, and manual sends all go
// through `send()` so every text lands in the conversation the client's
// replies thread into. Zod-free: the worker imports this directly.
//
// Two modes, decided per firm at send time:
//   • inbox mode   — firm has Twilio + a Messaging Service SID AND the
//                    inbox is enabled: gates (opt-out → consent → A2P),
//                    conversation upsert, sms_message row, Messaging
//                    Service send with StatusCallback, notification_log.
//   • legacy mode  — anything else: opt-out gate (when the person is
//                    known) then the fallback provider (env/TextLink/SNS),
//                    exactly as before this module existed.
// `kind: 'security'` (OTP / step-up / share codes) always uses the
// fallback: no gates, no conversation row — a sign-in code must never be
// blocked by a marketing opt-out (people/sms-gate.ts rule).

import type { Logger } from 'pino';
import { and, desc, eq, sql } from 'drizzle-orm';

import { normalizePhone } from '@vibe/core/auth';
import { detectPiiPatterns } from '@vibe/core/sms';
import type { Database } from '@vibe/db';
import {
  firmSettings,
  firms,
  persons,
  smsConversations,
  smsLines,
  smsMessages,
  type SmsContextKind,
} from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { loadFirmTwilioInboxConfig, type FirmTwilioInboxConfig } from '../messaging/sms-resolver';
import { recordNotificationLog } from '../notifications/audit';
import { mergeSmsHealth } from './health';
import { findPersonsByE164 } from './lookup';
import { resolveSmsPublicBaseUrlFrom, smsWebhookUrls, type SmsPublicUrlConfig } from './public-url';
import type { SmsProvider } from './provider';
import { syncLines } from './lines';
import { createTwilioClient, TwilioApiError, type TwilioClient } from './twilio-client';

// ----- context ----------------------------------------------------------

interface BaseContext {
  /** Omit on a single-firm appliance to resolve the lone firm. */
  firmId?: string;
  personId?: string | null;
  clientId?: string | null;
  engagementId?: string | null;
}

export type SmsSendContext =
  | { kind: 'security'; firmId?: string }
  | ({
      kind: 'manual';
      sentByUserId: string;
      conversationId?: string;
      lineId?: string;
    } & BaseContext)
  | ({ kind: 'appointment_reminder'; appointmentId?: string | null } & BaseContext)
  | ({ kind: 'booking'; bookingRequestId?: string | null } & BaseContext)
  | ({ kind: 'client_request'; clientRequestId: string } & BaseContext)
  | ({ kind: 'notification'; subKind: string } & BaseContext)
  | ({ kind: 'voice_fallback'; appointmentId?: string | null } & BaseContext)
  | ({ kind: 'auto_reply'; conversationId: string; appointmentId?: string | null } & BaseContext);

export interface SmsSendArgs {
  to: string;
  body: string;
  context: SmsSendContext;
  templateKey?: string;
}

export type SmsSendBlockReason =
  | 'opted_out'
  | 'no_consent'
  | 'a2p_unregistered'
  | 'invalid_number'
  | 'no_line'
  | 'not_configured'
  | 'provider_error'
  | 'rate_limited';

export type SmsSendResult =
  | {
      ok: true;
      mode: 'inbox' | 'legacy';
      messageId: string | null;
      conversationId: string | null;
      providerMessageId?: string;
      numSegments?: number;
    }
  | {
      ok: false;
      mode: 'inbox' | 'legacy';
      reason: SmsSendBlockReason;
      retryable?: boolean;
      error?: string;
      messageId?: string | null;
      conversationId?: string | null;
      personId?: string | null;
    };

export interface SmsSendService {
  send(args: SmsSendArgs): Promise<SmsSendResult>;
}

export interface SmsEvent {
  type: 'sms.message.created' | 'sms.message.status' | 'sms.conversation.updated';
  firmId: string;
  conversationId: string;
  messageId?: string;
  clientId?: string | null;
}

export interface SmsSendServiceDeps {
  db: Database | null;
  log: Logger;
  /** Legacy / security path (already audit-wrapped in the API; worker adapter). */
  fallback: SmsProvider | null;
  config: SmsPublicUrlConfig;
  publish?: (evt: SmsEvent) => Promise<void> | void;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  /** cache TTL for firm config (ms) */
  ttlMs?: number;
  /** Phase 13 — schedule a retry for a retryable provider failure. */
  enqueueRetry?: (job: { messageId: string; firmId: string }, attempt: number) => Promise<void>;
}

const OPT_OUT_ERROR_CODE = 21610;
const US_TOLL_FREE_RE = /^\+18(00|33|44|55|66|77|88)\d{7}$/;

export function isUsLongCode(e164: string): boolean {
  return /^\+1\d{10}$/.test(e164) && !US_TOLL_FREE_RE.test(e164);
}

interface FirmInboxState {
  cfg: FirmTwilioInboxConfig | null;
  enabled: boolean;
  consentEnforced: boolean;
  a2pStatus: string;
  a2pOverride: boolean;
  publicBaseUrl: string;
}

export function createSmsSendService(deps: SmsSendServiceDeps): SmsSendService {
  const now = deps.now ?? ((): Date => new Date());
  const ttl = deps.ttlMs ?? 60_000;
  const stateCache = new Map<string, { at: number; state: FirmInboxState }>();
  let loneFirm: { at: number; id: string | null } | null = null;

  async function resolveFirmId(ctx: SmsSendContext): Promise<string | null> {
    if (ctx.firmId) return ctx.firmId;
    if (!deps.db) return null;
    const t = now().getTime();
    if (!loneFirm || t - loneFirm.at > ttl) {
      const [f] = await deps.db.select({ id: firms.id }).from(firms).limit(1);
      loneFirm = { at: t, id: f?.id ?? null };
    }
    return loneFirm.id;
  }

  async function loadState(db: Database, firmId: string): Promise<FirmInboxState> {
    const t = now().getTime();
    const hit = stateCache.get(firmId);
    if (hit && t - hit.at < ttl) return hit.state;
    const [row] = await db
      .select({
        enabled: firmSettings.smsInboxEnabled,
        consentEnforced: firmSettings.smsConsentEnforced,
        a2pStatus: firmSettings.smsA2pStatus,
        a2pOverride: firmSettings.smsA2pOverrideAllow,
        publicBaseUrl: firmSettings.smsPublicBaseUrl,
      })
      .from(firmSettings)
      .where(eq(firmSettings.firmId, firmId))
      .limit(1);
    const cfg = row?.enabled ? await loadFirmTwilioInboxConfig(db, firmId, deps.log) : null;
    const state: FirmInboxState = {
      cfg,
      enabled: Boolean(row?.enabled),
      consentEnforced: row?.consentEnforced ?? true,
      a2pStatus: row?.a2pStatus ?? 'unknown',
      a2pOverride: row?.a2pOverride ?? false,
      publicBaseUrl: resolveSmsPublicBaseUrlFrom(row?.publicBaseUrl, deps.config).baseUrl,
    };
    stateCache.set(firmId, { at: t, state });
    return state;
  }

  function client(cfg: FirmTwilioInboxConfig): TwilioClient {
    return createTwilioClient({ ...cfg, fetchImpl: deps.fetchImpl }, deps.log);
  }

  async function legacySend(
    args: SmsSendArgs,
    firmId: string | null,
    personId: string | null,
  ): Promise<SmsSendResult> {
    // Opt-out gate when we know who this is (security codes skip it).
    if (args.context.kind !== 'security' && personId && deps.db) {
      const [p] = await deps.db
        .select({ optOut: persons.smsOptOut })
        .from(persons)
        .where(eq(persons.id, personId))
        .limit(1);
      if (p?.optOut) {
        return { ok: false, mode: 'legacy', reason: 'opted_out', personId };
      }
    }
    if (!deps.fallback) {
      return { ok: false, mode: 'legacy', reason: 'not_configured', error: 'no sms provider' };
    }
    const r = await deps.fallback.send({ to: args.to, body: args.body });
    if (!r.ok) {
      return {
        ok: false,
        mode: 'legacy',
        reason: 'provider_error',
        error: r.error,
        messageId: null,
      };
    }
    void firmId;
    return {
      ok: true,
      mode: 'legacy',
      messageId: null,
      conversationId: null,
      providerMessageId: r.providerMessageId,
    };
  }

  async function pickLine(
    db: Database,
    firmId: string,
    state: FirmInboxState,
    ctx: SmsSendContext,
    to: string,
  ): Promise<{ id: string; phoneNumberE164: string } | null> {
    // 1. the conversation's own line (replies never switch lines — D2a)
    const convId =
      ctx.kind === 'manual' || ctx.kind === 'auto_reply' ? (ctx.conversationId ?? null) : null;
    if (convId) {
      const [c] = await db
        .select({ id: smsLines.id, phoneNumberE164: smsLines.phoneNumberE164 })
        .from(smsConversations)
        .innerJoin(smsLines, eq(smsLines.id, smsConversations.lineId))
        .where(eq(smsConversations.id, convId))
        .limit(1);
      if (c) return c;
    }
    // 1b. an existing conversation with this number on any line (keeps the
    //     thread intact when a reminder follows an inbound text)
    const [existing] = await db
      .select({ id: smsLines.id, phoneNumberE164: smsLines.phoneNumberE164 })
      .from(smsConversations)
      .innerJoin(smsLines, eq(smsLines.id, smsConversations.lineId))
      .where(
        and(
          eq(smsConversations.firmId, firmId),
          eq(smsConversations.externalNumberE164, to),
          eq(smsLines.status, 'ACTIVE'),
        ),
      )
      .orderBy(desc(smsConversations.lastMessageAt))
      .limit(1);
    if (existing) return existing;
    // 2. caller-specified line
    if (ctx.kind === 'manual' && ctx.lineId) {
      const [l] = await db
        .select({ id: smsLines.id, phoneNumberE164: smsLines.phoneNumberE164 })
        .from(smsLines)
        .where(and(eq(smsLines.id, ctx.lineId), eq(smsLines.status, 'ACTIVE')))
        .limit(1);
      if (l) return l;
    }
    // 3. default, else first active line
    const lines = await db
      .select({
        id: smsLines.id,
        phoneNumberE164: smsLines.phoneNumberE164,
        isDefault: smsLines.isDefault,
      })
      .from(smsLines)
      .where(and(eq(smsLines.firmId, firmId), eq(smsLines.status, 'ACTIVE')))
      .orderBy(desc(smsLines.isDefault), smsLines.createdAt, smsLines.phoneNumberE164);
    if (lines[0]) return lines[0];
    // 4. never synced — pull the Messaging Service numbers once (best-effort)
    if (state.cfg) {
      try {
        const numbers = await client(state.cfg).listMessagingServicePhoneNumbers(
          state.cfg.messagingServiceSid,
        );
        if (numbers.length > 0) {
          await syncLines(db, firmId, numbers, now());
          const [l] = await db
            .select({ id: smsLines.id, phoneNumberE164: smsLines.phoneNumberE164 })
            .from(smsLines)
            .where(and(eq(smsLines.firmId, firmId), eq(smsLines.status, 'ACTIVE')))
            .orderBy(desc(smsLines.isDefault), smsLines.createdAt)
            .limit(1);
          if (l) return l;
        }
      } catch (err) {
        deps.log.warn({ err, firmId }, 'sms line auto-sync failed');
      }
    }
    return null;
  }

  async function markOptedOut(
    db: Database,
    personId: string,
    source: 'provider_21610',
  ): Promise<void> {
    await db
      .update(persons)
      .set({ smsOptOut: true, smsOptOutAt: now(), smsOptOutSource: source, updatedAt: now() })
      .where(and(eq(persons.id, personId), eq(persons.smsOptOut, false)));
    await emitAudit(db, {
      action: 'UPDATE',
      entityType: 'person',
      entityId: personId,
      after: { smsOptOut: true, smsAction: 'opt_out', source },
    }).catch(() => undefined);
  }

  return {
    async send(args) {
      const ctx = args.context;
      const to = normalizePhone(args.to);
      const firmId = await resolveFirmId(ctx);
      const explicitPerson = ctx.kind === 'security' ? null : (ctx.personId ?? null);

      // Security codes and firms without the inbox use the plain path.
      if (ctx.kind === 'security' || !deps.db || !firmId) {
        return legacySend(args, firmId, explicitPerson);
      }
      const db = deps.db;
      const state = await loadState(db, firmId);
      if (!state.cfg) return legacySend(args, firmId, explicitPerson);

      if (!to) {
        return {
          ok: false,
          mode: 'inbox',
          reason: 'invalid_number',
          error: `unparseable: ${args.to}`,
        };
      }

      // --- resolve person (explicit → unique phone match) ---------------
      let personId = explicitPerson;
      let personOptOut = false;
      let personConsentAt: Date | null = null;
      if (personId) {
        const [p] = await db
          .select({ optOut: persons.smsOptOut, consentAt: persons.smsConsentAt })
          .from(persons)
          .where(eq(persons.id, personId))
          .limit(1);
        personOptOut = p?.optOut ?? false;
        personConsentAt = p?.consentAt ?? null;
      } else {
        const matches = await findPersonsByE164(db, firmId, to);
        if (matches.length === 1) {
          personId = matches[0]!.personId;
          personOptOut = matches[0]!.smsOptOut;
          personConsentAt = matches[0]!.smsConsentAt;
        } else if (matches.length > 1) {
          // Ambiguous number: any opted-out holder blocks (conservative).
          if (matches.some((m) => m.smsOptOut)) personOptOut = true;
          if (matches.some((m) => m.smsConsentAt)) personConsentAt = now();
        }
      }

      // --- gates: opt-out → consent → A2P --------------------------------
      if (personOptOut) {
        return { ok: false, mode: 'inbox', reason: 'opted_out', personId };
      }
      const line = await pickLine(db, firmId, state, ctx, to);
      if (!line) {
        return { ok: false, mode: 'inbox', reason: 'no_line', error: 'no active texting line' };
      }
      const [existingConv] = await db
        .select({
          id: smsConversations.id,
          lastInboundAt: smsConversations.lastInboundAt,
          clientId: smsConversations.clientId,
        })
        .from(smsConversations)
        .where(
          and(eq(smsConversations.lineId, line.id), eq(smsConversations.externalNumberE164, to)),
        )
        .limit(1);
      const inboundInitiated = Boolean(existingConv?.lastInboundAt);
      if (
        state.consentEnforced &&
        personId &&
        !personConsentAt &&
        !inboundInitiated &&
        ctx.kind !== 'auto_reply'
      ) {
        return {
          ok: false,
          mode: 'inbox',
          reason: 'no_consent',
          personId,
          conversationId: existingConv?.id ?? null,
        };
      }
      if (
        state.a2pStatus === 'unregistered' &&
        !state.a2pOverride &&
        isUsLongCode(line.phoneNumberE164) &&
        isUsLongCode(to)
      ) {
        return {
          ok: false,
          mode: 'inbox',
          reason: 'a2p_unregistered',
          personId,
          conversationId: existingConv?.id ?? null,
        };
      }

      // --- rows first (message exists before the provider call) ----------
      const ts = now();
      const contextKind: SmsContextKind = ctx.kind;
      const linkFields = {
        personId: personId ?? null,
        clientId: ctx.clientId ?? null,
        engagementId: ctx.engagementId ?? null,
      };
      const { conversationId, messageId } = await db.transaction(async (tx) => {
        const [conv] = await tx
          .insert(smsConversations)
          .values({
            firmId,
            lineId: line.id,
            externalNumberE164: to,
            personId: linkFields.personId,
            clientId: linkFields.clientId,
            engagementId: linkFields.engagementId,
            linkSource: linkFields.clientId ? 'reply_context' : 'none',
            lastMessageAt: ts,
            lastOutboundAt: ts,
          })
          .onConflictDoUpdate({
            target: [smsConversations.lineId, smsConversations.externalNumberE164],
            set: {
              lastMessageAt: ts,
              lastOutboundAt: ts,
              updatedAt: ts,
              // an outbound to a closed thread reopens it so the reply is seen
              status: sql`CASE WHEN ${smsConversations.status} = 'closed' THEN 'open' ELSE ${smsConversations.status} END`,
              personId: sql`coalesce(${smsConversations.personId}, ${linkFields.personId})`,
              clientId: sql`coalesce(${smsConversations.clientId}, ${linkFields.clientId})`,
              engagementId: sql`coalesce(${smsConversations.engagementId}, ${linkFields.engagementId})`,
              linkSource: sql`CASE WHEN ${smsConversations.clientId} IS NULL AND ${linkFields.clientId}::uuid IS NOT NULL THEN 'reply_context' ELSE ${smsConversations.linkSource} END`,
            },
          })
          .returning({ id: smsConversations.id });
        const [msg] = await tx
          .insert(smsMessages)
          .values({
            firmId,
            conversationId: conv!.id,
            direction: 'outbound',
            fromE164: line.phoneNumberE164,
            toE164: to,
            body: args.body,
            providerStatus: 'queued',
            contextKind,
            engagementId: linkFields.engagementId,
            sentByUserId: ctx.kind === 'manual' ? ctx.sentByUserId : null,
            appointmentId:
              ctx.kind === 'appointment_reminder' ||
              ctx.kind === 'voice_fallback' ||
              ctx.kind === 'auto_reply'
                ? ctx.appointmentId || null
                : null,
            bookingRequestId: ctx.kind === 'booking' ? ctx.bookingRequestId || null : null,
            clientRequestId: ctx.kind === 'client_request' ? ctx.clientRequestId || null : null,
            redactionFlags: detectPiiPatterns(args.body),
            ingestSource: 'api',
            attemptCount: 1,
            createdAt: ts,
          })
          .returning({ id: smsMessages.id });
        return { conversationId: conv!.id, messageId: msg!.id };
      });

      // --- provider call --------------------------------------------------
      const statusCallback = smsWebhookUrls(state.publicBaseUrl).status;
      let result: SmsSendResult;
      try {
        const r = await client(state.cfg).sendMessage({
          to,
          body: args.body,
          messagingServiceSid: state.cfg.messagingServiceSid,
          statusCallback,
        });
        await db
          .update(smsMessages)
          .set({
            providerMessageId: r.sid,
            // reason: Twilio's status vocabulary matches the CHECK list; unknown → queued
            providerStatus: (r.status || 'queued') as 'queued',
            numSegments: r.numSegments,
          })
          .where(eq(smsMessages.id, messageId));
        await db
          .update(firmSettings)
          .set({ smsLastSendAt: ts })
          .where(eq(firmSettings.firmId, firmId));
        await recordNotificationLog(
          { db, log: deps.log },
          {
            firmId,
            channel: 'sms',
            provider: 'twilio',
            recipient: to,
            subject: null,
            templateKey: args.templateKey ?? null,
            status: 'sent',
            providerMessageId: r.sid,
            errorMessage: null,
          },
        );
        result = {
          ok: true,
          mode: 'inbox',
          messageId,
          conversationId,
          providerMessageId: r.sid,
          numSegments: r.numSegments,
        };
      } catch (err) {
        const twErr = err instanceof TwilioApiError ? err : null;
        const message = err instanceof Error ? err.message : 'twilio_failed';
        const optedOut = twErr?.code === OPT_OUT_ERROR_CODE;
        await db
          .update(smsMessages)
          .set({
            providerStatus: 'failed',
            providerErrorCode: twErr?.code ?? null,
            providerErrorMessage: message.slice(0, 500),
          })
          .where(eq(smsMessages.id, messageId));
        if (optedOut && personId) await markOptedOut(db, personId, 'provider_21610');
        await mergeSmsHealth(db, firmId, 'send', {
          lastError: message.slice(0, 200),
          lastAt: ts.toISOString(),
        }).catch(() => undefined);
        await recordNotificationLog(
          { db, log: deps.log },
          {
            firmId,
            channel: 'sms',
            provider: 'twilio',
            recipient: to,
            subject: null,
            templateKey: args.templateKey ?? null,
            status: 'failed',
            providerMessageId: null,
            errorMessage: message,
          },
        );
        deps.log.warn({ err, messageId, to }, 'sms send failed');
        const retryable = twErr ? twErr.retryable : true;
        if (retryable && !optedOut && deps.enqueueRetry) {
          await db
            .update(smsMessages)
            .set({ nextAttemptAt: new Date(ts.getTime() + 30_000) })
            .where(eq(smsMessages.id, messageId));
          await deps
            .enqueueRetry({ messageId, firmId }, 1)
            .catch((e: unknown) =>
              deps.log.warn({ err: e, messageId }, 'sms retry enqueue failed'),
            );
        }
        result = {
          ok: false,
          mode: 'inbox',
          reason: optedOut
            ? 'opted_out'
            : twErr?.status === 429
              ? 'rate_limited'
              : 'provider_error',
          retryable: twErr ? twErr.retryable : true,
          error: message,
          messageId,
          conversationId,
          personId,
        };
      }

      if (deps.publish) {
        try {
          await deps.publish({
            type: 'sms.message.created',
            firmId,
            conversationId,
            messageId,
            clientId: existingConv?.clientId ?? linkFields.clientId,
          });
          await deps.publish({
            type: 'sms.conversation.updated',
            firmId,
            conversationId,
            clientId: existingConv?.clientId ?? linkFields.clientId,
          });
        } catch (err) {
          deps.log.warn({ err }, 'sms event publish failed');
        }
      }
      return result;
    },
  };
}
