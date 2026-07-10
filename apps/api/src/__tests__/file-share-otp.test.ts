// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0150 — OTP challenge/grant helper for gated file shares. Verifies:
// codes are hashed at rest, resend cooldown + 24h quota, single live
// challenge (resend retires the prior one), the 5-attempt lock and
// 3-challenge revoke signal, and the grant mint/verify/expiry cycle.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { clientFolders, fileShareOtps, fileShares, files } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import {
  createOtpChallenge,
  verifyOtpChallenge,
  verifyGrant,
  GRANT_TTL_MS,
  MAX_ATTEMPTS,
  MAX_SENDS_PER_24H,
} from '../sharing/file-share-otp';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let shareId: string;

const T0 = new Date('2026-06-11T12:00:00Z');
const plus = (ms: number): Date => new Date(T0.getTime() + ms);

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  // A minimal folder + file + share to hang challenges off.
  const [folder] = await harness.db
    .insert(clientFolders)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      storagePath: `clients/${seed.clientId}`,
    })
    .returning({ id: clientFolders.id });
  const [f] = await harness.db
    .insert(files)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      clientFolderId: folder!.id,
      originalFilename: 'doc.pdf',
      storageKey: `clients/${seed.clientId}/doc.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 10,
    })
    .returning({ id: files.id });
  const fileId = f!.id;
  const [share] = await harness.db
    .insert(fileShares)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      fileId,
      tokenHash: `th-${Math.random()}`,
      recipientEmail: 'kurt.recipient@example.com',
      recipientPhone: '+15555550100',
      verifyChannel: 'NONE',
      gated: true,
    })
    .returning({ id: fileShares.id });
  shareId = share!.id;
});
afterEach(async () => {
  await harness.close();
});

async function shareRow() {
  const [s] = await harness.db.select().from(fileShares).where(eq(fileShares.id, shareId));
  return s!;
}

describe('createOtpChallenge', () => {
  it('hashes the code at rest and masks the destination', async () => {
    const r = await createOtpChallenge(harness.db, await shareRow(), T0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.code).toMatch(/^\d{6}$/);
    expect(r.channel).toBe('EMAIL');
    expect(r.maskedDestination).toBe('k************t@example.com');
    const [row] = await harness.db.select().from(fileShareOtps);
    expect(row!.codeHash).not.toContain(r.code);
    expect(row!.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses SMS when verifyChannel is SMS and a phone exists', async () => {
    await harness.db
      .update(fileShares)
      .set({ verifyChannel: 'SMS' })
      .where(eq(fileShares.id, shareId));
    const r = await createOtpChallenge(harness.db, await shareRow(), T0);
    expect(r.ok && r.channel).toBe('SMS');
  });

  it('cooldown blocks an immediate resend; a later one retires the old code', async () => {
    const first = await createOtpChallenge(harness.db, await shareRow(), T0);
    expect(first.ok).toBe(true);
    const tooSoon = await createOtpChallenge(harness.db, await shareRow(), plus(30_000));
    expect(tooSoon).toMatchObject({ ok: false, error: 'cooldown' });

    const second = await createOtpChallenge(harness.db, await shareRow(), plus(61_000));
    expect(second.ok).toBe(true);
    // Old challenge retired — its code no longer verifies.
    if (!first.ok || !second.ok) return;
    const stale = await verifyOtpChallenge(harness.db, shareId, first.code, plus(62_000));
    // Either no_active_code (old locked) or invalid (new challenge compared).
    expect(stale.ok).toBe(false);
    const fresh = await verifyOtpChallenge(harness.db, shareId, second.code, plus(62_000));
    expect(fresh.ok).toBe(true);
  });

  it('enforces the 24h send quota', async () => {
    let t = T0.getTime();
    for (let i = 0; i < MAX_SENDS_PER_24H; i++) {
      const r = await createOtpChallenge(harness.db, await shareRow(), new Date(t));
      expect(r.ok).toBe(true);
      t += 61_000;
    }
    const over = await createOtpChallenge(harness.db, await shareRow(), new Date(t));
    expect(over).toMatchObject({ ok: false, error: 'send_quota' });
  });

  it('no destination → no_destination', async () => {
    await harness.db
      .update(fileShares)
      .set({ recipientEmail: null, recipientPhone: null })
      .where(eq(fileShares.id, shareId));
    const r = await createOtpChallenge(harness.db, await shareRow(), T0);
    expect(r).toMatchObject({ ok: false, error: 'no_destination' });
  });
});

describe('verifyOtpChallenge', () => {
  it('expired code → no_active_code', async () => {
    const r = await createOtpChallenge(harness.db, await shareRow(), T0);
    if (!r.ok) throw new Error('setup');
    const late = await verifyOtpChallenge(harness.db, shareId, r.code, plus(11 * 60_000));
    expect(late).toMatchObject({ ok: false, error: 'no_active_code' });
  });

  it('5 wrong attempts lock; 3 exhausted challenges signal revoke', async () => {
    for (let round = 1; round <= 3; round++) {
      const sendAt = plus(round * 61_000);
      const c = await createOtpChallenge(harness.db, await shareRow(), sendAt);
      if (!c.ok) throw new Error('setup');
      const wrong = c.code === '000000' ? '111111' : '000000';
      for (let i = 1; i <= MAX_ATTEMPTS; i++) {
        const v = await verifyOtpChallenge(harness.db, shareId, wrong, sendAt);
        if (i < MAX_ATTEMPTS) {
          expect(v).toMatchObject({ ok: false, error: 'invalid_code' });
          if (!v.ok && v.error === 'invalid_code') {
            expect(v.attemptsRemaining).toBe(MAX_ATTEMPTS - i);
          }
        } else {
          expect(v).toMatchObject({ ok: false, error: 'locked', shouldRevoke: round >= 3 });
        }
      }
    }
  });

  it('correct code mints a grant; verifyGrant round-trips and expires', async () => {
    const c = await createOtpChallenge(harness.db, await shareRow(), T0);
    if (!c.ok) throw new Error('setup');
    const v = await verifyOtpChallenge(harness.db, shareId, c.code, plus(1000));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(await verifyGrant(harness.db, shareId, v.grant, plus(2000))).toBe(true);
    expect(await verifyGrant(harness.db, shareId, 'wrong-grant-value-here-123', plus(2000))).toBe(
      false,
    );
    expect(await verifyGrant(harness.db, shareId, v.grant, plus(GRANT_TTL_MS + 3000))).toBe(false);
    // Grant stored hashed.
    const [row] = await harness.db.select().from(fileShareOtps);
    expect(row!.grantTokenHash).not.toContain(v.grant);
  });
});
