// SPDX-License-Identifier: Elastic-2.0
//
// 0101 — unlimited custom engagement progress-statuses + client-facing text.
// Verifies: GET self-heals the built-ins; POST creates a custom status
// (slug + dedupe, is_system=false); PATCH sets client fields; DELETE is
// blocked for built-ins and for in-use customs, allowed otherwise; writes
// are gated by firm:settings:write.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type express from 'express';

import { engagementStatusConfig, engagementStatusServiceLine, engagements } from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createAdminRouter } from '../admin/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
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

// Runs the FULL handler chain so requirePermission executes.
async function invoke(
  router: express.Router,
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  req: Record<string, unknown>,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method} ${path}`);
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

function req(
  opts: { params?: Record<string, string>; body?: unknown } = {},
): Record<string, unknown> {
  return {
    body: opts.body ?? {},
    params: opts.params ?? {},
    query: {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
}

function router(roles: RoleSlug[] = ['admin']) {
  return createAdminRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, roles]]),
  });
}

interface StatusRow {
  workflowState: string;
  isSystem: boolean;
  clientLabel: string | null;
}

describe('engagement status catalog', () => {
  it('GET self-heals the 10 built-ins as system rows', async () => {
    const g = await invoke(router(), 'get', '/engagement-statuses', { ...req() });
    const items = (g.jsonBody as { items: StatusRow[] }).items;
    expect(items).toHaveLength(10);
    expect(items.every((i) => i.isSystem)).toBe(true);
    expect(items.map((i) => i.workflowState)).toContain('IN_PROGRESS');
  });

  it('POST creates a custom status with a slugified, deduped key', async () => {
    const r = router();
    const a = await invoke(r, 'post', '/engagement-statuses', {
      ...req({ body: { label: 'Awaiting documents' } }),
    });
    expect(a.statusCode).toBe(200);
    expect((a.jsonBody as { workflowState: string }).workflowState).toBe('AWAITING_DOCUMENTS');
    // Same label again → deduped key.
    const b = await invoke(r, 'post', '/engagement-statuses', {
      ...req({ body: { label: 'Awaiting documents' } }),
    });
    expect((b.jsonBody as { workflowState: string }).workflowState).toBe('AWAITING_DOCUMENTS_2');

    const rows = await harness.db
      .select()
      .from(engagementStatusConfig)
      .where(eq(engagementStatusConfig.workflowState, 'AWAITING_DOCUMENTS'));
    expect(rows[0]!.isSystem).toBe(false);
  });

  it('PATCH sets the client-facing label/description', async () => {
    const r = router();
    await invoke(r, 'get', '/engagement-statuses', { ...req() }); // seed built-ins
    const p = await invoke(r, 'patch', '/engagement-statuses/:state', {
      ...req({
        params: { state: 'IN_PROGRESS' },
        body: { clientLabel: 'We are working on it', clientDescription: 'Hang tight' },
      }),
    });
    expect(p.statusCode).toBe(200);
    const [row] = await harness.db
      .select()
      .from(engagementStatusConfig)
      .where(eq(engagementStatusConfig.workflowState, 'IN_PROGRESS'));
    expect(row!.clientLabel).toBe('We are working on it');
    expect(row!.clientDescription).toBe('Hang tight');
  });

  it('DELETE is blocked for built-in statuses', async () => {
    const r = router();
    await invoke(r, 'get', '/engagement-statuses', { ...req() }); // seed built-ins
    const d = await invoke(r, 'delete', '/engagement-statuses/:state', {
      ...req({ params: { state: 'IN_PROGRESS' } }),
    });
    expect(d.statusCode).toBe(409);
    expect((d.jsonBody as { error: string }).error).toBe('cannot_delete_system_status');
  });

  it('DELETE removes an unused custom status', async () => {
    const r = router();
    await invoke(r, 'post', '/engagement-statuses', {
      ...req({ body: { label: 'Scheduled call' } }),
    });
    const d = await invoke(r, 'delete', '/engagement-statuses/:state', {
      ...req({ params: { state: 'SCHEDULED_CALL' } }),
    });
    expect(d.statusCode).toBe(200);
    const rows = await harness.db
      .select()
      .from(engagementStatusConfig)
      .where(eq(engagementStatusConfig.workflowState, 'SCHEDULED_CALL'));
    expect(rows).toHaveLength(0);
  });

  it('DELETE is blocked when a custom status is in use', async () => {
    const r = router();
    await invoke(r, 'post', '/engagement-statuses', { ...req({ body: { label: 'In review' } }) });
    // Point the seeded engagement at the custom status.
    await harness.db
      .update(engagements)
      .set({ workflowState: 'IN_REVIEW' })
      .where(eq(engagements.id, seed.engagementId));
    const d = await invoke(r, 'delete', '/engagement-statuses/:state', {
      ...req({ params: { state: 'IN_REVIEW' } }),
    });
    expect(d.statusCode).toBe(409);
    expect((d.jsonBody as { error: string }).error).toBe('status_in_use');
  });

  it('POST requires firm:settings:write (403 for manager)', async () => {
    const r = router(['manager']);
    const a = await invoke(r, 'post', '/engagement-statuses', {
      ...req({ body: { label: 'Nope' } }),
    });
    expect(a.statusCode).toBe(403);
  });
});

// 0167 — per-status service-line mapping.
describe('engagement status ↔ service line mapping', () => {
  it('GET returns empty serviceLineIds and the firm service lines', async () => {
    const g = await invoke(router(), 'get', '/engagement-statuses', { ...req() });
    const body = g.jsonBody as {
      items: Array<{ workflowState: string; serviceLineIds: string[] }>;
      serviceLines: Array<{ id: string; name: string }>;
    };
    expect(
      body.items.every((i) => Array.isArray(i.serviceLineIds) && i.serviceLineIds.length === 0),
    ).toBe(true);
    expect(body.serviceLines.map((s) => s.id)).toContain(seed.serviceLineId);
  });

  it('POST persists the service-line mapping and GET reflects it', async () => {
    const r = router();
    const a = await invoke(r, 'post', '/engagement-statuses', {
      ...req({ body: { label: 'Tax only', serviceLineIds: [seed.serviceLineId] } }),
    });
    expect(a.statusCode).toBe(200);
    const key = (a.jsonBody as { workflowState: string }).workflowState;
    const rows = await harness.db
      .select()
      .from(engagementStatusServiceLine)
      .where(eq(engagementStatusServiceLine.workflowState, key));
    expect(rows.map((m) => m.serviceLineId)).toEqual([seed.serviceLineId]);
    const g = await invoke(r, 'get', '/engagement-statuses', { ...req() });
    const item = (
      g.jsonBody as { items: Array<{ workflowState: string; serviceLineIds: string[] }> }
    ).items.find((i) => i.workflowState === key);
    expect(item?.serviceLineIds).toEqual([seed.serviceLineId]);
  });

  it('POST with an unknown service line is rejected and creates nothing', async () => {
    const r = router();
    const a = await invoke(r, 'post', '/engagement-statuses', {
      ...req({
        body: { label: 'Bad map', serviceLineIds: ['00000000-0000-0000-0000-000000000000'] },
      }),
    });
    expect(a.statusCode).toBe(400);
    expect((a.jsonBody as { error: string }).error).toBe('invalid_service_line');
    const rows = await harness.db
      .select()
      .from(engagementStatusConfig)
      .where(eq(engagementStatusConfig.workflowState, 'BAD_MAP'));
    expect(rows).toHaveLength(0);
  });

  it('PATCH replaces, leaves intact when omitted, and clears with []', async () => {
    const r = router();
    await invoke(r, 'get', '/engagement-statuses', { ...req() }); // seed built-ins
    const count = async (): Promise<number> =>
      (
        await harness.db
          .select()
          .from(engagementStatusServiceLine)
          .where(eq(engagementStatusServiceLine.workflowState, 'IN_PROGRESS'))
      ).length;

    await invoke(r, 'patch', '/engagement-statuses/:state', {
      ...req({ params: { state: 'IN_PROGRESS' }, body: { serviceLineIds: [seed.serviceLineId] } }),
    });
    expect(await count()).toBe(1);

    // Omitting serviceLineIds must not touch the mapping.
    await invoke(r, 'patch', '/engagement-statuses/:state', {
      ...req({ params: { state: 'IN_PROGRESS' }, body: { label: 'In progress!' } }),
    });
    expect(await count()).toBe(1);

    // Empty array clears it.
    await invoke(r, 'patch', '/engagement-statuses/:state', {
      ...req({ params: { state: 'IN_PROGRESS' }, body: { serviceLineIds: [] } }),
    });
    expect(await count()).toBe(0);
  });

  it('deleting a custom status cascades its mappings', async () => {
    const r = router();
    const a = await invoke(r, 'post', '/engagement-statuses', {
      ...req({ body: { label: 'Map me', serviceLineIds: [seed.serviceLineId] } }),
    });
    const key = (a.jsonBody as { workflowState: string }).workflowState;
    const d = await invoke(r, 'delete', '/engagement-statuses/:state', {
      ...req({ params: { state: key } }),
    });
    expect(d.statusCode).toBe(200);
    const rows = await harness.db
      .select()
      .from(engagementStatusServiceLine)
      .where(eq(engagementStatusServiceLine.workflowState, key));
    expect(rows).toHaveLength(0);
  });
});
