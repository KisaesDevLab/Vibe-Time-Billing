// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Firm-wide People directory list: server-side pagination envelope + the
// portal/kind filters and sort (added so the 3000+ scale directory pages in
// SQL/memory rather than shipping the whole set to the browser).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sql } from 'drizzle-orm';

import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createPeopleRouter } from '../people/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

function app(): express.Express {
  const a = express();
  a.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  const roles = new Map<string, RoleSlug[]>([[seed.appUserId, ['admin']]]);
  a.use('/api/staff/people', createPeopleRouter({ db: harness.db, fakeUserRoles: roles }));
  return a;
}

async function person(fullName: string, email: string): Promise<void> {
  await harness.db.execute(
    sql`INSERT INTO person (firm_id, full_name, email, status)
        VALUES (${seed.firmId}, ${fullName}, ${email}, 'ACTIVE')`,
  );
}
async function portalOnlyIdentity(fullName: string): Promise<void> {
  await harness.db.execute(
    sql`INSERT INTO portal_identity (firm_id, full_name, preferred_method, status)
        VALUES (${seed.firmId}, ${fullName}, 'EMAIL', 'ACTIVE')`,
  );
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('GET /people — server-side filters + pagination', () => {
  it('returns the { rows, total, page, pageSize } envelope and honors pageSize', async () => {
    for (let i = 0; i < 6; i++) await person(`Person ${i}`, `p${i}@x.test`);
    const r = await request(app()).get('/api/staff/people?page=1&pageSize=4');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(6);
    expect(r.body.rows).toHaveLength(4);
    expect(r.body.pageSize).toBe(4);
  });

  it('filters by kind (person vs portal-only)', async () => {
    await person('A Contact', 'a@x.test');
    await portalOnlyIdentity('B Portal');
    const persons = await request(app()).get('/api/staff/people?page=1&pageSize=50&kind=person');
    expect((persons.body.rows as Array<{ kind: string }>).every((x) => x.kind === 'person')).toBe(
      true,
    );
    const portal = await request(app()).get(
      '/api/staff/people?page=1&pageSize=50&kind=portal_identity',
    );
    expect(portal.body.total).toBe(1);
    expect((portal.body.rows as Array<{ fullName: string }>)[0]!.fullName).toBe('B Portal');
  });

  it('sorts by name descending', async () => {
    await person('Aaron', 'aa@x.test');
    await person('Zelda', 'zz@x.test');
    const r = await request(app()).get('/api/staff/people?page=1&pageSize=50&sort=name&dir=desc');
    const names = (r.body.rows as Array<{ fullName: string }>).map((x) => x.fullName);
    expect(names[0]).toBe('Zelda');
  });
});
