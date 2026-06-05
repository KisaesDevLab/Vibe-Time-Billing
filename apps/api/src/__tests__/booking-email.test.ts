// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// BK-6 — appointment email jobs: render (default + override), per-
// participant send, confirmation/cancellation stamping, ICS attendees.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import {
  appointmentParticipants,
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
  type AppointmentMail,
} from '../appointments/email-jobs';

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
