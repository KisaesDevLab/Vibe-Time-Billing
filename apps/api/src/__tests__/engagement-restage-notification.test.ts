// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0166 — POST /api/staff/engagements/:id/restage-status-notification.
// Verifies: re-staging the engagement's CURRENT status always queues a
// PENDING_APPROVAL row (even for an IMMEDIATE-mode status), supersedes any
// prior unsent row, and 409s when the status isn't configured to notify.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { engagementStatusConfig, engagements, stagedNotifications } from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedMinimalFirm,
  seedContact,
  type PgliteHarness,
} from './_pglite-harness';
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
async function post(path: string): Promise<FakeRes> {
  const router = createEngagementRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['admin']]]),
  });
  const layer = (router as unknown as { stack: Array<{ route?: unknown }> }).stack.find((l) => {
    const r = l.route as { path: string; methods: Record<string, boolean> } | undefined;
    return r?.path === '/:id/restage-status-notification' && r.methods['post'] === true;
  });
  if (!layer) throw new Error('route not registered');
  const route = (layer as { route: { stack: Array<{ handle: (...a: unknown[]) => unknown }> } })
    .route;
  const handler = route.stack[route.stack.length - 1]!.handle;
  const res = makeRes();
  const req = {
    body: {},
    params: { id: seed.engagementId },
    query: {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
  void path;
  await (handler as (rq: unknown, rs: unknown) => Promise<void>)(req, res);
  return res;
}

async function setStatus(workflowState: string): Promise<void> {
  await harness.db
    .update(engagements)
    .set({ workflowState })
    .where(eq(engagements.id, seed.engagementId));
}
async function configure(workflowState: string, notifyMode: 'IMMEDIATE' | 'STAGED'): Promise<void> {
  await harness.db.insert(engagementStatusConfig).values({
    firmId: seed.firmId,
    workflowState,
    label: workflowState,
    triggersClientComm: true,
    notifyMode,
    notifyChannels: ['EMAIL'],
    notifyRecipients: 'ALL_CONTACTS',
  });
}

describe('POST /:id/restage-status-notification', () => {
  it('409s when the current status is not configured to notify', async () => {
    await setStatus('UNCONFIGURED');
    const r = await post(`/${seed.engagementId}/restage-status-notification`);
    expect(r.statusCode).toBe(409);
    expect((r.jsonBody as { error: string }).error).toBe('status_not_configured_for_notify');
  });

  it('queues PENDING_APPROVAL for an IMMEDIATE status (forced into approval queue)', async () => {
    await setStatus('REVIEW');
    await configure('REVIEW', 'IMMEDIATE');
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Reci Pient',
      email: 'reci@example.com',
    });
    const r = await post(`/${seed.engagementId}/restage-status-notification`);
    expect(r.statusCode).toBe(200);
    const id = (r.jsonBody as { stagedNotificationId: string }).stagedNotificationId;
    const [row] = await harness.db
      .select()
      .from(stagedNotifications)
      .where(eq(stagedNotifications.id, id));
    expect(row!.status).toBe('PENDING_APPROVAL');
    expect(row!.entityId).toBe(seed.engagementId);
  });

  it('a second reprocess supersedes the prior unsent row', async () => {
    await setStatus('REVIEW');
    await configure('REVIEW', 'STAGED');
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Reci Pient',
      email: 'reci@example.com',
    });
    const first = (
      (await post(`/${seed.engagementId}/restage-status-notification`)).jsonBody as {
        stagedNotificationId: string;
      }
    ).stagedNotificationId;
    const second = (
      (await post(`/${seed.engagementId}/restage-status-notification`)).jsonBody as {
        stagedNotificationId: string;
      }
    ).stagedNotificationId;
    expect(second).not.toBe(first);
    const [prior] = await harness.db
      .select()
      .from(stagedNotifications)
      .where(eq(stagedNotifications.id, first));
    expect(prior!.status).toBe('CANCELED');
    expect(prior!.canceledReason).toBe('SUPERSEDED');
  });
});
