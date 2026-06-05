// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// BK-5 — per-staff appointment calendar write-back jobs.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appointmentStaff,
  appointments,
  calendarEvents,
  calendarProviderConfig,
  staffCalendarConnections,
  staffCalendarSelections,
  staffNotifications,
} from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import { newCalendarRecordKey, encField } from '../calendar/crypto';
import {
  runAppointmentProviderWrite,
  runAppointmentProviderDelete,
} from '../appointments/provider-jobs';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let sealDir: string;

const GOOGLE_WRITE = 'https://www.googleapis.com/auth/calendar.events';
const GOOGLE_READ = 'https://www.googleapis.com/auth/calendar.readonly';

const mockFetch: typeof fetch = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  const method = init?.method ?? 'GET';
  if (u.includes('/calendar/v3/calendars/') && u.includes('/events')) {
    if (method === 'POST') {
      return new Response(
        JSON.stringify({ id: 'g-1', htmlLink: 'https://cal/g-1', etag: '"e1"' }),
        {
          status: 200,
        },
      );
    }
    if (method === 'DELETE') return new Response(null, { status: 204 });
  }
  return new Response('{}', { status: 200 });
}) as unknown as typeof fetch;

async function seedConn(scope: string, opts: { expired?: boolean } = {}): Promise<string> {
  const pc = newCalendarRecordKey(harness.db, seed.firmId);
  await harness.db.insert(calendarProviderConfig).values({
    firmId: seed.firmId,
    provider: 'google',
    tDekWrapped: Buffer.from(pc.wrappedDek),
    clientIdEnc: encField(pc.dek, 'cid')!,
    clientSecretEnc: encField(pc.dek, 'csec')!,
    enabled: true,
  });
  const ck = newCalendarRecordKey(harness.db, seed.firmId);
  const [conn] = await harness.db
    .insert(staffCalendarConnections)
    .values({
      firmId: seed.firmId,
      staffId: seed.appUserId,
      provider: 'google',
      tDekWrapped: Buffer.from(ck.wrappedDek),
      accessTokenEnc: encField(ck.dek, 'acc')!,
      refreshTokenEnc: opts.expired ? null : encField(ck.dek, 'ref'),
      tokenExpiry: opts.expired
        ? new Date('2020-01-01T00:00:00Z')
        : new Date('2031-01-01T00:00:00Z'),
      scope,
      enabled: true,
    })
    .returning({ id: staffCalendarConnections.id });
  await harness.db.insert(staffCalendarSelections).values({
    connectionId: conn!.id,
    calendarId: 'primary',
    calendarName: 'Work',
    isPrimary: true,
    syncEnabled: true,
  });
  return conn!.id;
}

async function seedAppt(): Promise<string> {
  const [appt] = await harness.db
    .insert(appointments)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      title: 'Planning call',
      startsAt: new Date('2030-01-07T15:00:00Z'),
      endsAt: new Date('2030-01-07T15:30:00Z'),
      location: 'VIDEO',
      status: 'SCHEDULED',
      leadAppUserId: seed.appUserId,
      createdById: seed.appUserId,
    })
    .returning({ id: appointments.id });
  await harness.db
    .insert(appointmentStaff)
    .values({ appointmentId: appt!.id, staffId: seed.appUserId });
  return appt!.id;
}

beforeEach(async () => {
  process.env['FEATURE_CALENDAR_WRITE'] = 'true';
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-bk5-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  await getFirmKeyManager(harness.db).bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
  setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
});
afterEach(async () => {
  delete process.env['FEATURE_CALENDAR_WRITE'];
  await harness.close();
  await rm(sealDir, { recursive: true, force: true });
});

describe('appointment provider write-back', () => {
  it('writes the event and records the per-staff handle', async () => {
    await seedConn(GOOGLE_WRITE);
    const apptId = await seedAppt();
    const r = await runAppointmentProviderWrite(
      { db: harness.db, fetchImpl: mockFetch },
      { appointmentId: apptId, staffId: seed.appUserId },
    );
    expect(r.status).toBe('written');
    const [row] = await harness.db
      .select()
      .from(appointmentStaff)
      .where(
        and(
          eq(appointmentStaff.appointmentId, apptId),
          eq(appointmentStaff.staffId, seed.appUserId),
        ),
      );
    expect(row!.providerWriteStatus).toBe('written');
    expect(row!.providerEventId).toBe('g-1');
    expect(row!.calendarEventId).toBeTruthy();
    const [mirror] = await harness.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, row!.calendarEventId!));
    expect(mirror!.tbOrigin).toBe(true);
  });

  it('marks failed (no_write_connection) for a read-only calendar, no notification', async () => {
    await seedConn(GOOGLE_READ);
    const apptId = await seedAppt();
    const r = await runAppointmentProviderWrite(
      { db: harness.db, fetchImpl: mockFetch },
      { appointmentId: apptId, staffId: seed.appUserId },
    );
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('no_write_connection');
    const notifs = await harness.db
      .select()
      .from(staffNotifications)
      .where(eq(staffNotifications.entityId, apptId));
    expect(notifs).toHaveLength(0);
  });

  it('marks failed (auth) + notifies when the token cannot be refreshed', async () => {
    await seedConn(GOOGLE_WRITE, { expired: true });
    const apptId = await seedAppt();
    const r = await runAppointmentProviderWrite(
      { db: harness.db, fetchImpl: mockFetch },
      { appointmentId: apptId, staffId: seed.appUserId },
    );
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('auth_failed');
    const notifs = await harness.db
      .select()
      .from(staffNotifications)
      .where(eq(staffNotifications.entityId, apptId));
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.type).toBe('provider_write_failed');
  });

  it('delete soft-deletes the mirror', async () => {
    await seedConn(GOOGLE_WRITE);
    const apptId = await seedAppt();
    await runAppointmentProviderWrite(
      { db: harness.db, fetchImpl: mockFetch },
      { appointmentId: apptId, staffId: seed.appUserId },
    );
    const [before] = await harness.db
      .select()
      .from(appointmentStaff)
      .where(eq(appointmentStaff.appointmentId, apptId));
    const r = await runAppointmentProviderDelete(
      { db: harness.db, fetchImpl: mockFetch },
      { appointmentId: apptId, staffId: seed.appUserId },
    );
    expect(r.status).toBe('deleted');
    const [mirror] = await harness.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, before!.calendarEventId!));
    expect(mirror!.softDeletedAt).not.toBeNull();
  });

  it('skips cleanly when write is disabled', async () => {
    delete process.env['FEATURE_CALENDAR_WRITE'];
    await seedConn(GOOGLE_WRITE);
    const apptId = await seedAppt();
    const r = await runAppointmentProviderWrite(
      { db: harness.db, fetchImpl: mockFetch },
      { appointmentId: apptId, staffId: seed.appUserId },
    );
    expect(r.status).toBe('skipped');
  });
});
