// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CAL-7 — appointment reminders. Each tick finds confirmed appointments
// whose reminder offset has just elapsed and emails the client contacts a
// reminder with a one-click RSVP link (a token per event×contact). The
// sent-ledger makes it idempotent per event × contact × offset, and
// contacts can opt out.

import { and, eq, gt, isNull, lte } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  calendarEventMatches,
  calendarEvents,
  calendarRemindersSent,
  calendarRsvpTokens,
  clientContacts,
  persons,
} from '@vibe/db/schema';

import { firmScope, renderTemplate } from '../notifications/templating';
import { getCalendarSettings } from './settings';

export type CalendarMailer = (args: {
  to: string;
  subject: string;
  body: string;
  html?: string;
}) => Promise<void>;

export interface ReminderTickDeps {
  sendEmail?: CalendarMailer;
  /** Base for RSVP links, e.g. https://app.firm.com (→ /api/calendar/rsvp/:token). */
  rsvpBaseUrl: string;
  firmName?: string;
}

export interface ReminderTickResult {
  scanned: number;
  sent: number;
  skipped: number;
  errors: number;
}

const WINDOW_MS = 7 * 24 * 3600_000 + 3600_000; // 7d + 1h lookahead

function fmtWhen(d: Date | null): string {
  return d ? d.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' }) : '';
}

export async function runCalendarReminderTick(
  db: Database,
  log: { warn: (o: unknown, m?: string) => void },
  deps: ReminderTickDeps,
  now: Date = new Date(),
): Promise<ReminderTickResult> {
  const result: ReminderTickResult = { scanned: 0, sent: 0, skipped: 0, errors: 0 };

  const events = await db
    .select({
      id: calendarEvents.id,
      firmId: calendarEvents.firmId,
      subject: calendarEvents.subject,
      startAt: calendarEvents.startAt,
      location: calendarEvents.location,
      clientId: calendarEventMatches.clientId,
    })
    .from(calendarEvents)
    .innerJoin(calendarEventMatches, eq(calendarEventMatches.eventId, calendarEvents.id))
    .where(
      and(
        eq(calendarEventMatches.matchStatus, 'confirmed'),
        isNull(calendarEvents.softDeletedAt),
        gt(calendarEvents.startAt, now),
        lte(calendarEvents.startAt, new Date(now.getTime() + WINDOW_MS)),
      ),
    )
    .limit(1000);
  result.scanned = events.length;

  const offsetsByFirm = new Map<string, number[]>();

  for (const ev of events) {
    if (!ev.clientId || !ev.startAt) continue;
    let offsets = offsetsByFirm.get(ev.firmId);
    if (!offsets) {
      offsets = (await getCalendarSettings(db, ev.firmId)).reminderOffsetsMinutes;
      offsetsByFirm.set(ev.firmId, offsets);
    }

    // Which offsets are due now (start - offset has passed, start is future).
    const dueOffsets = offsets.filter(
      (off) => now.getTime() >= ev.startAt!.getTime() - off * 60_000,
    );
    if (dueOffsets.length === 0) continue;

    // Contacts that accept reminders + have an email.
    const contacts = await db
      // 0115 — name/email canonical on person; reminder opt-out per contact.
      .select({ id: clientContacts.id, name: persons.fullName, email: persons.email })
      .from(clientContacts)
      .innerJoin(persons, eq(persons.id, clientContacts.personId))
      .where(
        and(
          eq(clientContacts.clientId, ev.clientId),
          eq(clientContacts.receiveAppointmentReminders, true),
        ),
      );

    for (const off of dueOffsets) {
      for (const contact of contacts) {
        if (!contact.email) continue;
        // Idempotency: already sent this (event, contact, offset)?
        const existing = await db
          .select({ id: calendarRemindersSent.id })
          .from(calendarRemindersSent)
          .where(
            and(
              eq(calendarRemindersSent.eventId, ev.id),
              eq(calendarRemindersSent.clientContactId, contact.id),
              eq(calendarRemindersSent.reminderOffsetMinutes, off),
            ),
          )
          .limit(1);
        if (existing.length) {
          result.skipped += 1;
          continue;
        }

        try {
          // Upsert one RSVP token per (event, contact); expires at start.
          let [tok] = await db
            .select({ id: calendarRsvpTokens.id, token: calendarRsvpTokens.token })
            .from(calendarRsvpTokens)
            .where(
              and(
                eq(calendarRsvpTokens.eventId, ev.id),
                eq(calendarRsvpTokens.clientContactId, contact.id),
              ),
            )
            .limit(1);
          if (!tok) {
            [tok] = await db
              .insert(calendarRsvpTokens)
              .values({ eventId: ev.id, clientContactId: contact.id, expiresAt: ev.startAt })
              .returning({ id: calendarRsvpTokens.id, token: calendarRsvpTokens.token });
          }

          const rsvpUrl = `${deps.rsvpBaseUrl.replace(/\/$/, '')}/api/calendar/rsvp/${tok!.token}`;
          if (deps.sendEmail) {
            const fallbackSubject = `Reminder: ${ev.subject ?? 'your appointment'}`;
            const fallbackBody =
              `Hello ${contact.name},\n\n` +
              `This is a reminder for "${ev.subject ?? 'your appointment'}" on ${fmtWhen(ev.startAt)}.\n` +
              (ev.location ? `Location: ${ev.location}\n` : '') +
              `\nPlease confirm or decline:\n${rsvpUrl}\n\n` +
              `— ${deps.firmName ?? 'Your firm'}`;
            const rendered = await renderTemplate({
              db,
              firmId: ev.firmId,
              kind: 'calendar_reminder',
              channel: 'EMAIL',
              fallback: { subject: fallbackSubject, body: fallbackBody },
              context: {
                client: { name: contact.name },
                firm: await firmScope(db, ev.firmId),
                event: {
                  subject: ev.subject ?? 'your appointment',
                  date: ev.startAt
                    ? ev.startAt.toLocaleDateString('en-US', { dateStyle: 'full' })
                    : '',
                  time: ev.startAt
                    ? ev.startAt.toLocaleTimeString('en-US', { timeStyle: 'short' })
                    : '',
                },
              },
            });
            const subject = rendered.subject ?? fallbackSubject;
            const body = rendered.body;
            const html =
              `<p>Hello ${contact.name},</p>` +
              `<p>This is a reminder for <strong>${ev.subject ?? 'your appointment'}</strong> on ${fmtWhen(ev.startAt)}.</p>` +
              (ev.location ? `<p>Location: ${ev.location}</p>` : '') +
              `<p><a href="${rsvpUrl}">Confirm or decline</a></p>`;
            await deps.sendEmail({ to: contact.email, subject, body, html });
          }

          await db.insert(calendarRemindersSent).values({
            eventId: ev.id,
            clientContactId: contact.id,
            reminderOffsetMinutes: off,
            rsvpTokenId: tok!.id,
            deliveryStatus: deps.sendEmail ? 'sent' : 'skipped_no_mailer',
          });
          result.sent += 1;
        } catch (err) {
          result.errors += 1;
          log.warn({ err, eventId: ev.id, contactId: contact.id, off }, 'reminder send failed');
        }
      }
    }
  }

  return result;
}
