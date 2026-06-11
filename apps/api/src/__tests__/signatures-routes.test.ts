// SPDX-License-Identifier: Elastic-2.0
//
// Phase 4 — Signatures CRUD API: create → place → detail round-trip,
// field-level rejection of bad placements + placeless signers, draft-only
// edit guard, and a signature_events trail on each mutation.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';

import { signatureEvents, signatureRequests } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createSignaturesRouter } from '../signatures/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

const LETTER_GEO = [{ pageNumber: 1, widthPt: 612, heightPt: 792 }];

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

async function createDraft(app: express.Express): Promise<string> {
  const res = await request(app)
    .post('/api/staff/signatures')
    .send({
      title: '8879-S 2025',
      clientId: seed.clientId,
      formType: '8879-S',
      pageGeometry: LETTER_GEO,
      signers: [
        { name: 'Pat Officer', email: 'pat@co.example', role: 'officer' },
        { name: 'Dana ERO', email: 'dana@firm.example', role: 'ero' },
      ],
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('signatures CRUD API (phase 4)', () => {
  it('creates a draft with signers + records a created event', async () => {
    const app = buildApp();
    const id = await createDraft(app);

    const [row] = await harness.db
      .select()
      .from(signatureRequests)
      .where(eq(signatureRequests.id, id));
    expect(row!.status).toBe('draft');
    expect(row!.signerCount).toBe(2);

    const detail = await request(app).get(`/api/staff/signatures/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.signers).toHaveLength(2);
    expect(detail.body.events.some((e: { event: string }) => e.event === 'created')).toBe(true);
  });

  it('round-trips placements and lists them in detail', async () => {
    const app = buildApp();
    const id = await createDraft(app);
    const detail = await request(app).get(`/api/staff/signatures/${id}`);
    const [s1, s2] = detail.body.signers as { id: string }[];

    const put = await request(app)
      .put(`/api/staff/signatures/${id}/placements`)
      .send({
        placements: [
          {
            signerId: s1!.id,
            fieldType: 'signature',
            pageNumber: 1,
            nx: 0.1,
            ny: 0.7,
            nw: 0.3,
            nh: 0.05,
          },
          {
            signerId: s1!.id,
            fieldType: 'date',
            pageNumber: 1,
            nx: 0.5,
            ny: 0.7,
            nw: 0.15,
            nh: 0.04,
          },
          {
            signerId: s2!.id,
            fieldType: 'signature',
            pageNumber: 1,
            nx: 0.1,
            ny: 0.85,
            nw: 0.3,
            nh: 0.05,
          },
        ],
      });
    expect(put.status).toBe(200);
    expect(put.body.count).toBe(3);

    const after = await request(app).get(`/api/staff/signatures/${id}`);
    expect(after.body.placements).toHaveLength(3);
    expect(after.body.events.some((e: { event: string }) => e.event === 'placements_updated')).toBe(
      true,
    );
  });

  it('rejects out-of-bounds coords and a placeless signer with field-level errors', async () => {
    const app = buildApp();
    const id = await createDraft(app);
    const detail = await request(app).get(`/api/staff/signatures/${id}`);
    const [s1] = detail.body.signers as { id: string }[];

    const put = await request(app)
      .put(`/api/staff/signatures/${id}/placements`)
      .send({
        placements: [
          // s1: signature that extends past the right edge (nx+nw > 1).
          {
            signerId: s1!.id,
            fieldType: 'signature',
            pageNumber: 1,
            nx: 0.9,
            ny: 0.5,
            nw: 0.3,
            nh: 0.05,
          },
          // page 5 doesn't exist in a 1-page doc.
          {
            signerId: s1!.id,
            fieldType: 'date',
            pageNumber: 5,
            nx: 0.1,
            ny: 0.1,
            nw: 0.1,
            nh: 0.03,
          },
          // s2 gets no signature field at all.
        ],
      });
    expect(put.status).toBe(422);
    const paths = (put.body.errors as { path: string; message: string }[]).map((e) => e.message);
    expect(paths).toContain('extends_past_page_width');
    expect(paths).toContain('page_not_in_document');
    expect(paths).toContain('signer_has_no_signature_field');
  });

  it('rejects placements when geometry is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/staff/signatures')
      .send({
        title: 'no geo',
        signers: [{ name: 'A', email: 'a@x.example' }],
      });
    const id = res.body.id as string;
    const detail = await request(app).get(`/api/staff/signatures/${id}`);
    const [s1] = detail.body.signers as { id: string }[];
    const put = await request(app)
      .put(`/api/staff/signatures/${id}/placements`)
      .send({
        placements: [
          {
            signerId: s1!.id,
            fieldType: 'signature',
            pageNumber: 1,
            nx: 0.1,
            ny: 0.1,
            nw: 0.2,
            nh: 0.05,
          },
        ],
      });
    expect(put.status).toBe(422);
    expect((put.body.errors as { message: string }[])[0]!.message).toBe('geometry_required');
  });

  it('blocks edits to a non-draft request (409)', async () => {
    const app = buildApp();
    const id = await createDraft(app);
    // Simulate the request having been sent.
    await harness.db
      .update(signatureRequests)
      .set({ status: 'sent' })
      .where(eq(signatureRequests.id, id));

    const patch = await request(app).patch(`/api/staff/signatures/${id}`).send({ title: 'nope' });
    expect(patch.status).toBe(409);
    const del = await request(app).delete(`/api/staff/signatures/${id}`);
    expect(del.status).toBe(409);
  });

  it('adds + removes signers and deletes a draft', async () => {
    const app = buildApp();
    const id = await createDraft(app);

    const add = await request(app)
      .post(`/api/staff/signatures/${id}/signers`)
      .send({ name: 'Third', email: 'third@x.example' });
    expect(add.status).toBe(201);
    let detail = await request(app).get(`/api/staff/signatures/${id}`);
    expect(detail.body.signers).toHaveLength(3);

    const del = await request(app).delete(`/api/staff/signatures/${id}/signers/${add.body.id}`);
    expect(del.status).toBe(200);
    detail = await request(app).get(`/api/staff/signatures/${id}`);
    expect(detail.body.signers).toHaveLength(2);
    expect(detail.body.request.signerCount).toBe(2);

    const delReq = await request(app).delete(`/api/staff/signatures/${id}`);
    expect(delReq.status).toBe(200);
    const events = await harness.db
      .select()
      .from(signatureEvents)
      .where(eq(signatureEvents.requestId, id));
    // Cascade removed the events with the request.
    expect(events).toHaveLength(0);
  });
});
