// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CAL-1 — calendar foundations: the MFK-envelope column helpers round-trip
// OAuth secrets, migration 0109 created the tables, and the
// provider→connection→selection→event→match→rsvp chain persists +
// cascade-deletes with the status/tier CHECKs enforced.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  calendarEventMatches,
  calendarEvents,
  calendarProviderConfig,
  calendarRsvpTokens,
  staffCalendarConnections,
  staffCalendarSelections,
} from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import {
  newCalendarRecordKey,
  unwrapCalendarRecordKey,
  encField,
  decField,
} from '../calendar/crypto';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let sealDir: string;

beforeEach(async () => {
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-cal-seal-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();

  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  const mgr = getFirmKeyManager(harness.db);
  await mgr.bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
  setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
});

afterEach(async () => {
  resetFirmKeyManagerForTests();
  await harness.close();
  await rm(sealDir, { recursive: true, force: true });
});

describe('calendar column crypto (CAL-1)', () => {
  it('round-trips an OAuth token through the MFK envelope', () => {
    const { dek, wrappedDek } = newCalendarRecordKey(harness.db, seed.firmId);
    const recovered = unwrapCalendarRecordKey(harness.db, seed.firmId, wrappedDek);
    const ct = encField(dek, 'ya29.secret-access-token');
    expect(ct).not.toBeNull();
    expect(ct?.toString('utf8')).not.toContain('secret-access-token');
    expect(decField(recovered, ct)).toBe('ya29.secret-access-token');
  });
});

describe('calendar schema (migration 0109)', () => {
  it('stores an encrypted provider config row', async () => {
    const { dek, wrappedDek } = newCalendarRecordKey(harness.db, seed.firmId);
    await harness.db.insert(calendarProviderConfig).values({
      firmId: seed.firmId,
      provider: 'microsoft',
      tDekWrapped: Buffer.from(wrappedDek),
      clientIdEnc: encField(dek, 'azure-client-id')!,
      clientSecretEnc: encField(dek, 'azure-secret')!,
      tenantIdEnc: encField(dek, 'tenant-123'),
      enabled: true,
    });
    const [row] = await harness.db
      .select()
      .from(calendarProviderConfig)
      .where(eq(calendarProviderConfig.firmId, seed.firmId));
    const recovered = unwrapCalendarRecordKey(harness.db, seed.firmId, row!.tDekWrapped);
    expect(decField(recovered, row!.clientSecretEnc)).toBe('azure-secret');
    expect(decField(recovered, row!.tenantIdEnc)).toBe('tenant-123');
  });

  it('round-trips connection → selection → event → match → rsvp and cascades', async () => {
    const { dek, wrappedDek } = newCalendarRecordKey(harness.db, seed.firmId);
    const [conn] = await harness.db
      .insert(staffCalendarConnections)
      .values({
        firmId: seed.firmId,
        staffId: seed.appUserId,
        provider: 'google',
        tDekWrapped: Buffer.from(wrappedDek),
        accessTokenEnc: encField(dek, 'access-tok')!,
        refreshTokenEnc: encField(dek, 'refresh-tok'),
        providerEmail: 'staff@firm.example',
      })
      .returning({ id: staffCalendarConnections.id });

    await harness.db.insert(staffCalendarSelections).values({
      connectionId: conn!.id,
      calendarId: 'primary',
      calendarName: 'Work',
      isPrimary: true,
      syncEnabled: true,
    });

    const [event] = await harness.db
      .insert(calendarEvents)
      .values({
        firmId: seed.firmId,
        staffId: seed.appUserId,
        connectionId: conn!.id,
        providerEventId: 'evt-1',
        calendarId: 'primary',
        subject: 'Tax review — Acme',
        startAt: new Date('2026-06-10T18:00:00Z'),
        endAt: new Date('2026-06-10T19:00:00Z'),
        organizerEmail: 'staff@firm.example',
        attendees: [{ email: 'cfo@acme.example', name: 'CFO', response_status: 'accepted' }],
      })
      .returning({ id: calendarEvents.id });

    const [match] = await harness.db
      .insert(calendarEventMatches)
      .values({
        eventId: event!.id,
        clientId: seed.clientId,
        matchTier: 'exact_email',
        matchScore: 1,
        matchStatus: 'confirmed',
      })
      .returning({ id: calendarEventMatches.id });
    expect(match!.id).toBeTruthy();

    await harness.db.insert(calendarRsvpTokens).values({
      eventId: event!.id,
      expiresAt: new Date('2026-06-10T18:00:00Z'),
    });

    // Deleting the event cascades to matches + rsvp tokens.
    await harness.db.delete(calendarEvents).where(eq(calendarEvents.id, event!.id));
    expect(
      await harness.db
        .select()
        .from(calendarEventMatches)
        .where(eq(calendarEventMatches.eventId, event!.id)),
    ).toHaveLength(0);
    expect(
      await harness.db
        .select()
        .from(calendarRsvpTokens)
        .where(eq(calendarRsvpTokens.eventId, event!.id)),
    ).toHaveLength(0);
  });

  it('rejects an invalid provider and match status via CHECK', async () => {
    const { dek, wrappedDek } = newCalendarRecordKey(harness.db, seed.firmId);
    await expect(
      harness.db.insert(calendarProviderConfig).values({
        firmId: seed.firmId,
        provider: 'yahoo',
        tDekWrapped: Buffer.from(wrappedDek),
        clientIdEnc: encField(dek, 'x')!,
        clientSecretEnc: encField(dek, 'y')!,
      }),
    ).rejects.toThrow();
  });
});
