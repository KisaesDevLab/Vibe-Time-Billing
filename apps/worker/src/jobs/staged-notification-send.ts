// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0146 — staged-notification send. Consumes the delayed
// 'staged-notification-send' queue (producer:
// apps/api/src/notifications/staged/queue.ts).
//
// The row is the contract: recipients + per-channel rendered content
// were snapshotted at staging time, so this job only (1) re-checks
// guards, (2) fans out per channel, (3) records the outcome. Statuses:
//   SENT    — at least one channel dispatched to someone
//   FAILED  — every channel failed (visible in the queue with Retry)
//   CANCELED/STATE_CHANGED_AT_FIRE — the engagement moved on before
//             the scheduled fire; superseded rows are skipped silently.
//
// Per successful channel: a client_communication OUTBOUND row (the
// client timeline requirement) and, for EMAIL/SMS, a notification_log
// row per recipient (technical send audit). PORTAL inserts one
// portal_notification per ACTIVE portal identity with access to the
// client. SMS consent: client_contact phones follow the dunning
// precedent (billing-contact SMS sends without portal-level consent).

import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  auditLog,
  clientCommunications,
  clientPortalAccess,
  clients,
  engagements,
  firms,
  notificationLog,
  persons,
  notificationTemplates,
  portalNotifications,
  stagedNotifications,
} from '@vibe/db/schema';

import type { Logger } from 'pino';

import type { MailDispatch, SmsDispatch } from '../dispatchers';
import { sendWebPushToIdentity } from '../web-push';
import { renderHtmlToPdf } from '../../../api/src/pdf/render';
import { resolveOfficePrinter } from '../../../api/src/print-gateway/assignments';
import { resolvePrintGateway } from '../../../api/src/print-gateway/config';
import { sendToPrinter } from '../../../api/src/print-gateway/send';
import {
  msUntilCallWindow,
  placeVoiceCall,
  resolveFirmVoiceConfig,
} from '../../../api/src/voice/place-call';

export interface StagedNotificationSendDeps {
  sendEmail?: MailDispatch;
  sendSms?: SmsDispatch;
  /** Public app origin for the voice status-callback / gather webhooks. */
  appBaseUrl?: string;
  /** Re-enqueue THIS notification after `delayMs` (0206 — calls due outside
   *  the firm's calling window wait for it). `callOnly` marks a voice-only
   *  pass over an already-SENT row; false replays the full send (used when
   *  CALL was the only channel and the row went back to SCHEDULED). */
  enqueueCallRetry?: (
    stagedNotificationId: string,
    delayMs: number,
    callOnly: boolean,
  ) => Promise<void>;
}

export interface StagedNotificationSendPayload {
  stagedNotificationId: string;
  /** 0206 — deferred voice pass: the row is already SENT; only place calls. */
  callOnly?: boolean;
}

interface ChannelResult {
  ok: boolean;
  sentTo: string[];
  error?: string;
}

interface RecipientSnapshot {
  personId: string;
  name: string;
  email: string | null;
  phone: string | null;
  /** 0224 — SMS opt-out captured when the notification was staged. Send
   *  paths re-check the live person row (liveSmsOptOuts) because a client
   *  can opt out between staging and approval. */
  smsOptOut?: boolean;
}

/** Live SMS opt-outs for the snapshot's people (the snapshot may be stale
 *  or pre-date 0224). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function liveSmsOptOuts(db: Database, recipients: RecipientSnapshot[]): Promise<Set<string>> {
  const ids = [...new Set(recipients.map((r) => r.personId).filter((x) => UUID_RE.test(x)))];
  if (ids.length === 0) return new Set();
  try {
    const rows = await db
      .select({ id: persons.id, smsOptOut: persons.smsOptOut })
      .from(persons)
      .where(inArray(persons.id, ids));
    return new Set(rows.filter((r) => r.smsOptOut).map((r) => r.id));
  } catch {
    // Fail open to the snapshot flag rather than blocking the whole channel.
    return new Set();
  }
}

type Rendered = Record<string, { subject: string | null; body: string } | undefined>;

export async function runStagedNotificationSend(
  db: Database,
  log: Logger,
  deps: StagedNotificationSendDeps,
  payload: StagedNotificationSendPayload,
): Promise<{ outcome: 'sent' | 'failed' | 'skipped' | 'canceled_at_fire' }> {
  const [row] = await db
    .select()
    .from(stagedNotifications)
    .where(eq(stagedNotifications.id, payload.stagedNotificationId))
    .limit(1);

  // 0206 — deferred call-only pass: the other channels already went out and
  // the row is SENT; this pass only places the queued voice calls (and may
  // defer itself again if the window still hasn't opened, e.g. DST edges).
  if (payload.callOnly) {
    if (!row || row.status !== 'SENT') {
      log.info({ stagedNotificationId: payload.stagedNotificationId }, 'call-only pass skipped');
      return { outcome: 'skipped' };
    }
    const callResult = await sendCallChannel(
      db,
      log,
      deps,
      row,
      row.recipients as RecipientSnapshot[],
      row.rendered as Rendered,
    );
    if (callResult.deferred && deps.enqueueCallRetry) {
      const cfg = await resolveFirmVoiceConfig(db, row.firmId);
      await deps.enqueueCallRetry(row.id, cfg ? msUntilCallWindow(cfg) : 60 * 60 * 1000, true);
      return { outcome: 'skipped' };
    }
    const merged = {
      ...((row.channelResults as Record<string, ChannelResult> | null) ?? {}),
      CALL: { ok: callResult.ok, sentTo: callResult.sentTo, error: callResult.error },
    };
    await db
      .update(stagedNotifications)
      .set({ channelResults: merged, updatedAt: new Date() })
      .where(eq(stagedNotifications.id, row.id));
    return { outcome: callResult.ok ? 'sent' : 'failed' };
  }

  // Cancel/supersede races and double-fires resolve here: only a row
  // still in SCHEDULED is sendable.
  if (!row || row.status !== 'SCHEDULED') {
    log.info({ stagedNotificationId: payload.stagedNotificationId }, 'staged send skipped');
    return { outcome: 'skipped' };
  }

  // Atomically CLAIM the row (SCHEDULED -> SENDING) so exactly one execution
  // fans out to recipients. A BullMQ stalled-job reprocess (worker killed
  // mid-send) or any double-fire loses this conditional update and skips,
  // preventing duplicate client emails/SMS. (A crash after claiming leaves the
  // row in SENDING — it won't auto-retry, trading at-most-once for no dupes.)
  const claimed = await db
    .update(stagedNotifications)
    .set({ status: 'SENDING', updatedAt: new Date() })
    .where(and(eq(stagedNotifications.id, row.id), eq(stagedNotifications.status, 'SCHEDULED')))
    .returning({ id: stagedNotifications.id });
  if (claimed.length === 0) {
    log.info(
      { stagedNotificationId: payload.stagedNotificationId },
      'staged send skipped (already claimed)',
    );
    return { outcome: 'skipped' };
  }

  // Fire-time guard: the snapshot must still describe reality.
  if (row.triggerKind === 'engagement_status') {
    const ctx = row.triggerContext as { workflowState?: string };
    const [eng] = await db
      .select({ workflowState: engagements.workflowState, status: engagements.status })
      .from(engagements)
      .where(eq(engagements.id, row.entityId))
      .limit(1);
    const [client] = await db
      .select({ status: clients.status })
      .from(clients)
      .where(eq(clients.id, row.clientId))
      .limit(1);
    const stale =
      !eng ||
      eng.workflowState !== ctx.workflowState ||
      eng.status === 'ARCHIVED' ||
      !client ||
      client.status === 'ARCHIVED';
    if (stale) {
      const now = new Date();
      await db
        .update(stagedNotifications)
        .set({
          status: 'CANCELED',
          canceledReason: 'STATE_CHANGED_AT_FIRE',
          updatedAt: now,
        })
        .where(eq(stagedNotifications.id, row.id));
      await db
        .insert(auditLog)
        .values({
          action: 'UPDATE',
          entityType: 'staged_notification',
          entityId: row.id,
          beforeJson: { status: 'SENDING' },
          afterJson: { status: 'CANCELED', canceledReason: 'STATE_CHANGED_AT_FIRE' },
        })
        .catch((err: unknown) => log.error({ err }, 'audit emit failed'));
      log.info({ stagedNotificationId: row.id }, 'staged send canceled at fire (state changed)');
      return { outcome: 'canceled_at_fire' };
    }
  }

  const recipients = row.recipients as RecipientSnapshot[];
  const rendered = row.rendered as Rendered;
  const results: Record<string, ChannelResult> = {};

  let callDeferred = false;
  for (const channel of row.channels) {
    if (channel === 'EMAIL') {
      results['EMAIL'] = await sendEmailChannel(db, log, deps, row, recipients, rendered['EMAIL']);
    } else if (channel === 'SMS') {
      results['SMS'] = await sendSmsChannel(db, log, deps, row, recipients, rendered['SMS']);
    } else if (channel === 'PORTAL') {
      results['PORTAL'] = await sendPortalChannel(db, log, row, rendered['PORTAL']);
    } else if (channel === 'PRINT') {
      results['PRINT'] = await sendPrintChannel(db, log, row, rendered['PRINT']);
    } else if (channel === 'CALL') {
      const call = await sendCallChannel(db, log, deps, row, recipients, rendered);
      if (call.deferred) {
        callDeferred = true;
        results['CALL'] = { ok: false, sentTo: [], error: 'deferred_to_call_window' };
      } else {
        results['CALL'] = { ok: call.ok, sentTo: call.sentTo, error: call.error };
      }
    }
  }

  // 0206 — the calling window is closed: park the voice pass until it opens.
  // If CALL was the only channel, put the row back to SCHEDULED (nothing was
  // sent); otherwise send everything else now and re-enqueue a call-only pass.
  if (callDeferred) {
    const cfg = await resolveFirmVoiceConfig(db, row.firmId);
    const delayMs = cfg ? msUntilCallWindow(cfg) : 60 * 60 * 1000;
    const otherChannels = row.channels.filter((c) => c !== 'CALL');
    if (otherChannels.length === 0) {
      await db
        .update(stagedNotifications)
        .set({ status: 'SCHEDULED', updatedAt: new Date() })
        .where(eq(stagedNotifications.id, row.id));
      // Full replay: the row is SCHEDULED again, so this is NOT call-only.
      if (deps.enqueueCallRetry) await deps.enqueueCallRetry(row.id, delayMs, false);
      log.info({ stagedNotificationId: row.id, delayMs }, 'staged call deferred to window');
      return { outcome: 'skipped' };
    }
    if (deps.enqueueCallRetry) await deps.enqueueCallRetry(row.id, delayMs, true);
  }

  // One client_communication row per successful channel (timeline view).
  // PRINT is audited in print_log (not the client_communication enum).
  for (const [channel, result] of Object.entries(results)) {
    if (!result.ok || channel === 'PRINT') continue;
    const r = rendered[channel];
    await db
      .insert(clientCommunications)
      .values({
        firmId: row.firmId,
        clientId: row.clientId,
        // reason: channel is constrained to EMAIL/SMS/PORTAL/CALL by the
        // row's channels column; all four are in the client_communication enum.
        channel: channel as 'EMAIL' | 'SMS' | 'PORTAL' | 'CALL',
        direction: 'OUTBOUND',
        subject: r?.subject ?? null,
        body: r?.body ?? '',
        occurredAt: new Date(),
        relatedEntityType: row.entityType,
        relatedEntityId: row.entityId,
      })
      .catch((err: unknown) => log.error({ err }, 'client_communication insert failed'));
  }

  const anyOk = Object.values(results).some((r) => r.ok);
  const errors = Object.entries(results)
    .filter(([, r]) => !r.ok)
    .map(([c, r]) => `${c}: ${r.error ?? 'failed'}`);
  const now = new Date();
  await db
    .update(stagedNotifications)
    .set({
      status: anyOk ? 'SENT' : 'FAILED',
      sentAt: anyOk ? now : null,
      channelResults: results,
      errorMessage: errors.length ? errors.join('; ') : null,
      updatedAt: now,
    })
    .where(eq(stagedNotifications.id, row.id));
  await db
    .insert(auditLog)
    .values({
      action: 'UPDATE',
      entityType: 'staged_notification',
      entityId: row.id,
      beforeJson: { status: 'SCHEDULED' },
      afterJson: { status: anyOk ? 'SENT' : 'FAILED', channelResults: results },
    })
    .catch((err: unknown) => log.error({ err }, 'audit emit failed'));

  log.info(
    { stagedNotificationId: row.id, results, outcome: anyOk ? 'sent' : 'failed' },
    'staged notification send complete',
  );
  return { outcome: anyOk ? 'sent' : 'failed' };
}

type StagedRow = typeof stagedNotifications.$inferSelect;

async function sendEmailChannel(
  db: Database,
  log: Logger,
  deps: StagedNotificationSendDeps,
  row: StagedRow,
  recipients: RecipientSnapshot[],
  content: { subject: string | null; body: string } | undefined,
): Promise<ChannelResult> {
  if (!deps.sendEmail) return { ok: false, sentTo: [], error: 'mail_not_configured' };
  if (!content) return { ok: false, sentTo: [], error: 'no_rendered_content' };
  const targets = recipients.filter((r) => r.email);
  if (targets.length === 0) return { ok: false, sentTo: [], error: 'no_recipient_handle' };
  const sentTo: string[] = [];
  let lastError: string | undefined;
  for (const r of targets) {
    try {
      await deps.sendEmail({
        to: r.email!,
        subject: content.subject ?? 'Update from your accounting firm',
        body: content.body,
      });
      sentTo.push(r.email!);
      await logSend(db, log, row, 'email', r.email!, content.subject, null);
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'send_failed';
      log.error({ err, stagedNotificationId: row.id, to: r.email }, 'staged email failed');
      await logSend(db, log, row, 'email', r.email!, content.subject, lastError);
    }
  }
  return sentTo.length > 0
    ? { ok: true, sentTo }
    : { ok: false, sentTo: [], error: lastError ?? 'send_failed' };
}

async function sendSmsChannel(
  db: Database,
  log: Logger,
  deps: StagedNotificationSendDeps,
  row: StagedRow,
  recipients: RecipientSnapshot[],
  content: { subject: string | null; body: string } | undefined,
): Promise<ChannelResult> {
  if (!deps.sendSms) return { ok: false, sentTo: [], error: 'sms_not_configured' };
  if (!content) return { ok: false, sentTo: [], error: 'no_rendered_content' };
  // 0224 — people who opted out of texts are not recipients for this
  // channel; checked live, not from the staging-time snapshot.
  const optedOut = await liveSmsOptOuts(db, recipients);
  const targets = recipients.filter((r) => r.phone && !r.smsOptOut && !optedOut.has(r.personId));
  if (targets.length === 0) return { ok: false, sentTo: [], error: 'no_recipient_handle' };
  const sentTo: string[] = [];
  let lastError: string | undefined;
  for (const r of targets) {
    try {
      await deps.sendSms({ to: r.phone!, body: content.body });
      sentTo.push(r.phone!);
      await logSend(db, log, row, 'sms', r.phone!, null, null);
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'send_failed';
      log.error({ err, stagedNotificationId: row.id, to: r.phone }, 'staged sms failed');
      await logSend(db, log, row, 'sms', r.phone!, null, lastError);
    }
  }
  return sentTo.length > 0
    ? { ok: true, sentTo }
    : { ok: false, sentTo: [], error: lastError ?? 'send_failed' };
}

// 0206 — CALL channel: place one automated voice call per recipient with a
// phone, via the shared placement engine (separate voice Twilio account,
// per-template voice, press-9 opt-out, AMD + status callback, voice_call
// log). Recipients flagged do-not-call get the SMS body instead; when the
// calling window is closed the whole channel defers (`deferred: true`) and
// the caller re-enqueues.
async function sendCallChannel(
  db: Database,
  log: Logger,
  deps: StagedNotificationSendDeps,
  row: StagedRow,
  recipients: RecipientSnapshot[],
  rendered: Rendered,
): Promise<ChannelResult & { deferred?: boolean }> {
  const content = rendered['CALL'];
  if (!content) return { ok: false, sentTo: [], error: 'no_rendered_content' };
  const targets = recipients.filter((r) => r.phone);
  if (targets.length === 0) return { ok: false, sentTo: [], error: 'no_recipient_handle' };
  // 0224 — live SMS opt-outs decide whether a failed call may fall back to a text.
  const smsOptedOut = await liveSmsOptOuts(db, recipients);
  // Per-template voice override, if the firm customized the CALL template.
  const [tpl] = await db
    .select({ voice: notificationTemplates.voice })
    .from(notificationTemplates)
    .where(
      and(
        eq(notificationTemplates.firmId, row.firmId),
        eq(notificationTemplates.kind, row.templateKind),
        eq(notificationTemplates.channel, 'CALL'),
      ),
    )
    .limit(1);
  const fallbackBody = rendered['SMS']?.body ?? content.body;
  const sentTo: string[] = [];
  let lastError: string | undefined;
  for (const r of targets) {
    try {
      const result = await placeVoiceCall(db, {
        firmId: row.firmId,
        kind: row.templateKind,
        to: r.phone!,
        script: content.body,
        // 0224 — no provider-side SMS fallback for an opted-out person.
        fallbackSmsBody: r.smsOptOut || smsOptedOut.has(r.personId) ? undefined : fallbackBody,
        voice: tpl?.voice ?? null,
        personId: r.personId,
        clientId: row.clientId,
        stagedNotificationId: row.id,
        publicBaseUrl: deps.appBaseUrl,
      });
      if (result.ok) {
        sentTo.push(r.phone!);
        await logSend(db, log, row, 'call', r.phone!, null, null);
        continue;
      }
      if (result.code === 'outside_window') {
        // Same firm-wide window for every target — defer the whole channel.
        return { ok: false, sentTo, deferred: true };
      }
      if (result.code === 'do_not_call') {
        // Opted out of calls → deliver the SMS version instead (0224: unless
        // they opted out of texts as well — then nothing goes out).
        if (deps.sendSms && !r.smsOptOut && !smsOptedOut.has(r.personId)) {
          await deps.sendSms({ to: r.phone!, body: fallbackBody });
          sentTo.push(r.phone!);
          await logSend(db, log, row, 'sms', r.phone!, null, null);
        } else {
          lastError = 'do_not_call_no_sms';
        }
        continue;
      }
      lastError = result.code;
      await logSend(db, log, row, 'call', r.phone!, null, lastError);
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'call_failed';
      log.error({ err, stagedNotificationId: row.id, to: r.phone }, 'staged call failed');
      await logSend(db, log, row, 'call', r.phone!, null, lastError);
    }
  }
  return sentTo.length > 0
    ? { ok: true, sentTo }
    : { ok: false, sentTo: [], error: lastError ?? 'call_failed' };
}

async function sendPortalChannel(
  db: Database,
  log: Logger,
  row: StagedRow,
  content: { subject: string | null; body: string } | undefined,
): Promise<ChannelResult> {
  if (!content) return { ok: false, sentTo: [], error: 'no_rendered_content' };
  const identities = await db
    .select({ portalIdentityId: clientPortalAccess.portalIdentityId })
    .from(clientPortalAccess)
    .where(
      and(eq(clientPortalAccess.clientId, row.clientId), eq(clientPortalAccess.status, 'ACTIVE')),
    );
  if (identities.length === 0) return { ok: false, sentTo: [], error: 'no_portal_access' };
  const sentTo: string[] = [];
  for (const ident of identities) {
    try {
      const title = content.subject ?? 'Update from your accounting firm';
      const actionUrl = row.entityType === 'engagement' ? '/engagements' : null;
      await db.insert(portalNotifications).values({
        firmId: row.firmId,
        clientId: row.clientId,
        portalIdentityId: ident.portalIdentityId,
        type: row.triggerKind.toUpperCase(),
        entityType: row.entityType,
        entityId: row.entityId,
        title,
        body: content.body || null,
        actionUrl,
        metadata: { stagedNotificationId: row.id },
      });
      // Phase 26 — mirror the in-portal notification to the identity's
      // installed-PWA devices via Web Push (no-op when VAPID is unconfigured
      // or the identity has no subscriptions).
      await sendWebPushToIdentity(db, ident.portalIdentityId, {
        title,
        body: content.body || null,
        url: actionUrl,
      }).catch((err: unknown) =>
        log.error({ err, portalIdentityId: ident.portalIdentityId }, 'web push send failed'),
      );
      sentTo.push(ident.portalIdentityId);
    } catch (err) {
      log.error(
        { err, stagedNotificationId: row.id, portalIdentityId: ident.portalIdentityId },
        'portal notification insert failed',
      );
    }
  }
  return sentTo.length > 0
    ? { ok: true, sentTo }
    : { ok: false, sentTo: [], error: 'insert_failed' };
}

async function logSend(
  db: Database,
  log: Logger,
  row: StagedRow,
  channel: 'email' | 'sms' | 'call',
  recipient: string,
  subject: string | null,
  errorMessage: string | null,
): Promise<void> {
  await db
    .insert(notificationLog)
    .values({
      firmId: row.firmId,
      channel,
      provider: 'worker',
      templateKey: row.templateKind,
      recipient,
      subject,
      status: errorMessage ? 'failed' : 'sent',
      errorMessage,
    })
    .catch((err: unknown) => log.error({ err }, 'notification_log insert failed'));
}

// 0188 — PRINT channel: render the snapshotted message to a PDF and print
// it to the kind's PRINT-template printer (specific id, or the client
// office's printer). Audited in print_log via sendToPrinter.
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendPrintChannel(
  db: Database,
  log: Logger,
  row: StagedRow,
  rendered: { subject: string | null; body: string } | undefined,
): Promise<ChannelResult> {
  if (!rendered?.body) return { ok: false, sentTo: [], error: 'no_body' };
  const gateway = await resolvePrintGateway(db, row.firmId);
  if (!gateway || !gateway.enabled) return { ok: false, sentTo: [], error: 'gateway_disabled' };

  const [tpl] = await db
    .select({
      printerMode: notificationTemplates.printerMode,
      printerId: notificationTemplates.printerId,
    })
    .from(notificationTemplates)
    .where(
      and(
        eq(notificationTemplates.firmId, row.firmId),
        eq(notificationTemplates.kind, row.templateKind),
        eq(notificationTemplates.channel, 'PRINT'),
      ),
    )
    .limit(1);

  let printerId: number | null;
  if (tpl?.printerMode === 'client_office') {
    let officeId: string | null = null;
    if (row.clientId) {
      const [c] = await db
        .select({ officeId: clients.officeId })
        .from(clients)
        .where(eq(clients.id, row.clientId))
        .limit(1);
      officeId = c?.officeId ?? null;
    }
    printerId = await resolveOfficePrinter(db, row.firmId, officeId);
  } else {
    printerId = tpl?.printerId ?? null;
  }
  if (printerId == null) return { ok: false, sentTo: [], error: 'no_printer' };

  const [firm] = await db
    .select({ name: firms.name })
    .from(firms)
    .where(eq(firms.id, row.firmId))
    .limit(1);
  const html = `<!doctype html><html><head><meta charset="utf-8" />
<style>@page{size:Letter;margin:0.75in}body{font:11pt "Helvetica Neue",Helvetica,Arial,sans-serif;color:#111;margin:0}.firm{font-size:16pt;font-weight:800;border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:16px}.body{white-space:pre-wrap;line-height:1.5}</style>
</head><body><div class="firm">${escHtml(firm?.name ?? 'Firm')}</div><div class="body">${escHtml(rendered.body)}</div></body></html>`;
  try {
    const pdf = await renderHtmlToPdf(html);
    const result = await sendToPrinter({
      db,
      firmId: row.firmId,
      appUserId: null,
      printableType: `notification:${row.templateKind}`,
      printableId: row.entityId,
      pdf,
      printerId,
      copies: 1,
      gateway,
      idempotencyKey: `staged-print:${row.id}`,
    });
    return result.ok ? { ok: true, sentTo: [] } : { ok: false, sentTo: [], error: result.error };
  } catch (err) {
    log.warn({ err, stagedNotificationId: row.id }, 'staged print channel failed');
    return { ok: false, sentTo: [], error: err instanceof Error ? err.message : 'print_failed' };
  }
}
