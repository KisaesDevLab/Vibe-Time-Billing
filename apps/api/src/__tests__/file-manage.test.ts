// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0219 — Files tab v3: subfolder registry, file move/rename, zip export,
// tax-return delete guard, and document requests (staff + portal upload).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express, { type Router } from 'express';
import AdmZip from 'adm-zip';
import { eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { clientFolders, clientSubfolders, files } from '@vibe/db/schema';
import type { Database } from '@vibe/db';
import { MockStorageClient } from '@vibe/storage';

import { mountFileManageRoutes } from '../clients/file-manage';
import { createFileVisibilityRouter } from '../files/visibility';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let storage: MockStorageClient;
let tmpDir: string;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  tmpDir = mkdtempSync(join(tmpdir(), 'file-manage-'));
  storage = new MockStorageClient({ rootPath: tmpDir });
});

afterEach(async () => {
  await harness.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const FOLDER_PATH = 'Client Files/Test Client/';

async function bindFolder(): Promise<string> {
  const [row] = await harness.db
    .insert(clientFolders)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      storagePath: FOLDER_PATH,
      status: 'active',
    })
    .returning({ id: clientFolders.id });
  return row!.id;
}

async function seedFile(
  clientFolderId: string,
  subfolderPath: string,
  name: string,
  body = 'hello',
): Promise<string> {
  const storageKey = `${FOLDER_PATH}${subfolderPath}${name}`;
  await storage.put(storageKey, Buffer.from(body));
  const [row] = await harness.db
    .insert(files)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      clientFolderId,
      subfolderPath,
      originalFilename: name,
      storageKey,
      sizeBytes: Buffer.byteLength(body),
      source: 'app',
      visibility: 'private',
      pendingUpload: false,
    })
    .returning({ id: files.id });
  return row!.id;
}

/** Invoke the LAST handler of a registered route with a stub req/res. */
async function invokeRoute(
  router: Router,
  method: 'get' | 'post' | 'delete' | 'patch',
  path: string,
  req: Record<string, unknown>,
): Promise<{ statusCode: number; body: unknown }> {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(n: number) {
      this.statusCode = n;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    send(b: unknown) {
      this.body = b;
      return this;
    },
  };
  const stack = (
    router as unknown as {
      stack: {
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: { handle: (...a: unknown[]) => unknown }[];
        };
      }[];
    }
  ).stack;
  const layer = stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`route not registered: ${method} ${path}`);
  const handler = layer.route.stack[layer.route.stack.length - 1]!.handle;
  await (handler as (rq: unknown, rs: unknown) => Promise<void>)(req, res);
  return res;
}

function staffReq(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    body: {},
    params: {},
    query: {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
    ...over,
  };
}

function buildManageRouter(): Router {
  const router = express.Router();
  mountFileManageRoutes(router, {
    db: harness.db as Database,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    storageClient: storage,
  });
  return router;
}

describe('0219 — subfolder registry', () => {
  it('create registers a normalized path; list-merge is covered via the table', async () => {
    const folderId = await bindFolder();
    const router = buildManageRouter();
    const res = await invokeRoute(
      router,
      'post',
      '/:id/subfolders',
      staffReq({ params: { id: seed.clientId }, body: { path: ' Income Tax/2026 ' } }),
    );
    expect(res.statusCode).toBe(201);
    const rows = await harness.db
      .select()
      .from(clientSubfolders)
      .where(eq(clientSubfolders.clientFolderId, folderId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe('Income Tax/2026/');
    // Idempotent.
    await invokeRoute(
      router,
      'post',
      '/:id/subfolders',
      staffReq({ params: { id: seed.clientId }, body: { path: 'Income Tax/2026/' } }),
    );
    const again = await harness.db
      .select()
      .from(clientSubfolders)
      .where(eq(clientSubfolders.clientFolderId, folderId));
    expect(again).toHaveLength(1);
  });

  it('delete refuses while files live under the path, then succeeds', async () => {
    const folderId = await bindFolder();
    await seedFile(folderId, 'Old/', 'doc.pdf');
    const router = buildManageRouter();
    await invokeRoute(
      router,
      'post',
      '/:id/subfolders',
      staffReq({ params: { id: seed.clientId }, body: { path: 'Old' } }),
    );
    const blocked = await invokeRoute(
      router,
      'delete',
      '/:id/subfolders',
      staffReq({ params: { id: seed.clientId }, body: { path: 'Old' } }),
    );
    expect(blocked.statusCode).toBe(409);
    await harness.db.update(files).set({ deletedAt: new Date() });
    const ok = await invokeRoute(
      router,
      'delete',
      '/:id/subfolders',
      staffReq({ params: { id: seed.clientId }, body: { path: 'Old' } }),
    );
    expect(ok.statusCode).toBe(200);
  });
});

describe('0219 — move + rename', () => {
  it('move copies the object, deletes the original, updates the row', async () => {
    const folderId = await bindFolder();
    const fileId = await seedFile(folderId, 'Inbox/', 'w2.pdf', 'W2BYTES');
    const router = buildManageRouter();
    const res = await invokeRoute(
      router,
      'post',
      '/:id/files/move',
      staffReq({
        params: { id: seed.clientId },
        body: { fileIds: [fileId], toSubfolderPath: 'Income Tax/2026/' },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { moved: number }).moved).toBe(1);
    const [row] = await harness.db.select().from(files).where(eq(files.id, fileId));
    expect(row!.subfolderPath).toBe('Income Tax/2026/');
    expect(row!.storageKey).toBe(`${FOLDER_PATH}Income Tax/2026/w2.pdf`);
    expect(await storage.head(`${FOLDER_PATH}Inbox/w2.pdf`)).toBeNull();
    expect(await storage.head(row!.storageKey)).not.toBeNull();
    // Destination auto-registered so the folder persists if emptied later.
    const reg = await harness.db
      .select()
      .from(clientSubfolders)
      .where(eq(clientSubfolders.clientFolderId, folderId));
    expect(reg.map((r) => r.path)).toContain('Income Tax/2026/');
  });

  it('move auto-suffixes a name collision in the destination', async () => {
    const folderId = await bindFolder();
    const a = await seedFile(folderId, 'A/', 'same.pdf', 'aaa');
    await seedFile(folderId, 'B/', 'same.pdf', 'bbb');
    const router = buildManageRouter();
    const res = await invokeRoute(
      router,
      'post',
      '/:id/files/move',
      staffReq({
        params: { id: seed.clientId },
        body: { fileIds: [a], toSubfolderPath: 'B/' },
      }),
    );
    expect(res.statusCode).toBe(200);
    const [row] = await harness.db.select().from(files).where(eq(files.id, a));
    expect(row!.subfolderPath).toBe('B/');
    expect(row!.storageKey).not.toBe(`${FOLDER_PATH}B/same.pdf`);
    expect(row!.storageKey.startsWith(`${FOLDER_PATH}B/same`)).toBe(true);
  });

  it('rename moves the storage key within the same folder', async () => {
    const folderId = await bindFolder();
    const fileId = await seedFile(folderId, 'Inbox/', 'scan001.pdf', 'xyz');
    const router = buildManageRouter();
    const res = await invokeRoute(
      router,
      'post',
      '/:id/files/:fileId/rename',
      staffReq({
        params: { id: seed.clientId, fileId },
        body: { newFilename: '2026 W-2 Smith.pdf' },
      }),
    );
    expect(res.statusCode).toBe(200);
    const [row] = await harness.db.select().from(files).where(eq(files.id, fileId));
    expect(row!.originalFilename).toBe('2026 W-2 Smith.pdf');
    expect(row!.storageKey).toBe(`${FOLDER_PATH}Inbox/2026 W-2 Smith.pdf`);
    expect(await storage.head(`${FOLDER_PATH}Inbox/scan001.pdf`)).toBeNull();
  });
});

describe('0219 — zip export', () => {
  it('zips a subfolder recursively with relative entry paths', async () => {
    const folderId = await bindFolder();
    await seedFile(folderId, 'Income Tax/', 'w2.pdf', 'W2');
    await seedFile(folderId, 'Income Tax/2026/', '1099.pdf', 'NEC');
    await seedFile(folderId, 'Other/', 'skip.pdf', 'NOPE');
    const router = buildManageRouter();
    const res = await invokeRoute(
      router,
      'get',
      '/:id/files/zip',
      staffReq({ params: { id: seed.clientId }, query: { path: 'Income Tax/' } }),
    );
    expect(res.statusCode).toBe(200);
    const zip = new AdmZip(res.body as Buffer);
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names.sort()).toEqual(['2026/1099.pdf', 'w2.pdf']);
    expect(names).not.toContain('skip.pdf');
  });
});

describe('0219 — tax-return delete guard', () => {
  it('DELETE refuses when a tax return references the file', async () => {
    const folderId = await bindFolder();
    const fileId = await seedFile(folderId, '', 'return.pdf');
    await harness.db.execute(
      // Minimal tax return referencing the file as its source.
      // (drizzle sql template avoided — raw insert via harness helper.)
      (await import('drizzle-orm')).sql`
        INSERT INTO tax_returns (firm_id, client_id, source_file_id, tax_year, form_code, title)
        VALUES (${seed.firmId}, ${seed.clientId}, ${fileId}, 2025, '1040', 'test return')`,
    );
    const router = createFileVisibilityRouter({
      db: harness.db as Database,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
      storageClient: storage,
    });
    const res = await invokeRoute(router, 'delete', '/:id', staffReq({ params: { id: fileId } }));
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toBe('file_backs_tax_return');
  });
});
