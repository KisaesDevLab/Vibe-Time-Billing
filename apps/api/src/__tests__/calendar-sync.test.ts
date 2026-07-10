// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CAL-3 — poll sync: event mapping, paginated fetch + upsert, soft-delete
// of vanished events, new-event detection, the per-firm interval gate, and
// manual-sync rate limiting.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, isNull } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  calendarEvents,
  calendarProviderConfig,
  staffCalendarConnections,
  staffCalendarSelections,
} from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import { newCalendarRecordKey, encField } from '../calendar/crypto';
import { mapGraphEvent, mapGoogleEvent } from '../calendar/event-mapper';
import { syncConnection } from '../calendar/sync';
import { runCalendarSyncTick } from '../calendar/sync-tick';
import type { ConnectionRow } from '../calendar/token-manager';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let sealDir: string;

const FUTURE = new Date(Date.now() + 3600_000);

// Stateful mock: controls which Google events the list endpoint returns.
let googleItems: Array<{
  id: string;
  summary: string;
  start: object;
  end: object;
  status?: string;
}>;
const mockFetch: typeof fetch = (async (url: string) => {
  const u = String(url);
  if (u.includes('calendar/v3/calendars/')) {
    // Single page (no nextPageToken) for simplicity in most tests.
    if (u.includes('pageToken=p2')) {
      return new Response(JSON.stringify({ items: googleItems.slice(2) }), { status: 200 });
    }
    const firstPage = googleItems.slice(0, 2);
    const body: Record<string, unknown> = { items: firstPage };
    if (googleItems.length > 2) body['nextPageToken'] = 'p2';
    return new Response(JSON.stringify(body), { status: 200 });
  }
  return new Response('{}', { status: 200 });
}) as unknown as typeof fetch;

async function setup(provider: 'google' = 'google'): Promise<ConnectionRow & { staffId: string }> {
  const { dek, wrappedDek } = newCalendarRecordKey(harness.db, seed.firmId);
  await harness.db.insert(calendarProviderConfig).values({
    firmId: seed.firmId,
    provider,
    tDekWrapped: Buffer.from(wrappedDek),
    clientIdEnc: encField(dek, 'cid')!,
    clientSecretEnc: encField(dek, 'csec')!,
    enabled: true,
  });
  const ck = newCalendarRecordKey(harness.db, seed.firmId);
  const [conn] = await harness.db
    .insert(staffCalendarConnections)
    .values({
      firmId: seed.firmId,
      staffId: seed.appUserId,
      provider,
      tDekWrapped: Buffer.from(ck.wrappedDek),
      accessTokenEnc: encField(ck.dek, 'acc')!,
      refreshTokenEnc: encField(ck.dek, 'ref'),
      tokenExpiry: FUTURE,
      enabled: true,
    })
    .returning();
  await harness.db.insert(staffCalendarSelections).values({
    connectionId: conn!.id,
    calendarId: 'primary',
    calendarName: 'Work',
    syncEnabled: true,
  });
  return conn as ConnectionRow & { staffId: string };
}

function ev(
  id: string,
  subject: string,
): { id: string; summary: string; start: object; end: object } {
  return {
    id,
    summary: subject,
    start: { dateTime: '2026-06-10T18:00:00Z' },
    end: { dateTime: '2026-06-10T19:00:00Z' },
  };
}

beforeEach(async () => {
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-cal-sync-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  await getFirmKeyManager(harness.db).bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
  setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
  googleItems = [];
});
afterEach(async () => {
  resetFirmKeyManagerForTests();
  await harness.close();
  await rm(sealDir, { recursive: true, force: true });
});

describe('event mapper (CAL-3)', () => {
  it('maps a Graph event (UTC-normalized) + attendees', () => {
    const n = mapGraphEvent({
      id: 'g1',
      subject: 'Review',
      start: { dateTime: '2026-06-10T18:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-06-10T19:00:00.0000000', timeZone: 'UTC' },
      isAllDay: false,
      organizer: { emailAddress: { name: 'Org', address: 'org@x.com' } },
      attendees: [
        { emailAddress: { name: 'A', address: 'a@x.com' }, status: { response: 'accepted' } },
      ],
      iCalUId: 'uid-1',
    });
    expect(n.startAt?.toISOString()).toBe('2026-06-10T18:00:00.000Z');
    expect(n.organizerEmail).toBe('org@x.com');
    expect(n.attendees[0]).toEqual({ email: 'a@x.com', name: 'A', response_status: 'accepted' });
    expect(n.deleted).toBe(false);
  });

  it('flags a cancelled Google event as deleted + handles all-day', () => {
    expect(mapGoogleEvent({ id: 'x', status: 'cancelled' }).deleted).toBe(true);
    const allDay = mapGoogleEvent({
      id: 'y',
      summary: 'Holiday',
      start: { date: '2026-06-10' },
      end: { date: '2026-06-11' },
    });
    expect(allDay.isAllDay).toBe(true);
  });
});

describe('syncConnection (CAL-3)', () => {
  it('upserts paginated events and reports new ids', async () => {
    const conn = await setup();
    googleItems = [ev('e1', 'One'), ev('e2', 'Two'), ev('e3', 'Three')];
    const out = await syncConnection({ db: harness.db, fetchImpl: mockFetch }, conn);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.synced).toBe(3);
      expect(out.newEventIds).toHaveLength(3);
    }
    const rows = await harness.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.connectionId, conn.id));
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.providerEventId === 'e1')!.subject).toBe('One');
  });

  it('soft-deletes events the provider no longer returns', async () => {
    const conn = await setup();
    googleItems = [ev('e1', 'One'), ev('e2', 'Two'), ev('e3', 'Three')];
    await syncConnection({ db: harness.db, fetchImpl: mockFetch }, conn);

    // e3 vanishes on the next sync.
    googleItems = [ev('e1', 'One'), ev('e2', 'Two')];
    const out = await syncConnection({ db: harness.db, fetchImpl: mockFetch }, conn);
    expect(out.ok && out.deleted).toBe(1);
    expect(out.ok && out.newEventIds).toHaveLength(0);

    const live = await harness.db
      .select()
      .from(calendarEvents)
      .where(isNull(calendarEvents.softDeletedAt));
    expect(live.map((r) => r.providerEventId).sort()).toEqual(['e1', 'e2']);
  });

  it('returns auth_failed when the token is expired with no refresh token', async () => {
    const { dek, wrappedDek } = newCalendarRecordKey(harness.db, seed.firmId);
    await harness.db.insert(calendarProviderConfig).values({
      firmId: seed.firmId,
      provider: 'google',
      tDekWrapped: Buffer.from(wrappedDek),
      clientIdEnc: encField(dek, 'cid')!,
      clientSecretEnc: encField(dek, 'csec')!,
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
        refreshTokenEnc: null, // no refresh token
        tokenExpiry: new Date(Date.now() - 1000), // expired
        enabled: true,
      })
      .returning();
    const out = await syncConnection(
      { db: harness.db, fetchImpl: mockFetch },
      conn as ConnectionRow & { staffId: string },
    );
    expect(out).toEqual({ ok: false, reason: 'auth_failed' });
    const [row] = await harness.db
      .select()
      .from(staffCalendarConnections)
      .where(eq(staffCalendarConnections.id, conn!.id));
    expect(row!.syncError).toBe('token_expired');
  });
});

describe('runCalendarSyncTick interval gate (CAL-3)', () => {
  it('skips a connection synced within the interval window', async () => {
    const conn = await setup();
    googleItems = [ev('e1', 'One')];
    // Mark as just synced (default interval 15 min).
    await harness.db
      .update(staffCalendarConnections)
      .set({ lastSyncedAt: new Date(Date.now() - 60_000) })
      .where(eq(staffCalendarConnections.id, conn.id));

    const r = await runCalendarSyncTick(
      harness.db,
      { warn() {}, debug() {} },
      { fetchImpl: mockFetch },
    );
    expect(r.scanned).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.synced).toBe(0);
  });
});
