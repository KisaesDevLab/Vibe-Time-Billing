// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The Activity card on a signature request used to render
// signature_events.actor raw — a bare uuid for a staff action, `signer:<id>`
// for an in-office one. The detail endpoint now resolves each to a name.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { signatureEvents, signatureSigners } from '@vibe/db/schema';
import { eq } from 'drizzle-orm';

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

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

interface DetailEvent {
  actor: string;
  actorName: string | null;
  event: string;
}

describe('signature activity actor names', () => {
  it('names the staff member, the signer, and the system actors', async () => {
    const app = buildApp();
    const created = await request(app)
      .post('/api/staff/signatures')
      .send({
        title: '8879-S 2025',
        clientId: seed.clientId,
        formType: '8879-S',
        pageGeometry: LETTER_GEO,
        signers: [{ name: 'Pat Officer', email: 'pat@co.example', role: 'officer' }],
      });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const [signer] = await harness.db
      .select({ id: signatureSigners.id })
      .from(signatureSigners)
      .where(eq(signatureSigners.requestId, id));

    // The three other actor shapes the trail can hold.
    await harness.db.insert(signatureEvents).values([
      { requestId: id, actor: `signer:${signer!.id}`, event: 'signer_opened' },
      { requestId: id, actor: 'system', event: 'reminder_sent' },
      { requestId: id, actor: 'opensign', event: 'webhook_received' },
    ]);

    const detail = await request(app).get(`/api/staff/signatures/${id}`);
    expect(detail.status).toBe(200);
    const byEvent = new Map(
      (detail.body.events as DetailEvent[]).map((e) => [e.event, e] as const),
    );

    // Staff action — the acting user's full name, not their uuid.
    expect(byEvent.get('created')!.actor).toBe(seed.appUserId);
    expect(byEvent.get('created')!.actorName).toBe('Sarah Chen');

    expect(byEvent.get('signer_opened')!.actorName).toBe('Pat Officer (signer)');
    expect(byEvent.get('reminder_sent')!.actorName).toBe('System');
    expect(byEvent.get('webhook_received')!.actorName).toBe('OpenSign');
  });

  it('leaves actorName null for an id that no longer resolves', async () => {
    const app = buildApp();
    const created = await request(app)
      .post('/api/staff/signatures')
      .send({
        title: '8879-S 2025',
        clientId: seed.clientId,
        formType: '8879-S',
        pageGeometry: LETTER_GEO,
        signers: [{ name: 'Pat Officer', email: 'pat@co.example', role: 'officer' }],
      });
    const id = created.body.id as string;
    await harness.db.insert(signatureEvents).values({
      requestId: id,
      actor: '00000000-0000-4000-8000-000000000000',
      event: 'ghost',
    });

    const detail = await request(app).get(`/api/staff/signatures/${id}`);
    const ghost = (detail.body.events as DetailEvent[]).find((e) => e.event === 'ghost');
    // Null, not the uuid — the UI stubs it to `00000000…` with the full id
    // in the tooltip.
    expect(ghost!.actorName).toBeNull();
  });
});
