// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DELETE /api/staff/files/:id — removes the storage object and
// soft-deletes the row. Verifies the storage-first ordering (a failed
// storage delete leaves the row visible), idempotency on repeat
// deletes, and firm scoping.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type express from 'express';
import type { StorageClient } from '@vibe/storage';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { files } from '@vibe/db/schema';
import { createFileVisibilityRouter } from '../files/visibility';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

function stubStorage(overrides: Partial<StorageClient> = {}): StorageClient & {
  deletedKeys: string[];
} {
  const deletedKeys: string[] = [];
  const stub = {
    kind: 'mock' as const,
    deletedKeys,
    // eslint-disable-next-line require-yield
    async *list(): AsyncGenerator<never> {
      throw new Error('unused');
    },
    async head() {
      return null;
    },
    async get(): Promise<never> {
      throw new Error('unused');
    },
    async put(): Promise<never> {
      throw new Error('unused');
    },
    async delete(key: string) {
      deletedKeys.push(key);
    },
    async copy(): Promise<never> {
      throw new Error('unused');
    },
    async presignGet(): Promise<never> {
      throw new Error('unused');
    },
    async presignPut(): Promise<never> {
      throw new Error('unused');
    },
  };
  return Object.assign(stub, overrides) as StorageClient & { deletedKeys: string[] };
}

async function seedFile(): Promise<{ firmId: string; appUserId: string; fileId: string }> {
  const seed = await seedMinimalFirm(harness.db);
  const folder = await harness.db.execute(
    sql`INSERT INTO client_folders (firm_id, client_id, storage_path)
        VALUES (${seed.firmId}, ${seed.clientId}, 'Client Files/TestClient/') RETURNING id`,
  );
  const folderId = (folder as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const [f] = await harness.db
    .insert(files)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      clientFolderId: folderId,
      originalFilename: 'w2.pdf',
      storageKey: 'Client Files/TestClient/Tax/w2.pdf',
      sizeBytes: 512,
      visibility: 'private',
    })
    .returning({ id: files.id });
  return { firmId: seed.firmId, appUserId: seed.appUserId, fileId: f!.id };
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

async function invokeDelete(
  router: express.Router,
  args: { firmId: string; appUserId: string; fileId: string },
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === '/:id' && r.methods['delete'] === true;
  });
  if (!layer) throw new Error('route not registered: delete /:id');
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const req = {
    body: {},
    params: { id: args.fileId },
    query: {},
    staffSession: { firmId: args.firmId, appUserId: args.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
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

describe('DELETE /files/:id', () => {
  it('deletes the storage object and soft-deletes the row', async () => {
    const f = await seedFile();
    const storage = stubStorage();
    const router = createFileVisibilityRouter({
      db: harness.db,
      storageClient: storage,
      fakeUserRoles: new Map([[f.appUserId, ['partner']]]),
    });
    const r = await invokeDelete(router, f);
    expect(r.statusCode).toBe(200);
    expect((r.jsonBody as { ok: boolean }).ok).toBe(true);
    expect(storage.deletedKeys).toEqual(['Client Files/TestClient/Tax/w2.pdf']);
    const [row] = await harness.db.select().from(files).where(eq(files.id, f.fileId));
    expect(row!.deletedAt).not.toBeNull();
  });

  it('is idempotent — second delete reports alreadyDeleted', async () => {
    const f = await seedFile();
    const storage = stubStorage();
    const router = createFileVisibilityRouter({
      db: harness.db,
      storageClient: storage,
      fakeUserRoles: new Map([[f.appUserId, ['partner']]]),
    });
    await invokeDelete(router, f);
    const r2 = await invokeDelete(router, f);
    expect(r2.statusCode).toBe(200);
    expect((r2.jsonBody as { alreadyDeleted?: boolean }).alreadyDeleted).toBe(true);
    // Storage delete ran only once.
    expect(storage.deletedKeys.length).toBe(1);
  });

  it('keeps the row visible when the storage delete fails', async () => {
    const f = await seedFile();
    const storage = stubStorage({
      async delete() {
        throw new Error('b2 down');
      },
    });
    const router = createFileVisibilityRouter({
      db: harness.db,
      storageClient: storage,
      fakeUserRoles: new Map([[f.appUserId, ['partner']]]),
    });
    const r = await invokeDelete(router, f);
    expect(r.statusCode).toBe(502);
    const [row] = await harness.db.select().from(files).where(eq(files.id, f.fileId));
    expect(row!.deletedAt).toBeNull();
  });

  it('404s for a file outside the session firm', async () => {
    const f = await seedFile();
    const router = createFileVisibilityRouter({
      db: harness.db,
      storageClient: stubStorage(),
      fakeUserRoles: new Map([[f.appUserId, ['partner']]]),
    });
    const r = await invokeDelete(router, {
      firmId: crypto.randomUUID(),
      appUserId: f.appUserId,
      fileId: f.fileId,
    });
    expect(r.statusCode).toBe(404);
  });
});
