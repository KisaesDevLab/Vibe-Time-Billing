// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Request-reminder worker. Daily sweep that emails the client billing
// contact when an OPEN / NEEDS_INFO request is within
// `reminder_days_before` of its due_date. Idempotent within a day via
// last_reminder_sent_at.

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { clientContacts, clientRequests, clients, engagements } from '@vibe/db/schema';

import type { MailDispatch } from '../dispatchers';

export interface RequestReminderResult {
  scanned: number;
  sent: number;
  skipped: number;
}

export async function runRequestReminderTick(
  db: Database,
  log: Logger,
  args: { sendEmail?: MailDispatch | undefined; portalBaseUrl?: string | undefined },
  now = new Date(),
): Promise<RequestReminderResult> {
  const today = now.toISOString().slice(0, 10);
  const result: RequestReminderResult = { scanned: 0, sent: 0, skipped: 0 };

  // Single SQL pass: due-soon, not-recently-reminded, eligible status.
  const due = await db
    .select({
      id: clientRequests.id,
      firmId: clientRequests.firmId,
      title: clientRequests.title,
      dueDate: clientRequests.dueDate,
      engagementId: clientRequests.engagementId,
      reminderDays: clientRequests.reminderDaysBefore,
      lastSent: clientRequests.lastReminderSentAt,
    })
    .from(clientRequests)
    .where(
      and(
        inArray(clientRequests.status, ['OPEN', 'NEEDS_INFO']),
        isNotNull(clientRequests.reminderDaysBefore),
        isNotNull(clientRequests.dueDate),
        sql`${clientRequests.dueDate} - ${today}::date <= ${clientRequests.reminderDaysBefore}`,
        sql`(${clientRequests.lastReminderSentAt} IS NULL
             OR ${clientRequests.lastReminderSentAt} < ${today}::date)`,
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
          email: clientContacts.email,
          isBilling: clientContacts.isBilling,
          isPrimary: clientContacts.isPrimary,
        })
        .from(clientContacts)
        .where(inArray(clientContacts.clientId, clientIds))
    : [];
  const billingByClient = new Map<string, string>();
  const primaryByClient = new Map<string, string>();
  for (const c of contactRows) {
    if (!c.email) continue;
    if (c.isBilling) billingByClient.set(c.clientId, c.email);
    else if (c.isPrimary) primaryByClient.set(c.clientId, c.email);
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
    if (!email) {
      result.skipped += 1;
      log.info({ requestId: req.id, clientId: eng.clientId }, 'request-reminder: no email');
      continue;
    }
    const link = `${portalBase.replace(/\/$/, '')}/requests/${req.id}`;
    const body = [
      `Hello${client ? ` ${client.name}` : ''},`,
      '',
      `This is a friendly reminder that the following request from your firm is due on ${req.dueDate}:`,
      '',
      `  ${req.title}`,
      '',
      `Please review and respond here: ${link}`,
    ].join('\n');
    try {
      await args.sendEmail({
        to: email,
        subject: `Reminder: ${req.title} — due ${req.dueDate}`,
        body,
      });
      await db
        .update(clientRequests)
        .set({ lastReminderSentAt: now, updatedAt: now })
        .where(eq(clientRequests.id, req.id));
      result.sent += 1;
    } catch (err) {
      log.warn({ err, requestId: req.id }, 'request-reminder: send failed');
      result.skipped += 1;
    }
  }

  return result;
}
