// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Unified People view (0114): reconciles client_contact with
// client_portal_access. Verifies the merge (linked / contact_only /
// portal_only / invited), the email self-heal of legacy unlinked
// accesses, and promoting a 3rd-party access into a contact.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';

import {
  clientContacts,
  clientPortalAccess,
  persons,
  portalIdentity,
  portalInvitation,
} from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  type PgliteHarness,
} from './_pglite-harness';
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

async function contact(fullName: string, email: string | null): Promise<string> {
  const { contactId } = await seedContact(harness.db, {
    firmId: seed.firmId,
    clientId: seed.clientId,
    fullName,
    email,
  });
  return contactId;
}

async function identity(fullName: string, email: string): Promise<string> {
  const [i] = await harness.db
    .insert(portalIdentity)
    .values({ firmId: seed.firmId, fullName, primaryEmail: email })
    .returning({ id: portalIdentity.id });
  return i!.id;
}

async function access(identityId: string, contactId: string | null): Promise<string> {
  const [r] = await harness.db
    .insert(clientPortalAccess)
    .values({
      portalIdentityId: identityId,
      clientId: seed.clientId,
      role: 'FULL',
      status: 'ACTIVE',
      clientContactId: contactId,
    })
    .returning({ id: clientPortalAccess.id });
  return r!.id;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('unified people view (0114)', () => {
  it('merges contacts and portal access, self-heals by email, and labels 3rd parties', async () => {
    // Alice: contact + access, explicitly linked.
    const aliceC = await contact('Alice', 'alice@x.com');
    await access(await identity('Alice', 'alice@x.com'), aliceC);
    // Bob: contact + access, NOT linked (legacy) — matches by email.
    const bobC = await contact('Bob', 'bob@x.com');
    const bobAccess = await access(await identity('Bob', 'bob@x.com'), null);
    // Carol: contact only, no login.
    await contact('Carol', 'carol@x.com');
    // Dave: 3rd-party login, not a contact.
    await access(await identity('Dave', 'dave@x.com'), null);
    // Eve: pending invitation, no identity yet.
    await harness.db.insert(portalInvitation).values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      invitedEmail: 'eve@x.com',
      proposedFullName: 'Eve',
      proposedRole: 'FULL',
      deliveryChannel: 'EMAIL',
      tokenHash: 'tok-eve',
      invitedBy: seed.appUserId,
      expiresAt: new Date(Date.now() + 7 * 86400_000),
    });

    const res = await request(app()).get(`/api/staff/clients/${seed.clientId}/people`);
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(
      res.body.people.map(
        (p: {
          contact?: { fullName?: string };
          access?: { fullName?: string };
          pendingInvitation?: { proposedFullName?: string };
          kind: string;
        }) => [
          p.contact?.fullName ?? p.access?.fullName ?? p.pendingInvitation?.proposedFullName,
          p,
        ],
      ),
    );

    expect(res.body.people).toHaveLength(5);
    expect(byName['Alice'].kind).toBe('linked');
    expect(byName['Alice'].contact).toBeTruthy();
    expect(byName['Alice'].access).toBeTruthy();

    expect(byName['Bob'].kind).toBe('linked'); // self-healed by email
    expect(byName['Carol'].kind).toBe('contact_only');
    expect(byName['Carol'].access).toBeNull();
    expect(byName['Dave'].kind).toBe('portal_only');
    expect(byName['Dave'].contact).toBeNull();
    expect(byName['Eve'].kind).toBe('invited');

    // Self-heal persisted the FK on Bob's access.
    const [bobRow] = await harness.db
      .select({ link: clientPortalAccess.clientContactId })
      .from(clientPortalAccess)
      .where(eq(clientPortalAccess.id, bobAccess));
    expect(bobRow!.link).toBe(bobC);
  });

  it('promotes a 3rd-party access into a contact and links it', async () => {
    const daveAccess = await access(await identity('Dave', 'dave@x.com'), null);
    const res = await request(app())
      .post(`/api/staff/portal-invites/access/${daveAccess}/add-contact`)
      .send({});
    expect(res.status).toBe(201);

    // The access is now linked to a freshly-created contact.
    const [row] = await harness.db
      .select({ link: clientPortalAccess.clientContactId })
      .from(clientPortalAccess)
      .where(eq(clientPortalAccess.id, daveAccess));
    expect(row!.link).toBe(res.body.contactId);

    // 0115 — name/email live on the linked person.
    const [c] = await harness.db
      .select({ fullName: persons.fullName, email: persons.email })
      .from(clientContacts)
      .innerJoin(persons, eq(persons.id, clientContacts.personId))
      .where(eq(clientContacts.id, res.body.contactId));
    expect(c!.fullName).toBe('Dave');
    expect(c!.email).toBe('dave@x.com');

    // Now appears as a linked person, not portal_only.
    const people = await request(app()).get(`/api/staff/clients/${seed.clientId}/people`);
    const dave = people.body.people.find(
      (p: { contact?: { fullName?: string } }) => p.contact?.fullName === 'Dave',
    );
    expect(dave.kind).toBe('linked');
  });

  it('links an invite to a contact by email', async () => {
    const cId = await contact('Frank', 'frank@x.com');
    const res = await request(app()).post('/api/staff/portal-invites').send({
      clientId: seed.clientId,
      fullName: 'Frank',
      email: 'frank@x.com',
      role: 'VIEW_ONLY',
    });
    expect(res.status).toBe(201);
    // Accept the (pending) invite by simulating the identity+access the
    // accept flow would create, then confirm the people view links them.
    // Here we assert the invite recorded the client; deeper accept flow is
    // covered elsewhere. The contact remains contact_only until accepted.
    const people = await request(app()).get(`/api/staff/clients/${seed.clientId}/people`);
    const frank = people.body.people.find(
      (p: { contact?: { id?: string } }) => p.contact?.id === cId,
    );
    expect(frank).toBeTruthy();
    expect(frank.pendingInvitation?.proposedFullName).toBe('Frank');
  });
});

describe('person model — firm-global dedup + propagation (0115)', () => {
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
  const post = (clientId: string, body: Record<string, unknown>) =>
    request(app()).post(`/api/staff/clients/${clientId}/contacts`).send(body);

  it('dedups the same email to one person across clients', async () => {
    const c2 = await secondClient();
    await post(seed.clientId, { fullName: 'Dana Doe', email: 'dana@x.com' });
    await post(c2, { fullName: 'Dana Doe', email: 'dana@x.com' });
    const ppl = await harness.db
      .select({ id: persons.id })
      .from(persons)
      .where(sql`lower(${persons.email}) = 'dana@x.com'`);
    expect(ppl).toHaveLength(1);
    const ccs = await harness.db
      .select({ id: clientContacts.id })
      .from(clientContacts)
      .where(eq(clientContacts.personId, ppl[0]!.id));
    expect(ccs).toHaveLength(2);
  });

  it('surfaces alsoOn for a person on multiple clients', async () => {
    const c2 = await secondClient();
    await post(seed.clientId, { fullName: 'Erin Eyre', email: 'erin@x.com' });
    await post(c2, { fullName: 'Erin Eyre', email: 'erin@x.com' });
    const people = await request(app()).get(`/api/staff/clients/${seed.clientId}/people`);
    const erin = people.body.people.find(
      (p: { contact?: { email?: string } }) => p.contact?.email === 'erin@x.com',
    );
    expect(erin.contact.alsoOn).toHaveLength(1);
    expect(erin.contact.alsoOn[0].clientId).toBe(c2);
  });

  it('propagates a contact email edit to the same person on other clients', async () => {
    const c2 = await secondClient();
    const r1 = await post(seed.clientId, { fullName: 'Gus Gray', email: 'gus@x.com' });
    await post(c2, { fullName: 'Gus Gray', email: 'gus@x.com' });
    const patch = await request(app())
      .patch(`/api/staff/clients/${seed.clientId}/contacts/${r1.body.contact.id}`)
      .send({ email: 'gus2@x.com' });
    expect(patch.status).toBe(200);
    const people2 = await request(app()).get(`/api/staff/clients/${c2}/people`);
    const gus = people2.body.people.find(
      (p: { contact?: { fullName?: string } }) => p.contact?.fullName === 'Gus Gray',
    );
    expect(gus.contact.email).toBe('gus2@x.com');
  });

  it('409s when an email edit collides with another person', async () => {
    await post(seed.clientId, { fullName: 'Hank Hill', email: 'hank@x.com' });
    const ivy = await post(seed.clientId, { fullName: 'Ivy Ives', email: 'ivy@x.com' });
    const res = await request(app())
      .patch(`/api/staff/clients/${seed.clientId}/contacts/${ivy.body.contact.id}`)
      .send({ email: 'hank@x.com' });
    expect(res.status).toBe(409);
  });
});
