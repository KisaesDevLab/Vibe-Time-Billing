// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// FMv2 §4.6-4.8 — admin conflict resolution tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type express from 'express';
import { eq, sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { clientFolders, folderLinkAttempts } from '@vibe/db/schema';
import { computeRecommendation, createConflictsRouter } from '../storage/conflicts';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

interface FakeReq {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  staffSession: { firmId: string; appUserId: string };
  ip: string;
  get(_h: string): string | undefined;
}
interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
}

function makeRes(): FakeRes {
  return {
    statusCode: 200,
    jsonBody: undefined,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.jsonBody = b;
      return this;
    },
  };
}

async function invoke(
  router: express.Router,
  method: 'get' | 'post',
  path: string,
  req: FakeReq,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

describe('FMv2 — computeRecommendation', () => {
  it('keep_current when current fuzzy is higher + binding is old', () => {
    const r = computeRecommendation({
      current_fuzzy: 0.94,
      challenger_fuzzy: 0.62,
      binding_age_days: 502,
    });
    expect(r.action).toBe('keep_current');
    expect(r.rationale).toContain('502');
  });

  it('reassign when challenger fuzzy is materially higher', () => {
    const r = computeRecommendation({
      current_fuzzy: 0.5,
      challenger_fuzzy: 0.9,
      binding_age_days: 10,
    });
    expect(r.action).toBe('reassign');
  });

  it('unbind_both when both near-equal AND binding is very recent', () => {
    const r = computeRecommendation({
      current_fuzzy: 0.82,
      challenger_fuzzy: 0.83,
      binding_age_days: 2,
    });
    expect(r.action).toBe('unbind_both');
  });

  it('keep_current when current matches challenger (>= rather than reassign)', () => {
    const r = computeRecommendation({
      current_fuzzy: 0.8,
      challenger_fuzzy: 0.7,
      binding_age_days: 5,
    });
    expect(r.action).toBe('keep_current');
  });
});

async function seedContestedConflict(): Promise<{
  firmId: string;
  appUserId: string;
  attemptId: string;
  challengerId: string;
  currentClientId: string;
  router: express.Router;
}> {
  const seed = await seedMinimalFirm(harness.db);
  // seed.clientId is the CURRENT binding client.
  const challenger = await harness.db.execute(
    sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
        VALUES (${seed.firmId}, 'Challenger Client', ${seed.appUserId},
                (SELECT id FROM office WHERE firm_id = ${seed.firmId} ORDER BY is_default DESC LIMIT 1)) RETURNING id`,
  );
  const challengerId = (challenger as unknown as { rows: { id: string }[] }).rows[0]!.id;
  // Create current binding.
  await harness.db.insert(clientFolders).values({
    firmId: seed.firmId,
    clientId: seed.clientId,
    storagePath: 'Smith Family/',
    status: 'active',
  });
  // Create contested attempt.
  const [attempt] = await harness.db
    .insert(folderLinkAttempts)
    .values({
      firmId: seed.firmId,
      clientId: challengerId,
      storagePath: 'Smith Family/',
      attemptedBy: seed.appUserId,
      outcome: 'contested',
    })
    .returning({ id: folderLinkAttempts.id });
  const router = createConflictsRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
  });
  return {
    firmId: seed.firmId,
    appUserId: seed.appUserId,
    attemptId: attempt!.id,
    challengerId,
    currentClientId: seed.clientId,
    router,
  };
}

function req(f: {
  firmId: string;
  appUserId: string;
  attemptId?: string;
  body?: unknown;
}): FakeReq {
  return {
    body: f.body ?? {},
    params: f.attemptId ? { attempt_id: f.attemptId } : {},
    query: {},
    staffSession: { firmId: f.firmId, appUserId: f.appUserId },
    ip: '127.0.0.1',
    get: () => undefined,
  };
}

describe('FMv2 — GET /conflicts', () => {
  it('lists contested attempts with bound_to + challenger', async () => {
    const f = await seedContestedConflict();
    const r = await invoke(f.router, 'get', '/', req(f));
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as {
      conflicts: { id: string; type: string; bound_to: { client_id: string } }[];
      counts: { contested: number };
    };
    expect(body.conflicts.length).toBe(1);
    expect(body.conflicts[0]!.type).toBe('link_contested');
    expect(body.conflicts[0]!.bound_to.client_id).toBe(f.currentClientId);
    expect(body.counts.contested).toBe(1);
  });

  it('cross-firm: empty for another firm', async () => {
    await seedContestedConflict();
    const other = await harness.db.execute(
      sql`INSERT INTO firm (name) VALUES ('Other') RETURNING id`,
    );
    const otherFirmId = (other as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherUser = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${otherFirmId}, 'o@x.example', 'O', 'O', 'O') RETURNING id`,
    );
    const otherUserId = (otherUser as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const router = createConflictsRouter({
      db: harness.db,
      fakeUserRoles: new Map([[otherUserId, ['partner']]]),
    });
    const r = await invoke(router, 'get', '/', {
      ...req({ firmId: otherFirmId, appUserId: otherUserId }),
    });
    const body = r.jsonBody as { conflicts: unknown[]; counts: { contested: number } };
    expect(body.conflicts.length).toBe(0);
    expect(body.counts.contested).toBe(0);
  });
});

describe('FMv2 — GET /conflicts/:attempt_id', () => {
  it('returns detail with currently_bound + challenger + recommendation', async () => {
    const f = await seedContestedConflict();
    const r = await invoke(f.router, 'get', '/:attempt_id', req(f));
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as {
      attempt: { id: string; outcome: string };
      currently_bound: { client_id: string };
      challenger: { client_id: string };
      recommendation: { action: string; rationale: string };
    };
    expect(body.attempt.id).toBe(f.attemptId);
    expect(body.attempt.outcome).toBe('contested');
    expect(body.currently_bound.client_id).toBe(f.currentClientId);
    expect(body.challenger.client_id).toBe(f.challengerId);
    expect(['keep_current', 'reassign', 'unbind_both']).toContain(body.recommendation.action);
  });

  it('404 on unknown attempt', async () => {
    const f = await seedContestedConflict();
    const r = await invoke(f.router, 'get', '/:attempt_id', {
      ...req(f),
      params: { attempt_id: '00000000-0000-4000-8000-000000000000' },
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('FMv2 — POST /conflicts/:attempt_id/resolve', () => {
  it('keep_current marks outcome=denied; binding unchanged', async () => {
    const f = await seedContestedConflict();
    const r = await invoke(f.router, 'post', '/:attempt_id/resolve', {
      ...req(f),
      body: { action: 'keep_current' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as { outcome: string };
    expect(body.outcome).toBe('denied');

    const [attempt] = await harness.db
      .select()
      .from(folderLinkAttempts)
      .where(eq(folderLinkAttempts.id, f.attemptId));
    expect(attempt!.outcome).toBe('denied');
    expect(attempt!.resolvedAt).not.toBeNull();

    // Binding unchanged
    const [binding] = await harness.db
      .select()
      .from(clientFolders)
      .where(eq(clientFolders.clientId, f.currentClientId));
    expect(binding!.clientId).toBe(f.currentClientId);
  });

  it('reassign transfers binding to challenger', async () => {
    const f = await seedContestedConflict();
    const r = await invoke(f.router, 'post', '/:attempt_id/resolve', {
      ...req(f),
      body: { action: 'reassign', reason: 'Original was wrong; this is the right client.' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as { outcome: string };
    expect(body.outcome).toBe('reassigned');

    const [binding] = await harness.db
      .select()
      .from(clientFolders)
      .where(eq(clientFolders.storagePath, 'Smith Family/'));
    expect(binding!.clientId).toBe(f.challengerId);
    expect(binding!.status).toBe('active');
  });

  it('unbind_both soft-deletes binding', async () => {
    const f = await seedContestedConflict();
    const r = await invoke(f.router, 'post', '/:attempt_id/resolve', {
      ...req(f),
      body: { action: 'unbind_both', reason: 'Both clients should re-link manually.' },
    });
    expect(r.statusCode).toBe(200);
    expect((r.jsonBody as { outcome: string }).outcome).toBe('aborted');
    const [binding] = await harness.db
      .select()
      .from(clientFolders)
      .where(eq(clientFolders.storagePath, 'Smith Family/'));
    expect(binding!.status).toBe('missing');
  });

  it('rejects non-default action with short reason', async () => {
    const f = await seedContestedConflict();
    const r = await invoke(f.router, 'post', '/:attempt_id/resolve', {
      ...req(f),
      body: { action: 'reassign', reason: 'short' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('rejects already-resolved attempts', async () => {
    const f = await seedContestedConflict();
    // First resolution: keep_current.
    await invoke(f.router, 'post', '/:attempt_id/resolve', {
      ...req(f),
      body: { action: 'keep_current' },
    });
    // Second resolution attempt: 409.
    const r = await invoke(f.router, 'post', '/:attempt_id/resolve', {
      ...req(f),
      body: { action: 'reassign', reason: 'try again with valid reason length.' },
    });
    expect(r.statusCode).toBe(409);
  });
});
