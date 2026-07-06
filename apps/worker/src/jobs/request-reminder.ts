// SPDX-License-Identifier: Elastic-2.0
//
// Request-reminder worker. Daily sweep that emails the client billing
// contact when an OPEN / NEEDS_INFO request is within
// `reminder_days_before` of its due_date. Idempotent within a day via
// last_reminder_sent_at.

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import {
  clientContacts,
  clientRequestReminderSent,
  clientRequests,
  clients,
  engagements,
  persons,
  type ReminderStep,
} from '@vibe/db/schema';

import type { MailDispatch, SmsDispatch } from '../dispatchers';
import { firmScope, renderTemplate } from '../notifications/templating';

export interface RequestReminderResult {
  scanned: number;
  sent: number;
  skipped: number;
  smsSent: number;
  activated: number;
}

export async function runRequestReminderTick(
  db: Database,
  log: Logger,
  args: {
    sendEmail?: MailDispatch | undefined;
    sendSms?: SmsDispatch | undefined;
    portalBaseUrl?: string | undefined;
  },
  now = new Date(),
): Promise<RequestReminderResult> {
  const today = now.toISOString().slice(0, 10);
  const result: RequestReminderResult = {
    scanned: 0,
    sent: 0,
    skipped: 0,
    smsSent: 0,
    activated: 0,
  };

  // 0198 — activation pass: open PENDING (scheduled) requests whose
  // activation_date has arrived, so they become visible to the client and
  // enter the reminder schedule. Runs before the reminder pass so a same-day
  // reminder step can fire immediately.
  const activated = await db
    .update(clientRequests)
    .set({ status: 'OPEN', activatedAt: now, updatedAt: now })
    .where(
      and(
        eq(clientRequests.status, 'PENDING'),
        isNotNull(clientRequests.activationDate),
        sql`${clientRequests.activationDate} <= ${today}::date`,
      ),
    )
    .returning({ id: clientRequests.id });
  result.activated = activated.length;
  if (activated.length > 0) {
    log.info({ activated: activated.length }, 'request-reminder: activated PENDING requests');
  }

  // Single SQL pass: due-soon, not-recently-reminded, eligible status.
  //
  // Re-fire policy: GENERAL requests re-remind daily across the window
  // (last_sent IS NULL OR < today). DROP_OFF requests fire exactly once
  // — only when last_sent IS NULL — so the client gets a single
  // email+SMS nudge when the reminder window opens.
  const due = await db
    .select({
      id: clientRequests.id,
      firmId: clientRequests.firmId,
      title: clientRequests.title,
      kind: clientRequests.kind,
      dueDate: clientRequests.dueDate,
      engagementId: clientRequests.engagementId,
      reminderDays: clientRequests.reminderDaysBefore,
      reminderSchedule: clientRequests.reminderSchedule,
      lastSent: clientRequests.lastReminderSentAt,
    })
    .from(clientRequests)
    .where(
      and(
        inArray(clientRequests.status, ['OPEN', 'NEEDS_INFO']),
        isNotNull(clientRequests.dueDate),
        // Either a legacy single lead or a multi-step schedule.
        sql`(${clientRequests.reminderDaysBefore} IS NOT NULL
             OR ${clientRequests.reminderSchedule} IS NOT NULL)`,
        // DROP_OFF reminders are bounded to the window [due - N, due]:
        // never nudge "drop off by {past date}". GENERAL keeps its prior
        // behavior (re-fires daily while OPEN, even once overdue).
        sql`(${clientRequests.kind} <> 'DROP_OFF'
             OR ${clientRequests.dueDate} - ${today}::date >= 0)`,
        // Due-window prefilter: legacy uses reminder_days_before; scheduled
        // rows use a fixed 15-day superset (max supported offset ~14d), with
        // exact per-step timing checked in JS below.
        sql`(
          (${clientRequests.reminderDaysBefore} IS NOT NULL
           AND ${clientRequests.dueDate} - ${today}::date <= ${clientRequests.reminderDaysBefore})
          OR (${clientRequests.reminderSchedule} IS NOT NULL
              AND ${clientRequests.dueDate} - ${today}::date <= 15)
        )`,
        // Once-only / re-fire policy applies to the LEGACY path only; scheduled
        // rows are idempotent via the client_request_reminder_sent ledger.
        sql`(${clientRequests.reminderSchedule} IS NOT NULL
             OR ${clientRequests.lastReminderSentAt} IS NULL
             OR (${clientRequests.kind} <> 'DROP_OFF'
                 AND ${clientRequests.lastReminderSentAt} < ${today}::date))`,
      ),
    )
    .limit(500);

  result.scanned = due.length;
  if (due.length === 0) return result;

  if (!args.sendEmail) {
    log.info({ scanned: due.length }, 'request-reminder: no mail dispatcher; skip send');
    result.skipped = due.length;
    return result;
  }

  // Resolve engagement → client_id for each request.
  const engIds = Array.from(new Set(due.map((r) => r.engagementId)));
  const engRows = engIds.length
    ? await db
        .select({ id: engagements.id, clientId: engagements.clientId, name: engagements.name })
        .from(engagements)
        .where(inArray(engagements.id, engIds))
    : [];
  const engById = new Map(engRows.map((e) => [e.id, e]));

  // Resolve billing contact email per client.
  const clientIds = Array.from(new Set(engRows.map((e) => e.clientId)));
  const clientRows = clientIds.length
    ? await db
        .select({ id: clients.id, name: clients.name })
        .from(clients)
        .where(inArray(clients.id, clientIds))
    : [];
  const clientById = new Map(clientRows.map((c) => [c.id, c]));

  const contactRows = clientIds.length
    ? await db
        .select({
          clientId: clientContacts.clientId,
          email: persons.email,
          phone: persons.mobile,
          altPhone: persons.phone,
          isBilling: clientContacts.isBilling,
          isPrimary: clientContacts.isPrimary,
        })
        .from(clientContacts)
        .innerJoin(persons, eq(persons.id, clientContacts.personId))
        .where(inArray(clientContacts.clientId, clientIds))
    : [];
  const billingByClient = new Map<string, string>();
  const primaryByClient = new Map<string, string>();
  // Phone for SMS: prefer mobile, fall back to landline.
  const billingPhoneByClient = new Map<string, string>();
  const primaryPhoneByClient = new Map<string, string>();
  for (const c of contactRows) {
    if (c.email) {
      if (c.isBilling) billingByClient.set(c.clientId, c.email);
      else if (c.isPrimary) primaryByClient.set(c.clientId, c.email);
    }
    const phone = c.phone ?? c.altPhone;
    if (phone) {
      if (c.isBilling) billingPhoneByClient.set(c.clientId, phone);
      else if (c.isPrimary) primaryPhoneByClient.set(c.clientId, phone);
    }
  }

  const portalBase =
    args.portalBaseUrl ?? process.env['PORTAL_BASE_URL'] ?? 'https://portal.firm.com';

  for (const req of due) {
    const eng = engById.get(req.engagementId);
    if (!eng) {
      result.skipped += 1;
      continue;
    }
    const client = clientById.get(eng.clientId);
    const email = billingByClient.get(eng.clientId) ?? primaryByClient.get(eng.clientId);
    const phone = billingPhoneByClient.get(eng.clientId) ?? primaryPhoneByClient.get(eng.clientId);
    const isDropOff = req.kind === 'DROP_OFF';
    const link = `${portalBase.replace(/\/$/, '')}/requests/${req.id}`;
    const firm = await firmScope(db, req.firmId);

    // Send helpers (bound to this request); return true on success.
    const sendEmailReminder = async (): Promise<boolean> => {
      if (!email || !args.sendEmail) return false;
      const fallbackBody = [
        `Hello${client ? ` ${client.name}` : ''},`,
        '',
        isDropOff
          ? `This is a reminder to drop off / upload the requested information by ${req.dueDate}:`
          : `This is a friendly reminder that the following request from your firm is due on ${req.dueDate}:`,
        '',
        `  ${req.title}`,
        '',
        `Please upload here: ${link}`,
      ].join('\n');
      const rendered = await renderTemplate({
        db,
        firmId: req.firmId,
        kind: isDropOff ? 'dropoff_reminder' : 'document_request',
        channel: 'EMAIL',
        fallback: { subject: `Reminder: ${req.title} — due ${req.dueDate}`, body: fallbackBody },
        context: isDropOff
          ? {
              client: { name: client?.name ?? '' },
              firm,
              engagement: { name: eng.name },
              link: { url: link },
            }
          : {
              client: { name: client?.name ?? '' },
              firm,
              request: { title: req.title },
              link: { url: link },
            },
      });
      try {
        await args.sendEmail({
          to: email,
          subject: rendered.subject ?? `Reminder: ${req.title} — due ${req.dueDate}`,
          body: rendered.body,
        });
        return true;
      } catch (err) {
        log.warn({ err, requestId: req.id }, 'request-reminder: email send failed');
        return false;
      }
    };
    const sendSmsReminder = async (): Promise<boolean> => {
      if (!phone || !args.sendSms) return false;
      try {
        const renderedSms = await renderTemplate({
          db,
          firmId: req.firmId,
          kind: 'dropoff_reminder',
          channel: 'SMS',
          fallback: {
            subject: null,
            body: `Reminder: please drop off / upload "${req.title}" by ${req.dueDate}. ${link}`,
          },
          context: {
            client: { name: client?.name ?? '' },
            firm,
            engagement: { name: eng.name },
            link: { url: link },
          },
        });
        await args.sendSms({ to: phone, body: renderedSms.body });
        return true;
      } catch (smsErr) {
        log.warn({ err: smsErr, requestId: req.id }, 'request-reminder: sms send failed');
        return false;
      }
    };

    const schedule =
      Array.isArray(req.reminderSchedule) && req.reminderSchedule.length > 0
        ? (req.reminderSchedule as ReminderStep[])
        : null;

    // ---- Scheduled path (drop-off multi-reminder): one send per due,
    //      unsent (offset, channel) step; idempotent via the ledger. ----
    if (schedule) {
      const sentRows = await db
        .select({
          offset: clientRequestReminderSent.reminderOffsetMinutes,
          channel: clientRequestReminderSent.channel,
        })
        .from(clientRequestReminderSent)
        .where(eq(clientRequestReminderSent.clientRequestId, req.id));
      const sentSet = new Set(sentRows.map((s) => `${s.offset}:${s.channel}`));
      const dueMs = Date.parse(`${req.dueDate}T00:00:00Z`);
      for (const step of schedule) {
        const key = `${step.offsetMinutes}:${step.channel}`;
        if (sentSet.has(key)) continue;
        // Not yet time (due - offset still in the future).
        if (dueMs - step.offsetMinutes * 60_000 > now.getTime()) continue;
        let ok = false;
        if (step.channel === 'EMAIL') ok = await sendEmailReminder();
        else if (step.channel === 'SMS') ok = await sendSmsReminder();
        else continue; // CALL not supported for drop-offs
        if (ok) {
          if (step.channel === 'EMAIL') result.sent += 1;
          else result.smsSent += 1;
          await db
            .insert(clientRequestReminderSent)
            .values({
              clientRequestId: req.id,
              reminderOffsetMinutes: step.offsetMinutes,
              channel: step.channel,
            })
            .onConflictDoNothing();
          sentSet.add(key);
        } else {
          result.skipped += 1;
        }
      }
      continue;
    }

    // ---- Legacy single-reminder path ----
    if (!email) {
      result.skipped += 1;
      log.info({ requestId: req.id, clientId: eng.clientId }, 'request-reminder: no email');
      continue;
    }
    const emailedOk = await sendEmailReminder();
    if (!emailedOk) {
      result.skipped += 1;
      continue;
    }
    result.sent += 1;
    if (isDropOff) {
      if (await sendSmsReminder()) result.smsSent += 1;
    }
    await db
      .update(clientRequests)
      .set({ lastReminderSentAt: now, updatedAt: now })
      .where(eq(clientRequests.id, req.id));
  }

  return result;
}
