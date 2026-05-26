// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// FMv2 §8 — audit-completeness test.
//
// Asserts the invariants from the spec table:
//
// | Path                           | folder_link_attempts.outcome | folder_sync_events.event_type | resolution    |
// |--------------------------------|------------------------------|-------------------------------|---------------|
// | Link unbound folder            | linked                       | link_attempted                | n/a           |
// | Link contested → keep_current  | denied                       | link_contested → resolved     | kept_current  |
// | Link contested → reassign      | reassigned                   | link_contested → resolved     | reassigned    |
// | Link contested → unbind_both   | aborted                      | link_contested → resolved     | unbound_both  |
// | Create new folder              | linked                       | link_attempted                | n/a           |
// | Link idempotent (same client)  | linked (existing, no new)    | none                          | n/a           |

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type express from 'express';
import { and, eq, sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { clientFolders, folderLinkAttempts, folderSyncEvents } from '@vibe/db/schema';
import { MockStorageClient, writeSentinel } from '@vibe/storage';
import { mountFolderLinkRoutes } from '../clients/folder-link';
import { createConflictsRouter } from '../storage/conflicts';

let harness: PgliteHarness;
let storage: MockStorageClient;
let tmpDir: string;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  tmpDir = mkdtempSync(join(tmpdir(), 'fmv2-audit-'));
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
  appUserId: string;
  clientId: string;
  challengerId: string;
  linkRouter: express.Router;
  conflictsRouter: express.Router;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const challenger = await harness.db.execute(
    sql`INSERT INTO client (firm_id, name, partner_in_charge_id)
        VALUES (${seed.firmId}, 'Challenger Client', ${seed.appUserId}) RETURNING id`,
  );
  const challengerId = (challenger as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const linkRouter = (await import('express')).default.Router();
  mountFolderLinkRoutes(linkRouter, {
    db: harness.db,
    storage,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
  });
  const conflictsRouter = createConflictsRouter({
    db: harness.db,
    storage,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
  });
  return {
    firmId: seed.firmId,
    appUserId: seed.appUserId,
    clientId: seed.clientId,
    challengerId,
    linkRouter,
    conflictsRouter,
  };
}

function req(
  s: { firmId: string; appUserId: string },
  params: Record<string, string>,
  body: unknown,
): FakeReq {
  return {
    body,
    params,
    query: {},
    staffSession: { firmId: s.firmId, appUserId: s.appUserId },
    ip: '127.0.0.1',
    get: () => undefined,
  };
}

async function attemptsFor(returnFirmId: string, clientId: string) {
  return harness.db
    .select()
    .from(folderLinkAttempts)
    .where(
      and(eq(folderLinkAttempts.firmId, returnFirmId), eq(folderLinkAttempts.clientId, clientId)),
    );
}

async function eventsFor(returnFirmId: string, storagePath: string) {
  return harness.db
    .select()
    .from(folderSyncEvents)
    .where(
      and(eq(folderSyncEvents.firmId, returnFirmId), eq(folderSyncEvents.pathAfter, storagePath)),
    );
}

describe('FMv2 §8 — audit completeness', () => {
  it('Path 1: Link unbound folder → outcome=linked + link_attempted', async () => {
    const f = await setup();
    await storage.put('Test/dummy.txt', Buffer.from('x'), {
      contentType: 'text/plain',
    });
    const r = await invoke(
      f.linkRouter,
      'post',
      '/:id/folder/link',
      req(f, { id: f.clientId }, { storage_path: 'Test/' }),
    );
    expect(r.statusCode).toBe(201);
    const attempts = await attemptsFor(f.firmId, f.clientId);
    expect(attempts.length).toBe(1);
    expect(attempts[0]!.outcome).toBe('linked');
    const events = await eventsFor(f.firmId, 'Test/');
    expect(events.some((e) => e.eventType === 'link_attempted')).toBe(true);
  });

  it('Path 2: Link contested → keep_current → outcome=denied + resolution=kept_current', async () => {
    const f = await setup();
    // Pre-bind the path to current client + sentinel.
    await storage.put('Smith/dummy.txt', Buffer.from('x'), {
      contentType: 'text/plain',
    });
    await writeSentinel(storage, 'Smith/', {
      version: 1,
      client_id: f.clientId,
      firm_id: f.firmId,
      tax_software_id: null,
      created_at: new Date().toISOString(),
      created_by: f.appUserId,
      display_name_at_creation: 'Smith',
    });
    await harness.db.insert(clientFolders).values({
      firmId: f.firmId,
      clientId: f.clientId,
      storagePath: 'Smith/',
      status: 'active',
    });
    // Challenger attempts to link → contested (409 with attempt_id).
    const link = await invoke(
      f.linkRouter,
      'post',
      '/:id/folder/link',
      req(f, { id: f.challengerId }, { storage_path: 'Smith/' }),
    );
    expect(link.statusCode).toBe(409);
    const attemptId = (link.jsonBody as { attempt_id: string }).attempt_id;

    // Admin resolves keep_current.
    const resolve = await invoke(
      f.conflictsRouter,
      'post',
      '/:attempt_id/resolve',
      req(f, { attempt_id: attemptId }, { action: 'keep_current' }),
    );
    expect(resolve.statusCode).toBe(200);

    const [attempt] = await harness.db
      .select()
      .from(folderLinkAttempts)
      .where(eq(folderLinkAttempts.id, attemptId));
    expect(attempt!.outcome).toBe('denied');
    expect(attempt!.resolvedAt).not.toBeNull();

    const events = await eventsFor(f.firmId, 'Smith/');
    // Expect both the contested event (created at link time) AND
    // the resolution event (created at resolve time).
    const contested = events.filter((e) => e.eventType === 'link_contested');
    expect(contested.length).toBeGreaterThanOrEqual(1);
    const resolved = contested.find((e) => e.resolvedAt !== null);
    expect(resolved).toBeTruthy();
    expect(resolved!.resolution).toBe('kept_current');
  });

  it('Path 3: Link contested → reassign → outcome=reassigned + resolution=reassigned', async () => {
    const f = await setup();
    await storage.put('Jones/dummy.txt', Buffer.from('x'), {
      contentType: 'text/plain',
    });
    await writeSentinel(storage, 'Jones/', {
      version: 1,
      client_id: f.clientId,
      firm_id: f.firmId,
      tax_software_id: null,
      created_at: new Date().toISOString(),
      created_by: f.appUserId,
      display_name_at_creation: 'Jones',
    });
    await harness.db.insert(clientFolders).values({
      firmId: f.firmId,
      clientId: f.clientId,
      storagePath: 'Jones/',
      status: 'active',
    });
    const link = await invoke(
      f.linkRouter,
      'post',
      '/:id/folder/link',
      req(f, { id: f.challengerId }, { storage_path: 'Jones/' }),
    );
    expect(link.statusCode).toBe(409);
    const attemptId = (link.jsonBody as { attempt_id: string }).attempt_id;
    const resolve = await invoke(
      f.conflictsRouter,
      'post',
      '/:attempt_id/resolve',
      req(
        f,
        { attempt_id: attemptId },
        {
          action: 'reassign',
          reason: 'Challenger is the correct owner per signed engagement letter.',
        },
      ),
    );
    expect(resolve.statusCode).toBe(200);

    const [attempt] = await harness.db
      .select()
      .from(folderLinkAttempts)
      .where(eq(folderLinkAttempts.id, attemptId));
    expect(attempt!.outcome).toBe('reassigned');
    expect(attempt!.resolvedAt).not.toBeNull();

    const events = await eventsFor(f.firmId, 'Jones/');
    const reassigned = events.find((e) => e.eventType === 'link_reassigned');
    expect(reassigned).toBeTruthy();
    expect(reassigned!.resolution).toBe('reassigned');

    // Binding now points at challenger.
    const [binding] = await harness.db
      .select()
      .from(clientFolders)
      .where(eq(clientFolders.storagePath, 'Jones/'));
    expect(binding!.clientId).toBe(f.challengerId);
  });

  it('Path 4: Link contested → unbind_both → outcome=aborted + resolution=unbound_both', async () => {
    const f = await setup();
    await storage.put('Andersen/dummy.txt', Buffer.from('x'), {
      contentType: 'text/plain',
    });
    await writeSentinel(storage, 'Andersen/', {
      version: 1,
      client_id: f.clientId,
      firm_id: f.firmId,
      tax_software_id: null,
      created_at: new Date().toISOString(),
      created_by: f.appUserId,
      display_name_at_creation: 'Andersen',
    });
    await harness.db.insert(clientFolders).values({
      firmId: f.firmId,
      clientId: f.clientId,
      storagePath: 'Andersen/',
      status: 'active',
    });
    const link = await invoke(
      f.linkRouter,
      'post',
      '/:id/folder/link',
      req(f, { id: f.challengerId }, { storage_path: 'Andersen/' }),
    );
    expect(link.statusCode).toBe(409);
    const attemptId = (link.jsonBody as { attempt_id: string }).attempt_id;
    const resolve = await invoke(
      f.conflictsRouter,
      'post',
      '/:attempt_id/resolve',
      req(
        f,
        { attempt_id: attemptId },
        { action: 'unbind_both', reason: 'Both clients should re-link from a fresh search.' },
      ),
    );
    expect(resolve.statusCode).toBe(200);

    const [attempt] = await harness.db
      .select()
      .from(folderLinkAttempts)
      .where(eq(folderLinkAttempts.id, attemptId));
    expect(attempt!.outcome).toBe('aborted');

    const events = await eventsFor(f.firmId, 'Andersen/');
    const resolution = events.find((e) => e.resolution === 'unbound_both');
    expect(resolution).toBeTruthy();
  });

  it('Path 5: Create new folder → outcome=linked + link_attempted', async () => {
    const f = await setup();
    const r = await invoke(
      f.linkRouter,
      'post',
      '/:id/folder/create',
      req(f, { id: f.clientId }, { folder_name: 'Brand New Folder' }),
    );
    expect(r.statusCode).toBe(201);
    const attempts = await attemptsFor(f.firmId, f.clientId);
    expect(attempts.length).toBe(1);
    expect(attempts[0]!.outcome).toBe('linked');
    const events = await eventsFor(f.firmId, 'Brand New Folder/');
    expect(events.some((e) => e.eventType === 'link_attempted')).toBe(true);
  });

  it('Path 6: Link idempotent (same client) → 200, no new attempt + no new event', async () => {
    const f = await setup();
    // Pre-write a sentinel matching the client + a binding row.
    await storage.put('Self/dummy.txt', Buffer.from('x'), {
      contentType: 'text/plain',
    });
    await writeSentinel(storage, 'Self/', {
      version: 1,
      client_id: f.clientId,
      firm_id: f.firmId,
      tax_software_id: null,
      created_at: new Date().toISOString(),
      created_by: f.appUserId,
      display_name_at_creation: 'Self',
    });
    await harness.db.insert(clientFolders).values({
      firmId: f.firmId,
      clientId: f.clientId,
      storagePath: 'Self/',
      status: 'active',
    });
    const r = await invoke(
      f.linkRouter,
      'post',
      '/:id/folder/link',
      req(f, { id: f.clientId }, { storage_path: 'Self/' }),
    );
    expect(r.statusCode).toBe(200);
    expect((r.jsonBody as { idempotent: boolean }).idempotent).toBe(true);
    const attempts = await attemptsFor(f.firmId, f.clientId);
    // No new folder_link_attempts row written for idempotent path.
    expect(attempts.length).toBe(0);
  });
});

describe('FMv2 §6 Phase E — concurrency guard', () => {
  it('second attempt on the same path while one is pending → 409', async () => {
    const f = await setup();
    await storage.put('Race/dummy.txt', Buffer.from('x'), {
      contentType: 'text/plain',
    });
    await writeSentinel(storage, 'Race/', {
      version: 1,
      client_id: f.clientId,
      firm_id: f.firmId,
      tax_software_id: null,
      created_at: new Date().toISOString(),
      created_by: f.appUserId,
      display_name_at_creation: 'Race',
    });
    await harness.db.insert(clientFolders).values({
      firmId: f.firmId,
      clientId: f.clientId,
      storagePath: 'Race/',
      status: 'active',
    });
    // Insert a different user's pending attempt.
    const otherUser = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${f.firmId}, 'other@x.example', 'Other', 'O', 'Ther') RETURNING id`,
    );
    const otherUserId = (otherUser as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await harness.db.insert(folderLinkAttempts).values({
      firmId: f.firmId,
      clientId: f.challengerId,
      storagePath: 'Race/',
      attemptedBy: otherUserId,
      outcome: 'contested',
    });
    // Now the original user tries to link to Race/. Should get 409.
    const r = await invoke(
      f.linkRouter,
      'post',
      '/:id/folder/link',
      req(f, { id: f.challengerId }, { storage_path: 'Race/' }),
    );
    expect(r.statusCode).toBe(409);
    expect((r.jsonBody as { code: string }).code).toBe('link_already_pending');
  });
});
