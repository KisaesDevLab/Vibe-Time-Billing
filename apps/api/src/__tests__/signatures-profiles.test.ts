// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Phase 10 — role-based placement profiles: seed defaults, version on
// re-create, apply by role onto a draft's signers, and the IRS KBA gate
// that blocks a 1040 8879 from going out the entity path.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';

import { signatureRequests, signaturePlacementProfiles } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createSignaturesRouter } from '../signatures/routes';
import { applyProfile, formRequiresKba, DEFAULT_PLACEMENT_PROFILES } from '../signatures/profiles';

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

describe('placement profiles unit', () => {
  it('formRequiresKba flags the 1040 8879 but not entity forms', () => {
    expect(formRequiresKba('8879')).toBe(true);
    expect(formRequiresKba('8879-S')).toBe(false);
    expect(formRequiresKba('engagement-letter')).toBe(false);
    expect(formRequiresKba(null)).toBe(false);
  });

  it('does not ship a 1040 8879 default profile', () => {
    expect(DEFAULT_PLACEMENT_PROFILES.some((p) => p.formType === '8879')).toBe(false);
    expect(DEFAULT_PLACEMENT_PROFILES.some((p) => p.formType === '8879-S')).toBe(true);
  });

  it('applyProfile expands role fields onto matching signers', () => {
    const fields = [
      {
        role: 'officer',
        fieldType: 'signature' as const,
        pageNumber: 1,
        nx: 0.1,
        ny: 0.6,
        nw: 0.3,
        nh: 0.04,
      },
      {
        role: 'ero',
        fieldType: 'signature' as const,
        pageNumber: 1,
        nx: 0.1,
        ny: 0.8,
        nw: 0.3,
        nh: 0.04,
      },
      {
        role: 'witness',
        fieldType: 'signature' as const,
        pageNumber: 1,
        nx: 0.1,
        ny: 0.9,
        nw: 0.3,
        nh: 0.04,
      },
    ];
    const result = applyProfile(
      fields,
      [
        { id: 's1', role: 'officer' },
        { id: 's2', role: 'ERO' }, // case-insensitive match
      ],
      LETTER_GEO,
    );
    expect(result.placements.map((p) => p.signerId).sort()).toEqual(['s1', 's2']);
    expect(result.unmatchedRoles).toEqual(['witness']);
  });
});

describe('placement profiles API (phase 10)', () => {
  it('seeds defaults idempotently and lists latest', async () => {
    const app = buildApp();
    const first = await request(app).post('/api/staff/signatures/profiles/seed-defaults');
    expect(first.status).toBe(200);
    expect(first.body.inserted).toBe(DEFAULT_PLACEMENT_PROFILES.length);
    // Second run inserts nothing.
    const second = await request(app).post('/api/staff/signatures/profiles/seed-defaults');
    expect(second.body.inserted).toBe(0);

    const list = await request(app).get('/api/staff/signatures/profiles');
    expect(list.status).toBe(200);
    expect(list.body.profiles.length).toBe(DEFAULT_PLACEMENT_PROFILES.length);
    expect(list.body.registry['8879'].requiresKba).toBe(true);
  });

  it('versions on re-create and applies a profile to a draft', async () => {
    const app = buildApp();
    await request(app).post('/api/staff/signatures/profiles/seed-defaults');

    // New version of 8879-S.
    const v2 = await request(app)
      .post('/api/staff/signatures/profiles')
      .send({
        formType: '8879-S',
        fields: [
          {
            role: 'officer',
            fieldType: 'signature',
            pageNumber: 1,
            nx: 0.1,
            ny: 0.5,
            nw: 0.3,
            nh: 0.04,
          },
          {
            role: 'ero',
            fieldType: 'signature',
            pageNumber: 1,
            nx: 0.1,
            ny: 0.7,
            nw: 0.3,
            nh: 0.04,
          },
        ],
      });
    expect(v2.status).toBe(201);
    expect(v2.body.version).toBe(2);

    // Draft with officer + ero signers.
    const create = await request(app)
      .post('/api/staff/signatures')
      .send({
        title: '8879-S apply',
        formType: '8879-S',
        pageGeometry: LETTER_GEO,
        signers: [
          { name: 'Officer', email: 'o@co.example', role: 'officer' },
          { name: 'Ero', email: 'e@firm.example', role: 'ero' },
        ],
      });
    const id = create.body.id as string;

    const apply = await request(app)
      .post(`/api/staff/signatures/${id}/apply-profile`)
      .send({ profileId: v2.body.id });
    expect(apply.status).toBe(200);
    // v2 has signature for each role → 2 placements, every signer covered.
    expect(apply.body.count).toBe(2);
    expect(apply.body.unmatchedRoles).toEqual([]);

    const detail = await request(app).get(`/api/staff/signatures/${id}`);
    expect(detail.body.placements).toHaveLength(2);
  });

  it('blocks sending a KBA-gated 1040 8879 (entity path forbidden)', async () => {
    const app = buildApp();
    // A draft marked as the individual 1040 form.
    const create = await request(app)
      .post('/api/staff/signatures')
      .send({
        title: '1040 8879',
        formType: '8879',
        pageGeometry: LETTER_GEO,
        signers: [{ name: 'TP', email: 'tp@x.example', role: 'taxpayer' }],
      });
    const id = create.body.id as string;
    // Give it a source key directly so the send reaches the KBA gate.
    await harness.db
      .update(signatureRequests)
      .set({ sourceFileKey: 'signatures/x/source.pdf' })
      .where(eq(signatureRequests.id, id));

    const send = await request(
      (() => {
        const app2 = express();
        app2.use(express.json());
        app2.use((req, _res, next) => {
          (req as unknown as { staffSession: unknown }).staffSession = {
            firmId: seed.firmId,
            appUserId: seed.appUserId,
          };
          next();
        });
        app2.use(
          '/api/staff/signatures',
          createSignaturesRouter({
            db: harness.db,
            fakeUserRoles: new Map([[seed.appUserId, ['admin']]]),
            // Inject stubs so the route reaches sendSignatureRequest's gate.
            storageClient: {
              get: async () => ({ body: null, meta: {} }),
              put: async () => ({ etag: 'x' }),
            } as never,
            openSignClient: {} as never,
          }),
        );
        return app2;
      })(),
    ).post(`/api/staff/signatures/${id}/send`);
    expect(send.status).toBe(409);
    expect(send.body.error).toBe('kba_required');

    // Unseeded list still has no 8879 profile to apply.
    const [profileRows] = await harness.db
      .select()
      .from(signaturePlacementProfiles)
      .where(eq(signaturePlacementProfiles.formType, '8879'));
    expect(profileRows).toBeUndefined();
  });
});
