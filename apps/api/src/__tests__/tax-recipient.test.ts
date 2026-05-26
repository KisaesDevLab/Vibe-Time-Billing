// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-7 — Recipient page + token resolve tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sql, eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { taxReturnReleases, taxReturnSections, taxReturns, taxReturnShares } from '@vibe/db/schema';
import {
  createShare,
  resolveShareToken,
  bumpFailed2fa,
  ShareError,
} from '../tax-returns/share-helper';
import { createShareRecipientRouter } from '../share-public/tax-recipient';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

async function setupWithShare(opts: { require2fa?: boolean } = {}): Promise<{
  shareId: string;
  token: string;
  returnId: string;
  app: express.Express;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const [r] = await harness.db
    .insert(taxReturns)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      taxYear: 2025,
      formCode: '1040',
      title: 'T',
      status: 'RELEASED',
      totalPages: 5,
    })
    .returning();
  await harness.db.insert(taxReturnSections).values({
    returnId: r!.id,
    ordinal: 0,
    rawTitle: 'Form 1040',
    normalizedTitle: 'Form 1040',
    kind: 'MAIN_FORM',
    startPage: 1,
    endPage: 5,
  });
  const [rel] = await harness.db
    .insert(taxReturnReleases)
    .values({
      returnId: r!.id,
      releasedToClientId: seed.clientId,
      scope: 'FULL',
      sectionIds: [],
      releasedByUserId: seed.appUserId,
    })
    .returning({ id: taxReturnReleases.id });
  const identity = await harness.db.execute(
    sql`INSERT INTO portal_identity (firm_id, full_name, primary_email)
        VALUES (${seed.firmId}, 'C', 'c@x.example') RETURNING id`,
  );
  const identityId = (identity as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const access = await harness.db.execute(
    sql`INSERT INTO client_portal_access (portal_identity_id, client_id, status, role)
        VALUES (${identityId}, ${seed.clientId}, 'ACTIVE', 'FULL') RETURNING id`,
  );
  const accessId = (access as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const created = await createShare({
    db: harness.db,
    returnId: r!.id,
    sharedByAccessId: accessId,
    callerClientIds: [seed.clientId],
    recipientName: 'Banker',
    recipientEmail: 'banker@chase.example',
    recipientPhone: '15551234567',
    organization: 'Chase Bank',
    role: 'lender',
    accessLevel: 'view_only',
    scope: 'FULL',
    sectionIds: [],
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    require2fa: opts.require2fa ?? false,
    verifyChannel: opts.require2fa ? 'EMAIL' : 'NONE',
    watermark: true,
    personalMessage: '',
  });

  const app = express();
  app.use(express.json());
  app.use('/shared/tax', createShareRecipientRouter({ db: harness.db }));
  void rel;
  return { shareId: created.shareId, token: created.token, returnId: r!.id, app };
}

describe('TR-7 — resolveShareToken', () => {
  it('parses <id>.<secret> and verifies argon2', async () => {
    const f = await setupWithShare();
    const resolved = await resolveShareToken(harness.db, f.token);
    expect(resolved.id).toBe(f.shareId);
    expect(resolved.returnId).toBe(f.returnId);
  });

  it('rejects malformed token', async () => {
    await setupWithShare();
    await expect(resolveShareToken(harness.db, 'no-dot-here')).rejects.toThrow(/not_found/);
    await expect(
      resolveShareToken(harness.db, '00000000-0000-4000-8000-000000000000.wrong-secret'),
    ).rejects.toThrow(/not_found/);
  });

  it('rejects wrong secret with the same not_found code (no disclosure)', async () => {
    const f = await setupWithShare();
    const id = f.shareId;
    await expect(resolveShareToken(harness.db, `${id}.completely-wrong-secret`)).rejects.toThrow(
      /not_found/,
    );
  });

  it('rejects expired share', async () => {
    const f = await setupWithShare();
    await harness.db.execute(
      sql`UPDATE tax_return_shares
          SET sent_at = NOW() - INTERVAL '2 hours',
              expires_at = NOW() - INTERVAL '1 hour'
          WHERE id = ${f.shareId}`,
    );
    await expect(resolveShareToken(harness.db, f.token)).rejects.toThrow(/expired/);
  });

  it('rejects revoked share', async () => {
    const f = await setupWithShare();
    await harness.db.execute(
      sql`UPDATE tax_return_shares SET status = 'REVOKED', revoked_at = NOW() WHERE id = ${f.shareId}`,
    );
    await expect(resolveShareToken(harness.db, f.token)).rejects.toThrow(/revoked/);
  });
});

describe('TR-7 — bumpFailed2fa auto-revokes at 5', async () => {
  it('flips to REVOKED after the 5th failure', async () => {
    const f = await setupWithShare({ require2fa: true });
    for (let i = 0; i < 4; i++) {
      const b = await bumpFailed2fa(harness.db, f.shareId);
      expect(b.revoked).toBe(false);
    }
    const fifth = await bumpFailed2fa(harness.db, f.shareId);
    expect(fifth.revoked).toBe(true);
    const [row] = await harness.db
      .select()
      .from(taxReturnShares)
      .where(eq(taxReturnShares.id, f.shareId));
    expect(row!.status).toBe('REVOKED');
  });
});

describe('TR-7 — GET /shared/tax/:token', () => {
  it('returns channel hint shape for EMAIL 2FA', async () => {
    const f = await setupWithShare({ require2fa: true });
    const r = await request(f.app).get(`/shared/tax/${f.token}`);
    expect(r.status).toBe(200);
    expect(r.body.requires2fa).toBe(true);
    expect(r.body.verifyChannel).toBe('EMAIL');
    expect(r.body.channelHint).toBe('… @chase.example');
    expect(r.body.recipientEmailDomain).toBe('@chase.example');
    expect(r.body.organization).toBe('Chase Bank');
  });

  it('returns 404 for unknown token', async () => {
    const f = await setupWithShare();
    const r = await request(f.app).get('/shared/tax/00000000-0000-4000-8000-000000000000.fake');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  });

  it('returns 404 for malformed token (no dot)', async () => {
    const f = await setupWithShare();
    const r = await request(f.app).get('/shared/tax/garbage');
    expect(r.status).toBe(404);
  });
});

describe('TR-7 — POST /shared/tax/:token/2fa/verify', () => {
  it('NONE channel passes without code check + marks viewed', async () => {
    const f = await setupWithShare();
    const r = await request(f.app)
      .post(`/shared/tax/${f.token}/2fa/verify`)
      .send({ code: '000000' });
    expect(r.status).toBe(200);
    const [row] = await harness.db
      .select()
      .from(taxReturnShares)
      .where(eq(taxReturnShares.id, f.shareId));
    expect(row!.status).toBe('VIEWED');
    expect(row!.firstViewedAt).not.toBeNull();
  });

  it('EMAIL channel returns 503 (dispatcher not wired) + bumps counter', async () => {
    const f = await setupWithShare({ require2fa: true });
    const r = await request(f.app)
      .post(`/shared/tax/${f.token}/2fa/verify`)
      .send({ code: '123456' });
    expect(r.status).toBe(503);
    const [row] = await harness.db
      .select()
      .from(taxReturnShares)
      .where(eq(taxReturnShares.id, f.shareId));
    expect(row!.failed2faCount).toBe(1);
  });

  it('after 5 failed verifies → share auto-revoked, route returns 403', async () => {
    const f = await setupWithShare({ require2fa: true });
    for (let i = 0; i < 4; i++) {
      await request(f.app).post(`/shared/tax/${f.token}/2fa/verify`).send({ code: '111111' });
    }
    const fifth = await request(f.app)
      .post(`/shared/tax/${f.token}/2fa/verify`)
      .send({ code: '111111' });
    expect(fifth.status).toBe(403);
    expect(fifth.body.error).toBe('2fa_locked');
  });

  it('invalid payload → 404 (generic not_found)', async () => {
    const f = await setupWithShare();
    const r = await request(f.app).post(`/shared/tax/${f.token}/2fa/verify`).send({ code: 'abc' });
    expect(r.status).toBe(404);
  });

  // Silence unused-import lint
  it('ShareError type exported for callers', () => {
    expect(typeof ShareError).toBe('function');
  });
});

describe('TR-7 — GET /shared/tax/:token/pdf', () => {
  it('returns 503 plan-metadata when no 2FA required', async () => {
    const f = await setupWithShare();
    const r = await request(f.app).get(`/shared/tax/${f.token}/pdf`);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('pdf_renderer_unavailable');
    expect(r.body.pages).toBe(5);
    expect(r.body.watermark).toContain('banker@chase.example');
    expect(r.body.watermark).toContain('Chase Bank');
  });

  it('returns 403 when 2FA required (cookie verification not wired yet)', async () => {
    const f = await setupWithShare({ require2fa: true });
    const r = await request(f.app).get(`/shared/tax/${f.token}/pdf`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('2fa_required');
  });
});
