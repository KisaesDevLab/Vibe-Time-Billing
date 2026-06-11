// SPDX-License-Identifier: Elastic-2.0
//
// TR-10b — Staff amend routes.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { taxReturns } from '@vibe/db/schema';
import { createTaxReturnRouter } from '../tax-returns/routes';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

async function setup(): Promise<{
  firmId: string;
  appUserId: string;
  clientId: string;
  returnId: string;
  app: express.Express;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const [r] = await harness.db
    .insert(taxReturns)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      taxYear: 2024,
      formCode: '1040',
      title: '2024 1040',
      status: 'RELEASED',
      totalPages: 17,
    })
    .returning();
  const router = createTaxReturnRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  app.use('/api/staff/tax/returns', router);
  return {
    firmId: seed.firmId,
    appUserId: seed.appUserId,
    clientId: seed.clientId,
    returnId: r!.id,
    app,
  };
}

describe('TR-10b — POST /:id/amend', () => {
  it('creates amended row in DRAFT state', async () => {
    const f = await setup();
    const r = await request(f.app).post(`/api/staff/tax/returns/${f.returnId}/amend`).send({
      newTitle: '2024 1040 (Amended)',
      newSourceFileId: null,
      newSourceFileSha256: null,
      newTotalPages: 18,
    });
    expect(r.status).toBe(201);
    expect(r.body.amendedReturnId).toBeTruthy();
  });

  it('400 on invalid payload', async () => {
    const f = await setup();
    const r = await request(f.app).post(`/api/staff/tax/returns/${f.returnId}/amend`).send({}); // missing newTitle
    expect(r.status).toBe(400);
  });

  it('400 on bad sha256 format', async () => {
    const f = await setup();
    const r = await request(f.app).post(`/api/staff/tax/returns/${f.returnId}/amend`).send({
      newTitle: 'X',
      newSourceFileSha256: 'not-a-hash',
    });
    expect(r.status).toBe(400);
  });
});

describe('TR-10b — POST /:id/amend/approve', () => {
  it('flips predecessor to SUPERSEDED', async () => {
    const f = await setup();
    const create = await request(f.app)
      .post(`/api/staff/tax/returns/${f.returnId}/amend`)
      .send({ newTitle: 'A' });
    const amendedId = (create.body as { amendedReturnId: string }).amendedReturnId;
    const approve = await request(f.app).post(`/api/staff/tax/returns/${amendedId}/amend/approve`);
    expect(approve.status).toBe(200);
    expect(approve.body.supersededId).toBe(f.returnId);
  });

  it('409 when called on a non-amendment', async () => {
    const f = await setup();
    const r = await request(f.app).post(`/api/staff/tax/returns/${f.returnId}/amend/approve`);
    expect(r.status).toBe(409);
  });
});

describe('TR-10b — GET /:id/amend/diff', () => {
  it('returns 404 when not an amendment', async () => {
    const f = await setup();
    const r = await request(f.app).get(`/api/staff/tax/returns/${f.returnId}/amend/diff`);
    expect(r.status).toBe(404);
  });

  it('returns a diff for an amended return', async () => {
    const f = await setup();
    const create = await request(f.app)
      .post(`/api/staff/tax/returns/${f.returnId}/amend`)
      .send({ newTitle: 'A' });
    const amendedId = (create.body as { amendedReturnId: string }).amendedReturnId;
    const r = await request(f.app).get(`/api/staff/tax/returns/${amendedId}/amend/diff`);
    expect(r.status).toBe(200);
    expect(r.body.before.returnId).toBe(f.returnId);
    expect(r.body.after.returnId).toBe(amendedId);
  });
});
