// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0160 — recurring tasks. Proves: completing a task that carries a recurrence
// cadence opens exactly one successor (OPEN, due advanced one cadence step,
// same cadence carried forward); a non-recurring task spawns nothing; and
// re-patching an already-DONE recurring task does not double-spawn.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';

import { clientTasks } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createTaskRouter } from '../tasks/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  app.use(
    '/api/staff/tasks',
    createTaskRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['admin']]]),
    }),
  );
  return app;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});

afterEach(async () => {
  await harness.close();
});

async function createTask(app: express.Express, body: Record<string, unknown>): Promise<string> {
  const res = await request(app)
    .post('/api/staff/tasks')
    .send({ clientId: seed.clientId, title: 'Monthly close', ...body });
  expect(res.status).toBe(201);
  return res.body.task.id as string;
}

describe('recurring tasks', () => {
  it('opens the next occurrence when a recurring task is completed', async () => {
    const app = buildApp();
    const id = await createTask(app, { recurrence: 'MONTHLY', dueDate: '2026-06-14' });

    const res = await request(app).patch(`/api/staff/tasks/${id}`).send({ status: 'DONE' });
    expect(res.status).toBe(200);
    expect(res.body.spawned).toBeTruthy();

    const rows = await harness.db
      .select()
      .from(clientTasks)
      .where(eq(clientTasks.clientId, seed.clientId));
    expect(rows).toHaveLength(2);
    const next = rows.find((r) => r.id !== id)!;
    expect(next.status).toBe('OPEN');
    expect(next.recurrence).toBe('MONTHLY');
    expect(next.dueDate).toBe('2026-07-14');
    expect(next.title).toBe('Monthly close');
  });

  it('does not spawn for a non-recurring task', async () => {
    const app = buildApp();
    const id = await createTask(app, { dueDate: '2026-06-14' });

    const res = await request(app).patch(`/api/staff/tasks/${id}`).send({ status: 'DONE' });
    expect(res.status).toBe(200);
    expect(res.body.spawned).toBeNull();

    const rows = await harness.db
      .select()
      .from(clientTasks)
      .where(eq(clientTasks.clientId, seed.clientId));
    expect(rows).toHaveLength(1);
  });

  it('does not double-spawn when an already-DONE task is patched again', async () => {
    const app = buildApp();
    const id = await createTask(app, { recurrence: 'WEEKLY', dueDate: '2026-06-14' });

    await request(app).patch(`/api/staff/tasks/${id}`).send({ status: 'DONE' });
    // Patch the already-DONE task again (e.g. tweak priority) — no new spawn.
    const res = await request(app).patch(`/api/staff/tasks/${id}`).send({ priority: 'HIGH' });
    expect(res.status).toBe(200);
    expect(res.body.spawned).toBeNull();

    const rows = await harness.db
      .select()
      .from(clientTasks)
      .where(eq(clientTasks.clientId, seed.clientId));
    expect(rows).toHaveLength(2);
  });

  it('advances semi-monthly from the old due date', async () => {
    const app = buildApp();
    const id = await createTask(app, { recurrence: 'SEMIMONTHLY', dueDate: '2026-06-01' });

    await request(app).patch(`/api/staff/tasks/${id}`).send({ status: 'DONE' });
    const rows = await harness.db
      .select()
      .from(clientTasks)
      .where(eq(clientTasks.clientId, seed.clientId));
    const next = rows.find((r) => r.id !== id)!;
    expect(next.dueDate).toBe('2026-06-15');
  });
});
