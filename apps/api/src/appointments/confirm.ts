// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Appointment RSVP helpers shared by the legacy Twilio appointment webhook
// and the SMS inbox reply parser (0234, D13). Zod-free.

import { and, asc, eq, gt, lt } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { appointmentParticipants, appointments, clientContacts, persons } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';

export const CONFIRM_KEYWORDS = new Set(['YES', 'Y', 'C', 'CONFIRM', 'CONFIRMED']);
export const RESCHEDULE_KEYWORDS = new Set(['R', 'RESCHEDULE', 'RESCHED', 'CHANGE']);

export function parseReminderIntent(body: string): 'confirm' | 'reschedule' | null {
  const first = body.trim().toUpperCase().split(/\s+/)[0] ?? '';
  if (CONFIRM_KEYWORDS.has(first)) return 'confirm';
  if (RESCHEDULE_KEYWORDS.has(first)) return 'reschedule';
  return null;
}

/** Flip a participant's RSVP to confirmed. Returns true when a row changed. */
export async function confirmParticipant(
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

function last10(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '').slice(-10);
}

/**
 * Upcoming SCHEDULED appointments (next 30 days) with a participant whose
 * phone matches `from`. Used when a reply carries no reply-context row.
 */
export async function findUpcomingAppointmentForPhone(
  db: Database,
  from: string,
  now: Date,
): Promise<{ appointmentId: string; contactId: string } | null> {
  const fromKey = last10(from);
  if (fromKey.length < 7) return null;
  const horizon = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
  const rows = await db
    .select({
      appointmentId: appointmentParticipants.appointmentId,
      contactId: appointmentParticipants.clientContactId,
      mobile: persons.mobile,
      phone: persons.phone,
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
  return match ? { appointmentId: match.appointmentId, contactId: match.contactId } : null;
}
