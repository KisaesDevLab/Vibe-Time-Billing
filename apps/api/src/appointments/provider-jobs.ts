// SPDX-License-Identifier: Elastic-2.0
//
// BK-5 — per-staff calendar write-back for appointments. One job per
// staff member: create / update / delete the event on THAT staff
// member's connected calendar via CalendarWriteService, tracking the
// outcome on the appointment_staff row. Provider 5xx throw (BullMQ
// retries); auth/scope failures mark the row failed + drop an in-app
// notification (never failing the appointment itself).

import { and, eq, ne } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  appointmentParticipants,
  appointmentStaff,
  appointmentTypes,
  appointments,
  clientContacts,
  engagements,
  persons,
  staffNotifications,
} from '@vibe/db/schema';

import {
  CalendarWriteError,
  CalendarWriteService,
  isCalendarWriteEnabled,
} from '../calendar/write-service';
import { logger } from '../logger';

export interface ProviderJobDeps {
  db: Database;
  fetchImpl?: typeof fetch;
  now?: Date;
}

export type ProviderJobResult = {
  status: 'written' | 'updated' | 'deleted' | 'skipped' | 'failed';
  reason?: string;
};

function locationText(location: string, detail: string | null | undefined): string {
  return detail && detail.trim() ? detail : location;
}

/**
 * Build the provider event body: appointment type, the other staff on the
 * appointment, the linked engagement, and any internal notes — so the staff
 * member's own calendar event carries the booking context.
 */
async function buildDescription(
  db: Database,
  appt: typeof appointments.$inferSelect,
  staffId: string,
): Promise<string> {
  const lines: string[] = [];
  if (appt.appointmentTypeId) {
    const [t] = await db
      .select({ name: appointmentTypes.name })
      .from(appointmentTypes)
      .where(eq(appointmentTypes.id, appt.appointmentTypeId))
      .limit(1);
    if (t?.name) lines.push(`Type: ${t.name}`);
  }
  const others = await db
    .select({ name: appUsers.fullName })
    .from(appointmentStaff)
    .innerJoin(appUsers, eq(appUsers.id, appointmentStaff.staffId))
    .where(and(eq(appointmentStaff.appointmentId, appt.id), ne(appointmentStaff.staffId, staffId)));
  const otherNames = others.map((o) => o.name).filter(Boolean);
  if (otherNames.length) lines.push(`With: ${otherNames.join(', ')}`);
  if (appt.engagementId) {
    const [e] = await db
      .select({ name: engagements.name })
      .from(engagements)
      .where(eq(engagements.id, appt.engagementId))
      .limit(1);
    if (e?.name) lines.push(`Engagement: ${e.name}`);
  }
  if (appt.internalNotes && appt.internalNotes.trim()) {
    lines.push('', appt.internalNotes.trim());
  }
  return lines.join('\n');
}

async function attendeeEmails(
  db: Database,
  appointmentId: string,
  staffId: string,
): Promise<string[]> {
  const parts = await db
    .select({ email: persons.email })
    .from(appointmentParticipants)
    .innerJoin(clientContacts, eq(clientContacts.id, appointmentParticipants.clientContactId))
    .innerJoin(persons, eq(persons.id, clientContacts.personId))
    .where(eq(appointmentParticipants.appointmentId, appointmentId));
  const others = await db
    .select({ email: appUsers.email })
    .from(appointmentStaff)
    .innerJoin(appUsers, eq(appUsers.id, appointmentStaff.staffId))
    .where(
      and(eq(appointmentStaff.appointmentId, appointmentId), ne(appointmentStaff.staffId, staffId)),
    );
  const emails = [...parts, ...others].map((r) => r.email).filter((e): e is string => Boolean(e));
  return [...new Set(emails)];
}

async function loadPair(db: Database, appointmentId: string, staffId: string) {
  const [appt] = await db
    .select()
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .limit(1);
  const [row] = await db
    .select()
    .from(appointmentStaff)
    .where(
      and(eq(appointmentStaff.appointmentId, appointmentId), eq(appointmentStaff.staffId, staffId)),
    )
    .limit(1);
  return { appt, row };
}

async function markFailed(
  db: Database,
  appointmentId: string,
  staffId: string,
  firmId: string,
  reason: string,
  title: string,
  notify: boolean,
): Promise<void> {
  await db
    .update(appointmentStaff)
    .set({ providerWriteStatus: 'failed', providerWriteError: reason, updatedAt: new Date() })
    .where(
      and(eq(appointmentStaff.appointmentId, appointmentId), eq(appointmentStaff.staffId, staffId)),
    );
  if (notify) {
    await db
      .insert(staffNotifications)
      .values({
        firmId,
        recipientAppUserId: staffId,
        type: 'provider_write_failed',
        entityType: 'appointment',
        entityId: appointmentId,
        title: 'Calendar write failed',
        body: title,
        actionUrl: '/appointments#list',
      })
      .catch((err: unknown) => logger.warn({ err }, 'provider_write_failed notify insert failed'));
  }
}

export async function runAppointmentProviderWrite(
  deps: ProviderJobDeps,
  job: { appointmentId: string; staffId: string },
): Promise<ProviderJobResult> {
  const { db } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (!isCalendarWriteEnabled()) return { status: 'skipped', reason: 'write_disabled' };
  const { appt, row } = await loadPair(db, job.appointmentId, job.staffId);
  if (!appt || !row || appt.status === 'CANCELLED') return { status: 'skipped' };
  // Idempotency: if an event was already written for this staff (e.g. a
  // retry after the DB update raced, or a double-delivered job), update it
  // in place instead of creating a duplicate provider event.
  if (row.calendarEventId) return runAppointmentProviderUpdate(deps, job);

  const svc = new CalendarWriteService();
  const target = await svc.resolveTarget(db, appt.firmId, job.staffId);
  if (!target) {
    await markFailed(
      db,
      job.appointmentId,
      job.staffId,
      appt.firmId,
      'no_write_connection',
      appt.title,
      false,
    );
    return { status: 'failed', reason: 'no_write_connection' };
  }
  try {
    const attendees = await attendeeEmails(db, job.appointmentId, job.staffId);
    const description = await buildDescription(db, appt, job.staffId);
    const { eventId, providerEventId } = await svc.createEvent(
      { db, fetchImpl },
      {
        firmId: appt.firmId,
        staffId: job.staffId,
        connectionId: target.connectionId,
        calendarId: target.calendarId,
        input: {
          title: appt.title,
          start: appt.startsAt,
          end: appt.endsAt,
          location: locationText(appt.location, appt.locationDetail),
          description,
          attendees,
        },
        actorAppUserId: appt.createdById ?? undefined,
      },
    );
    await db
      .update(appointmentStaff)
      .set({
        calendarEventId: eventId,
        providerEventId,
        providerCalendarId: target.calendarId,
        providerWriteStatus: 'written',
        providerWriteError: null,
        writtenAt: deps.now ?? new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(appointmentStaff.appointmentId, job.appointmentId),
          eq(appointmentStaff.staffId, job.staffId),
        ),
      );
    return { status: 'written' };
  } catch (err) {
    return handleWriteError(db, job, appt.firmId, appt.title, err);
  }
}

export async function runAppointmentProviderUpdate(
  deps: ProviderJobDeps,
  job: { appointmentId: string; staffId: string },
): Promise<ProviderJobResult> {
  const { db } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (!isCalendarWriteEnabled()) return { status: 'skipped', reason: 'write_disabled' };
  const { appt, row } = await loadPair(db, job.appointmentId, job.staffId);
  if (!appt || !row || appt.status === 'CANCELLED') return { status: 'skipped' };
  // Never written yet → create instead.
  if (!row.calendarEventId) return runAppointmentProviderWrite(deps, job);

  const svc = new CalendarWriteService();
  try {
    const description = await buildDescription(db, appt, job.staffId);
    await svc.updateEvent(
      { db, fetchImpl },
      {
        firmId: appt.firmId,
        staffId: job.staffId,
        eventId: row.calendarEventId,
        patch: {
          title: appt.title,
          start: appt.startsAt,
          end: appt.endsAt,
          location: locationText(appt.location, appt.locationDetail),
          description,
        },
        actorAppUserId: appt.createdById ?? undefined,
      },
    );
    return { status: 'updated' };
  } catch (err) {
    return handleWriteError(db, job, appt.firmId, appt.title, err);
  }
}

export async function runAppointmentProviderDelete(
  deps: ProviderJobDeps,
  job: { appointmentId: string; staffId: string },
): Promise<ProviderJobResult> {
  const { db } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (!isCalendarWriteEnabled()) return { status: 'skipped', reason: 'write_disabled' };
  const { appt, row } = await loadPair(db, job.appointmentId, job.staffId);
  if (!appt || !row || !row.calendarEventId) return { status: 'skipped' };

  const svc = new CalendarWriteService();
  try {
    await svc.deleteEvent(
      { db, fetchImpl },
      {
        firmId: appt.firmId,
        staffId: job.staffId,
        eventId: row.calendarEventId,
        actorAppUserId: appt.cancelledById ?? appt.createdById ?? undefined,
      },
    );
  } catch (err) {
    // 404 / already-gone is success; other provider errors are logged but
    // don't block — the appointment is already cancelled locally.
    if (err instanceof CalendarWriteError && err.code === 'provider_failed') {
      logger.warn({ err, ...job }, 'appointment provider delete failed (ignored)');
    } else if (!(err instanceof CalendarWriteError)) {
      logger.warn({ err, ...job }, 'appointment provider delete error (ignored)');
    }
  }
  return { status: 'deleted' };
}

function handleWriteError(
  db: Database,
  job: { appointmentId: string; staffId: string },
  firmId: string,
  title: string,
  err: unknown,
): Promise<ProviderJobResult> | ProviderJobResult {
  if (err instanceof CalendarWriteError) {
    if (err.code === 'provider_failed') {
      // Transient — rethrow so BullMQ retries with backoff.
      throw err;
    }
    const reason =
      err.code === 'reauth_required' || err.code === 'write_scope_missing'
        ? 'auth_failed'
        : err.code;
    return markFailed(db, job.appointmentId, job.staffId, firmId, reason, title, true).then(() => ({
      status: 'failed' as const,
      reason,
    }));
  }
  throw err;
}
