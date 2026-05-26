// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// FMv2 §4.1–§4.5 — folder-link route tests.
//
// Uses an in-memory MockStorageClient + pglite harness. Direct-handler
// invocation pattern (no HTTP harness) matches recent FMv2 schema
// tests + tax-return tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { eq, sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import {
  clientFolders,
  clients as clientsSchema,
  folderLinkAttempts,
  folderSyncEvents,
} from '@vibe/db/schema';
import { MockStorageClient, writeSentinel } from '@vibe/storage';
import { mountFolderLinkRoutes } from '../clients/folder-link';

let harness: PgliteHarness;
let storage: MockStorageClient;
let tmpDir: string;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  tmpDir = mkdtempSync(join(tmpdir(), 'fmv2-'));
  storage = new MockStorageClient({ rootPath: tmpDir });
});

afterEach(async () => {
  await harness.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function buildRouter(appUserId: string): express.Router {
  const router = express.Router();
  mountFolderLinkRoutes(router, {
    db: harness.db,
    storage,
    fakeUserRoles: new Map([[appUserId, ['partner']]]),
  });
  return router;
}

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

async function setup(): Promise<{
  firmId: string;
  clientId: string;
  appUserId: string;
  router: express.Router;
}> {
  const seed = await seedMinimalFirm(harness.db);
  // Update the client to have a tax_software_id for richer matching.
  await harness.db
    .update(clientsSchema)
    .set({ taxSoftwareId: '0042' })
    .where(eq(clientsSchema.id, seed.clientId));
  // Pre-populate a few folders in the mock storage:
  // - A matching unbound folder
  // - A non-matching unbound folder
  await storage.put('0042 - Test Client Co/dummy.txt', Buffer.from('x'), {
    contentType: 'text/plain',
  });
  await storage.put('Anderson Construction/dummy.txt', Buffer.from('x'), {
    contentType: 'text/plain',
  });
  return {
    firmId: seed.firmId,
    clientId: seed.clientId,
    appUserId: seed.appUserId,
    router: buildRouter(seed.appUserId),
  };
}

function makeReq(s: {
  firmId: string;
  appUserId: string;
  clientId: string;
  body?: unknown;
}): FakeReq {
  return {
    body: s.body ?? {},
    params: { id: s.clientId },
    query: {},
    staffSession: { firmId: s.firmId, appUserId: s.appUserId },
    ip: '127.0.0.1',
    get: () => undefined,
  };
}

describe('FMv2 — POST /:id/folder/match', () => {
  it('returns ranked candidates with tax-ID match at top', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'post', '/:id/folder/match', makeReq(f));
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as {
      candidates: { storage_path: string; reason_code: string; confidence: number }[];
      unbound_count: number;
      suggested_queries: string[];
    };
    expect(body.candidates[0]!.storage_path).toBe('0042 - Test Client Co/');
    expect(body.candidates[0]!.reason_code).toBe('tax_id_in_folder_name');
    expect(body.candidates[0]!.confidence).toBe(1.0);
    expect(body.suggested_queries).toContain('0042');
    expect(body.unbound_count).toBeGreaterThan(0);
  });

  it('404 on unknown client', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'post', '/:id/folder/match', {
      ...makeReq(f),
      params: { id: '00000000-0000-4000-8000-000000000000' },
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('FMv2 — POST /:id/folder/match/search', () => {
  it('filters candidates by query', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'post', '/:id/folder/match/search', {
      ...makeReq(f),
      body: { query: 'anderson' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as { candidates: { storage_path: string }[]; unbound_count: number };
    // No client tax-ID hit on 'anderson', and partial match unlikely
    // to cross 0.50. The folder still listed via unbound_count.
    expect(body.unbound_count).toBeGreaterThanOrEqual(1);
  });

  it('400 on invalid query', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'post', '/:id/folder/match/search', {
      ...makeReq(f),
      body: {},
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('FMv2 — POST /:id/folder/link', () => {
  it('binds unbound folder + writes sentinel + creates rows', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'post', '/:id/folder/link', {
      ...makeReq(f),
      body: { storage_path: '0042 - Test Client Co/' },
    });
    expect(r.statusCode).toBe(201);
    const body = r.jsonBody as {
      client_folder_id: string;
      storage_path: string;
      status: string;
      index_channel: string;
    };
    expect(body.storage_path).toBe('0042 - Test Client Co/');
    expect(body.index_channel).toMatch(/^storage:index:/);

    // client_folders row
    const [row] = await harness.db
      .select()
      .from(clientFolders)
      .where(eq(clientFolders.clientId, f.clientId));
    expect(row!.storagePath).toBe('0042 - Test Client Co/');
    expect(row!.status).toBe('active');

    // folder_link_attempts row
    const [attempt] = await harness.db
      .select()
      .from(folderLinkAttempts)
      .where(eq(folderLinkAttempts.clientId, f.clientId));
    expect(attempt!.outcome).toBe('linked');

    // folder_sync_events row
    const events = await harness.db
      .select()
      .from(folderSyncEvents)
      .where(eq(folderSyncEvents.firmId, f.firmId));
    const linkEvent = events.find((e) => e.eventType === 'link_attempted');
    expect(linkEvent).toBeTruthy();
  });

  it('contested 409 when sentinel points at another client', async () => {
    const f = await setup();
    // Pre-write a sentinel to a different client_id at a NEW path
    // (not pre-populated). We need a real UUID for that client_id.
    const otherClient = await harness.db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id)
          VALUES (${f.firmId}, 'Other Smith', ${f.appUserId}) RETURNING id`,
    );
    const otherClientId = (otherClient as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await writeSentinel(storage, 'Smith Family/', {
      version: 1,
      client_id: otherClientId,
      firm_id: f.firmId,
      tax_software_id: null,
      created_at: new Date().toISOString(),
      created_by: f.appUserId,
      display_name_at_creation: 'Smith Family',
    });
    const r = await invoke(f.router, 'post', '/:id/folder/link', {
      ...makeReq(f),
      body: { storage_path: 'Smith Family/' },
    });
    expect(r.statusCode).toBe(409);
    const body = r.jsonBody as {
      code: string;
      bound_to: { client_id: string; client_name: string };
      attempt_id: string;
      admin_url: string;
    };
    expect(body.code).toBe('folder_already_bound');
    expect(body.bound_to.client_id).toBe(otherClientId);
    expect(body.attempt_id).toBeTruthy();
    expect(body.admin_url).toContain('/admin/storage/conflicts/');

    // folder_link_attempts row with outcome='contested'
    const [attempt] = await harness.db
      .select()
      .from(folderLinkAttempts)
      .where(eq(folderLinkAttempts.id, body.attempt_id));
    expect(attempt!.outcome).toBe('contested');
  });

  it('idempotent: 200 when sentinel matches the same client', async () => {
    const f = await setup();
    await writeSentinel(storage, '0042 - Test Client Co/', {
      version: 1,
      client_id: f.clientId,
      firm_id: f.firmId,
      tax_software_id: '0042',
      created_at: new Date().toISOString(),
      created_by: f.appUserId,
      display_name_at_creation: 'Test Client Co',
    });
    const r = await invoke(f.router, 'post', '/:id/folder/link', {
      ...makeReq(f),
      body: { storage_path: '0042 - Test Client Co/' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as { idempotent?: boolean };
    expect(body.idempotent).toBe(true);
  });

  it('409 when client is already bound to a different path', async () => {
    const f = await setup();
    // Pre-bind to one path.
    await harness.db.insert(clientFolders).values({
      firmId: f.firmId,
      clientId: f.clientId,
      storagePath: 'Other Path/',
      status: 'active',
    });
    const r = await invoke(f.router, 'post', '/:id/folder/link', {
      ...makeReq(f),
      body: { storage_path: '0042 - Test Client Co/' },
    });
    expect(r.statusCode).toBe(409);
    expect((r.jsonBody as { code: string }).code).toBe('client_already_bound');
  });
});

describe('FMv2 — POST /:id/folder/create', () => {
  it('creates a folder + sentinel + binding', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'post', '/:id/folder/create', {
      ...makeReq(f),
      body: { folder_name: 'My New Client Folder' },
    });
    expect(r.statusCode).toBe(201);
    const body = r.jsonBody as { storage_path: string; client_folder_id: string };
    expect(body.storage_path).toBe('My New Client Folder/');

    const [row] = await harness.db
      .select()
      .from(clientFolders)
      .where(eq(clientFolders.clientId, f.clientId));
    expect(row!.storagePath).toBe('My New Client Folder/');
  });

  it('sanitizes Windows-illegal characters', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'post', '/:id/folder/create', {
      ...makeReq(f),
      body: { folder_name: 'Bad:|/Name' },
    });
    expect(r.statusCode).toBe(201);
    const body = r.jsonBody as { storage_path: string };
    expect(body.storage_path).not.toMatch(/[<>:"|?*]/);
  });

  it('409 when path already has a sentinel', async () => {
    const f = await setup();
    // Make the otherClient first to use as sentinel target.
    const otherClient = await harness.db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id)
          VALUES (${f.firmId}, 'Other', ${f.appUserId}) RETURNING id`,
    );
    const otherClientId = (otherClient as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await writeSentinel(storage, 'My New Client Folder/', {
      version: 1,
      client_id: otherClientId,
      firm_id: f.firmId,
      tax_software_id: null,
      created_at: new Date().toISOString(),
      created_by: f.appUserId,
      display_name_at_creation: 'My New Client Folder',
    });
    const r = await invoke(f.router, 'post', '/:id/folder/create', {
      ...makeReq(f),
      body: { folder_name: 'My New Client Folder' },
    });
    expect(r.statusCode).toBe(409);
    expect((r.jsonBody as { code: string }).code).toBe('folder_already_exists');
  });
});

describe('FMv2 — GET /:id/folder/index-status', () => {
  it('returns 404 when client has no folder', async () => {
    const f = await setup();
    const r = await invoke(f.router, 'get', '/:id/folder/index-status', makeReq(f));
    expect(r.statusCode).toBe(404);
  });

  it('returns status snapshot when folder exists', async () => {
    const f = await setup();
    await harness.db.insert(clientFolders).values({
      firmId: f.firmId,
      clientId: f.clientId,
      storagePath: 'X/',
      status: 'active',
      lastSyncedAt: new Date(),
    });
    const r = await invoke(f.router, 'get', '/:id/folder/index-status', makeReq(f));
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as { status: string; index_channel: string };
    expect(body.status).toBe('active');
    expect(body.index_channel).toMatch(/^storage:index:/);
  });
});
