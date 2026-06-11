// SPDX-License-Identifier: Elastic-2.0
//
// CAL-2 — per-staff OAuth connect flow end-to-end (mocked provider). Begin
// → authorize URL + stored state; callback exchanges the code, stores the
// encrypted tokens, fetches calendars (primary pre-enabled); selections
// PATCH + disconnect. Provider-not-enabled is refused.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  calendarProviderConfig,
  staffCalendarConnections,
  staffCalendarSelections,
} from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import {
  newCalendarRecordKey,
  encField,
  decField,
  unwrapCalendarRecordKey,
} from '../calendar/crypto';
import { createCalendarConnectRouter } from '../calendar/connect-routes';
import { createCalendarPublicRouter } from '../calendar/public-routes';
import type { OAuthStateStore } from '../calendar/connect-shared';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let sealDir: string;

// In-memory state store (stands in for Redis).
function memStore(): OAuthStateStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    async set(k, v) {
      map.set(k, v);
    },
    async get(k) {
      return map.get(k) ?? null;
    },
    async del(k) {
      map.delete(k);
    },
  };
}

// Mocked Google endpoints: token exchange, userinfo, calendar list.
const mockFetch: typeof fetch = (async (url: string) => {
  const u = String(url);
  if (u.includes('oauth2.googleapis.com/token')) {
    return new Response(
      JSON.stringify({
        access_token: 'acc-123',
        refresh_token: 'ref-456',
        expires_in: 3600,
        scope: 'calendar.readonly',
      }),
      { status: 200 },
    );
  }
  if (u.includes('googleapis.com/oauth2/v2/userinfo')) {
    return new Response(JSON.stringify({ id: 'g-user', email: 'staff@firm.example' }), {
      status: 200,
    });
  }
  if (u.includes('calendar/v3/users/me/calendarList')) {
    return new Response(
      JSON.stringify({
        items: [
          { id: 'primary', summary: 'Work', backgroundColor: '#fff', primary: true },
          { id: 'cal-2', summary: 'Personal', backgroundColor: '#0a0' },
        ],
      }),
      { status: 200 },
    );
  }
  return new Response('{}', { status: 200 });
}) as unknown as typeof fetch;

const REDIRECT_BASE = 'https://app.firm.example';

function buildApps(store: OAuthStateStore) {
  const staff = express();
  staff.use(express.json());
  staff.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  staff.use(
    '/api/staff/calendar',
    createCalendarConnectRouter({
      db: harness.db,
      stateStore: store,
      redirectBase: REDIRECT_BASE,
      fetchImpl: mockFetch,
    }),
  );

  const pub = express();
  pub.use(
    '/api/calendar',
    createCalendarPublicRouter({
      db: harness.db,
      stateStore: store,
      redirectBase: REDIRECT_BASE,
      appBaseUrl: REDIRECT_BASE,
      fetchImpl: mockFetch,
    }),
  );
  return { staff, pub };
}

async function enableProvider(provider: 'google' | 'microsoft'): Promise<void> {
  const { dek, wrappedDek } = newCalendarRecordKey(harness.db, seed.firmId);
  await harness.db.insert(calendarProviderConfig).values({
    firmId: seed.firmId,
    provider,
    tDekWrapped: Buffer.from(wrappedDek),
    clientIdEnc: encField(dek, 'cid')!,
    clientSecretEnc: encField(dek, 'csecret')!,
    tenantIdEnc: provider === 'microsoft' ? encField(dek, 'tid') : null,
    enabled: true,
  });
}

beforeEach(async () => {
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-cal-connect-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  await getFirmKeyManager(harness.db).bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
  setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
});
afterEach(async () => {
  resetFirmKeyManagerForTests();
  await harness.close();
  await rm(sealDir, { recursive: true, force: true });
});

function stateFromUrl(url: string): string {
  return new URL(url).searchParams.get('state')!;
}

describe('calendar connect flow (CAL-2)', () => {
  it('refuses to connect a provider that is not enabled', async () => {
    const store = memStore();
    const { staff } = buildApps(store);
    const res = await request(staff).post('/api/staff/calendar/connect/google');
    expect(res.status).toBe(409);
  });

  it('begins OAuth, then the callback stores tokens + calendars', async () => {
    await enableProvider('google');
    const store = memStore();
    const { staff, pub } = buildApps(store);

    const begin = await request(staff).post('/api/staff/calendar/connect/google');
    expect(begin.status).toBe(200);
    const url = begin.body.authorizeUrl as string;
    expect(url).toContain('accounts.google.com');
    expect(url).toContain('client_id=cid');
    const state = stateFromUrl(url);
    expect(store.map.has(`cal:oauth:state:${state}`)).toBe(true);

    // Provider redirects back to the public callback.
    const cb = await request(pub).get(
      `/api/calendar/oauth/callback/google?state=${state}&code=auth-code`,
    );
    expect(cb.status).toBe(302);
    expect(cb.headers['location']).toBe(`${REDIRECT_BASE}/account?cal_connect=success`);
    // State is single-use.
    expect(store.map.has(`cal:oauth:state:${state}`)).toBe(false);

    const [conn] = await harness.db
      .select()
      .from(staffCalendarConnections)
      .where(eq(staffCalendarConnections.staffId, seed.appUserId));
    expect(conn!.provider).toBe('google');
    expect(conn!.providerEmail).toBe('staff@firm.example');
    // Tokens decrypt back.
    const dek = unwrapCalendarRecordKey(harness.db, seed.firmId, conn!.tDekWrapped);
    expect(decField(dek, conn!.accessTokenEnc)).toBe('acc-123');
    expect(decField(dek, conn!.refreshTokenEnc)).toBe('ref-456');

    // Calendars stored; primary pre-enabled, the other off.
    const sels = await harness.db
      .select()
      .from(staffCalendarSelections)
      .where(eq(staffCalendarSelections.connectionId, conn!.id));
    expect(sels).toHaveLength(2);
    expect(sels.find((s) => s.calendarId === 'primary')!.syncEnabled).toBe(true);
    expect(sels.find((s) => s.calendarId === 'cal-2')!.syncEnabled).toBe(false);
  });

  it('rejects a replayed / unknown state', async () => {
    const store = memStore();
    const { pub } = buildApps(store);
    const res = await request(pub).get('/api/calendar/oauth/callback/google?state=bogus&code=x');
    expect(res.status).toBe(400);
  });

  it('updates selections and disconnects', async () => {
    await enableProvider('google');
    const store = memStore();
    const { staff, pub } = buildApps(store);
    const begin = await request(staff).post('/api/staff/calendar/connect/google');
    const state = stateFromUrl(begin.body.authorizeUrl);
    await request(pub).get(`/api/calendar/oauth/callback/google?state=${state}&code=c`);

    const list = await request(staff).get('/api/staff/calendar/connections');
    const connId = list.body.connections[0].id as string;

    const patch = await request(staff)
      .patch(`/api/staff/calendar/connections/${connId}/selections`)
      .send({ selections: [{ calendarId: 'cal-2', syncEnabled: true }] });
    expect(patch.status).toBe(200);
    const [sel] = await harness.db
      .select()
      .from(staffCalendarSelections)
      .where(eq(staffCalendarSelections.calendarId, 'cal-2'));
    expect(sel!.syncEnabled).toBe(true);

    const del = await request(staff).delete(`/api/staff/calendar/connections/${connId}`);
    expect(del.status).toBe(200);
    expect(
      await harness.db
        .select()
        .from(staffCalendarConnections)
        .where(eq(staffCalendarConnections.id, connId)),
    ).toHaveLength(0);
  });
});
