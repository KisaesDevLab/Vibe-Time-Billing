// SPDX-License-Identifier: Elastic-2.0
//
// CAL-7 — reminders: an in-window offset fires once per (event, contact,
// offset), creates an RSVP token, respects opt-out, and is idempotent.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import {
  calendarEventMatches,
  calendarEvents,
  calendarRemindersSent,
  calendarRsvpTokens,
  staffCalendarConnections,
} from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  type PgliteHarness,
} from './_pglite-harness';
import { runCalendarReminderTick } from '../calendar/reminder-tick';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

const log = { warn() {} };

async function setupConfirmedEvent(startInMinutes: number, optOut = false): Promise<string> {
  const [conn] = await harness.db
    .insert(staffCalendarConnections)
    .values({
      firmId: seed.firmId,
      staffId: seed.appUserId,
      provider: 'google',
      tDekWrapped: Buffer.from([1]),
      accessTokenEnc: Buffer.from([1]),
    })
    .returning({ id: staffCalendarConnections.id });
  await seedContact(harness.db, {
    firmId: seed.firmId,
    clientId: seed.clientId,
    fullName: 'Client Contact',
    email: 'contact@co.example',
    receiveAppointmentReminders: !optOut,
  });
  const [ev] = await harness.db
    .insert(calendarEvents)
    .values({
      firmId: seed.firmId,
      staffId: seed.appUserId,
      connectionId: conn!.id,
      providerEventId: 'evt-rem',
      subject: 'Tax planning',
      startAt: new Date(Date.now() + startInMinutes * 60_000),
      endAt: new Date(Date.now() + (startInMinutes + 60) * 60_000),
    })
    .returning({ id: calendarEvents.id });
  await harness.db.insert(calendarEventMatches).values({
    eventId: ev!.id,
    clientId: seed.clientId,
    matchTier: 'exact_email',
    matchStatus: 'confirmed',
  });
  return ev!.id;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('runCalendarReminderTick (CAL-7)', () => {
  it('sends the 1-day reminder once and creates an RSVP token, then is idempotent', async () => {
    // Event starts in 20h → the 1440-min (1d) offset is due; the 2h is not.
    const eventId = await setupConfirmedEvent(20 * 60);
    const sent: Array<{ to: string; subject: string }> = [];
    const deps = {
      rsvpBaseUrl: 'https://firm.example',
      sendEmail: async (a: { to: string; subject: string }) => {
        sent.push({ to: a.to, subject: a.subject });
      },
    };

    const r1 = await runCalendarReminderTick(harness.db, log, deps);
    expect(r1.sent).toBe(1);
    expect(sent[0]!.to).toBe('contact@co.example');

    const tokens = await harness.db
      .select()
      .from(calendarRsvpTokens)
      .where(eq(calendarRsvpTokens.eventId, eventId));
    expect(tokens).toHaveLength(1);

    const ledger = await harness.db
      .select()
      .from(calendarRemindersSent)
      .where(eq(calendarRemindersSent.eventId, eventId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.reminderOffsetMinutes).toBe(1440);

    // Second tick: already sent → no new send.
    const r2 = await runCalendarReminderTick(harness.db, log, deps);
    expect(r2.sent).toBe(0);
    expect(r2.skipped).toBeGreaterThanOrEqual(1);
  });

  it('does not fire when no offset is due yet', async () => {
    // Starts in 5 days → neither 1d nor 2h offset is due.
    await setupConfirmedEvent(5 * 24 * 60);
    const r = await runCalendarReminderTick(harness.db, log, {
      rsvpBaseUrl: 'https://x',
      sendEmail: async () => {},
    });
    expect(r.sent).toBe(0);
  });

  it('respects the contact opt-out', async () => {
    await setupConfirmedEvent(20 * 60, true);
    const r = await runCalendarReminderTick(harness.db, log, {
      rsvpBaseUrl: 'https://x',
      sendEmail: async () => {},
    });
    expect(r.sent).toBe(0);
  });
});
