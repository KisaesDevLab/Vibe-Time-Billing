// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0210 — POST /time-entries/from-appointments: one entry per appointment
// the caller attends in the window, hours = appointment length, linked
// via time_entry.appointment_id. Already-logged and other-staff
// appointments are skipped; client-less internal meetings fall back to
// the firm-admin engagement (forced non-billable by the core).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type express from 'express';
import { eq } from 'drizzle-orm';

import {
  appointments,
  engagements,
  firmSettings,
  staffRateSnapshotEntries,
  staffRateSnapshots,
  timeEntries,
} from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createTimeEntryRouter } from '../time-entries/routes';

let h: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  h = await buildPgliteHarness();
  seed = await seedMinimalFirm(h.db);
  // DAY is a fixed past date, so the default 14-day late-entry lockout would
  // reject every entry once the wall clock drifts past it (createTimeEntryCore
  // → 409 late_entry_locked, leaving the route with nothing created). This
  // suite is about appointment → time-entry conversion, not back-dating
  // policy, so switch the lockout off and keep the test deterministic.
  // seedMinimalFirm creates no firm_settings row, so this must upsert — an
  // UPDATE would match nothing and leave the 14-day default in force.
  await h.db
    .insert(firmSettings)
    .values({ firmId: seed.firmId, lateEntryLockoutDays: 0 })
    .onConflictDoUpdate({
      target: firmSettings.firmId,
      set: { lateEntryLockoutDays: 0 },
    });
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
  method: 'post',
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
function req(body: unknown): Record<string, unknown> {
  return {
    body: body ?? {},
    params: {},
    query: {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
}
function router() {
  return createTimeEntryRouter({
    db: h.db,
    fakeUserRoles: new Map([[seed.appUserId, ['staff']]]),
  });
}

const DAY = '2026-07-10';
const body = (dryRun?: boolean) => ({
  entryDate: DAY,
  from: `${DAY}T00:00:00.000Z`,
  to: `${DAY}T23:59:59.999Z`,
  ...(dryRun ? { dryRun: true } : {}),
});

interface Created {
  created: { id: string; appointmentId: string }[];
  skipped: { appointmentId: string; reason: string }[];
}

describe('POST /from-appointments', () => {
  it('creates one entry per attended appointment, hours = length', async () => {
    const [mine] = await h.db
      .insert(appointments)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        engagementId: seed.engagementId,
        title: 'Quarterly review',
        startsAt: new Date(`${DAY}T15:00:00Z`),
        endsAt: new Date(`${DAY}T16:30:00Z`),
        leadAppUserId: seed.appUserId,
      })
      .returning({ id: appointments.id });
    // Someone else's appointment in the same window — not a candidate.
    await h.db.insert(appointments).values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      engagementId: seed.engagementId,
      title: 'Not mine',
      startsAt: new Date(`${DAY}T17:00:00Z`),
      endsAt: new Date(`${DAY}T18:00:00Z`),
      leadAppUserId: null,
    });

    const preview = await invoke(router(), 'post', '/from-appointments', req(body(true)));
    expect(preview.statusCode).toBe(200);
    const cands = (preview.jsonBody as { candidates: { hours: number }[] }).candidates;
    expect(cands).toHaveLength(1);
    expect(cands[0]!.hours).toBe(1.5);

    const r = await invoke(router(), 'post', '/from-appointments', req(body()));
    expect(r.statusCode).toBe(201);
    const out = r.jsonBody as Created;
    expect(out.created).toHaveLength(1);

    const [entry] = await h.db
      .select()
      .from(timeEntries)
      .where(eq(timeEntries.appointmentId, mine!.id));
    expect(entry!.hours).toBe('1.50');
    expect(entry!.entryDate).toBe(DAY);
    expect(entry!.description).toBe('Quarterly review');

    // Second run: already logged, nothing created.
    const again = await invoke(router(), 'post', '/from-appointments', req(body()));
    expect(again.statusCode).toBe(200);
    const outAgain = again.jsonBody as Created;
    expect(outAgain.created).toHaveLength(0);
    expect(outAgain.skipped[0]!.reason).toBe('already_logged');
  });

  it('routes client-less appointments to the firm-admin engagement, non-billable', async () => {
    await h.db
      .update(engagements)
      .set({ firmAdmin: true, status: 'ACTIVE' })
      .where(eq(engagements.id, seed.engagementId));
    const [appt] = await h.db
      .insert(appointments)
      .values({
        firmId: seed.firmId,
        clientId: null,
        engagementId: null,
        title: 'Staff meeting',
        startsAt: new Date(`${DAY}T13:00:00Z`),
        endsAt: new Date(`${DAY}T14:00:00Z`),
        leadAppUserId: seed.appUserId,
      })
      .returning({ id: appointments.id });

    const r = await invoke(router(), 'post', '/from-appointments', req(body()));
    expect(r.statusCode).toBe(201);
    const [entry] = await h.db
      .select()
      .from(timeEntries)
      .where(eq(timeEntries.appointmentId, appt!.id));
    expect(entry!.engagementId).toBe(seed.engagementId);
    expect(entry!.billableFlag).toBe(false);
    expect(entry!.hours).toBe('1.00');
  });
});
