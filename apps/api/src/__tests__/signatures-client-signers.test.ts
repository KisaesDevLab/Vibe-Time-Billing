// SPDX-License-Identifier: Elastic-2.0
//
// 0133 — new signature-request flow: associate a request with one of the
// client's engagements, and capture signer provenance (person/contact) when a
// signer is pulled from the client's people list. Engagement must belong to
// the same client + firm; signer link ids that don't belong to the client are
// cleared (name+email stay canonical).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';

import { signatureRequests, signatureSigners } from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  type PgliteHarness,
} from './_pglite-harness';
import { createSignaturesRouter } from '../signatures/routes';

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
    '/api/staff/signatures',
    createSignaturesRouter({
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

describe('signature requests — client people + engagement (0133)', () => {
  it('creates a request linked to the client engagement', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/staff/signatures')
      .send({
        title: 'Engagement letter',
        clientId: seed.clientId,
        engagementId: seed.engagementId,
        signers: [{ name: 'Pat Officer', email: 'pat@co.example' }],
      });
    expect(res.status).toBe(201);
    const [row] = await harness.db
      .select()
      .from(signatureRequests)
      .where(eq(signatureRequests.id, res.body.id));
    expect(row!.clientId).toBe(seed.clientId);
    expect(row!.engagementId).toBe(seed.engagementId);

    // Detail exposes the resolved engagement name.
    const detail = await request(app).get(`/api/staff/signatures/${res.body.id}`);
    expect(detail.body.engagement?.id).toBe(seed.engagementId);
    expect(detail.body.engagement?.name).toBe('Test Engagement');
  });

  it('rejects an engagement that belongs to a different client', async () => {
    const app = buildApp();
    // Second client + its engagement.
    const other = await harness.db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
          VALUES (${seed.firmId}, 'Other Co', ${seed.appUserId},
                  (SELECT office_id FROM client WHERE id = ${seed.clientId})) RETURNING id`,
    );
    const otherClientId = (other as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherEng = await harness.db.execute(
      sql`INSERT INTO engagement (client_id, name, fee_structure)
          VALUES (${otherClientId}, 'Other Engagement', 'HOURLY') RETURNING id`,
    );
    const otherEngId = (otherEng as unknown as { rows: { id: string }[] }).rows[0]!.id;

    const res = await request(app)
      .post('/api/staff/signatures')
      .send({
        title: 'Mismatched',
        clientId: seed.clientId,
        engagementId: otherEngId, // belongs to otherClientId, not seed.clientId
        signers: [{ name: 'Pat', email: 'pat@co.example' }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_engagement');
  });

  it('rejects an engagement when no client is given', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/staff/signatures')
      .send({
        title: 'No client',
        engagementId: seed.engagementId,
        signers: [{ name: 'Pat', email: 'pat@co.example' }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_engagement');
  });

  it('persists signer provenance for people that belong to the client', async () => {
    const app = buildApp();
    const { contactId, personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Jamie Client',
      email: 'jamie@client.example',
    });
    const res = await request(app)
      .post('/api/staff/signatures')
      .send({
        title: 'With contact signer',
        clientId: seed.clientId,
        signers: [
          {
            name: 'Jamie Client',
            email: 'jamie@client.example',
            personId,
            clientContactId: contactId,
          },
        ],
      });
    expect(res.status).toBe(201);
    const [signer] = await harness.db
      .select()
      .from(signatureSigners)
      .where(eq(signatureSigners.requestId, res.body.id));
    expect(signer!.personId).toBe(personId);
    expect(signer!.clientContactId).toBe(contactId);
  });

  it('clears signer link ids that do not belong to the client', async () => {
    const app = buildApp();
    // A real contact, but on a DIFFERENT client → its ids must be cleared.
    const otherClient = await harness.db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
          VALUES (${seed.firmId}, 'Foreign Co', ${seed.appUserId},
                  (SELECT office_id FROM client WHERE id = ${seed.clientId})) RETURNING id`,
    );
    const otherClientId = (otherClient as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const foreign = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: otherClientId,
      fullName: 'Foreign Person',
      email: 'foreign@x.example',
    });

    const res = await request(app)
      .post('/api/staff/signatures')
      .send({
        title: 'Stale link',
        clientId: seed.clientId,
        signers: [
          {
            name: 'Foreign Person',
            email: 'foreign@x.example',
            personId: foreign.personId,
            clientContactId: foreign.contactId,
          },
        ],
      });
    expect(res.status).toBe(201);
    const [signer] = await harness.db
      .select()
      .from(signatureSigners)
      .where(eq(signatureSigners.requestId, res.body.id));
    // Name+email kept, but the cross-client provenance was dropped.
    expect(signer!.name).toBe('Foreign Person');
    expect(signer!.personId).toBeNull();
    expect(signer!.clientContactId).toBeNull();
  });

  it('keeps backward-compatible free-text creation (no client, null links)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/staff/signatures')
      .send({
        title: 'Manual only',
        signers: [{ name: 'Third Party', email: 'third@party.example' }],
      });
    expect(res.status).toBe(201);
    const [row] = await harness.db
      .select()
      .from(signatureRequests)
      .where(eq(signatureRequests.id, res.body.id));
    expect(row!.clientId).toBeNull();
    expect(row!.engagementId).toBeNull();
    const [signer] = await harness.db
      .select()
      .from(signatureSigners)
      .where(eq(signatureSigners.requestId, res.body.id));
    expect(signer!.personId).toBeNull();
  });

  it('patches a draft to set and clear the engagement (with validation)', async () => {
    const app = buildApp();
    const created = await request(app)
      .post('/api/staff/signatures')
      .send({
        title: 'Patch me',
        clientId: seed.clientId,
        signers: [{ name: 'Pat', email: 'pat@co.example' }],
      });
    const id = created.body.id as string;

    // Valid set.
    const ok = await request(app)
      .patch(`/api/staff/signatures/${id}`)
      .send({ engagementId: seed.engagementId });
    expect(ok.status).toBe(200);
    let [row] = await harness.db
      .select()
      .from(signatureRequests)
      .where(eq(signatureRequests.id, id));
    expect(row!.engagementId).toBe(seed.engagementId);

    // Clear.
    const cleared = await request(app)
      .patch(`/api/staff/signatures/${id}`)
      .send({ engagementId: null });
    expect(cleared.status).toBe(200);
    [row] = await harness.db.select().from(signatureRequests).where(eq(signatureRequests.id, id));
    expect(row!.engagementId).toBeNull();
  });
});
