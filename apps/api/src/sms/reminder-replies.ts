// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// D13 / Phase 12 — appointment reminder reply parsing, as an ingest hook.
// A reply tied (via reply-context ≤14 d, or an upcoming appointment for
// the number) to an appointment and starting with C/Y/CONFIRM confirms the
// participant, marks the text read, and auto-replies from a template;
// R/RESCHEDULE opens a reschedule request, notifies the assignee (or the
// appointment lead), and stays unread. Everything else falls through to
// the ordinary inbox flow. Zod-free (the worker poll runs it too).

import { and, desc, eq, gt, isNotNull } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import {
  appointmentParticipants,
  appointmentRescheduleRequests,
  appointments,
  smsConversations,
  smsMessages,
} from '@vibe/db/schema';

import {
  confirmParticipant,
  findUpcomingAppointmentForPhone,
  parseReminderIntent,
} from '../appointments/confirm';
import { firmScope, renderTemplate } from '../notifications/templating';
import { REPLY_CONTEXT_WINDOW_MS } from './associate';
import type { IngestHooks } from './ingest';
import { insertSmsNotifications } from './notify';
import type { SmsSendService } from './send-service';

export interface ReminderReplyDeps {
  smsSend: SmsSendService;
  log: Logger;
  now?: () => Date;
}

async function recentReminderAppointment(
  db: Database,
  firmId: string,
  to: string,
  now: Date,
): Promise<string | null> {
  const since = new Date(now.getTime() - REPLY_CONTEXT_WINDOW_MS);
  const [m] = await db
    .select({ appointmentId: smsMessages.appointmentId })
    .from(smsMessages)
    .where(
      and(
        eq(smsMessages.firmId, firmId),
        eq(smsMessages.direction, 'outbound'),
        eq(smsMessages.toE164, to),
        isNotNull(smsMessages.appointmentId),
        gt(smsMessages.createdAt, since),
      ),
    )
    .orderBy(desc(smsMessages.createdAt))
    .limit(1);
  return m?.appointmentId ?? null;
}

export function createReminderReplyHook(
  deps: ReminderReplyDeps,
): NonNullable<IngestHooks['onInbound']> {
  const nowFn = deps.now ?? ((): Date => new Date());
  return async (ctx) => {
    const intent = parseReminderIntent(ctx.body);
    if (!intent) return { handled: false };
    const { db } = ctx;
    const now = nowFn();

    // Which appointment? reply-context first, then an upcoming one by phone.
    let appointmentId = await recentReminderAppointment(db, ctx.firmId, ctx.from, now);
    let contactId = ctx.clientContactId;
    if (!appointmentId) {
      const found = await findUpcomingAppointmentForPhone(db, ctx.from, now);
      if (!found) return { handled: false };
      appointmentId = found.appointmentId;
      contactId = contactId ?? found.contactId;
    }
    if (!contactId) {
      const [p] = await db
        .select({ contactId: appointmentParticipants.clientContactId })
        .from(appointmentParticipants)
        .where(eq(appointmentParticipants.appointmentId, appointmentId))
        .limit(1);
      contactId = p?.contactId ?? null;
    }
    const [appt] = await db
      .select({
        id: appointments.id,
        leadAppUserId: appointments.leadAppUserId,
        title: appointments.title,
      })
      .from(appointments)
      .where(eq(appointments.id, appointmentId))
      .limit(1);
    if (!appt) return { handled: false };

    await db
      .update(smsMessages)
      .set({ parsedIntent: intent, appointmentId })
      .where(eq(smsMessages.id, ctx.messageId));

    if (intent === 'confirm') {
      if (contactId) await confirmParticipant(db, appointmentId, contactId, 'sms');
      const firm = await firmScope(db, ctx.firmId);
      const rendered = await renderTemplate({
        db,
        firmId: ctx.firmId,
        kind: 'appointment_confirmed_reply',
        channel: 'SMS',
        fallback: {
          subject: null,
          body: "Thanks — you're confirmed. Reply R if you need to reschedule.",
        },
        context: { firm, appointment: { title: appt.title } },
      });
      const r = await deps.smsSend.send({
        to: ctx.from,
        body: rendered.body,
        templateKey: 'appointment_confirmed_reply',
        context: {
          kind: 'auto_reply',
          firmId: ctx.firmId,
          conversationId: ctx.conversationId,
          appointmentId,
          personId: ctx.personId,
        },
      });
      if (!r.ok)
        deps.log.warn({ reason: r.reason, appointmentId }, 'sms confirm auto-reply not sent');
      return { handled: true, markRead: true };
    }

    // reschedule
    await db
      .insert(appointmentRescheduleRequests)
      .values({
        appointmentId,
        requestedByContactId: contactId,
        requestedAt: now,
        message: ctx.body.slice(0, 2000),
      })
      .catch((err: unknown) =>
        deps.log.warn({ err, appointmentId }, 'reschedule request insert failed'),
      );
    const [conv] = await db
      .select({ assignedUserId: smsConversations.assignedUserId })
      .from(smsConversations)
      .where(eq(smsConversations.id, ctx.conversationId))
      .limit(1);
    const recipient = conv?.assignedUserId ?? appt.leadAppUserId;
    if (recipient) {
      await insertSmsNotifications(db, {
        firmId: ctx.firmId,
        recipients: [recipient],
        type: 'sms_reschedule_request',
        conversationId: ctx.conversationId,
        title: `Reschedule requested by text — ${appt.title}`,
        body: ctx.body.slice(0, 140),
        metadata: { appointmentId, messageId: ctx.messageId },
      }).catch((err: unknown) => deps.log.warn({ err }, 'reschedule notification failed'));
    }
    return { handled: true, markRead: false };
  };
}
