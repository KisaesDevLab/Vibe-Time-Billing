// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0146 — staged-notification decision routes. Verifies: list scopes to
// the firm and defaults to the active queue; send-now/schedule/cancel
// flip status with decided_by and audit; cancel writes the
// client_communication INTERNAL note; schedule rejects past dates;
// decided rows are not re-actionable (409); bulk processes actionable
// ids and skips the rest; everything 403s without notification:approve.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import type express from 'express';

import { auditLog, clientCommunications, stagedNotifications } from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createStagedNotificationRouter } from '../notifications/staged/routes';

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

// Runs the FULL handler chain so requirePermission executes.
async function invoke(
  router: express.Router,
  method: 'get' | 'post',
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

function req(
  opts: { params?: Record<string, string>; body?: unknown; query?: Record<string, string> } = {},
): Record<string, unknown> {
  return {
    body: opts.body ?? {},
    params: opts.params ?? {},
    query: opts.query ?? {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
}

function router(roles: RoleSlug[] = ['partner']) {
  return createStagedNotificationRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, roles]]),
  });
}

async function insertStaged(
  status: 'PENDING_APPROVAL' | 'SCHEDULED' | 'SENT' | 'CANCELED' | 'FAILED' = 'PENDING_APPROVAL',
  supersedeSuffix = '',
): Promise<string> {
  const [row] = await harness.db
    .insert(stagedNotifications)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      triggerKind: 'engagement_status',
      entityType: 'engagement',
      entityId: seed.engagementId,
      triggerContext: { workflowState: 'WITH_CLIENT', fromState: null, statusLabel: 'With client' },
      supersedeKey: `engagement_status:${seed.engagementId}${supersedeSuffix}`,
      mode: 'STAGED',
      status,
      channels: ['EMAIL'],
      recipientMode: 'BILLING_CONTACT',
      recipients: [{ personId: 'p', name: 'Lisa', email: 'lisa@example.com', phone: null }],
      rendered: { EMAIL: { subject: 'S', body: 'B' } },
      templateKind: 'engagement_status:WITH_CLIENT',
      createdBy: seed.appUserId,
    })
    .returning({ id: stagedNotifications.id });
  return row!.id;
}

describe('staged-notification routes', () => {
  it('GET lists the active queue with client/engagement labels', async () => {
    await insertStaged('PENDING_APPROVAL');
    const sentId = await insertStaged('SENT', ':old');
    const g = await invoke(router(), 'get', '/', { ...req() });
    expect(g.statusCode).toBe(200);
    const items = (g.jsonBody as { items: Array<Record<string, unknown>> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!['clientName']).toBe('Test Client Co');
    expect(items[0]!['engagementName']).toBe('Test Engagement');
    expect(items.find((i) => i['id'] === sentId)).toBeUndefined();

    const gSent = await invoke(router(), 'get', '/', { ...req({ query: { status: 'SENT' } }) });
    expect((gSent.jsonBody as { items: unknown[] }).items).toHaveLength(1);
  });

  it('send-now flips to SCHEDULED(now) with decided_by + audit', async () => {
    const id = await insertStaged();
    const r = await invoke(router(), 'post', '/:id/send-now', { ...req({ params: { id } }) });
    expect(r.statusCode).toBe(200);
    const [row] = await harness.db
      .select()
      .from(stagedNotifications)
      .where(eq(stagedNotifications.id, id));
    expect(row!.status).toBe('SCHEDULED');
    expect(row!.decidedBy).toBe(seed.appUserId);
    expect(row!.scheduledAt).not.toBeNull();
    const [audit] = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityType, 'staged_notification'))
      .orderBy(desc(auditLog.occurredAt))
      .limit(1);
    expect(audit).toBeTruthy();
  });

  it('schedule stores the future fire time and rejects past dates', async () => {
    const id = await insertStaged();
    const past = await invoke(router(), 'post', '/:id/schedule', {
      ...req({ params: { id }, body: { scheduledAt: '2000-01-01T00:00:00Z' } }),
    });
    expect(past.statusCode).toBe(400);

    const future = new Date(Date.now() + 3600_000).toISOString();
    const ok = await invoke(router(), 'post', '/:id/schedule', {
      ...req({ params: { id }, body: { scheduledAt: future } }),
    });
    expect(ok.statusCode).toBe(200);
    const [row] = await harness.db
      .select()
      .from(stagedNotifications)
      .where(eq(stagedNotifications.id, id));
    expect(row!.status).toBe('SCHEDULED');
    expect(row!.scheduledAt!.toISOString()).toBe(future);
  });

  it('cancel marks MANUAL and writes the client_communication note', async () => {
    const id = await insertStaged();
    const r = await invoke(router(), 'post', '/:id/cancel', { ...req({ params: { id } }) });
    expect(r.statusCode).toBe(200);
    const [row] = await harness.db
      .select()
      .from(stagedNotifications)
      .where(eq(stagedNotifications.id, id));
    expect(row!.status).toBe('CANCELED');
    expect(row!.canceledReason).toBe('MANUAL');
    const comms = await harness.db
      .select()
      .from(clientCommunications)
      .where(eq(clientCommunications.clientId, seed.clientId));
    expect(comms).toHaveLength(1);
    expect(comms[0]!.channel).toBe('NOTE');
    expect(comms[0]!.direction).toBe('INTERNAL');
  });

  it('decided rows are not re-actionable', async () => {
    const id = await insertStaged('CANCELED');
    const r = await invoke(router(), 'post', '/:id/send-now', { ...req({ params: { id } }) });
    expect(r.statusCode).toBe(409);
  });

  it('send-now retries a FAILED row', async () => {
    const id = await insertStaged('FAILED');
    const r = await invoke(router(), 'post', '/:id/send-now', { ...req({ params: { id } }) });
    expect(r.statusCode).toBe(200);
    const [row] = await harness.db
      .select()
      .from(stagedNotifications)
      .where(eq(stagedNotifications.id, id));
    expect(row!.status).toBe('SCHEDULED');
    expect(row!.errorMessage).toBeNull();
  });

  it('bulk cancels actionable ids and skips the rest', async () => {
    const a = await insertStaged('PENDING_APPROVAL');
    const b = await insertStaged('SCHEDULED', ':b');
    const c = await insertStaged('SENT', ':c');
    const r = await invoke(router(), 'post', '/bulk', {
      ...req({ body: { ids: [a, b, c], action: 'CANCEL' } }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.jsonBody).toMatchObject({ processed: 2, skipped: 1 });
    const rows = await harness.db
      .select()
      .from(stagedNotifications)
      .where(eq(stagedNotifications.status, 'CANCELED'));
    expect(rows).toHaveLength(2);
  });

  it('requires notification:approve (403 for senior)', async () => {
    const id = await insertStaged();
    const r = router(['senior']);
    expect((await invoke(r, 'get', '/', { ...req() })).statusCode).toBe(403);
    expect(
      (await invoke(r, 'post', '/:id/send-now', { ...req({ params: { id } }) })).statusCode,
    ).toBe(403);
  });
});
