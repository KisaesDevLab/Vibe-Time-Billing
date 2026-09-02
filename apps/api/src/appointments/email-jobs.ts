// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
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
  appointmentTypes,
  appointments,
  clientCommunications,
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
import { firmScope } from '../notifications/templating';
import { resolveSchedule } from './reminders';

export type AppointmentEmailEvent =
  | 'appointment_confirmation'
  | 'appointment_reschedule_confirmation'
  | 'appointment_cancellation'
  | 'appointment_reminder'
  | 'appointment_reschedule_request_declined'
  | 'appointment_reschedule_requested_staff';

interface Template {
  subject: string;
  body: string;
  // 0206 — CALL templates may carry a per-template voice override.
  voice?: string | null;
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
  appointment_reschedule_requested_staff: {
    subject: 'Reschedule requested: {{ appointment.subject }} ({{ appointment.date }})',
    body: `{{ client.name }} asked to reschedule:

{{ appointment.subject }}
Currently {{ appointment.date }} at {{ appointment.time }}
With: {{ staff.names }}

Their note: {{ request.message }}

Review and propose a new time in the reschedule inbox.

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
/** 0121 — optional reminder channels (worker injects real dispatchers).
 *  firmId lets the worker resolve the firm's DB-backed SMS provider. */
export type SendAppointmentSms = (msg: {
  to: string;
  body: string;
  firmId: string;
  // 0234 — thread context for the SMS inbox send service.
  appointmentId?: string;
  personId?: string | null;
  clientId?: string | null;
  contactId?: string | null;
}) => Promise<void | { skipped: 'opted_out' | 'no_consent' | 'a2p_unregistered' | 'no_line' }>;
// 0206 — the dialer is the shared voice engine (placeVoiceCall): it applies
// the calling window, do-not-call, per-template voice, AMD + SMS fallback,
// and returns a coded result instead of throwing on gate refusals.
export type PlaceAppointmentCall = (msg: {
  firmId: string;
  to: string;
  script: string;
  confirmUrl?: string;
  fallbackSmsBody?: string;
  voice?: string | null;
  personId?: string | null;
  clientId?: string | null;
  appointmentId?: string;
}) => Promise<{ ok: boolean; code?: string }>;

export interface EmailJobDeps {
  db: Database;
  sendEmail: SendAppointmentEmail;
  /** 0121 — present only when an SMS provider is configured. */
  sendSms?: SendAppointmentSms;
  /** 0121 — present only when a voice provider is configured. */
  placeCall?: PlaceAppointmentCall;
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

type ReminderChannel = 'EMAIL' | 'SMS' | 'CALL';

// 0121 — per-channel defaults for the reminder. SMS is concise + asks for a
// reply to confirm; CALL is a plain TTS script (the dialer appends "Press 1 to
// confirm"). EMAIL keeps the rich DEFAULTS body above.
const REMINDER_SMS_DEFAULT: Template = {
  subject: '',
  body: `Reminder: {{ appointment.subject }} on {{ appointment.date }} at {{ appointment.time }} with {{ staff.names }}. Reply YES to confirm.`,
};
const REMINDER_CALL_DEFAULT: Template = {
  subject: '',
  body: `Hello {{ client.name }}. This is a reminder from {{ firm.name }} about your appointment, {{ appointment.subject }}, on {{ appointment.date }} at {{ appointment.time }}.`,
};

function channelDefault(event: AppointmentEmailEvent, channel: ReminderChannel): Template {
  if (channel === 'SMS' && event === 'appointment_reminder') return REMINDER_SMS_DEFAULT;
  if (channel === 'CALL' && event === 'appointment_reminder') return REMINDER_CALL_DEFAULT;
  return DEFAULTS[event];
}

async function loadTemplate(
  db: Database,
  firmId: string,
  event: AppointmentEmailEvent,
  channel: ReminderChannel = 'EMAIL',
): Promise<Template> {
  const fallback = channelDefault(event, channel);
  const [override] = await db
    .select({
      subject: notificationTemplates.subject,
      body: notificationTemplates.body,
      enabled: notificationTemplates.enabled,
      voice: notificationTemplates.voice,
    })
    .from(notificationTemplates)
    .where(
      and(
        eq(notificationTemplates.firmId, firmId),
        eq(notificationTemplates.kind, event),
        eq(notificationTemplates.channel, channel),
      ),
    )
    .limit(1);
  if (override && override.enabled && override.body) {
    return {
      subject: override.subject ?? fallback.subject,
      body: override.body,
      voice: override.voice ?? null,
    };
  }
  return fallback;
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
  firmTokens: Record<string, string>;
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
  const firmTokens = await firmScope(db, appt.firmId);
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
    firmTokens,
    tz,
  };
}

function buildCtx(l: Loaded, appBaseUrl: string, cancelledBy?: string): MergeContext {
  const { appt, tz } = l;
  return {
    client: { name: l.clientName || 'there' },
    firm: { ...l.firmTokens, name: l.firmName },
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
 * Decline notice — sent to the appointment's participants when staff decline
 * a client's reschedule request. The original time stands.
 */
export async function runAppointmentDeclineSend(
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
    'appointment_reschedule_request_declined',
    ctx,
    ics,
  );
  return { sent };
}

/**
 * Staff alert — emails the booking staff when a client requests a reschedule
 * via the public link, so they don't rely solely on the in-app inbox.
 */
export async function runAppointmentRescheduleRequestedStaffSend(
  deps: EmailJobDeps,
  job: { appointmentId: string; message?: string | null },
): Promise<{ sent: number }> {
  const l = await load(deps.db, job.appointmentId);
  if (!l || !l.appt.createdById) return { sent: 0 };
  const [staff] = await deps.db
    .select({ email: appUsers.email, name: appUsers.fullName })
    .from(appUsers)
    .where(eq(appUsers.id, l.appt.createdById))
    .limit(1);
  if (!staff?.email) return { sent: 0 };
  const tpl = await loadTemplate(deps.db, l.appt.firmId, 'appointment_reschedule_requested_staff');
  const ctx: MergeContext = {
    ...buildCtx(l, deps.appBaseUrl ?? ''),
    request: { message: job.message?.trim() || '(no message)' },
  };
  const { subject, body } = renderTemplate(tpl, ctx);
  await deps.sendEmail({ to: staff.email, subject, body });
  return { sent: 1 };
}

/** Wall-clock HH:MM of `at` in `tz` (24h). */
function hhmmInTz(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  let h = parts.find((p) => p.type === 'hour')?.value ?? '00';
  if (h === '24') h = '00'; // some envs render midnight as 24
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${h}:${m}`;
}

/** True when `at` (in `tz`) is inside the allowed send window [start, end).
 *  Handles overnight windows (start > end). */
function withinSendWindow(at: Date, tz: string, start: string, end: string): boolean {
  const cur = hhmmInTz(at, tz);
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

interface FirmReminderCfg {
  offsets: number[];
  quietStart: string;
  quietEnd: string;
  tz: string;
}

/**
 * Reminder heartbeat — sends pre-meeting reminders for SCHEDULED appointments
 * on each step of the effective schedule (per-appointment override →
 * appointment-type default → firm offsets), across EMAIL / SMS / CALL. Honors
 * per-contact opt-out, per-channel quiet hours (SMS/voice only), and is
 * idempotent per (appointment, contact, offset, channel). 5-minute worker cron.
 */
export async function runAppointmentReminderTick(
  deps: EmailJobDeps,
  nowArg?: Date,
): Promise<{ sent: number }> {
  const db = deps.db;
  const now = nowArg ?? deps.now ?? new Date();
  const MAX_LOOKAHEAD_MIN = 15 * 24 * 60; // covers the 14-day max offset
  const windowEnd = new Date(now.getTime() + MAX_LOOKAHEAD_MIN * 60_000);

  const due = await db
    .select({
      id: appointments.id,
      firmId: appointments.firmId,
      startsAt: appointments.startsAt,
      reminderSchedule: appointments.reminderSchedule,
      typeSchedule: appointmentTypes.reminderSchedule,
    })
    .from(appointments)
    .leftJoin(appointmentTypes, eq(appointmentTypes.id, appointments.appointmentTypeId))
    .where(
      and(
        eq(appointments.status, 'SCHEDULED'),
        gt(appointments.startsAt, now),
        lte(appointments.startsAt, windowEnd),
      ),
    );

  const firmCfg = new Map<string, FirmReminderCfg>();
  const tplCache = new Map<string, Template>(); // `${firmId}:${channel}`
  let sent = 0;

  for (const appt of due) {
    let cfg = firmCfg.get(appt.firmId);
    if (!cfg) {
      const s = await getCalendarSettings(db, appt.firmId);
      const raw = s.reminderOffsetsMinutes as unknown;
      cfg = {
        offsets: Array.isArray(raw) ? (raw as number[]) : [1440, 120],
        quietStart: s.reminderQuietStart,
        quietEnd: s.reminderQuietEnd,
        tz: await firmTimezone(db, appt.firmId),
      };
      firmCfg.set(appt.firmId, cfg);
    }

    const schedule = resolveSchedule(appt.reminderSchedule, appt.typeSchedule, cfg.offsets);
    const elapsed = schedule.filter(
      (step) => appt.startsAt.getTime() - step.offsetMinutes * 60_000 <= now.getTime(),
    );
    if (elapsed.length === 0) continue;

    const parts = await db
      .select({
        contactId: appointmentParticipants.clientContactId,
        personId: persons.id,
        clientId: clientContacts.clientId,
        email: persons.email,
        mobile: persons.mobile,
        phone: persons.phone,
        name: persons.fullName,
        optIn: clientContacts.receiveAppointmentReminders,
        doNotCall: persons.doNotCall,
        smsOptOut: persons.smsOptOut,
      })
      .from(appointmentParticipants)
      .innerJoin(clientContacts, eq(clientContacts.id, appointmentParticipants.clientContactId))
      .innerJoin(persons, eq(persons.id, clientContacts.personId))
      .where(eq(appointmentParticipants.appointmentId, appt.id));
    const recipients = parts.filter((p) => p.optIn !== false);
    if (recipients.length === 0) continue;

    const already = await db
      .select({
        c: appointmentRemindersSent.clientContactId,
        o: appointmentRemindersSent.reminderOffsetMinutes,
        ch: appointmentRemindersSent.channel,
      })
      .from(appointmentRemindersSent)
      .where(eq(appointmentRemindersSent.appointmentId, appt.id));
    const sentSet = new Set(already.map((a) => `${a.c}:${a.o}:${a.ch}`));

    const loaded = await load(db, appt.id);
    if (!loaded) continue;
    const ctx = buildCtx(loaded, deps.appBaseUrl ?? '');
    const ics = icsFor(loaded);
    // SMS/voice only fire inside the firm's allowed hours; out-of-window steps
    // are skipped (not recorded) so they fire on a later tick.
    const canSendQuiet = withinSendWindow(now, cfg.tz, cfg.quietStart, cfg.quietEnd);

    for (const step of elapsed) {
      const channel = step.channel as ReminderChannel;
      const tkey = `${appt.firmId}:${channel}`;
      let tpl = tplCache.get(tkey);
      if (!tpl) {
        tpl = await loadTemplate(db, appt.firmId, 'appointment_reminder', channel);
        tplCache.set(tkey, tpl);
      }
      for (const p of recipients) {
        const key = `${p.contactId}:${step.offsetMinutes}:${channel}`;
        if (sentSet.has(key)) continue;
        const phone = p.mobile || p.phone || null;
        let skippedReason: string | null = null;
        const { subject, body } = renderTemplate(tpl, {
          ...ctx,
          client: { name: p.name ?? loaded.clientName ?? 'there' },
        });
        try {
          if (channel === 'EMAIL') {
            if (!p.email) continue;
            await deps.sendEmail({
              to: p.email,
              subject,
              body,
              ics,
              icsFilename: 'appointment.ics',
            });
          } else if (channel === 'SMS') {
            // 0224 — person opted out of automated texts.
            if (!deps.sendSms || !phone || !canSendQuiet || p.smsOptOut) continue;
            const r = await deps.sendSms({
              to: phone,
              body,
              firmId: appt.firmId,
              appointmentId: appt.id,
              personId: p.personId,
              clientId: p.clientId,
              contactId: p.contactId,
            });
            // 0234 — a policy skip (opt-out / consent / A2P) is recorded so
            // the step isn't retried every tick; a delivery failure throws.
            if (r && 'skipped' in r) skippedReason = r.skipped;
          } else {
            if (!phone || !canSendQuiet) continue;
            // Rendered SMS version doubles as the do-not-call delivery and
            // the can't-connect fallback body.
            const skey = `${appt.firmId}:SMS`;
            let smsTpl = tplCache.get(skey);
            if (!smsTpl) {
              smsTpl = await loadTemplate(db, appt.firmId, 'appointment_reminder', 'SMS');
              tplCache.set(skey, smsTpl);
            }
            const smsBody = renderTemplate(smsTpl, {
              ...ctx,
              client: { name: p.name ?? loaded.clientName ?? 'there' },
            }).body;
            if (p.doNotCall) {
              // 0206 — opted out of automated calls: deliver the SMS version
              // and record the step so it isn't retried. 0224 — unless they
              // opted out of texts too, in which case nothing goes out.
              if (!deps.sendSms || p.smsOptOut) continue;
              const r = await deps.sendSms({
                to: phone,
                body: smsBody,
                firmId: appt.firmId,
                appointmentId: appt.id,
                personId: p.personId,
                clientId: p.clientId,
                contactId: p.contactId,
              });
              if (r && 'skipped' in r) skippedReason = r.skipped;
            } else {
              if (!deps.placeCall) continue;
              const confirmUrl = deps.appBaseUrl
                ? `${deps.appBaseUrl}/api/public/appointments/twilio/voice-gather?a=${appt.id}&c=${p.contactId}`
                : undefined;
              const result = await deps.placeCall({
                firmId: appt.firmId,
                to: phone,
                script: body,
                confirmUrl,
                // 0224 — no SMS fallback of any kind for an SMS opt-out.
                fallbackSmsBody: p.smsOptOut ? undefined : smsBody,
                voice: tpl.voice ?? null,
                personId: p.personId,
                clientId: p.clientId,
                appointmentId: appt.id,
              });
              // Gate refusals: outside the calling window (or transient
              // failure) → skip WITHOUT recording so a later tick retries.
              // do_not_call raced a fresh press-9 → send the SMS instead.
              if (!result.ok) {
                // 0224 — same opt-out guard as the pre-checked branch above.
                if (result.code === 'do_not_call' && deps.sendSms && !p.smsOptOut) {
                  const r = await deps.sendSms({
                    to: phone,
                    body: smsBody,
                    firmId: appt.firmId,
                    appointmentId: appt.id,
                    personId: p.personId,
                    clientId: p.clientId,
                    contactId: p.contactId,
                  });
                  if (r && 'skipped' in r) skippedReason = r.skipped;
                } else {
                  continue;
                }
              }
            }
          }
        } catch (err) {
          logger.warn(
            { err, appointmentId: appt.id, channel },
            'appointment reminder send failed; will retry',
          );
          continue; // don't record → retried next tick
        }
        await db
          .insert(appointmentRemindersSent)
          .values({
            appointmentId: appt.id,
            clientContactId: p.contactId,
            reminderOffsetMinutes: step.offsetMinutes,
            channel,
            deliveryStatus: skippedReason ? `skipped_${skippedReason}` : 'sent',
          })
          .onConflictDoNothing();
        // 0206 follow-up — reminders now appear on the client's
        // Communications timeline like every other client-facing send
        // (previously only the idempotency ledger recorded them, so staff
        // could see a client's reply without the reminder that caused it).
        if (p.clientId) {
          await db
            .insert(clientCommunications)
            .values({
              firmId: appt.firmId,
              clientId: p.clientId,
              channel,
              direction: 'OUTBOUND',
              subject: channel === 'EMAIL' ? subject : 'Appointment reminder',
              body,
              occurredAt: now,
              relatedEntityType: 'appointment',
              relatedEntityId: appt.id,
            })
            .catch((err: unknown) =>
              logger.warn({ err, appointmentId: appt.id }, 'reminder timeline log failed'),
            );
        }
        sentSet.add(key);
        sent++;
      }
    }
  }
  return { sent };
}
