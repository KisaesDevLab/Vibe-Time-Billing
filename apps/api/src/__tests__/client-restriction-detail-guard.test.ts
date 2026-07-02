// SPDX-License-Identifier: Elastic-2.0
//
// 0165 QA fix — the client access-restriction was enforced on LIST endpoints
// but missing on single-resource detail/mutation handlers in the requests,
// signatures, and expenses routers. These tests lock in the added
// blockIfClientRestricted guards: a staffer restricted from a client is 403'd
// on that client's request detail and can't create an expense on it, while
// the partner-in-charge is unaffected.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sql } from 'drizzle-orm';

import type { RoleSlug } from '@vibe/core/rbac';
import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { clientRequests } from '@vibe/db/schema';
import { createRequestRouter } from '../requests/routes';
import { createExpensesRouter } from '../expenses/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
const roles = new Map<string, RoleSlug[]>();
let currentUser = '';
let staffUserId: string;

function app(): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: currentUser,
    };
    next();
  });
  a.use('/api/staff/requests', createRequestRouter({ db: harness.db, fakeUserRoles: roles }));
  a.use('/api/staff/expenses', createExpensesRouter({ db: harness.db, fakeUserRoles: roles }));
  return a;
}
function as(userId: string): express.Express {
  currentUser = userId;
  return app();
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  roles.clear();
  // Partner-in-charge of the seeded client is seed.appUserId.
  roles.set(seed.appUserId, ['partner']);
  const r = (await harness.db.execute(
    sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
        VALUES (${seed.firmId}, 'staff@t.example', 'Staff', 'S', 'T') RETURNING id`,
  )) as unknown as { rows: { id: string }[] };
  staffUserId = r.rows[0]!.id;
  roles.set(staffUserId, ['staff']);
  // Restrict the client — staff is not the partner and not designated.
  await harness.db.execute(sql`UPDATE client SET restricted = true WHERE id = ${seed.clientId}`);
});
afterEach(async () => {
  await harness.close();
});

async function seedRequest(): Promise<string> {
  const [row] = await harness.db
    .insert(clientRequests)
    .values({ firmId: seed.firmId, engagementId: seed.engagementId, title: 'Docs please' })
    .returning({ id: clientRequests.id });
  return row!.id;
}

describe('0165 detail guard — requests', () => {
  it('403s a restricted staffer on request detail but allows the partner', async () => {
    const reqId = await seedRequest();
    const denied = await request(as(staffUserId)).get(`/api/staff/requests/${reqId}`);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('client_restricted');

    const ok = await request(as(seed.appUserId)).get(`/api/staff/requests/${reqId}`);
    expect(ok.status).toBe(200);
  });
});

describe('0165 detail guard — expenses', () => {
  it('403s a restricted staffer creating an expense but allows the partner', async () => {
    const body = {
      engagementId: seed.engagementId,
      expenseDate: '2026-06-10',
      description: 'Filing fee',
      costCents: 5000,
    };
    const denied = await request(as(staffUserId)).post('/api/staff/expenses').send(body);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('client_restricted');

    const ok = await request(as(seed.appUserId)).post('/api/staff/expenses').send(body);
    expect(ok.status).toBe(201);
  });
});
