// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0165 — per-client visibility restriction. Verifies the access helper +
// clients-router enforcement: basic surfaces (detail, contacts) stay open
// to all staff; restricted surfaces (tasks, notes, …) are blocked for
// non-designated, non-admin, non-partner-in-charge users; the restriction
// endpoint is admin/partner only; designating a user restores access.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sql } from 'drizzle-orm';

import type { RoleSlug } from '@vibe/core/rbac';
import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createClientRouter } from '../clients/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

// Partner-in-charge of the seeded client = seed.appUserId. We add a plain
// staff user (not the partner, not designated) and a manager.
let staffUserId: string;
let managerUserId: string;
let adminUserId: string;

const roles = new Map<string, RoleSlug[]>();
let currentUser = '';

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
  a.use('/api/staff/clients', createClientRouter({ db: harness.db, fakeUserRoles: roles }));
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

function as(userId: string): express.Express {
  currentUser = userId;
  return app();
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  roles.clear();
  // The seeded client's partner-in-charge is seed.appUserId — make that a partner.
  roles.set(seed.appUserId, ['partner']);
  adminUserId = await addUser('admin@test.example', 'admin');
  staffUserId = await addUser('staff@test.example', 'staff');
  managerUserId = await addUser('manager@test.example', 'manager');
});
afterEach(async () => {
  await harness.close();
});

async function restrict(actor: string, designated: string[]): Promise<request.Response> {
  return request(as(actor))
    .put(`/api/staff/clients/${seed.clientId}/restriction`)
    .send({ restricted: true, designatedUserIds: designated });
}

describe('client restriction — management endpoint', () => {
  it('admins and partners can set restriction; managers cannot', async () => {
    expect((await restrict(adminUserId, [])).status).toBe(200);
    expect((await restrict(seed.appUserId, [])).status).toBe(200); // partner-in-charge (partner role)
    const denied = await restrict(managerUserId, []);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('forbidden');
  });

  it('writes the designated grant set and reports it back', async () => {
    const res = await restrict(adminUserId, [staffUserId]);
    expect(res.status).toBe(200);
    expect(res.body.restricted).toBe(true);
    expect(res.body.designatedUserIds).toEqual([staffUserId]);
    const rows = (await harness.db.execute(
      sql`SELECT app_user_id FROM client_access_grant WHERE client_id = ${seed.clientId}`,
    )) as unknown as { rows: { app_user_id: string }[] };
    expect(rows.rows.map((r) => r.app_user_id)).toEqual([staffUserId]);
  });
});

describe('client restriction — enforcement', () => {
  it('blocks restricted sub-routes for a non-designated staff user but keeps basic surfaces', async () => {
    await restrict(adminUserId, []);

    // Basic surfaces remain open.
    const detail = await request(as(staffUserId)).get(`/api/staff/clients/${seed.clientId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.client.accessRestricted).toBe(true);
    const contacts = await request(as(staffUserId)).get(
      `/api/staff/clients/${seed.clientId}/contacts`,
    );
    expect(contacts.status).toBe(200);

    // Restricted surfaces are blocked.
    const tasks = await request(as(staffUserId)).get(`/api/staff/clients/${seed.clientId}/tasks`);
    expect(tasks.status).toBe(403);
    expect(tasks.body.error).toBe('client_restricted');
    const notes = await request(as(staffUserId)).get(`/api/staff/clients/${seed.clientId}/notes`);
    expect(notes.status).toBe(403);
  });

  it('allows the partner-in-charge and designated users through', async () => {
    await restrict(adminUserId, [staffUserId]);

    // Partner-in-charge always allowed.
    expect(
      (await request(as(seed.appUserId)).get(`/api/staff/clients/${seed.clientId}/tasks`)).status,
    ).toBe(200);
    // Designated staff allowed.
    expect(
      (await request(as(staffUserId)).get(`/api/staff/clients/${seed.clientId}/tasks`)).status,
    ).toBe(200);
    // Admin always allowed.
    expect(
      (await request(as(adminUserId)).get(`/api/staff/clients/${seed.clientId}/tasks`)).status,
    ).toBe(200);
    // detail no longer flags accessRestricted for the designated user.
    const detail = await request(as(staffUserId)).get(`/api/staff/clients/${seed.clientId}`);
    expect(detail.body.client.accessRestricted).toBe(false);
  });

  it('non-restricted clients are open to everyone', async () => {
    const tasks = await request(as(staffUserId)).get(`/api/staff/clients/${seed.clientId}/tasks`);
    expect(tasks.status).toBe(200);
    const detail = await request(as(staffUserId)).get(`/api/staff/clients/${seed.clientId}`);
    expect(detail.body.client.accessRestricted).toBe(false);
  });

  it('lifting the restriction reopens the restricted surfaces', async () => {
    await restrict(adminUserId, []);
    expect(
      (await request(as(staffUserId)).get(`/api/staff/clients/${seed.clientId}/tasks`)).status,
    ).toBe(403);
    await request(as(adminUserId))
      .put(`/api/staff/clients/${seed.clientId}/restriction`)
      .send({ restricted: false, designatedUserIds: [] });
    expect(
      (await request(as(staffUserId)).get(`/api/staff/clients/${seed.clientId}/tasks`)).status,
    ).toBe(200);
  });
});
