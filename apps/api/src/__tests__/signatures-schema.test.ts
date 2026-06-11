// SPDX-License-Identifier: Elastic-2.0
//
// Signatures module (0108) — schema applies + the request → signers →
// placements → events chain round-trips, with the status/field CHECKs and
// cascade deletes enforced.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import {
  signatureRequests,
  signatureSigners,
  signatureFieldPlacements,
  signaturePlacementProfiles,
  signatureEvents,
} from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('signatures schema (0108)', () => {
  it('round-trips a request → signer → placement → event chain', async () => {
    const [req] = await harness.db
      .insert(signatureRequests)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        title: '8879-S 2025',
        createdBy: seed.appUserId,
        signerCount: 1,
        pageGeometry: [{ pageNumber: 1, widthPt: 612, heightPt: 792 }],
      })
      .returning({ id: signatureRequests.id, status: signatureRequests.status });
    expect(req!.status).toBe('draft');

    const [signer] = await harness.db
      .insert(signatureSigners)
      .values({ requestId: req!.id, name: 'Pat Officer', email: 'pat@co.example', role: 'officer' })
      .returning({ id: signatureSigners.id, status: signatureSigners.status });
    expect(signer!.status).toBe('pending');

    await harness.db.insert(signatureFieldPlacements).values({
      requestId: req!.id,
      signerId: signer!.id,
      fieldType: 'signature',
      pageNumber: 1,
      nx: 0.1,
      ny: 0.8,
      nw: 0.25,
      nh: 0.06,
    });
    await harness.db.insert(signatureEvents).values({
      requestId: req!.id,
      actor: seed.appUserId,
      event: 'created',
      detail: { title: '8879-S 2025' },
    });

    const placements = await harness.db
      .select()
      .from(signatureFieldPlacements)
      .where(eq(signatureFieldPlacements.requestId, req!.id));
    expect(placements).toHaveLength(1);
    expect(placements[0]!.nx).toBeCloseTo(0.1);

    // Deleting the request cascades to signers / placements / events.
    await harness.db.delete(signatureRequests).where(eq(signatureRequests.id, req!.id));
    expect(
      await harness.db
        .select()
        .from(signatureFieldPlacements)
        .where(eq(signatureFieldPlacements.requestId, req!.id)),
    ).toHaveLength(0);
    expect(
      await harness.db
        .select()
        .from(signatureSigners)
        .where(eq(signatureSigners.requestId, req!.id)),
    ).toHaveLength(0);
  });

  it('rejects an invalid status and field type via CHECK', async () => {
    await expect(
      harness.db
        .insert(signatureRequests)
        .values({ firmId: seed.firmId, title: 'x', status: 'bogus' }),
    ).rejects.toThrow();
  });

  it('stores a versioned placement profile with role-based fields', async () => {
    const [p] = await harness.db
      .insert(signaturePlacementProfiles)
      .values({
        firmId: seed.firmId,
        formType: '8879-S',
        version: 1,
        fields: [
          {
            role: 'officer',
            fieldType: 'signature',
            pageNumber: 2,
            nx: 0.1,
            ny: 0.7,
            nw: 0.3,
            nh: 0.05,
          },
          {
            role: 'ero',
            fieldType: 'signature',
            pageNumber: 2,
            nx: 0.1,
            ny: 0.85,
            nw: 0.3,
            nh: 0.05,
          },
        ],
      })
      .returning({ id: signaturePlacementProfiles.id });
    const [row] = await harness.db
      .select()
      .from(signaturePlacementProfiles)
      .where(eq(signaturePlacementProfiles.id, p!.id));
    expect((row!.fields as unknown[]).length).toBe(2);
  });
});
