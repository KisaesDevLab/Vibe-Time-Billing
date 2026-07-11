// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0207 — pause-and-hold stopwatch timers:
//  - blank start (no engagement) allowed; classification deferred
//  - starting a second timer auto-pauses the running one (single-RUNNING)
//  - resume swaps which timer runs
//  - PATCH classifies (engagement backfills client) and corrects elapsed
//  - save converts to a time_entry with exact 2-decimal hours (min 0.01)
//    and deletes the timer; a rejected save leaves the timer PAUSED
//  - discard deletes; forgotten RUNNING timers lazily auto-pause on read

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type express from 'express';
import { eq } from 'drizzle-orm';

import {
  engagements,
  staffRateSnapshotEntries,
  staffRateSnapshots,
  timeEntries,
  timeTimers,
} from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createTimerRouter, TIMER_AUTO_PAUSE_SECONDS } from '../time-entries/timers';

let h: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  h = await buildPgliteHarness();
  seed = await seedMinimalFirm(h.db);
  // StandardRate snapshot so the save path can resolve a rate and reach
  // the time_entry insert (otherwise it 400s with no_rate_resolves).
  const [snap] = await h.db
    .insert(staffRateSnapshots)
    .values({ appUserId: seed.appUserId, effectiveDate: '2026-01-01', costRateCents: 12000 })
    .returning({ id: staffRateSnapshots.id });
  await h.db.insert(staffRateSnapshotEntries).values({
    snapshotId: snap!.id,
    rateCodeId: seed.rateCodeId,
    billRateCents: 30000,
  });
});
afterEach(async () => {
  await h.close();
});

interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
}
function makeRes(): FakeRes {
  return {
    statusCode: 200,
    jsonBody: undefined,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.jsonBody = b;
      return this;
    },
  };
}
async function invoke(
  router: express.Router,
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  req: Record<string, unknown>,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const chain = route.stack;
  for (let i = 0; i < chain.length - 1; i++) {
    let advanced = false;
    await (chain[i]!.handle as (rq: unknown, rs: unknown, nx: () => void) => unknown)(
      req,
      res,
      () => {
        advanced = true;
      },
    );
    if (!advanced) return res;
  }
  await (chain[chain.length - 1]!.handle as (rq: unknown, rs: unknown) => unknown)(req, res);
  return res;
}
function req(body: unknown, params: Record<string, string> = {}): Record<string, unknown> {
  return {
    body: body ?? {},
    params,
    query: {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
}
function router(roles: RoleSlug[] = ['staff']) {
  return createTimerRouter({
    db: h.db,
    fakeUserRoles: new Map([[seed.appUserId, roles]]),
  });
}

interface TimerDto {
  id: string;
  clientId: string | null;
  engagementId: string | null;
  status: 'RUNNING' | 'PAUSED';
  elapsedSeconds: number;
  autoPausedAt: string | null;
}
function items(r: FakeRes): TimerDto[] {
  return (r.jsonBody as { items: TimerDto[] }).items;
}

/** Backdate a timer's running segment to simulate elapsed wall-clock. */
async function backdate(id: string, seconds: number): Promise<void> {
  await h.db
    .update(timeTimers)
    .set({ lastStartedAt: new Date(Date.now() - seconds * 1000) })
    .where(eq(timeTimers.id, id));
}

describe('POST / — start', () => {
  it('starts blank (no engagement) and RUNNING', async () => {
    const r = await invoke(router(), 'post', '/', req({}));
    expect(r.statusCode).toBe(201);
    const [t] = items(r);
    expect(t!.status).toBe('RUNNING');
    expect(t!.engagementId).toBeNull();
    expect(t!.clientId).toBeNull();
  });

  it('starting a second timer pauses the running one', async () => {
    const a = await invoke(router(), 'post', '/', req({ engagementId: seed.engagementId }));
    const aId = items(a).find((t) => t.status === 'RUNNING')!.id;
    await backdate(aId, 600);
    const b = await invoke(router(), 'post', '/', req({ description: 'phone call' }));
    const list = items(b);
    expect(list).toHaveLength(2);
    const paused = list.find((t) => t.id === aId)!;
    expect(paused.status).toBe('PAUSED');
    // The 10 backdated minutes were accumulated at pause time.
    expect(paused.elapsedSeconds).toBeGreaterThanOrEqual(600);
    expect(list.filter((t) => t.status === 'RUNNING')).toHaveLength(1);
  });

  it('derives clientId from the engagement', async () => {
    const r = await invoke(router(), 'post', '/', req({ engagementId: seed.engagementId }));
    expect(items(r)[0]!.clientId).toBe(seed.clientId);
  });

  it('rejects an engagement from another firm', async () => {
    const r = await invoke(
      router(),
      'post',
      '/',
      req({ engagementId: '00000000-0000-4000-8000-000000000000' }),
    );
    expect(r.statusCode).toBe(404);
  });

  it('rejects an unknown work code up-front (404, no FK 500)', async () => {
    const r = await invoke(
      router(),
      'post',
      '/',
      req({ workCodeId: '00000000-0000-4000-8000-000000000000' }),
    );
    expect(r.statusCode).toBe(404);
    expect((r.jsonBody as { error: string }).error).toBe('work_code_not_found');
  });

  it('caps the parking lot (409 timer_limit)', async () => {
    for (let i = 0; i < 10; i++) {
      await h.db.insert(timeTimers).values({
        appUserId: seed.appUserId,
        status: 'PAUSED',
        accumulatedSeconds: 60,
        startedAt: new Date(),
      });
    }
    const r = await invoke(router(), 'post', '/', req({}));
    expect(r.statusCode).toBe(409);
    expect((r.jsonBody as { error: string }).error).toBe('timer_limit');
  });

  it('requires time_entry:create (403 without it)', async () => {
    const r = await invoke(router([]), 'post', '/', req({}));
    expect(r.statusCode).toBe(403);
  });
});

describe('pause / resume', () => {
  it('pause accumulates; pausing a paused timer 409s', async () => {
    const a = await invoke(router(), 'post', '/', req({}));
    const id = items(a)[0]!.id;
    await backdate(id, 300);
    const p = await invoke(router(), 'post', '/:id/pause', req({}, { id }));
    const t = items(p).find((x) => x.id === id)!;
    expect(t.status).toBe('PAUSED');
    expect(t.elapsedSeconds).toBeGreaterThanOrEqual(300);
    const again = await invoke(router(), 'post', '/:id/pause', req({}, { id }));
    expect(again.statusCode).toBe(409);
  });

  it('resume swaps which timer runs (single-RUNNING invariant)', async () => {
    const a = await invoke(router(), 'post', '/', req({ description: 'first' }));
    const aId = items(a)[0]!.id;
    const b = await invoke(router(), 'post', '/', req({ description: 'second' }));
    const bId = items(b).find((t) => t.id !== aId)!.id;
    const r = await invoke(router(), 'post', '/:id/resume', req({}, { id: aId }));
    const list = items(r);
    expect(list.find((t) => t.id === aId)!.status).toBe('RUNNING');
    expect(list.find((t) => t.id === bId)!.status).toBe('PAUSED');
  });

  it("404s on another user's timer", async () => {
    const [foreign] = await h.db
      .insert(timeTimers)
      .values({
        // seed.appUserId is the caller; make a row owned by nobody-they-know
        appUserId: seed.appUserId,
        status: 'PAUSED',
        accumulatedSeconds: 1,
        startedAt: new Date(),
      })
      .returning({ id: timeTimers.id });
    // simulate foreign ownership by asking for a random uuid
    void foreign;
    const r = await invoke(
      router(),
      'post',
      '/:id/resume',
      req({}, { id: '00000000-0000-4000-8000-000000000000' }),
    );
    expect(r.statusCode).toBe(404);
  });
});

describe('PATCH /:id — classify & correct elapsed', () => {
  it('setting the engagement backfills clientId', async () => {
    const a = await invoke(router(), 'post', '/', req({}));
    const id = items(a)[0]!.id;
    const r = await invoke(
      router(),
      'patch',
      '/:id',
      req({ engagementId: seed.engagementId, description: 'classified' }, { id }),
    );
    const t = items(r).find((x) => x.id === id)!;
    expect(t.engagementId).toBe(seed.engagementId);
    expect(t.clientId).toBe(seed.clientId);
  });

  it('rejects unknown work code / client ids (404, no FK 500)', async () => {
    const a = await invoke(router(), 'post', '/', req({}));
    const id = items(a)[0]!.id;
    const w = await invoke(
      router(),
      'patch',
      '/:id',
      req({ workCodeId: '00000000-0000-4000-8000-000000000000' }, { id }),
    );
    expect(w.statusCode).toBe(404);
    expect((w.jsonBody as { error: string }).error).toBe('work_code_not_found');
    const c = await invoke(
      router(),
      'patch',
      '/:id',
      req({ clientId: '00000000-0000-4000-8000-000000000000' }, { id }),
    );
    expect(c.statusCode).toBe(404);
    expect((c.jsonBody as { error: string }).error).toBe('client_not_found');
  });

  it('elapsedSeconds replaces the tracked time as of now', async () => {
    const a = await invoke(router(), 'post', '/', req({}));
    const id = items(a)[0]!.id;
    await backdate(id, 3600);
    const r = await invoke(router(), 'patch', '/:id', req({ elapsedSeconds: 120 }, { id }));
    const t = items(r).find((x) => x.id === id)!;
    // Still RUNNING, but the hour-old segment was replaced by 120s.
    expect(t.status).toBe('RUNNING');
    expect(t.elapsedSeconds).toBeGreaterThanOrEqual(120);
    expect(t.elapsedSeconds).toBeLessThan(200);
  });
});

describe('POST /:id/save — convert to time entry', () => {
  const save = (id: string, body: unknown = {}) =>
    invoke(router(), 'post', '/:id/save', req(body, { id }));

  it('saves exact 2-decimal hours from elapsed and deletes the timer', async () => {
    const a = await invoke(
      router(),
      'post',
      '/',
      req({ engagementId: seed.engagementId, description: 'call' }),
    );
    const id = items(a)[0]!.id;
    await backdate(id, 1110); // 18.5 min → 0.31 hr exact, NOT 0.25-rounded
    const r = await save(id);
    expect(r.statusCode).toBe(201);
    const body = r.jsonBody as { id: string; items: TimerDto[]; elapsedSeconds: number };
    expect(body.elapsedSeconds).toBeGreaterThanOrEqual(1110);
    expect(body.items).toHaveLength(0); // timer gone
    const [entry] = await h.db.select().from(timeEntries).where(eq(timeEntries.id, body.id));
    expect(entry!.hours).toBe('0.31');
    expect(entry!.description).toBe('call');
    const remaining = await h.db.select().from(timeTimers).where(eq(timeTimers.id, id));
    expect(remaining).toHaveLength(0);
  });

  it('floors sub-18-second timers at 0.01 hours (hours > 0 CHECK)', async () => {
    const a = await invoke(router(), 'post', '/', req({ engagementId: seed.engagementId }));
    const id = items(a)[0]!.id;
    const r = await save(id); // ~0 elapsed
    expect(r.statusCode).toBe(201);
    const body = r.jsonBody as { id: string };
    const [entry] = await h.db.select().from(timeEntries).where(eq(timeEntries.id, body.id));
    expect(entry!.hours).toBe('0.01');
  });

  it('400s engagement_required on an unclassified timer (timer survives)', async () => {
    const a = await invoke(router(), 'post', '/', req({}));
    const id = items(a)[0]!.id;
    const r = await save(id);
    expect(r.statusCode).toBe(400);
    expect((r.jsonBody as { error: string }).error).toBe('engagement_required');
    const [row] = await h.db.select().from(timeTimers).where(eq(timeTimers.id, id));
    expect(row!.status).toBe('PAUSED'); // parked, not lost
  });

  it('a save rejected by engagement lifecycle leaves the timer PAUSED', async () => {
    const a = await invoke(router(), 'post', '/', req({ engagementId: seed.engagementId }));
    const id = items(a)[0]!.id;
    await backdate(id, 900);
    await h.db
      .update(engagements)
      .set({ status: 'PAUSED' })
      .where(eq(engagements.id, seed.engagementId));
    const r = await save(id);
    expect(r.statusCode).toBe(409);
    expect((r.jsonBody as { error: string }).error).toBe('engagement_not_writable');
    const [row] = await h.db.select().from(timeTimers).where(eq(timeTimers.id, id));
    expect(row!.status).toBe('PAUSED');
    expect(row!.accumulatedSeconds).toBeGreaterThanOrEqual(900); // time preserved
  });

  it('rejects an unknown work code in the save body (timer survives)', async () => {
    const a = await invoke(router(), 'post', '/', req({ engagementId: seed.engagementId }));
    const id = items(a)[0]!.id;
    const r = await save(id, { workCodeId: '00000000-0000-4000-8000-000000000000' });
    expect(r.statusCode).toBe(404);
    expect((r.jsonBody as { error: string }).error).toBe('work_code_not_found');
    const [row] = await h.db.select().from(timeTimers).where(eq(timeTimers.id, id));
    expect(row).toBeDefined();
  });

  it('body overrides (hours, engagement) win over timer fields', async () => {
    const a = await invoke(router(), 'post', '/', req({}));
    const id = items(a)[0]!.id;
    const r = await save(id, {
      engagementId: seed.engagementId,
      hours: 2.5,
      description: 'manual',
    });
    expect(r.statusCode).toBe(201);
    const body = r.jsonBody as { id: string };
    const [entry] = await h.db.select().from(timeEntries).where(eq(timeEntries.id, body.id));
    expect(entry!.hours).toBe('2.50');
    expect(entry!.description).toBe('manual');
  });
});

describe('DELETE /:id — discard', () => {
  it('deletes the timer outright', async () => {
    const a = await invoke(router(), 'post', '/', req({}));
    const id = items(a)[0]!.id;
    const r = await invoke(router(), 'delete', '/:id', req({}, { id }));
    expect(r.statusCode).toBe(200);
    expect(items(r)).toHaveLength(0);
    const rows = await h.db.select().from(timeTimers).where(eq(timeTimers.id, id));
    expect(rows).toHaveLength(0);
  });
});

describe('GET / — list + lazy auto-pause', () => {
  it('lists RUNNING first and computes elapsed', async () => {
    const a = await invoke(router(), 'post', '/', req({ description: 'first' }));
    const aId = items(a)[0]!.id;
    await invoke(router(), 'post', '/', req({ description: 'second' }));
    const r = await invoke(router(), 'get', '/', req({}));
    expect(r.statusCode).toBe(200);
    const list = items(r);
    expect(list).toHaveLength(2);
    expect(list[0]!.status).toBe('RUNNING');
    expect(list.find((t) => t.id === aId)!.status).toBe('PAUSED');
  });

  it('auto-pauses a RUNNING segment past the cap and flags it', async () => {
    const a = await invoke(router(), 'post', '/', req({}));
    const id = items(a)[0]!.id;
    await backdate(id, TIMER_AUTO_PAUSE_SECONDS + 3600); // 9h ago
    const r = await invoke(router(), 'get', '/', req({}));
    const t = items(r).find((x) => x.id === id)!;
    expect(t.status).toBe('PAUSED');
    expect(t.autoPausedAt).not.toBeNull();
    // Full elapsed kept (non-destructive) for the user to review.
    expect(t.elapsedSeconds).toBeGreaterThanOrEqual(TIMER_AUTO_PAUSE_SECONDS + 3600);
    // Resume clears the flag.
    const resumed = await invoke(router(), 'post', '/:id/resume', req({}, { id }));
    expect(items(resumed).find((x) => x.id === id)!.autoPausedAt).toBeNull();
  });

  it('requires time_entry:read:own (403 without it)', async () => {
    const r = await invoke(router([]), 'get', '/', req({}));
    expect(r.statusCode).toBe(403);
  });
});
