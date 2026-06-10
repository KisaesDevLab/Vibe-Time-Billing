// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Firm-wide People directory (0115 follow-up): GET /people list + search,
// GET /people/:id detail with per-client portal status, PATCH /people/:id,
// the add-contact "link existing person" path (no duplicate person), and
// the enable/disable/restore portal round-trip the detail page drives.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';

import { clientContacts, clientPortalAccess, persons, portalIdentity } from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  type PgliteHarness,
} from './_pglite-harness';
import { createPeopleRouter } from '../people/routes';
import { mountPeopleRoutes } from '../clients/people';
import { mountContactRoutes } from '../clients/contacts';
import { createPortalInviteRouter } from '../portal-invites/routes';

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
  const roles = new Map([[seed.appUserId, ['admin' as const]]]);
  a.use('/api/staff/people', createPeopleRouter({ db: harness.db, fakeUserRoles: roles }));
  const clientRouter = express.Router();
  mountPeopleRoutes(clientRouter, { db: harness.db, fakeUserRoles: roles });
  mountContactRoutes(clientRouter, { db: harness.db, fakeUserRoles: roles });
  a.use('/api/staff/clients', clientRouter);
  a.use(
    '/api/staff/portal-invites',
    createPortalInviteRouter({ db: harness.db, fakeUserRoles: roles, portalBaseUrl: 'https://x' }),
  );
  return a;
}

async function secondClient(): Promise<string> {
  const r0 = (await harness.db.execute(
    sql`SELECT office_id FROM client WHERE id = ${seed.clientId}`,
  )) as unknown as { rows: { office_id: string }[] };
  const officeId = r0.rows[0]!.office_id;
  const r = (await harness.db.execute(
    sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
        VALUES (${seed.firmId}, 'Second Client Co', ${seed.appUserId}, ${officeId})
        RETURNING id`,
  )) as unknown as { rows: { id: string }[] };
  return r.rows[0]!.id;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('people directory — list (0115)', () => {
  it('searches by name and email, and counts clients', async () => {
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Alice Anders',
      email: 'alice@x.com',
    });
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Bob Brown',
      email: 'bob@x.com',
    });

    const byName = await request(app()).get('/api/staff/people?q=alice');
    expect(byName.status).toBe(200);
    expect(byName.body.rows).toHaveLength(1);
    expect(byName.body.rows[0].fullName).toBe('Alice Anders');
    expect(byName.body.rows[0].clientCount).toBe(1);

    const byEmail = await request(app()).get('/api/staff/people?q=bob@x');
    expect(byEmail.body.rows).toHaveLength(1);
    expect(byEmail.body.rows[0].fullName).toBe('Bob Brown');
  });

  it('reflects active portal access and surfaces portal-only identities', async () => {
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Cara Cole',
      email: 'cara@x.com',
    });
    const [identity] = await harness.db
      .insert(portalIdentity)
      .values({ firmId: seed.firmId, fullName: 'Cara Cole', primaryEmail: 'cara@x.com', personId })
      .returning({ id: portalIdentity.id });
    await harness.db.insert(clientPortalAccess).values({
      portalIdentityId: identity!.id,
      clientId: seed.clientId,
      role: 'FULL',
      status: 'ACTIVE',
    });
    // Standalone 3rd party — portal identity with no person row.
    const [tp] = await harness.db
      .insert(portalIdentity)
      .values({ firmId: seed.firmId, fullName: 'Otto Outside', primaryEmail: 'otto@adv.io' })
      .returning({ id: portalIdentity.id });
    await harness.db.insert(clientPortalAccess).values({
      portalIdentityId: tp!.id,
      clientId: seed.clientId,
      role: 'VIEW_ONLY',
      status: 'ACTIVE',
    });

    const res = await request(app()).get('/api/staff/people');
    const byName = Object.fromEntries(
      res.body.rows.map((r: { fullName: string }) => [r.fullName, r]),
    );
    expect(byName['Cara Cole'].kind).toBe('person');
    expect(byName['Cara Cole'].hasPortalAccess).toBe(true);
    expect(byName['Otto Outside'].kind).toBe('portal_identity');
    expect(byName['Otto Outside'].hasPortalAccess).toBe(true);
  });

  it('annotates onThisClient / alsoOn when scoped to a client', async () => {
    const c2 = await secondClient();
    await request(app())
      .post(`/api/staff/clients/${seed.clientId}/contacts`)
      .send({ fullName: 'Dana Doe', email: 'dana@x.com' });
    // Add the same person to a second client via the people search → link.
    const linkRes = await request(app()).get(`/api/staff/people?q=dana&clientId=${c2}`);
    const dana = linkRes.body.rows[0];
    expect(dana.onThisClient).toBe(false);
    expect(dana.alsoOn).toHaveLength(1);
    expect(dana.alsoOn[0].clientId).toBe(seed.clientId);

    // On the client she already belongs to, onThisClient is true.
    const onIt = await request(app()).get(`/api/staff/people?q=dana&clientId=${seed.clientId}`);
    expect(onIt.body.rows[0].onThisClient).toBe(true);
  });
});

describe('people directory — detail + edit (0115)', () => {
  it('returns a person with every client and their portal status', async () => {
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Erin Eyre',
      email: 'erin@x.com',
    });
    const [identity] = await harness.db
      .insert(portalIdentity)
      .values({ firmId: seed.firmId, fullName: 'Erin Eyre', primaryEmail: 'erin@x.com', personId })
      .returning({ id: portalIdentity.id });
    await harness.db.insert(clientPortalAccess).values({
      portalIdentityId: identity!.id,
      clientId: seed.clientId,
      role: 'PAY_ONLY',
      status: 'ACTIVE',
    });

    const res = await request(app()).get(`/api/staff/people/${personId}`);
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('person');
    expect(res.body.clients).toHaveLength(1);
    expect(res.body.clients[0].clientId).toBe(seed.clientId);
    expect(res.body.clients[0].accessStatus).toBe('ACTIVE');
    expect(res.body.clients[0].role).toBe('PAY_ONLY');
    expect(res.body.clients[0].contactId).toBeTruthy();
  });

  it('edits canonical fields and propagates across clients; 409 on collision', async () => {
    const c2 = await secondClient();
    const r1 = await request(app())
      .post(`/api/staff/clients/${seed.clientId}/contacts`)
      .send({ fullName: 'Gus Gray', email: 'gus@x.com' });
    await request(app())
      .post(`/api/staff/clients/${c2}/contacts`)
      .send({ personId: r1.body.contact.personId });

    const patch = await request(app())
      .patch(`/api/staff/people/${r1.body.contact.personId}`)
      .send({ email: 'gus2@x.com' });
    expect(patch.status).toBe(200);
    const onC2 = await request(app()).get(`/api/staff/clients/${c2}/people`);
    const gus = onC2.body.people.find(
      (p: { contact?: { fullName?: string } }) => p.contact?.fullName === 'Gus Gray',
    );
    expect(gus.contact.email).toBe('gus2@x.com');

    // Collision with another firm person.
    await request(app())
      .post(`/api/staff/clients/${seed.clientId}/contacts`)
      .send({ fullName: 'Hank Hill', email: 'hank@x.com' });
    const collide = await request(app())
      .patch(`/api/staff/people/${r1.body.contact.personId}`)
      .send({ email: 'hank@x.com' });
    expect(collide.status).toBe(409);
  });

  it('404s for an unknown / foreign person id', async () => {
    const res = await request(app()).get(`/api/staff/people/${seed.appUserId}`);
    expect(res.status).toBe(404);
  });
});

describe('add-contact link existing person (0115)', () => {
  const post = (clientId: string, body: Record<string, unknown>) =>
    request(app()).post(`/api/staff/clients/${clientId}/contacts`).send(body);

  it('links an existing person without creating a duplicate', async () => {
    const c2 = await secondClient();
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Ida Iverson',
      email: 'ida@x.com',
    });
    const res = await post(c2, { fullName: 'Ida Iverson', personId });
    expect(res.status).toBe(201);

    const people = await harness.db
      .select({ id: persons.id })
      .from(persons)
      .where(eq(persons.id, personId));
    expect(people).toHaveLength(1);
    const ccs = await harness.db
      .select({ id: clientContacts.id })
      .from(clientContacts)
      .where(eq(clientContacts.personId, personId));
    expect(ccs).toHaveLength(2);
  });

  it('409s when linking a person already on the client', async () => {
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Jon Jones',
      email: 'jon@x.com',
    });
    const res = await post(seed.clientId, { fullName: 'Jon Jones', personId });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_linked');
  });

  it('404s when linking a person from another firm / nonexistent', async () => {
    const res = await post(seed.clientId, {
      fullName: 'Nobody',
      personId: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('person_not_found');
  });
});

describe('per-client portal enable/disable round-trip (0115)', () => {
  it('grants on enable (existing identity), then disables and restores', async () => {
    const c2 = await secondClient();
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Kim Kerr',
      email: 'kim@x.com',
    });
    // Person already has a firm portal identity (so grant is immediate).
    await harness.db
      .insert(portalIdentity)
      .values({ firmId: seed.firmId, fullName: 'Kim Kerr', primaryEmail: 'kim@x.com', personId });
    // Also make her a contact of c2 so the access links to that contact.
    await request(app()).post(`/api/staff/clients/${c2}/contacts`).send({ personId });

    // Enable for c2 (one-click grant the PersonDetail page issues).
    const enable = await request(app()).post('/api/staff/portal-invites').send({
      clientId: c2,
      fullName: 'Kim Kerr',
      email: 'kim@x.com',
      role: 'FULL',
      deliveryChannel: 'EMAIL',
      personId,
    });
    expect(enable.status).toBe(200);
    expect(enable.body.deduped).toBe(true);

    let detail = await request(app()).get(`/api/staff/people/${personId}`);
    const c2Entry = () => detail.body.clients.find((c: { clientId: string }) => c.clientId === c2);
    expect(c2Entry().accessStatus).toBe('ACTIVE');
    const accessId = c2Entry().accessId as string;
    expect(accessId).toBeTruthy();

    // Disable.
    await request(app()).post(`/api/staff/portal-invites/access/${accessId}/revoke`).send({});
    detail = await request(app()).get(`/api/staff/people/${personId}`);
    expect(c2Entry().accessStatus).toBe('INACTIVE');

    // Restore.
    await request(app()).post(`/api/staff/portal-invites/access/${accessId}/restore`).send({});
    detail = await request(app()).get(`/api/staff/people/${personId}`);
    expect(c2Entry().accessStatus).toBe('ACTIVE');
  });
});
