// SPDX-License-Identifier: Elastic-2.0
//
// 0103 — Document Intake foundations. Proves (a) the MFK-envelope column
// helpers round-trip a value through wrap→encrypt→decrypt→unwrap, (b)
// migration 0103 created the intake tables (a real session row stores and
// recovers its encrypted PII), and (c) the per-firm feature flag defaults
// off and flips on.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { firmConfig, intakeSessions } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import { newIntakeRecordKey, unwrapIntakeRecordKey, encField, decField } from '../intake/crypto';
import { isIntakeEnabled } from '../intake/feature-flag';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let sealDir: string;

beforeEach(async () => {
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-intake-seal-'));
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

describe('intake column crypto', () => {
  it('round-trips a record key and field through the MFK envelope', () => {
    const { dek, wrappedDek } = newIntakeRecordKey(harness.db, seed.firmId);
    const recovered = unwrapIntakeRecordKey(harness.db, seed.firmId, wrappedDek);
    const ct = encField(dek, 'jane@example.com');
    expect(ct).not.toBeNull();
    expect(decField(recovered, ct)).toBe('jane@example.com');
  });

  it('passes null fields through unchanged', () => {
    const { dek } = newIntakeRecordKey(harness.db, seed.firmId);
    expect(encField(dek, null)).toBeNull();
    expect(encField(dek, undefined)).toBeNull();
    expect(decField(dek, null)).toBeNull();
  });

  it('ciphertext is not the plaintext', () => {
    const { dek } = newIntakeRecordKey(harness.db, seed.firmId);
    const ct = encField(dek, 'secret-message');
    expect(ct?.toString('utf8')).not.toContain('secret-message');
  });
});

describe('intake schema (migration 0103)', () => {
  it('persists and recovers an encrypted intake session', async () => {
    const { dek, wrappedDek } = newIntakeRecordKey(harness.db, seed.firmId);
    await harness.db.insert(intakeSessions).values({
      firmId: seed.firmId,
      targetStaffId: seed.appUserId,
      wrappedDek: Buffer.from(wrappedDek),
      clientNameEnc: encField(dek, 'Jane Client'),
      clientEmailEnc: encField(dek, 'jane@example.com'),
    });

    const [row] = await harness.db
      .select()
      .from(intakeSessions)
      .where(eq(intakeSessions.firmId, seed.firmId))
      .limit(1);
    expect(row).toBeTruthy();
    expect(row?.status).toBe('pending_scan');
    expect(row?.source).toBe('public');

    const recovered = unwrapIntakeRecordKey(harness.db, seed.firmId, row!.wrappedDek);
    expect(decField(recovered, row!.clientNameEnc)).toBe('Jane Client');
    expect(decField(recovered, row!.clientEmailEnc)).toBe('jane@example.com');
  });

  // The migration's auto-seed runs before seedMinimalFirm inserts the
  // user (harness applies all migrations on an empty DB first), so here we
  // exercise the same idempotent seed statement and assert it produces one
  // hidden, upload-accepting card per active user — and no duplicates.
  it('seeds exactly one hidden staff card per active user (idempotent)', async () => {
    const seedCards = sql`
      INSERT INTO intake_staff_cards (firm_id, user_id, is_visible, accepting_uploads)
      SELECT u.firm_id, u.id, false, true
      FROM app_user u
      WHERE u.status = 'ACTIVE'
      ON CONFLICT (firm_id, user_id) DO NOTHING`;
    await harness.db.execute(seedCards);
    await harness.db.execute(seedCards); // second run must be a no-op

    const rows = await harness.db.execute(
      sql`SELECT is_visible, accepting_uploads FROM intake_staff_cards WHERE firm_id = ${seed.firmId}`,
    );
    const cards = (
      rows as unknown as { rows: { is_visible: boolean; accepting_uploads: boolean }[] }
    ).rows;
    expect(cards.length).toBe(1);
    expect(cards.every((c) => c.is_visible === false)).toBe(true);
    expect(cards.every((c) => c.accepting_uploads === true)).toBe(true);
  });
});

describe('isIntakeEnabled', () => {
  it('returns false when no firm_config row exists', async () => {
    expect(await isIntakeEnabled(harness.db, seed.firmId)).toBe(false);
  });

  it('returns false for a null db', async () => {
    expect(await isIntakeEnabled(null, seed.firmId)).toBe(false);
  });

  it('reflects the firm_config.intake_enabled flag', async () => {
    await harness.db.insert(firmConfig).values({ firmId: seed.firmId, intakeEnabled: true });
    expect(await isIntakeEnabled(harness.db, seed.firmId)).toBe(true);

    await harness.db
      .update(firmConfig)
      .set({ intakeEnabled: false })
      .where(eq(firmConfig.firmId, seed.firmId));
    expect(await isIntakeEnabled(harness.db, seed.firmId)).toBe(false);
  });
});
