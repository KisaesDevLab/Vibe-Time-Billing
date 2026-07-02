// SPDX-License-Identifier: Elastic-2.0
//
// Firm-wide task list router (top-level "Tasks" view). Exercises the real
// /api/staff/tasks handlers: scope (mine/all), filters, joined names,
// assignees feed, firm-scoped create/patch.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type express from 'express';

import { appUsers, clients, clientTasks, offices } from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createTaskRouter } from '../tasks/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let otherUserId: string;
let otherClientId: string;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  // A second staff user (the "other" assignee) and a second client.
  const [u] = await harness.db
    .insert(appUsers)
    .values({
      firmId: seed.firmId,
      email: 'bob@test.example',
      fullName: 'Bob Lee',
      firstName: 'Bob',
      lastName: 'Lee',
    })
    .returning({ id: appUsers.id });
  otherUserId = u!.id;
  const [c] = await harness.db
    .insert(clients)
    .values({
      firmId: seed.firmId,
      name: 'Second Client LLC',
      partnerInChargeId: seed.appUserId,
      officeId: (
        await harness.db
          .select({ id: clients.officeId })
          .from(clients)
          .where(eq(clients.id, seed.clientId))
          .limit(1)
      )[0]!.id,
    })
    .returning({ id: clients.id });
  otherClientId = c!.id;
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

async function invoke(
  router: express.Router,
  method: 'get' | 'post' | 'patch' | 'delete',
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

function req(opts: {
  query?: Record<string, string>;
  params?: Record<string, string>;
  body?: unknown;
  appUserId?: string;
}): Record<string, unknown> {
  return {
    body: opts.body ?? {},
    params: opts.params ?? {},
    query: opts.query ?? {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: opts.appUserId ?? seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
}

function router(roles: RoleSlug[] = ['admin']) {
  return createTaskRouter({
    db: harness.db,
    fakeUserRoles: new Map([
      [seed.appUserId, roles],
      [otherUserId, roles],
    ]),
  });
}

async function seedTask(opts: {
  clientId?: string;
  engagementId?: string | null;
  assigneeUserId?: string | null;
  title: string;
  status?: 'OPEN' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE' | 'CANCELED';
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  dueDate?: string | null;
  firmId?: string;
}): Promise<string> {
  const [row] = await harness.db
    .insert(clientTasks)
    .values({
      firmId: opts.firmId ?? seed.firmId,
      clientId: opts.clientId ?? seed.clientId,
      engagementId: opts.engagementId ?? null,
      assigneeUserId: opts.assigneeUserId ?? null,
      title: opts.title,
      status: opts.status ?? 'OPEN',
      priority: opts.priority ?? 'MEDIUM',
      dueDate: opts.dueDate ?? null,
    })
    .returning({ id: clientTasks.id });
  return row!.id;
}

describe('GET /api/staff/tasks', () => {
  it('scope=mine returns only the caller’s tasks; scope=all returns all', async () => {
    await seedTask({ title: 'Mine A', assigneeUserId: seed.appUserId });
    await seedTask({ title: 'Bob B', assigneeUserId: otherUserId });
    const r = router();

    const mine = await invoke(r, 'get', '/', req({ query: { scope: 'mine' } }));
    const mineItems = (mine.jsonBody as { items: { title: string }[] }).items;
    expect(mineItems.map((t) => t.title)).toEqual(['Mine A']);

    const all = await invoke(r, 'get', '/', req({ query: { scope: 'all' } }));
    const allTitles = (all.jsonBody as { items: { title: string }[] }).items
      .map((t) => t.title)
      .sort();
    expect(allTitles).toEqual(['Bob B', 'Mine A']);
  });

  it('default excludes DONE/CANCELED; status=ALL includes them', async () => {
    await seedTask({ title: 'Open one', assigneeUserId: seed.appUserId });
    await seedTask({ title: 'Done one', assigneeUserId: seed.appUserId, status: 'DONE' });
    const r = router();

    const active = await invoke(r, 'get', '/', req({ query: { scope: 'mine' } }));
    expect((active.jsonBody as { items: { title: string }[] }).items.map((t) => t.title)).toEqual([
      'Open one',
    ]);

    const all = await invoke(r, 'get', '/', req({ query: { scope: 'mine', status: 'ALL' } }));
    expect(
      (all.jsonBody as { items: { title: string }[] }).items.map((t) => t.title).sort(),
    ).toEqual(['Done one', 'Open one']);
  });

  it('engagementId filter returns only that engagement’s tasks', async () => {
    await seedTask({
      title: 'On the engagement',
      assigneeUserId: seed.appUserId,
      engagementId: seed.engagementId,
    });
    await seedTask({ title: 'No engagement', assigneeUserId: seed.appUserId });
    const r = router();
    const res = await invoke(
      r,
      'get',
      '/',
      req({ query: { scope: 'all', engagementId: seed.engagementId } }),
    );
    const items = (res.jsonBody as { items: { title: string; engagementId: string | null }[] })
      .items;
    expect(items.map((t) => t.title)).toEqual(['On the engagement']);
    expect(items[0]!.engagementId).toBe(seed.engagementId);
  });

  it('clientId filter and overdue filter narrow results, and names are joined', async () => {
    await seedTask({
      title: 'Overdue on second client',
      assigneeUserId: seed.appUserId,
      clientId: otherClientId,
      dueDate: '2000-01-01',
    });
    await seedTask({ title: 'Future on first client', assigneeUserId: seed.appUserId });
    const r = router();

    const byClient = await invoke(
      r,
      'get',
      '/',
      req({ query: { scope: 'all', clientId: otherClientId } }),
    );
    const items = (
      byClient.jsonBody as {
        items: { title: string; clientName: string; assigneeName: string }[];
      }
    ).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Overdue on second client');
    expect(items[0]!.clientName).toBe('Second Client LLC');
    expect(items[0]!.assigneeName).toBe('Sarah Chen');

    const overdue = await invoke(r, 'get', '/', req({ query: { scope: 'all', overdue: '1' } }));
    expect((overdue.jsonBody as { items: { title: string }[] }).items.map((t) => t.title)).toEqual([
      'Overdue on second client',
    ]);
  });
});

describe('GET /api/staff/tasks/assignees', () => {
  it('lists active staff users', async () => {
    const r = router();
    const res = await invoke(r, 'get', '/assignees', req({}));
    const names = (res.jsonBody as { users: { fullName: string }[] }).users
      .map((u) => u.fullName)
      .sort();
    expect(names).toEqual(['Bob Lee', 'Sarah Chen']);
  });
});

describe('POST /api/staff/tasks', () => {
  it('creates a task against a valid client with createdById set', async () => {
    const r = router();
    const res = await invoke(
      r,
      'post',
      '/',
      req({
        body: { clientId: seed.clientId, title: 'New from list', assigneeUserId: otherUserId },
      }),
    );
    expect(res.statusCode).toBe(201);
    const task = (res.jsonBody as { task: { id: string; createdById: string } }).task;
    expect(task.createdById).toBe(seed.appUserId);
    const [row] = await harness.db.select().from(clientTasks).where(eq(clientTasks.id, task.id));
    expect(row!.title).toBe('New from list');
    expect(row!.assigneeUserId).toBe(otherUserId);
  });

  it('404s when the client is not in the firm', async () => {
    const r = router();
    const res = await invoke(
      r,
      'post',
      '/',
      req({ body: { clientId: '00000000-0000-0000-0000-000000000000', title: 'X' } }),
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/staff/tasks/:taskId', () => {
  it('flips status to DONE and stamps completedAt', async () => {
    const id = await seedTask({ title: 'To finish', assigneeUserId: seed.appUserId });
    const r = router();
    const res = await invoke(
      r,
      'patch',
      '/:taskId',
      req({ params: { taskId: id }, body: { status: 'DONE' } }),
    );
    expect(res.statusCode).toBe(200);
    const [row] = await harness.db.select().from(clientTasks).where(eq(clientTasks.id, id));
    expect(row!.status).toBe('DONE');
    expect(row!.completedAt).toBeTruthy();
  });

  it('404s for a task in another firm', async () => {
    // Seed a separate firm + office + client, then a task under it.
    const otherFirm = await harness.db.execute(
      sql`INSERT INTO firm (name) VALUES ('Other Firm') RETURNING id`,
    );
    const otherFirmId = (otherFirm as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const [office] = await harness.db
      .insert(offices)
      .values({ firmId: otherFirmId, name: 'HQ2', timezone: 'America/Chicago', isDefault: true })
      .returning({ id: offices.id });
    const [partner] = await harness.db
      .insert(appUsers)
      .values({
        firmId: otherFirmId,
        email: 'p@other.example',
        fullName: 'Other Partner',
        firstName: 'Other',
        lastName: 'Partner',
      })
      .returning({ id: appUsers.id });
    const [oc] = await harness.db
      .insert(clients)
      .values({
        firmId: otherFirmId,
        name: 'Foreign Client',
        officeId: office!.id,
        partnerInChargeId: partner!.id,
      })
      .returning({ id: clients.id });
    const foreignTaskId = await seedTask({
      title: 'Foreign',
      clientId: oc!.id,
      firmId: otherFirmId,
    });
    const r = router();
    const res = await invoke(
      r,
      'patch',
      '/:taskId',
      req({ params: { taskId: foreignTaskId }, body: { status: 'DONE' } }),
    );
    expect(res.statusCode).toBe(404);
  });
});
