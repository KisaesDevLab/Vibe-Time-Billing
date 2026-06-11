// SPDX-License-Identifier: Elastic-2.0
//
// Progress-status change history: surfaces audit_log rows
// (entity_type='engagement_workflow_state') as who/when/old→new, with
// actor names + catalog labels, firm-scoped via client.firm_id.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type express from 'express';

import { engagementStatusConfig } from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { emitAudit } from '../auth/audit';
import { queryStatusHistory, createStatusHistoryRouter } from '../engagements/status-history';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  // Catalog rows so old/new keys resolve to labels.
  await harness.db.insert(engagementStatusConfig).values([
    { firmId: seed.firmId, workflowState: 'NO_STATUS', label: 'No status', isSystem: true },
    { firmId: seed.firmId, workflowState: 'IN_PROGRESS', label: 'In progress', isSystem: true },
    { firmId: seed.firmId, workflowState: 'WITH_CLIENT', label: 'With client', isSystem: true },
  ]);
  // Two transitions on the seeded engagement.
  await emitAudit(harness.db, {
    action: 'UPDATE',
    entityType: 'engagement_workflow_state',
    entityId: seed.engagementId,
    actorAppUserId: seed.appUserId,
    before: { workflowState: 'NO_STATUS' },
    after: { workflowState: 'IN_PROGRESS' },
  });
  await emitAudit(harness.db, {
    action: 'UPDATE',
    entityType: 'engagement_workflow_state',
    entityId: seed.engagementId,
    actorAppUserId: seed.appUserId,
    before: { workflowState: 'IN_PROGRESS' },
    after: { workflowState: 'WITH_CLIENT' },
  });
});
afterEach(async () => {
  await harness.close();
});

describe('queryStatusHistory', () => {
  it('returns transitions newest-first with actor name + resolved labels', async () => {
    const rows = await queryStatusHistory(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
    });
    expect(rows).toHaveLength(2);
    // Newest first → the IN_PROGRESS → WITH_CLIENT change.
    expect(rows[0]!.fromLabel).toBe('In progress');
    expect(rows[0]!.toLabel).toBe('With client');
    expect(rows[0]!.actorName).toBeTruthy();
    expect(rows[0]!.engagementId).toBe(seed.engagementId);
    expect(rows[1]!.fromLabel).toBe('No status');
    expect(rows[1]!.toLabel).toBe('In progress');
  });

  it('is firm-scoped (other firm sees nothing)', async () => {
    const rows = await queryStatusHistory(harness.db, {
      firmId: '00000000-0000-0000-0000-000000000000',
    });
    expect(rows).toHaveLength(0);
  });

  it('honors the date filter', async () => {
    const future = await queryStatusHistory(harness.db, {
      firmId: seed.firmId,
      start: '2999-01-01T00:00:00Z',
    });
    expect(future).toHaveLength(0);
  });

  it('falls back to the raw key when a status was deleted', async () => {
    await emitAudit(harness.db, {
      action: 'UPDATE',
      entityType: 'engagement_workflow_state',
      entityId: seed.engagementId,
      actorAppUserId: seed.appUserId,
      before: { workflowState: 'WITH_CLIENT' },
      after: { workflowState: 'GHOST_STATUS' }, // never in the catalog
    });
    const rows = await queryStatusHistory(harness.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
    });
    expect(rows[0]!.toLabel).toBe('GHOST_STATUS');
  });
});

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
  path: string,
  req: Record<string, unknown>,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods['get'] === true;
  });
  if (!layer) throw new Error(`route not registered: get ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const chain = route.stack;
  for (let i = 0; i < chain.length - 1; i++) {
    let advanced = false;
    await (chain[i]!.handle as (rq: unknown, rs: unknown, nx: () => void) => unknown)(
      req,
      res,
      () => {
        advanced = true;
      },
    );
    if (!advanced) return res;
  }
  await (chain[chain.length - 1]!.handle as (rq: unknown, rs: unknown) => unknown)(req, res);
  return res;
}

describe('firm-wide status-history report router', () => {
  function router(roles: RoleSlug[] = ['partner']) {
    return createStatusHistoryRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, roles]]),
    });
  }
  function req(): Record<string, unknown> {
    return {
      query: {},
      params: {},
      headers: {},
      staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
      ip: '127.0.0.1',
      header: () => undefined,
      get: () => undefined,
    };
  }

  it('returns the firm history', async () => {
    const r = await invoke(router(), '/', { ...req() });
    expect(r.statusCode).toBe(200);
    expect((r.jsonBody as { items: unknown[] }).items).toHaveLength(2);
  });

  it('requires engagement:read (403 without it)', async () => {
    const r = await invoke(router([] as RoleSlug[]), '/', { ...req() });
    expect(r.statusCode).toBe(403);
  });
});
