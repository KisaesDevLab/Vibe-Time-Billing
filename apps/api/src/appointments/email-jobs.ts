// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// BK-6 — appointment transactional emails (confirmation, reschedule,
// cancellation) + the decline notice. Defaults live here; a per-firm
// notification_template override (kind = the event, channel = EMAIL)
// wins. Tokens resolve via the shared merge-token engine. An ICS is
// generated and handed to the mailer (attachment when supported).

import { and, eq, gt, inArray, lte } from 'drizzle-orm';

import { resolveMergeTokens, type MergeContext } from '@vibe/core/proposals';
import type { Database } from '@vibe/db';
import {
  appUsers,
  appointmentParticipants,
  appointmentRemindersSent,
  appointmentStaff,
  appointments,
  clientContacts,
  clients,
  engagements,
  firms,
  notificationTemplates,
  offices,
  persons,
} from '@vibe/db/schema';

import { buildIcs, type IcsAttendee } from '../calendar/ics';
import { getCalendarSettings } from '../calendar/settings';
import { logger } from '../logger';

export type AppointmentEmailEvent =
  | 'appointment_confirmation'
  | 'appointment_reschedule_confirmation'
  | 'appointment_cancellation'
  | 'appointment_reminder'
  | 'appointment_reschedule_request_declined';

interface Template {
  subject: string;
  body: string;
}

const DEFAULTS: Record<AppointmentEmailEvent, Template> = {
  appointment_confirmation: {
    subject: 'Confirmed: {{ appointment.subject }} on {{ appointment.date }}',
    body: `Hi {{ client.name }},

Your appointment is confirmed:

{{ appointment.subject }}
{{ appointment.date }} at {{ appointment.time }} ({{ appointment.duration }} min)
With: {{ staff.names }}
{{ appointment.location_type_label }}: {{ appointment.location_detail }}

Need to cancel? {{ appointment.cancel_url }}
Need a different time? {{ appointment.reschedule_request_url }}

— {{ firm.name }}`,
  },
  appointment_reschedule_confirmation: {
    subject: 'Updated time: {{ appointment.subject }} on {{ appointment.date }}',
    body: `Hi {{ client.name }},

Your appointment has been rescheduled to:

{{ appointment.date }} at {{ appointment.time }} ({{ appointment.duration }} min)
With: {{ staff.names }}
{{ appointment.location_type_label }}: {{ appointment.location_detail }}

Need to cancel? {{ appointment.cancel_url }}

— {{ firm.name }}`,
  },
  appointment_cancellation: {
    subject: 'Cancelled: {{ appointment.subject }} on {{ appointment.date }}',
    body: `Hi {{ client.name }},

Your appointment on {{ appointment.date }} at {{ appointment.time }} with
{{ staff.names }} has been cancelled by {{ appointment.cancelled_by }}.

Please contact us to find another time.

— {{ firm.name }}`,
  },
  appointment_reminder: {
    subject: 'Reminder: {{ appointment.subject }} on {{ appointment.date }}',
    body: `Hi {{ client.name }},

A reminder of your upcoming appointment:

{{ appointment.subject }}
{{ appointment.date }} at {{ appointment.time }} ({{ appointment.duration }} min)
With: {{ staff.names }}
{{ appointment.location_type_label }}: {{ appointment.location_detail }}

Need to cancel? {{ appointment.cancel_url }}
Need a different time? {{ appointment.reschedule_request_url }}

— {{ firm.name }}`,
  },
  appointment_reschedule_request_declined: {
    subject: 'About your reschedule request — {{ appointment.subject }}',
    body: `Hi {{ client.name }},

We weren't able to move your appointment on {{ appointment.date }}. The
original time still stands. If it no longer works, you can cancel here:
{{ appointment.cancel_url }}

— {{ firm.name }}`,
  },
};

export interface AppointmentMail {
  to: string;
  subject: string;
  body: string;
  ics?: string;
  icsFilename?: string;
}
export type SendAppointmentEmail = (mail: AppointmentMail) => Promise<void>;

export interface EmailJobDeps {
  db: Database;
  sendEmail: SendAppointmentEmail;
  appBaseUrl?: string;
  now?: Date;
}

const LOCATION_LABEL: Record<string, string> = {
  IN_PERSON: 'In-person',
  PHONE: 'Phone',
  VIDEO: 'Video',
};

async function firmTimezone(db: Database, firmId: string): Promise<string> {
  const [row] = await db
    .select({ tz: offices.timezone })
    .from(offices)
    .where(and(eq(offices.firmId, firmId), eq(offices.isDefault, true)))
    .limit(1);
  return row?.tz ?? 'America/Chicago';
}

function fmtDate(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(at);
}
function fmtTime(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(at);
}

async function loadTemplate(
  db: Database,
  firmId: string,
  event: AppointmentEmailEvent,
): Promise<Template> {
  const [override] = await db
    .select({
      subject: notificationTemplates.subject,
      body: notificationTemplates.body,
      enabled: notificationTemplates.enabled,
    })
    .from(notificationTemplates)
    .where(
      and(
        eq(notificationTemplates.firmId, firmId),
        eq(notificationTemplates.kind, event),
        eq(notificationTemplates.channel, 'EMAIL'),
      ),
    )
    .limit(1);
  if (override && override.enabled && override.body) {
    return { subject: override.subject ?? DEFAULTS[event].subject, body: override.body };
  }
  return DEFAULTS[event];
}

export function renderTemplate(
  tpl: Template,
  ctx: MergeContext,
): { subject: string; body: string } {
  return {
    subject: resolveMergeTokens(tpl.subject, ctx).output,
    body: resolveMergeTokens(tpl.body, ctx).output,
  };
}

interface Loaded {
  appt: typeof appointments.$inferSelect;
  staffNames: string;
  participants: { email: string | null; name: string | null; contactId: string }[];
  attendees: IcsAttendee[];
  clientName: string;
  engagementName: string | null;
  firmName: string;
  tz: string;
}

async function load(db: Database, appointmentId: string): Promise<Loaded | null> {
  const [appt] = await db
    .select()
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .limit(1);
  if (!appt) return null;
  const staff = await db
    .select({ name: appUsers.fullName, email: appUsers.email })
    .from(appointmentStaff)
    .innerJoin(appUsers, eq(appUsers.id, appointmentStaff.staffId))
    .where(eq(appointmentStaff.appointmentId, appointmentId));
  const participants = await db
    .select({
      email: persons.email,
      name: persons.fullName,
      contactId: appointmentParticipants.clientContactId,
    })
    .from(appointmentParticipants)
    .innerJoin(clientContacts, eq(clientContacts.id, appointmentParticipants.clientContactId))
    .innerJoin(persons, eq(persons.id, clientContacts.personId))
    .where(eq(appointmentParticipants.appointmentId, appointmentId));
  let clientName = '';
  if (appt.clientId) {
    const [c] = await db
      .select({ name: clients.name })
      .from(clients)
      .where(eq(clients.id, appt.clientId))
      .limit(1);
    clientName = c?.name ?? '';
  }
  let engagementName: string | null = null;
  if (appt.engagementId) {
    const [e] = await db
      .select({ name: engagements.name })
      .from(engagements)
      .where(eq(engagements.id, appt.engagementId))
      .limit(1);
    engagementName = e?.name ?? null;
  }
  const [firm] = await db
    .select({ name: firms.name })
    .from(firms)
    .where(eq(firms.id, appt.firmId))
    .limit(1);
  const tz = await firmTimezone(db, appt.firmId);
  const attendees: IcsAttendee[] = [];
  for (const s of staff) if (s.email) attendees.push({ email: s.email, name: s.name });
  for (const p of participants) if (p.email) attendees.push({ email: p.email, name: p.name });
  return {
    appt,
    staffNames: staff.map((s) => s.name).join(', '),
    participants,
    attendees,
    clientName,
    engagementName,
    firmName: firm?.name ?? 'Your firm',
    tz,
  };
}

function buildCtx(l: Loaded, appBaseUrl: string, cancelledBy?: string): MergeContext {
  const { appt, tz } = l;
  return {
    client: { name: l.clientName || 'there' },
    firm: { name: l.firmName },
    engagement: { name: l.engagementName ?? '' },
    staff: { names: l.staffNames },
    appointment: {
      subject: appt.title,
      date: fmtDate(appt.startsAt, tz),
      time: fmtTime(appt.startsAt, tz),
      duration: String(
        appt.durationMinutes ??
          Math.round((appt.endsAt.getTime() - appt.startsAt.getTime()) / 60000),
      ),
      location_type_label: LOCATION_LABEL[appt.location] ?? appt.location,
      location_detail: appt.locationDetail ?? '',
      cancelled_by: cancelledBy === 'client' ? 'you' : 'your firm',
      cancel_url: `${appBaseUrl}/api/public/appointments/${appt.cancelToken}/cancel`,
      reschedule_request_url: `${appBaseUrl}/api/public/appointments/${appt.rescheduleToken}/request`,
    },
  };
}

function icsFor(l: Loaded, opts: { cancel?: boolean } = {}): string {
  return buildIcs({
    uid: `appt-${l.appt.id}@vibe`,
    title: l.appt.title,
    start: l.appt.startsAt,
    end: l.appt.endsAt,
    location: l.appt.locationDetail ?? l.appt.location,
    organizerName: l.firmName,
    attendees: l.attendees,
    method: opts.cancel ? 'CANCEL' : 'PUBLISH',
    status: opts.cancel ? 'CANCELLED' : 'CONFIRMED',
  });
}

async function sendToParticipants(
  deps: EmailJobDeps,
  l: Loaded,
  event: AppointmentEmailEvent,
  ctx: MergeContext,
  ics: string,
  cancelledBy?: string,
): Promise<{ sent: number; contactIds: string[] }> {
  const tpl = await loadTemplate(deps.db, l.appt.firmId, event);
  void cancelledBy;
  const contactIds: string[] = [];
  for (const p of l.participants) {
    if (!p.email) continue;
    const { subject, body } = renderTemplate(tpl, {
      ...ctx,
      client: { name: p.name ?? l.clientName ?? 'there' },
    });
    await deps.sendEmail({ to: p.email, subject, body, ics, icsFilename: 'appointment.ics' });
    contactIds.push(p.contactId);
  }
  return { sent: contactIds.length, contactIds };
}

export async function runAppointmentConfirmationSend(
  deps: EmailJobDeps,
  job: { appointmentId: string },
): Promise<{ sent: number }> {
  const l = await load(deps.db, job.appointmentId);
  if (!l) return { sent: 0 };
  const ctx = buildCtx(l, deps.appBaseUrl ?? '');
  const ics = icsFor(l);
  const { sent, contactIds } = await sendToParticipants(
    deps,
    l,
    'appointment_confirmation',
    ctx,
    ics,
  );
  if (contactIds.length > 0) {
    await deps.db
      .update(appointmentParticipants)
      .set({ confirmationSentAt: deps.now ?? new Date() })
      .where(
        and(
          eq(appointmentParticipants.appointmentId, job.appointmentId),
          inArray(appointmentParticipants.clientContactId, contactIds),
        ),
      )
      .catch((err: unknown) => logger.warn({ err }, 'confirmation stamp failed'));
  }
  return { sent };
}

export async function runAppointmentRescheduleConfirmationSend(
  deps: EmailJobDeps,
  job: { appointmentId: string },
): Promise<{ sent: number }> {
  const l = await load(deps.db, job.appointmentId);
  if (!l) return { sent: 0 };
  const ctx = buildCtx(l, deps.appBaseUrl ?? '');
  const ics = icsFor(l);
  const { sent } = await sendToParticipants(
    deps,
    l,
    'appointment_reschedule_confirmation',
    ctx,
    ics,
  );
  return { sent };
}

export async function runAppointmentCancellationSend(
  deps: EmailJobDeps,
  job: { appointmentId: string; cancelledBy: 'staff' | 'client' },
): Promise<{ sent: number }> {
  const l = await load(deps.db, job.appointmentId);
  if (!l) return { sent: 0 };
  const ctx = buildCtx(l, deps.appBaseUrl ?? '', job.cancelledBy);
  const ics = icsFor(l, { cancel: true });
  const { sent, contactIds } = await sendToParticipants(
    deps,
    l,
    'appointment_cancellation',
    ctx,
    ics,
    job.cancelledBy,
  );
  if (contactIds.length > 0) {
    await deps.db
      .update(appointmentParticipants)
      .set({ cancellationSentAt: deps.now ?? new Date() })
      .where(
        and(
          eq(appointmentParticipants.appointmentId, job.appointmentId),
          inArray(appointmentParticipants.clientContactId, contactIds),
        ),
      )
      .catch(() => undefined);
  }
  return { sent };
}

/**
 * Reminder heartbeat — sends pre-meeting reminders for SCHEDULED
 * appointments at the firm's reminder offsets (calendar_settings.
 * reminder_offsets_minutes), honoring per-contact opt-out, idempotent via
 * appointment_reminders_sent. Run on a 5-minute cron from the worker.
 */
export async function runAppointmentReminderTick(
  deps: EmailJobDeps,
  nowArg?: Date,
): Promise<{ sent: number }> {
  const db = deps.db;
  const now = nowArg ?? deps.now ?? new Date();
  const MAX_LOOKAHEAD_MIN = 8 * 24 * 60;
  const windowEnd = new Date(now.getTime() + MAX_LOOKAHEAD_MIN * 60_000);

  const due = await db
    .select({ id: appointments.id, firmId: appointments.firmId, startsAt: appointments.startsAt })
    .from(appointments)
    .where(
      and(
        eq(appointments.status, 'SCHEDULED'),
        gt(appointments.startsAt, now),
        lte(appointments.startsAt, windowEnd),
      ),
    );

  const offsetsByFirm = new Map<string, number[]>();
  let sent = 0;

  for (const appt of due) {
    let offsets = offsetsByFirm.get(appt.firmId);
    if (!offsets) {
      const s = await getCalendarSettings(db, appt.firmId);
      const raw = s.reminderOffsetsMinutes as unknown;
      offsets = Array.isArray(raw) ? (raw as number[]) : [1440, 120];
      offsetsByFirm.set(appt.firmId, offsets);
    }
    const elapsed = offsets.filter((o) => appt.startsAt.getTime() - o * 60_000 <= now.getTime());
    if (elapsed.length === 0) continue;

    const parts = await db
      .select({
        contactId: appointmentParticipants.clientContactId,
        email: persons.email,
        name: persons.fullName,
        optIn: clientContacts.receiveAppointmentReminders,
      })
      .from(appointmentParticipants)
      .innerJoin(clientContacts, eq(clientContacts.id, appointmentParticipants.clientContactId))
      .innerJoin(persons, eq(persons.id, clientContacts.personId))
      .where(eq(appointmentParticipants.appointmentId, appt.id));
    const recipients = parts.filter((p) => p.email && p.optIn !== false);
    if (recipients.length === 0) continue;

    const already = await db
      .select({
        c: appointmentRemindersSent.clientContactId,
        o: appointmentRemindersSent.reminderOffsetMinutes,
      })
      .from(appointmentRemindersSent)
      .where(eq(appointmentRemindersSent.appointmentId, appt.id));
    const sentSet = new Set(already.map((a) => `${a.c}:${a.o}`));

    const loaded = await load(db, appt.id);
    if (!loaded) continue;
    const tpl = await loadTemplate(db, appt.firmId, 'appointment_reminder');
    const ics = icsFor(loaded);
    const ctx = buildCtx(loaded, deps.appBaseUrl ?? '');

    for (const o of elapsed) {
      for (const p of recipients) {
        if (sentSet.has(`${p.contactId}:${o}`)) continue;
        const { subject, body } = renderTemplate(tpl, {
          ...ctx,
          client: { name: p.name ?? loaded.clientName ?? 'there' },
        });
        await deps.sendEmail({ to: p.email!, subject, body, ics, icsFilename: 'appointment.ics' });
        await db
          .insert(appointmentRemindersSent)
          .values({
            appointmentId: appt.id,
            clientContactId: p.contactId,
            reminderOffsetMinutes: o,
          })
          .onConflictDoNothing();
        sent++;
      }
    }
  }
  return { sent };
}
