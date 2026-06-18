// SPDX-License-Identifier: Elastic-2.0
//
// 0165 — cross-client + MCP enforcement for per-client restriction. The
// global Tasks board and the MCP list_engagements tool must hide a
// restricted client's rows from callers who aren't admin / partner-in-
// charge / designated, while still surfacing them to those who are.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sql } from 'drizzle-orm';

import type { RoleSlug } from '@vibe/core/rbac';
import { clientAccessGrants, clientTasks, clients, mcpTokens } from '@vibe/db/schema';
import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createTaskRouter } from '../tasks/routes';
import { createMcpRouter } from '../mcp/routes';
import { requireApiToken, hashToken } from '../auth/api-token';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let staffUserId: string;

const roles = new Map<string, RoleSlug[]>();
let currentUser = '';

function taskApp(): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: currentUser,
    };
    next();
  });
  a.use('/api/staff/tasks', createTaskRouter({ db: harness.db, fakeUserRoles: roles }));
  return a;
}

function mcpApp(): express.Express {
  const a = express();
  a.use(requireApiToken(harness.db));
  a.use('/api/mcp', createMcpRouter({ db: harness.db }));
  return a;
}

async function addUser(email: string, slug: RoleSlug): Promise<string> {
  const r = (await harness.db.execute(
    sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
        VALUES (${seed.firmId}, ${email}, ${email}, 'X', 'Y') RETURNING id`,
  )) as unknown as { rows: { id: string }[] };
  const id = r.rows[0]!.id;
  roles.set(id, [slug]);
  return id;
}

async function makeMcpToken(createdById: string | null): Promise<string> {
  const secret = `tok-${createdById ?? 'none'}`;
  await harness.db.insert(mcpTokens).values({
    firmId: seed.firmId,
    name: `t-${createdById ?? 'none'}`,
    tokenHash: hashToken(secret),
    allowedTools: ['list_engagements'],
    createdById,
  });
  return secret;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  roles.clear();
  roles.set(seed.appUserId, ['partner']); // partner-in-charge of seed client
  staffUserId = await addUser('staff@test.example', 'staff');
  // A task on the (soon-to-be-)restricted client.
  await harness.db.insert(clientTasks).values({
    firmId: seed.firmId,
    clientId: seed.clientId,
    title: 'Secret task',
    assigneeUserId: staffUserId,
  });
  await harness.db.update(clients).set({ restricted: true });
});
afterEach(async () => {
  await harness.close();
});

describe('global tasks board respects restriction', () => {
  it('hides a restricted client task from a non-designated staff user', async () => {
    currentUser = staffUserId;
    const res = await request(taskApp()).get('/api/staff/tasks?scope=all');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it('shows it to the partner-in-charge and to a designated user', async () => {
    currentUser = seed.appUserId;
    const partnerRes = await request(taskApp()).get('/api/staff/tasks?scope=all');
    expect(partnerRes.body.items).toHaveLength(1);

    await harness.db
      .insert(clientAccessGrants)
      .values({ clientId: seed.clientId, appUserId: staffUserId });
    currentUser = staffUserId;
    const staffRes = await request(taskApp()).get('/api/staff/tasks?scope=all');
    expect(staffRes.body.items).toHaveLength(1);
  });
});

describe('MCP list_engagements respects restriction', () => {
  it('omits a restricted client for a token whose creator is unauthorized', async () => {
    const secret = await makeMcpToken(staffUserId);
    const res = await request(mcpApp())
      .post('/api/mcp/call')
      .set('authorization', `Bearer ${secret}`)
      .send({ tool: 'list_engagements' });
    expect(res.status).toBe(200);
    expect(res.body.result.items).toHaveLength(0);
  });

  it('includes it for a token whose creator is the partner-in-charge', async () => {
    const secret = await makeMcpToken(seed.appUserId);
    const res = await request(mcpApp())
      .post('/api/mcp/call')
      .set('authorization', `Bearer ${secret}`)
      .send({ tool: 'list_engagements' });
    expect(res.status).toBe(200);
    expect(res.body.result.items.length).toBeGreaterThanOrEqual(1);
  });
});
