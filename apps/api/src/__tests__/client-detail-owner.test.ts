// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// GET /clients/:id resolves the client owner's (partner-in-charge) name
// alongside the office name, so the Client info card can render "Owner"
// without a second round trip to /admin/users.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sql } from 'drizzle-orm';

import type { RoleSlug } from '@vibe/core/rbac';
import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createClientRouter } from '../clients/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

function app(): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  const roles = new Map<string, RoleSlug[]>([[seed.appUserId, ['admin']]]);
  a.use('/api/staff/clients', createClientRouter({ db: harness.db, fakeUserRoles: roles }));
  return a;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('client detail — owner', () => {
  it('returns partnerName with the office name', async () => {
    const res = await request(app()).get(`/api/staff/clients/${seed.clientId}`);
    expect(res.status).toBe(200);
    expect(res.body.client.partnerInChargeId).toBe(seed.appUserId);
    expect(res.body.client.partnerName).toBe('Sarah Chen');
    expect(res.body.client.officeName).toBe('Headquarters');
  });

  it('reflects a reassigned owner', async () => {
    const r = (await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${seed.firmId}, 'dana@test.example', 'Dana Ruiz', 'Dana', 'Ruiz') RETURNING id`,
    )) as unknown as { rows: { id: string }[] };
    const danaId = r.rows[0]!.id;

    const patch = await request(app())
      .patch(`/api/staff/clients/${seed.clientId}`)
      .send({ partnerInChargeId: danaId });
    expect(patch.status).toBe(200);

    const res = await request(app()).get(`/api/staff/clients/${seed.clientId}`);
    expect(res.body.client.partnerName).toBe('Dana Ruiz');
  });
});
