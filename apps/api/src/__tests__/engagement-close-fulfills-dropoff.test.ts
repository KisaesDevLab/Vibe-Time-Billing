// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Closing an engagement auto-fulfills its open DROP_OFF request(s) so they
// stop showing outstanding / reminding. Non-drop-off requests are untouched.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

import {
  appointments,
  clientRequests,
  engagementRecurrences,
  engagementStatusConfig,
  engagementTemplates,
  engagements,
} from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createEngagementRouter } from '../engagements/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

function makeRes() {
  return {
    statusCode: 200,
    jsonBody: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.jsonBody = b;
      return this;
    },
  };
}

async function patchStatus(status: string): Promise<ReturnType<typeof makeRes>> {
  const router = createEngagementRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['admin']]]),
  });
  const layer = (router as unknown as { stack: Array<{ route?: unknown }> }).stack.find((l) => {
    const r = l.route as { path: string; methods: Record<string, boolean> } | undefined;
    return r?.path === '/:id/status' && r.methods['patch'] === true;
  });
  if (!layer) throw new Error('route not registered');
  const route = (layer as { route: { stack: Array<{ handle: (...a: unknown[]) => unknown }> } })
    .route;
  const handler = route.stack[route.stack.length - 1]!.handle;
  const res = makeRes();
  const req = {
    body: { status },
    params: { id: seed.engagementId },
    query: {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
  await (handler as (rq: unknown, rs: unknown) => Promise<void>)(req, res);
  return res;
}

async function patchWorkflow(workflowState: string): Promise<ReturnType<typeof makeRes>> {
  const router = createEngagementRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['admin']]]),
  });
  const layer = (router as unknown as { stack: Array<{ route?: unknown }> }).stack.find((l) => {
    const r = l.route as { path: string; methods: Record<string, boolean> } | undefined;
    return r?.path === '/:id/workflow-state' && r.methods['patch'] === true;
  });
  if (!layer) throw new Error('route not registered');
  const route = (layer as { route: { stack: Array<{ handle: (...a: unknown[]) => unknown }> } })
    .route;
  const handler = route.stack[route.stack.length - 1]!.handle;
  const res = makeRes();
  const req = {
    body: { workflowState },
    params: { id: seed.engagementId },
    query: {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
  await (handler as (rq: unknown, rs: unknown) => Promise<void>)(req, res);
  return res;
}

async function seedRequest(kind: string, status: string): Promise<string> {
  const row = await harness.db.execute(
    sql`INSERT INTO client_request (firm_id, engagement_id, title, kind, status, priority)
        VALUES (${seed.firmId}, ${seed.engagementId}, ${`${kind} req`}, ${kind}, ${status}, 'MEDIUM')
        RETURNING id`,
  );
  return (row as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

describe('engagement close auto-fulfills drop-offs', () => {
  it('marks the open DROP_OFF FULFILLED (with actor) on CLOSE, leaves GENERAL alone', async () => {
    const dropId = await seedRequest('DROP_OFF', 'OPEN');
    const genId = await seedRequest('GENERAL', 'OPEN');

    const res = await patchStatus('CLOSED');
    expect(res.statusCode).toBe(200);

    const [eng] = await harness.db
      .select({ status: engagements.status })
      .from(engagements)
      .where(eq(engagements.id, seed.engagementId));
    expect(eng!.status).toBe('CLOSED');

    const [drop] = await harness.db
      .select({
        status: clientRequests.status,
        by: clientRequests.fulfilledByAppUserId,
        at: clientRequests.fulfilledAt,
      })
      .from(clientRequests)
      .where(eq(clientRequests.id, dropId));
    expect(drop!.status).toBe('FULFILLED');
    expect(drop!.by).toBe(seed.appUserId);
    expect(drop!.at).not.toBeNull();

    const [gen] = await harness.db
      .select({ status: clientRequests.status })
      .from(clientRequests)
      .where(eq(clientRequests.id, genId));
    expect(gen!.status).toBe('OPEN'); // non-drop-off untouched
  });

  it('also fulfills a PENDING (scheduled) drop-off on close', async () => {
    const dropId = await seedRequest('DROP_OFF', 'PENDING');
    const res = await patchStatus('CLOSED');
    expect(res.statusCode).toBe(200);
    const [drop] = await harness.db
      .select({ status: clientRequests.status })
      .from(clientRequests)
      .where(and(eq(clientRequests.id, dropId)));
    expect(drop!.status).toBe('FULFILLED');
  });

  it('does not fulfill an already-DISMISSED drop-off', async () => {
    const dropId = await seedRequest('DROP_OFF', 'DISMISSED');
    await patchStatus('CLOSED');
    const [drop] = await harness.db
      .select({ status: clientRequests.status })
      .from(clientRequests)
      .where(eq(clientRequests.id, dropId));
    expect(drop!.status).toBe('DISMISSED');
  });

  it('workflow status → COMPLETED fulfills drop-off AND spawns/rolls-forward the recurrence', async () => {
    // COMPLETED must exist in the firm's status catalog for the endpoint.
    await harness.db.insert(engagementStatusConfig).values({
      firmId: seed.firmId,
      workflowState: 'COMPLETED',
      label: 'Completed',
    });
    // Source engagement carries a 2025 period, a drop-off, and an appointment.
    await harness.db
      .update(engagements)
      .set({ periodYear: 2025 })
      .where(eq(engagements.id, seed.engagementId));
    const dropRow = await harness.db.execute(
      sql`INSERT INTO client_request (firm_id, engagement_id, title, kind, status, priority, due_date)
          VALUES (${seed.firmId}, ${seed.engagementId}, 'Docs', 'DROP_OFF', 'OPEN', 'MEDIUM', '2025-04-15')
          RETURNING id`,
    );
    const dropId = (dropRow as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await harness.db.insert(appointments).values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      engagementId: seed.engagementId,
      title: 'Review',
      startsAt: new Date('2025-04-10T15:00:00Z'),
      endsAt: new Date('2025-04-10T16:00:00Z'),
      status: 'SCHEDULED',
    });
    const [tpl] = await harness.db
      .insert(engagementTemplates)
      .values({ firmId: seed.firmId, key: 't', name: '1040', defaultFeeStructure: 'FIXED_FEE' })
      .returning({ id: engagementTemplates.id });
    // ON_COMPLETION recurrence anchored to the source engagement, rollforward on.
    await harness.db.insert(engagementRecurrences).values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      templateId: tpl!.id,
      frequency: 'ANNUAL',
      triggerMode: 'ON_COMPLETION',
      lastEngagementId: seed.engagementId,
      rollforwardAppointment: true,
      rollforwardDropoff: true,
      createdById: seed.appUserId,
    });

    const res = await patchWorkflow('COMPLETED');
    expect(res.statusCode).toBe(200);

    // Source drop-off fulfilled.
    const [srcDrop] = await harness.db
      .select({ status: clientRequests.status })
      .from(clientRequests)
      .where(eq(clientRequests.id, dropId));
    expect(srcDrop!.status).toBe('FULFILLED');

    // A new engagement spawned as DRAFT with the rolled-forward items.
    const newEngs = await harness.db
      .select({ id: engagements.id, ws: engagements.workflowState, year: engagements.periodYear })
      .from(engagements)
      .where(and(eq(engagements.clientId, seed.clientId), eq(engagements.periodYear, 2026)));
    expect(newEngs).toHaveLength(1);
    const newEng = newEngs[0]!;
    expect(newEng.ws).toBe('DRAFT');

    const rolledDrop = await harness.db
      .select({ status: clientRequests.status })
      .from(clientRequests)
      .where(and(eq(clientRequests.engagementId, newEng.id), eq(clientRequests.kind, 'DROP_OFF')));
    expect(rolledDrop).toHaveLength(1);
    expect(rolledDrop[0]!.status).toBe('PENDING');

    const rolledAppt = await harness.db
      .select({ id: appointments.id })
      .from(appointments)
      .where(eq(appointments.engagementId, newEng.id));
    expect(rolledAppt).toHaveLength(1);
  });
});
