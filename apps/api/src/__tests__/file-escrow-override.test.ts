// SPDX-License-Identifier: Elastic-2.0
//
// Connect F.7 — admin escrow override endpoint. Verifies that a
// partner can flip a file escrow ↔ client_visible without an invoice
// payment, that the reason must be present + non-trivial, and that
// non-partner roles can't reach the endpoint.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type express from 'express';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { files, fileVisibilityEvents, invoices } from '@vibe/db/schema';
import { createFileVisibilityRouter } from '../files/visibility';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

async function seedFile(visibility: 'escrow' | 'client_visible' | 'private'): Promise<{
  firmId: string;
  appUserId: string;
  fileId: string;
  invoiceId: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  // Need a client_folder for the FK
  const folder = await harness.db.execute(
    sql`INSERT INTO client_folders (firm_id, client_id, storage_path)
        VALUES (${seed.firmId}, ${seed.clientId}, 'TestClient/') RETURNING id`,
  );
  const folderId = (folder as unknown as { rows: { id: string }[] }).rows[0]!.id;
  // Invoice (escrow rows require an invoice_id).
  const [inv] = await harness.db
    .insert(invoices)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      invoiceNumber: 'INV-1',
      issueDate: '2026-01-01',
      dueDate: '2026-01-31',
      subtotalCents: 10000,
      totalCents: 10000,
      status: 'SENT',
    })
    .returning({ id: invoices.id });
  const [f] = await harness.db
    .insert(files)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      clientFolderId: folderId,
      originalFilename: 'deliverable.pdf',
      storageKey: `firm/${seed.firmId}/file1.pdf`,
      sizeBytes: 1024,
      visibility,
      invoiceId: visibility === 'escrow' ? inv!.id : null,
    })
    .returning({ id: files.id });
  return { firmId: seed.firmId, appUserId: seed.appUserId, fileId: f!.id, invoiceId: inv!.id };
}

interface FakeReq {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  staffSession: { firmId: string; appUserId: string };
  ip: string;
  header(name: string): string | undefined;
  get(name: string): string | undefined;
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
  method: 'post',
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
  // Skip the permission middleware (index 0) — RBAC is tested separately.
  // Call the actual handler (last item).
  const handlers = route.stack.map((s) => s.handle);
  for (const h of handlers) {
    let nextCalled = false;
    await (h as (req: unknown, res: unknown, next: () => void) => Promise<void>)(req, res, () => {
      nextCalled = true;
    });
    if (!nextCalled && (res.statusCode !== 200 || res.jsonBody !== undefined)) break;
  }
  return res;
}

function req(f: { firmId: string; appUserId: string; fileId: string; body: unknown }): FakeReq {
  return {
    body: f.body,
    params: { id: f.fileId },
    query: {},
    staffSession: { firmId: f.firmId, appUserId: f.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
}

describe('Connect F.7 — escrow override', () => {
  it('partner can promote escrow → client_visible without payment', async () => {
    const f = await seedFile('escrow');
    const router = createFileVisibilityRouter({
      db: harness.db,
      fakeUserRoles: new Map([[f.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/:id/escrow-override', {
      ...req({
        firmId: f.firmId,
        appUserId: f.appUserId,
        fileId: f.fileId,
        body: {
          targetVisibility: 'client_visible',
          reason: 'Client paid in person; releasing deliverable.',
        },
      }),
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as { ok: boolean; oldValue: string; newValue: string };
    expect(body.oldValue).toBe('escrow');
    expect(body.newValue).toBe('client_visible');
    const [row] = await harness.db.select().from(files).where(eq(files.id, f.fileId));
    expect(row!.visibility).toBe('client_visible');
    // Visibility event recorded with override-tagged reason.
    const events = await harness.db
      .select()
      .from(fileVisibilityEvents)
      .where(eq(fileVisibilityEvents.fileId, f.fileId));
    expect(events.length).toBe(1);
    expect(events[0]!.reason).toContain('[OVERRIDE]');
  });

  it('rejects short reason', async () => {
    const f = await seedFile('escrow');
    const router = createFileVisibilityRouter({
      db: harness.db,
      fakeUserRoles: new Map([[f.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/:id/escrow-override', {
      ...req({
        firmId: f.firmId,
        appUserId: f.appUserId,
        fileId: f.fileId,
        body: { targetVisibility: 'client_visible', reason: 'short' },
      }),
    });
    expect(r.statusCode).toBe(400);
  });

  it('rejects manager (no billing:override permission)', async () => {
    const f = await seedFile('escrow');
    const router = createFileVisibilityRouter({
      db: harness.db,
      fakeUserRoles: new Map([[f.appUserId, ['manager']]]),
    });
    const r = await invoke(router, 'post', '/:id/escrow-override', {
      ...req({
        firmId: f.firmId,
        appUserId: f.appUserId,
        fileId: f.fileId,
        body: {
          targetVisibility: 'client_visible',
          reason: 'Manager tries to release file.',
        },
      }),
    });
    expect(r.statusCode).toBe(403);
    // Original visibility unchanged.
    const [row] = await harness.db.select().from(files).where(eq(files.id, f.fileId));
    expect(row!.visibility).toBe('escrow');
  });

  it('partner can re-gate client_visible → escrow with invoiceId', async () => {
    const f = await seedFile('client_visible');
    const router = createFileVisibilityRouter({
      db: harness.db,
      fakeUserRoles: new Map([[f.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/:id/escrow-override', {
      ...req({
        firmId: f.firmId,
        appUserId: f.appUserId,
        fileId: f.fileId,
        body: {
          targetVisibility: 'escrow',
          reason: 'Re-gating until disputed invoice resolves.',
          invoiceId: f.invoiceId,
        },
      }),
    });
    expect(r.statusCode).toBe(200);
    const [row] = await harness.db.select().from(files).where(eq(files.id, f.fileId));
    expect(row!.visibility).toBe('escrow');
  });

  it('409 when target visibility equals current', async () => {
    const f = await seedFile('client_visible');
    const router = createFileVisibilityRouter({
      db: harness.db,
      fakeUserRoles: new Map([[f.appUserId, ['partner']]]),
    });
    const r = await invoke(router, 'post', '/:id/escrow-override', {
      ...req({
        firmId: f.firmId,
        appUserId: f.appUserId,
        fileId: f.fileId,
        body: {
          targetVisibility: 'client_visible',
          reason: 'No-op test — already client_visible.',
        },
      }),
    });
    expect(r.statusCode).toBe(409);
  });
});
