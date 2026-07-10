// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0179 — "Log time" from an appointment persists a durable back-link
// (time_entry.appointment_id) and validates the appointment is the firm's.

import type express from 'express';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import type { RoleSlug } from '@vibe/core/rbac';
import {
  appointments,
  staffRateSnapshotEntries,
  staffRateSnapshots,
  timeEntries,
} from '@vibe/db/schema';
import { eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createTimeEntryRouter } from '../time-entries/routes';

let h: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  h = await buildPgliteHarness();
  seed = await seedMinimalFirm(h.db);
  // Give Sarah a StandardRate snapshot so the create route can resolve a
  // rate and reach the insert (otherwise it 400s with no_rate_resolves).
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
    statusCode: 201,
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
  method: 'get' | 'post',
  path: string,
  reqObj: Record<string, unknown>,
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
      reqObj,
      res,
      () => {
        advanced = true;
      },
    );
    if (!advanced) return res;
  }
  await (chain[chain.length - 1]!.handle as (rq: unknown, rs: unknown) => unknown)(reqObj, res);
  return res;
}

// Use today so the late-entry lockout (default 14-day window) never trips.
const TODAY = new Date().toISOString().slice(0, 10);

function req(body: Record<string, unknown>): Record<string, unknown> {
  return {
    query: {},
    params: {},
    body,
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
  };
}

function router(): express.Router {
  return createTimeEntryRouter({
    db: h.db,
    fakeUserRoles: new Map([[seed.appUserId, ['staff'] as RoleSlug[]]]),
  });
}

async function makeAppointment(firmId: string): Promise<string> {
  const [a] = await h.db
    .insert(appointments)
    .values({
      firmId,
      clientId: seed.clientId,
      engagementId: seed.engagementId,
      title: 'Quarterly review',
      startsAt: new Date(`${TODAY}T15:00:00Z`),
      endsAt: new Date(`${TODAY}T16:00:00Z`),
    })
    .returning({ id: appointments.id });
  return a!.id;
}

describe('Appointment → time entry link (0179)', () => {
  it('persists appointment_id when logging time from an appointment', async () => {
    const apptId = await makeAppointment(seed.firmId);
    const r = await invoke(
      router(),
      'post',
      '/',
      req({
        engagementId: seed.engagementId,
        entryDate: TODAY,
        hours: 1,
        description: 'Quarterly review',
        appointmentId: apptId,
      }),
    );
    expect(r.statusCode).toBe(201);
    const entryId = (r.jsonBody as { id: string }).id;
    const [row] = await h.db
      .select({ appointmentId: timeEntries.appointmentId })
      .from(timeEntries)
      .where(eq(timeEntries.id, entryId))
      .limit(1);
    expect(row?.appointmentId).toBe(apptId);
  });

  it('still creates an unlinked entry when no appointment is supplied', async () => {
    const r = await invoke(
      router(),
      'post',
      '/',
      req({ engagementId: seed.engagementId, entryDate: TODAY, hours: 1 }),
    );
    expect(r.statusCode).toBe(201);
    const entryId = (r.jsonBody as { id: string }).id;
    const [row] = await h.db
      .select({ appointmentId: timeEntries.appointmentId })
      .from(timeEntries)
      .where(eq(timeEntries.id, entryId))
      .limit(1);
    expect(row?.appointmentId).toBeNull();
  });

  it('rejects an appointment id that is not the firm’s (404)', async () => {
    const r = await invoke(
      router(),
      'post',
      '/',
      req({
        engagementId: seed.engagementId,
        entryDate: TODAY,
        hours: 1,
        appointmentId: '00000000-0000-0000-0000-000000000000',
      }),
    );
    expect(r.statusCode).toBe(404);
    expect((r.jsonBody as { error: string }).error).toBe('appointment_not_found');
  });
});
