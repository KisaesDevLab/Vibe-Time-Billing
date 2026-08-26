// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Clients list free-text search covers the client's PEOPLE, not just the
// client record: staff routinely know the spouse / controller / trustee by
// name, and the client row is stored under the entity's name. A hit on a
// person also reports which person matched (matchedPeople) so the row
// explains itself in the results.

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

async function makeClient(name: string): Promise<string> {
  const r = await request(app())
    .post('/api/staff/clients')
    .send({ name, partnerInChargeId: seed.appUserId });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

async function addPerson(
  clientId: string,
  fullName: string,
  email: string | null = null,
): Promise<void> {
  const r = (await harness.db.execute(
    sql`INSERT INTO person (firm_id, full_name, email)
        VALUES (${seed.firmId}, ${fullName}, ${email}) RETURNING id`,
  )) as unknown as { rows: { id: string }[] };
  await harness.db.execute(
    sql`INSERT INTO client_contact (client_id, person_id, full_name, email)
        VALUES (${clientId}, ${r.rows[0]!.id}, ${fullName}, ${email})`,
  );
}

type Row = { id: string; name: string; matchedPeople: string | null };

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  await harness.db.execute(sql`DELETE FROM engagement WHERE client_id = ${seed.clientId}`);
  await harness.db.execute(sql`DELETE FROM client WHERE id = ${seed.clientId}`);
});
afterEach(async () => {
  await harness.close();
});

describe('clients search — people', () => {
  it('finds a client by a person name that is nowhere in the client record', async () => {
    const acme = await makeClient('Acme Holdings LLC');
    await addPerson(acme, 'Priya Raman', 'priya@acme.example');
    await makeClient('Unrelated Co');

    const r = await request(app()).get('/api/staff/clients?page=1&pageSize=50&q=priya');
    expect(r.body.total).toBe(1);
    const row = (r.body.rows as Row[])[0]!;
    expect(row.name).toBe('Acme Holdings LLC');
    expect(row.matchedPeople).toBe('Priya Raman');
  });

  it('matches a partial surname and lists every matching person on the client', async () => {
    const c = await makeClient('Ramanujan Family Trust');
    await addPerson(c, 'Dev Raman');
    await addPerson(c, 'Priya Raman');
    await addPerson(c, 'Sam Okafor');

    const r = await request(app()).get('/api/staff/clients?page=1&pageSize=50&q=raman');
    expect(r.body.total).toBe(1);
    const row = (r.body.rows as Row[])[0]!;
    expect(row.matchedPeople).toBe('Dev Raman, Priya Raman');
  });

  it('still matches contact email, and leaves matchedPeople null without a query', async () => {
    const c = await makeClient('Beta LLC');
    await addPerson(c, 'Chris Vale', 'chris@beta.example');

    const byEmail = await request(app()).get(
      '/api/staff/clients?page=1&pageSize=50&q=chris@beta.example',
    );
    expect(byEmail.body.total).toBe(1);
    expect((byEmail.body.rows as Row[])[0]!.matchedPeople).toBe('Chris Vale');

    const noQuery = await request(app()).get('/api/staff/clients?page=1&pageSize=50');
    expect((noQuery.body.rows as Row[])[0]!.matchedPeople).toBeNull();
  });

  it('reports no people when only the client record matched', async () => {
    const c = await makeClient('Findme Industries');
    await addPerson(c, 'Chris Vale');

    const r = await request(app()).get('/api/staff/clients?page=1&pageSize=50&q=findme');
    expect(r.body.total).toBe(1);
    expect((r.body.rows as Row[])[0]!.matchedPeople).toBeNull();
  });
});
