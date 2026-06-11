// SPDX-License-Identifier: Elastic-2.0
//
// P20 — section view tracking tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { magicLinks, proposalActivity, proposalSectionViews, proposals } from '@vibe/db/schema';
import { createSectionViewRouter } from '../proposals/section-views';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

async function seed(): Promise<{
  proposalId: string;
  token: string;
}> {
  const s = await seedMinimalFirm(harness.db);
  const [p] = await harness.db
    .insert(proposals)
    .values({
      firmId: s.firmId,
      clientId: s.clientId,
      title: 'P',
      brochureJsonb: { schemaVersion: 1, blocks: [] } as unknown as Record<string, unknown>,
      status: 'SENT',
      sentAt: new Date(),
      createdById: s.appUserId,
    })
    .returning({ id: proposals.id });
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  await harness.db.insert(magicLinks).values({
    firmId: s.firmId,
    tokenHash: hash,
    purpose: 'PROPOSAL',
    clientId: s.clientId,
    proposalId: p!.id,
    expiresAt: new Date(Date.now() + 86400_000),
  });
  return { proposalId: p!.id, token };
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/portal/proposals', createSectionViewRouter({ db: harness.db }));
  return app;
}

describe('P20 — section-view upsert', () => {
  it('first view inserts row', async () => {
    const { proposalId, token } = await seed();
    const app = buildApp();
    const r = await request(app).post('/api/portal/proposals/section-view').send({
      magicLinkToken: token,
      sessionId: 'sess_abc',
      sectionBlockId: 'block-cover',
      dwellMs: 1500,
    });
    expect(r.status).toBe(200);
    const [row] = await harness.db
      .select()
      .from(proposalSectionViews)
      .where(eq(proposalSectionViews.proposalId, proposalId));
    expect(row!.sectionBlockId).toBe('block-cover');
    expect(row!.sessionId).toBe('sess_abc');
    expect(row!.viewCount).toBe(1);
    expect(Number(row!.totalDwellMs)).toBe(1500);
  });

  it('second view from same session accumulates dwell + bumps count', async () => {
    const { proposalId, token } = await seed();
    const app = buildApp();
    for (let i = 0; i < 3; i++) {
      await request(app).post('/api/portal/proposals/section-view').send({
        magicLinkToken: token,
        sessionId: 'sess_abc',
        sectionBlockId: 'block-cover',
        dwellMs: 2000,
      });
    }
    const rows = await harness.db
      .select()
      .from(proposalSectionViews)
      .where(eq(proposalSectionViews.proposalId, proposalId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.viewCount).toBe(3);
    expect(Number(rows[0]!.totalDwellMs)).toBe(6000);
  });

  it('different session_id creates a separate row', async () => {
    const { proposalId, token } = await seed();
    const app = buildApp();
    await request(app).post('/api/portal/proposals/section-view').send({
      magicLinkToken: token,
      sessionId: 'sess_A',
      sectionBlockId: 'block-1',
      dwellMs: 1000,
    });
    await request(app).post('/api/portal/proposals/section-view').send({
      magicLinkToken: token,
      sessionId: 'sess_B',
      sectionBlockId: 'block-1',
      dwellMs: 2000,
    });
    const rows = await harness.db
      .select()
      .from(proposalSectionViews)
      .where(eq(proposalSectionViews.proposalId, proposalId));
    expect(rows.length).toBe(2);
  });

  it('writes proposal_activity SECTION_VIEWED row each post', async () => {
    const { proposalId, token } = await seed();
    const app = buildApp();
    await request(app).post('/api/portal/proposals/section-view').send({
      magicLinkToken: token,
      sessionId: 'sess',
      sectionBlockId: 'b1',
      dwellMs: 100,
    });
    const activity = await harness.db
      .select()
      .from(proposalActivity)
      .where(eq(proposalActivity.proposalId, proposalId));
    expect(activity.length).toBe(1);
    expect(activity[0]!.kind).toBe('SECTION_VIEWED');
  });

  it('404 on unknown token', async () => {
    const app = buildApp();
    const r = await request(app)
      .post('/api/portal/proposals/section-view')
      .send({
        magicLinkToken: 'a'.repeat(43),
        sessionId: 'sess',
        sectionBlockId: 'b',
        dwellMs: 0,
      });
    expect(r.status).toBe(404);
  });
});

describe('P20 — aggregate read', () => {
  it('aggregates dwell across sessions per section', async () => {
    const { proposalId, token } = await seed();
    const app = buildApp();
    await request(app).post('/api/portal/proposals/section-view').send({
      magicLinkToken: token,
      sessionId: 'sA',
      sectionBlockId: 'block-cover',
      dwellMs: 1000,
    });
    await request(app).post('/api/portal/proposals/section-view').send({
      magicLinkToken: token,
      sessionId: 'sB',
      sectionBlockId: 'block-cover',
      dwellMs: 4000,
    });
    await request(app).post('/api/portal/proposals/section-view').send({
      magicLinkToken: token,
      sessionId: 'sA',
      sectionBlockId: 'block-services',
      dwellMs: 2500,
    });
    const r = await request(app).get(`/api/portal/proposals/${proposalId}/section-views`);
    expect(r.status).toBe(200);
    const items = (
      r.body as {
        items: { sectionBlockId: string; sessions: number; totalDwellMs: number }[];
      }
    ).items;
    const cover = items.find((i) => i.sectionBlockId === 'block-cover')!;
    expect(cover.sessions).toBe(2);
    expect(cover.totalDwellMs).toBe(5000);
    const svc = items.find((i) => i.sectionBlockId === 'block-services')!;
    expect(svc.sessions).toBe(1);
    expect(svc.totalDwellMs).toBe(2500);
  });
});
