// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
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
  calendarEvents,
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

function buildApps(store: OAuthStateStore, fetchImpl: typeof fetch = mockFetch) {
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
      fetchImpl,
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
      fetchImpl,
    }),
  );
  return { staff, pub };
}

/** mockFetch variant with per-URL-substring overrides. */
function fetchWith(
  overrides: Record<string, (url: string) => Response | Promise<Response>>,
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    for (const [needle, fn] of Object.entries(overrides)) {
      if (u.includes(needle)) return fn(u);
    }
    return mockFetch(url as never, init);
  }) as unknown as typeof fetch;
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

  it('microsoft authorize URL forces the consent screen', async () => {
    await enableProvider('microsoft');
    const store = memStore();
    const { staff } = buildApps(store);
    const begin = await request(staff).post('/api/staff/calendar/connect/microsoft');
    expect(begin.status).toBe(200);
    expect(begin.body.authorizeUrl).toContain('prompt=consent');
  });
});

describe('connect-flow error visibility', () => {
  async function beginAndGetState(staff: express.Express): Promise<string> {
    const begin = await request(staff).post('/api/staff/calendar/connect/google');
    return stateFromUrl(begin.body.authorizeUrl);
  }

  it('provider decline redirects with cal_error=declined', async () => {
    await enableProvider('google');
    const store = memStore();
    const { staff, pub } = buildApps(store);
    const state = await beginAndGetState(staff);
    const cb = await request(pub).get(
      `/api/calendar/oauth/callback/google?state=${state}&error=access_denied`,
    );
    expect(cb.status).toBe(302);
    expect(cb.headers['location']).toBe(
      `${REDIRECT_BASE}/account?cal_connect=error&cal_error=declined`,
    );
  });

  it('token-exchange failure redirects with cal_error=auth_failed', async () => {
    await enableProvider('google');
    const store = memStore();
    const failTokens = fetchWith({
      'oauth2.googleapis.com/token': () => new Response('{"error":"bad"}', { status: 400 }),
    });
    const { staff, pub } = buildApps(store, failTokens);
    const state = await beginAndGetState(staff);
    const cb = await request(pub).get(
      `/api/calendar/oauth/callback/google?state=${state}&code=auth-code`,
    );
    expect(cb.status).toBe(302);
    expect(cb.headers['location']).toBe(
      `${REDIRECT_BASE}/account?cal_connect=error&cal_error=auth_failed`,
    );
  });

  it('calendar-list failure still connects but marks syncError', async () => {
    await enableProvider('google');
    const store = memStore();
    const failList = fetchWith({
      'calendar/v3/users/me/calendarList': () => new Response('nope', { status: 500 }),
    });
    const { staff, pub } = buildApps(store, failList);
    const state = await beginAndGetState(staff);
    const cb = await request(pub).get(
      `/api/calendar/oauth/callback/google?state=${state}&code=auth-code`,
    );
    expect(cb.status).toBe(302);
    expect(cb.headers['location']).toBe(`${REDIRECT_BASE}/account?cal_connect=success`);
    const [conn] = await harness.db
      .select()
      .from(staffCalendarConnections)
      .where(eq(staffCalendarConnections.staffId, seed.appUserId));
    expect(conn!.syncError).toBe('calendar_list_failed');
  });

  it('refresh-calendars failure persists syncError; a later success clears it', async () => {
    await enableProvider('google');
    const store = memStore();
    const { staff, pub } = buildApps(store);
    const state = await beginAndGetState(staff);
    await request(pub).get(`/api/calendar/oauth/callback/google?state=${state}&code=c`);
    const list = await request(staff).get('/api/staff/calendar/connections');
    const connId = list.body.connections[0].id as string;

    const failList = fetchWith({
      'calendar/v3/users/me/calendarList': () => new Response('nope', { status: 500 }),
    });
    const { staff: failingStaff } = buildApps(store, failList);
    const bad = await request(failingStaff).post(
      `/api/staff/calendar/connections/${connId}/refresh-calendars`,
    );
    expect(bad.status).toBe(502);
    let [conn] = await harness.db
      .select()
      .from(staffCalendarConnections)
      .where(eq(staffCalendarConnections.id, connId));
    expect(conn!.syncError).toBe('calendar_list_failed');

    const good = await request(staff).post(
      `/api/staff/calendar/connections/${connId}/refresh-calendars`,
    );
    expect(good.status).toBe(200);
    [conn] = await harness.db
      .select()
      .from(staffCalendarConnections)
      .where(eq(staffCalendarConnections.id, connId));
    expect(conn!.syncError).toBeNull();
  });
});

describe('write capability + first sync', () => {
  afterEach(() => {
    delete process.env['FEATURE_CALENDAR_WRITE'];
  });

  it('GET /connections reports canWrite per scope and writeEnabled per flag', async () => {
    process.env['FEATURE_CALENDAR_WRITE'] = 'true';
    await enableProvider('google');
    const store = memStore();
    // Read-only scope (mockFetch default token response).
    const { staff, pub } = buildApps(store);
    const begin = await request(staff).post('/api/staff/calendar/connect/google');
    const state = stateFromUrl(begin.body.authorizeUrl);
    await request(pub).get(`/api/calendar/oauth/callback/google?state=${state}&code=c`);
    let list = await request(staff).get('/api/staff/calendar/connections');
    expect(list.body.writeEnabled).toBe(true);
    expect(list.body.connections[0].canWrite).toBe(false);

    // Reconnect with a write scope → canWrite flips.
    const writeTokens = fetchWith({
      'oauth2.googleapis.com/token': () =>
        new Response(
          JSON.stringify({
            access_token: 'acc-w',
            refresh_token: 'ref-w',
            expires_in: 3600,
            scope: 'https://www.googleapis.com/auth/calendar.events',
          }),
          { status: 200 },
        ),
    });
    const { staff: wStaff, pub: wPub } = buildApps(store, writeTokens);
    const begin2 = await request(wStaff).post('/api/staff/calendar/connect/google');
    const state2 = stateFromUrl(begin2.body.authorizeUrl);
    await request(wPub).get(`/api/calendar/oauth/callback/google?state=${state2}&code=c`);
    list = await request(wStaff).get('/api/staff/calendar/connections');
    expect(list.body.connections[0].canWrite).toBe(true);
  });

  it('the callback runs a first sync inline — events appear without a worker tick', async () => {
    await enableProvider('google');
    const store = memStore();
    const withEvents = fetchWith({
      '/calendar/v3/calendars/': () =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: 'ev-1',
                summary: 'Kickoff',
                start: { dateTime: new Date(Date.now() + 86_400_000).toISOString() },
                end: { dateTime: new Date(Date.now() + 90_000_000).toISOString() },
              },
            ],
          }),
          { status: 200 },
        ),
    });
    const { staff, pub } = buildApps(store, withEvents);
    const begin = await request(staff).post('/api/staff/calendar/connect/google');
    const state = stateFromUrl(begin.body.authorizeUrl);
    const cb = await request(pub).get(`/api/calendar/oauth/callback/google?state=${state}&code=c`);
    expect(cb.headers['location']).toBe(`${REDIRECT_BASE}/account?cal_connect=success`);

    const [conn] = await harness.db
      .select()
      .from(staffCalendarConnections)
      .where(eq(staffCalendarConnections.staffId, seed.appUserId));
    expect(conn!.lastSyncedAt).not.toBeNull();
    const events = await harness.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.connectionId, conn!.id));
    expect(events).toHaveLength(1);
    expect(events[0]!.subject).toBe('Kickoff');
  });

  it('a failing first sync does not flip the connect outcome', async () => {
    await enableProvider('google');
    const store = memStore();
    const failEvents = fetchWith({
      '/calendar/v3/calendars/': () => new Response('boom', { status: 500 }),
    });
    const { staff, pub } = buildApps(store, failEvents);
    const begin = await request(staff).post('/api/staff/calendar/connect/google');
    const state = stateFromUrl(begin.body.authorizeUrl);
    const cb = await request(pub).get(`/api/calendar/oauth/callback/google?state=${state}&code=c`);
    expect(cb.status).toBe(302);
    expect(cb.headers['location']).toBe(`${REDIRECT_BASE}/account?cal_connect=success`);
  });
});
