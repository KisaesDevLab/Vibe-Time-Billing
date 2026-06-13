// SPDX-License-Identifier: Elastic-2.0
//
// Token-refresh concurrency: two callers (api + worker) refreshing the
// same connection must not overwrite each other's rotated refresh token.
// The CAS in ensureFreshAccessToken persists only the winner's set; the
// loser re-reads and returns the winner's access token.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { staffCalendarConnections } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import { newCalendarRecordKey, encField } from '../calendar/crypto';
import { ensureFreshAccessToken } from '../calendar/token-manager';
import { decryptConnectionTokens, type ProviderCreds } from '../calendar/store';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let sealDir: string;

const CREDS: ProviderCreds = {
  clientId: 'cid',
  clientSecret: 'csec',
  tenantId: null,
  enabled: true,
};

async function seedConn(opts: { expired: boolean }): Promise<string> {
  const ck = newCalendarRecordKey(harness.db, seed.firmId);
  const [conn] = await harness.db
    .insert(staffCalendarConnections)
    .values({
      firmId: seed.firmId,
      staffId: seed.appUserId,
      provider: 'google',
      tDekWrapped: Buffer.from(ck.wrappedDek),
      accessTokenEnc: encField(ck.dek, 'acc-old')!,
      refreshTokenEnc: encField(ck.dek, 'ref-old'),
      tokenExpiry: opts.expired ? new Date('2020-01-01T00:00:00Z') : null,
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
      enabled: true,
    })
    .returning({ id: staffCalendarConnections.id });
  return conn!.id;
}

async function loadRow(id: string) {
  const [row] = await harness.db
    .select()
    .from(staffCalendarConnections)
    .where(eq(staffCalendarConnections.id, id))
    .limit(1);
  return row!;
}

/** Token endpoint mock whose Nth call returns token set N, with each
 *  response held until the test releases it. */
function gatedTokenFetch(): {
  fetchImpl: typeof fetch;
  release: (n: number) => void;
  calls: () => number;
} {
  const gates: (() => void)[] = [];
  let calls = 0;
  const fetchImpl = (async (url: string) => {
    if (!String(url).includes('oauth2.googleapis.com/token')) {
      return new Response('{}', { status: 200 });
    }
    const n = ++calls;
    await new Promise<void>((resolve) => {
      gates[n - 1] = resolve;
    });
    return new Response(
      JSON.stringify({
        access_token: `acc-${n}`,
        refresh_token: `ref-${n}`,
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/calendar.readonly',
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, release: (n) => gates[n - 1]?.(), calls: () => calls };
}

beforeEach(async () => {
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-tokrace-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  await getFirmKeyManager(harness.db).bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
  setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
});
afterEach(async () => {
  await harness.close();
  await rm(sealDir, { recursive: true, force: true });
});

describe('ensureFreshAccessToken — concurrent refresh', () => {
  it('the loser discards its token set and adopts the winner’s (no lost rotation)', async () => {
    const id = await seedConn({ expired: true });
    const conn = await loadRow(id);
    const { fetchImpl, release, calls } = gatedTokenFetch();

    // Both callers read the same stale row, then refresh concurrently.
    const p1 = ensureFreshAccessToken(harness.db, conn, CREDS, fetchImpl);
    const p2 = ensureFreshAccessToken(harness.db, conn, CREDS, fetchImpl);
    // Wait until both provider calls are in flight.
    while (calls() < 2) await new Promise((r) => setTimeout(r, 5));

    release(1);
    const t1 = await p1; // winner persists acc-1/ref-1
    release(2);
    const t2 = await p2; // CAS fails → re-read → adopts acc-1

    expect(t1).toBe('acc-1');
    expect(t2).toBe('acc-1');
    const after = await loadRow(id);
    const stored = decryptConnectionTokens(harness.db, seed.firmId, after);
    expect(stored.accessToken).toBe('acc-1');
    expect(stored.refreshToken).toBe('ref-1'); // ref-2 was discarded, not persisted
  });

  it('a single caller with NULL expiry still persists normally (IS NULL guard)', async () => {
    const id = await seedConn({ expired: false }); // tokenExpiry NULL → refresh path
    const conn = await loadRow(id);
    const { fetchImpl, release } = gatedTokenFetch();
    const p = ensureFreshAccessToken(harness.db, conn, CREDS, fetchImpl);
    await new Promise((r) => setTimeout(r, 5));
    release(1);
    expect(await p).toBe('acc-1');
    const stored = decryptConnectionTokens(harness.db, seed.firmId, await loadRow(id));
    expect(stored.accessToken).toBe('acc-1');
    expect(stored.refreshToken).toBe('ref-1');
  });
});
