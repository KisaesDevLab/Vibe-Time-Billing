// SPDX-License-Identifier: Elastic-2.0
//
// BK-6 — appointment email jobs: render (default + override), per-
// participant send, confirmation/cancellation stamping, ICS attendees.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import {
  appointmentParticipants,
  appointmentRemindersSent,
  appointmentStaff,
  appointments,
  notificationTemplates,
} from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  type PgliteHarness,
} from './_pglite-harness';
import {
  runAppointmentConfirmationSend,
  runAppointmentCancellationSend,
  runAppointmentDeclineSend,
  runAppointmentRescheduleRequestedStaffSend,
  runAppointmentReminderTick,
  type AppointmentMail,
} from '../appointments/email-jobs';
import { resolveSchedule, type ReminderStep } from '../appointments/reminders';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

async function seedAppt(withParticipant = true): Promise<{ apptId: string; contactId?: string }> {
  const [appt] = await harness.db
    .insert(appointments)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      title: 'Tax Review',
      startsAt: new Date('2030-01-07T15:00:00Z'),
      endsAt: new Date('2030-01-07T15:30:00Z'),
      durationMinutes: 30,
      location: 'VIDEO',
      locationDetail: 'https://meet/abc',
      status: 'SCHEDULED',
      leadAppUserId: seed.appUserId,
      createdById: seed.appUserId,
      cancelToken: sql`gen_random_uuid()` as never,
      rescheduleToken: sql`gen_random_uuid()` as never,
    })
    .returning({ id: appointments.id });
  await harness.db
    .insert(appointmentStaff)
    .values({ appointmentId: appt!.id, staffId: seed.appUserId });
  let contactId: string | undefined;
  if (withParticipant) {
    const c = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Jane Client',
      email: 'jane@client.example',
    });
    contactId = c.contactId;
    await harness.db
      .insert(appointmentParticipants)
      .values({ appointmentId: appt!.id, clientContactId: contactId });
  }
  return { apptId: appt!.id, contactId };
}

function recorder(): { send: (m: AppointmentMail) => Promise<void>; mails: AppointmentMail[] } {
  const mails: AppointmentMail[] = [];
  return {
    mails,
    async send(m) {
      mails.push(m);
    },
  };
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('appointment confirmation email', () => {
  it('renders the default template, sends per participant, stamps sent', async () => {
    const { apptId } = await seedAppt();
    const rec = recorder();
    const r = await runAppointmentConfirmationSend(
      { db: harness.db, sendEmail: rec.send, appBaseUrl: 'https://practice.example' },
      { appointmentId: apptId },
    );
    expect(r.sent).toBe(1);
    expect(rec.mails[0]!.to).toBe('jane@client.example');
    expect(rec.mails[0]!.subject).toContain('Tax Review');
    expect(rec.mails[0]!.body).toContain('Sarah Chen'); // staff name
    expect(rec.mails[0]!.body).toContain('https://practice.example/api/public/appointments/');
    expect(rec.mails[0]!.ics).toContain('BEGIN:VCALENDAR');
    expect(rec.mails[0]!.ics).toContain('ATTENDEE');
    const [p] = await harness.db
      .select()
      .from(appointmentParticipants)
      .where(eq(appointmentParticipants.appointmentId, apptId));
    expect(p!.confirmationSentAt).not.toBeNull();
  });

  it('honors a per-firm template override', async () => {
    const { apptId } = await seedAppt();
    await harness.db.insert(notificationTemplates).values({
      firmId: seed.firmId,
      kind: 'appointment_confirmation',
      channel: 'EMAIL',
      subject: 'See you soon: {{ appointment.subject }}',
      body: 'Custom body for {{ client.name }}',
      enabled: true,
    });
    const rec = recorder();
    await runAppointmentConfirmationSend(
      { db: harness.db, sendEmail: rec.send },
      { appointmentId: apptId },
    );
    expect(rec.mails[0]!.subject).toBe('See you soon: Tax Review');
    expect(rec.mails[0]!.body).toBe('Custom body for Jane Client');
  });

  it('no participants → nothing sent', async () => {
    const { apptId } = await seedAppt(false);
    const rec = recorder();
    const r = await runAppointmentConfirmationSend(
      { db: harness.db, sendEmail: rec.send },
      { appointmentId: apptId },
    );
    expect(r.sent).toBe(0);
    expect(rec.mails).toHaveLength(0);
  });
});

describe('appointment cancellation email', () => {
  it('sends a CANCEL ics and stamps cancellation', async () => {
    const { apptId } = await seedAppt();
    const rec = recorder();
    const r = await runAppointmentCancellationSend(
      { db: harness.db, sendEmail: rec.send },
      { appointmentId: apptId, cancelledBy: 'client' },
    );
    expect(r.sent).toBe(1);
    expect(rec.mails[0]!.ics).toContain('METHOD:CANCEL');
    expect(rec.mails[0]!.body).toContain('you'); // cancelled_by = "you" for client
    const [p] = await harness.db
      .select()
      .from(appointmentParticipants)
      .where(eq(appointmentParticipants.appointmentId, apptId));
    expect(p!.cancellationSentAt).not.toBeNull();
  });
});

describe('appointment reschedule decline email', () => {
  it('sends the decline notice to participants', async () => {
    const { apptId } = await seedAppt();
    const rec = recorder();
    const r = await runAppointmentDeclineSend(
      { db: harness.db, sendEmail: rec.send, appBaseUrl: 'https://practice.example' },
      { appointmentId: apptId },
    );
    expect(r.sent).toBe(1);
    expect(rec.mails[0]!.to).toBe('jane@client.example');
    expect(rec.mails[0]!.subject).toContain('reschedule');
    expect(rec.mails[0]!.body).toContain('original time still stands');
  });
});

describe('appointment reschedule-requested staff alert', () => {
  it('emails the booking staff with the client message', async () => {
    const { apptId } = await seedAppt();
    const rec = recorder();
    const r = await runAppointmentRescheduleRequestedStaffSend(
      { db: harness.db, sendEmail: rec.send },
      { appointmentId: apptId, message: 'Mornings are better' },
    );
    expect(r.sent).toBe(1);
    expect(rec.mails[0]!.to).toBe('sarah@test.example'); // the createdBy staff
    expect(rec.mails[0]!.body).toContain('Mornings are better');
  });
});

async function seadApptAt(startsAt: Date, opts: { reminders?: boolean } = {}): Promise<string> {
  const [appt] = await harness.db
    .insert(appointments)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      title: 'Reminder me',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60000),
      durationMinutes: 30,
      location: 'VIDEO',
      status: 'SCHEDULED',
      leadAppUserId: seed.appUserId,
      createdById: seed.appUserId,
      cancelToken: sql`gen_random_uuid()` as never,
      rescheduleToken: sql`gen_random_uuid()` as never,
    })
    .returning({ id: appointments.id });
  const c = await seedContact(harness.db, {
    firmId: seed.firmId,
    clientId: seed.clientId,
    fullName: 'Rem Contact',
    email: 'rem@client.example',
    receiveAppointmentReminders: opts.reminders ?? true,
  });
  await harness.db
    .insert(appointmentParticipants)
    .values({ appointmentId: appt!.id, clientContactId: c.contactId });
  return appt!.id;
}

describe('appointment reminder tick', () => {
  it('fires once per offset, is idempotent, attaches ics', async () => {
    // start in 90 min → the 120-min offset window has elapsed (default offsets [1440,120]).
    const apptId = await seadApptAt(new Date(Date.now() + 90 * 60000));
    const rec = recorder();
    const r1 = await runAppointmentReminderTick({ db: harness.db, sendEmail: rec.send });
    expect(r1.sent).toBeGreaterThanOrEqual(1);
    expect(rec.mails[0]!.to).toBe('rem@client.example');
    expect(rec.mails[0]!.subject).toContain('Reminder');
    expect(rec.mails[0]!.ics).toContain('BEGIN:VCALENDAR');
    const ledger = await harness.db
      .select()
      .from(appointmentRemindersSent)
      .where(eq(appointmentRemindersSent.appointmentId, apptId));
    expect(ledger.length).toBe(r1.sent);
    // Second run sends nothing new (idempotent).
    const rec2 = recorder();
    const r2 = await runAppointmentReminderTick({ db: harness.db, sendEmail: rec2.send });
    expect(r2.sent).toBe(0);
  });

  it('skips contacts who opted out of reminders', async () => {
    await seadApptAt(new Date(Date.now() + 90 * 60000), { reminders: false });
    const rec = recorder();
    const r = await runAppointmentReminderTick({ db: harness.db, sendEmail: rec.send });
    expect(r.sent).toBe(0);
  });

  it('does not remind for appointments outside the offset window', async () => {
    // start in 30 days → neither 1440 (1d) nor 120 (2h) offset has elapsed.
    await seadApptAt(new Date(Date.now() + 30 * 24 * 60 * 60000));
    const rec = recorder();
    const r = await runAppointmentReminderTick({ db: harness.db, sendEmail: rec.send });
    expect(r.sent).toBe(0);
  });
});

// --- multi-channel + quiet hours -------------------------------------
// 15:00 UTC sits inside the default quiet window (08:00–20:00) so SMS/voice
// are allowed; 03:00 UTC sits outside it.
const NOW_OPEN = new Date('2030-01-07T15:00:00Z');
const NOW_QUIET = new Date('2030-01-07T03:00:00Z');

async function setOfficeUtc(): Promise<void> {
  await harness.db.execute(sql`UPDATE office SET timezone = 'UTC' WHERE firm_id = ${seed.firmId}`);
}

async function seedScheduledAppt(opts: {
  at: Date;
  schedule: ReminderStep[];
  mobile?: string | null;
}): Promise<string> {
  const [appt] = await harness.db
    .insert(appointments)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      title: 'Multi reminder',
      startsAt: opts.at,
      endsAt: new Date(opts.at.getTime() + 30 * 60000),
      durationMinutes: 30,
      location: 'VIDEO',
      status: 'SCHEDULED',
      leadAppUserId: seed.appUserId,
      createdById: seed.appUserId,
      reminderSchedule: opts.schedule,
      cancelToken: sql`gen_random_uuid()` as never,
      rescheduleToken: sql`gen_random_uuid()` as never,
    })
    .returning({ id: appointments.id });
  const c = await seedContact(harness.db, {
    firmId: seed.firmId,
    clientId: seed.clientId,
    fullName: 'Multi Contact',
    email: 'multi@client.example',
    mobile: opts.mobile ?? null,
    receiveAppointmentReminders: true,
  });
  await harness.db
    .insert(appointmentParticipants)
    .values({ appointmentId: appt!.id, clientContactId: c.contactId });
  return appt!.id;
}

function chanRecorders() {
  const sms: { to: string; body: string }[] = [];
  const calls: { to: string; script: string; confirmUrl?: string }[] = [];
  return {
    sms,
    calls,
    sendSms: async (m: { to: string; body: string }) => void sms.push(m),
    placeCall: async (m: { to: string; script: string; confirmUrl?: string }) => {
      calls.push(m);
      return { ok: true };
    },
  };
}

describe('multi-channel reminders', () => {
  it('sends one reminder per channel and is idempotent per channel', async () => {
    await setOfficeUtc();
    await seedScheduledAppt({
      at: new Date(NOW_OPEN.getTime() + 90 * 60000), // 120-min offset elapsed
      schedule: [
        { offsetMinutes: 120, channel: 'EMAIL' },
        { offsetMinutes: 120, channel: 'SMS' },
        { offsetMinutes: 120, channel: 'CALL' },
      ],
      mobile: '+15551234567',
    });
    const rec = recorder();
    const ch = chanRecorders();
    const r1 = await runAppointmentReminderTick(
      {
        db: harness.db,
        sendEmail: rec.send,
        sendSms: ch.sendSms,
        placeCall: ch.placeCall,
        appBaseUrl: 'https://practice.example',
      },
      NOW_OPEN,
    );
    expect(r1.sent).toBe(3);
    expect(rec.mails).toHaveLength(1);
    expect(ch.sms).toHaveLength(1);
    expect(ch.sms[0]!.to).toBe('+15551234567');
    expect(ch.calls).toHaveLength(1);
    expect(ch.calls[0]!.confirmUrl).toContain('/api/public/appointments/twilio/voice-gather');
    // Second tick: nothing new.
    const r2 = await runAppointmentReminderTick(
      { db: harness.db, sendEmail: recorder().send, ...chanRecorders() },
      NOW_OPEN,
    );
    expect(r2.sent).toBe(0);
  });

  it('skips SMS/voice when the contact has no phone (email still sends)', async () => {
    await setOfficeUtc();
    await seedScheduledAppt({
      at: new Date(NOW_OPEN.getTime() + 90 * 60000),
      schedule: [
        { offsetMinutes: 120, channel: 'EMAIL' },
        { offsetMinutes: 120, channel: 'SMS' },
        { offsetMinutes: 120, channel: 'CALL' },
      ],
      mobile: null,
    });
    const rec = recorder();
    const ch = chanRecorders();
    const r = await runAppointmentReminderTick(
      { db: harness.db, sendEmail: rec.send, sendSms: ch.sendSms, placeCall: ch.placeCall },
      NOW_OPEN,
    );
    expect(r.sent).toBe(1);
    expect(rec.mails).toHaveLength(1);
    expect(ch.sms).toHaveLength(0);
    expect(ch.calls).toHaveLength(0);
  });

  it('quiet hours defer SMS/voice but not email', async () => {
    await setOfficeUtc();
    await seedScheduledAppt({
      at: new Date(NOW_QUIET.getTime() + 90 * 60000),
      schedule: [
        { offsetMinutes: 120, channel: 'EMAIL' },
        { offsetMinutes: 120, channel: 'SMS' },
      ],
      mobile: '+15551234567',
    });
    const rec = recorder();
    const ch = chanRecorders();
    const r = await runAppointmentReminderTick(
      { db: harness.db, sendEmail: rec.send, sendSms: ch.sendSms, placeCall: ch.placeCall },
      NOW_QUIET, // 03:00 UTC → outside 08:00–20:00
    );
    expect(rec.mails).toHaveLength(1); // email ignores quiet hours
    expect(ch.sms).toHaveLength(0); // SMS deferred
    expect(r.sent).toBe(1);
  });
});

describe('resolveSchedule precedence', () => {
  const firm = [1440, 120];
  it('uses the appointment override first', () => {
    const out = resolveSchedule(
      [{ offsetMinutes: 60, channel: 'SMS' }],
      [{ offsetMinutes: 1440, channel: 'EMAIL' }],
      firm,
    );
    expect(out).toEqual([{ offsetMinutes: 60, channel: 'SMS' }]);
  });
  it('falls back to the type schedule, then firm offsets (as EMAIL)', () => {
    expect(resolveSchedule(null, [{ offsetMinutes: 30, channel: 'CALL' }], firm)).toEqual([
      { offsetMinutes: 30, channel: 'CALL' },
    ]);
    expect(resolveSchedule(null, null, firm)).toEqual([
      { offsetMinutes: 1440, channel: 'EMAIL' },
      { offsetMinutes: 120, channel: 'EMAIL' },
    ]);
  });
});
