// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0223 — auto-rename gate + consumer outcomes (no BullMQ: the enqueue fn
// is injected and the job handler is driven directly).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';

import { clientFolders, files, firmSettings } from '@vibe/db/schema';
import { MockStorageClient } from '@vibe/storage';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { _resetAiRuntimeForTests } from '../ai/ai-runtime';
import { _clearRouterProviderCacheForTests } from '../ai/vibe-router';
import {
  _resetAutoRenameGateForTests,
  maybeEnqueueAutoRename,
  processAutoRenameJob,
} from '../files/auto-rename-queue';
import type { AiNamingDeps } from '../files/ai-naming';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let storage: MockStorageClient;
let tmpDir: string;
let folderId: string;
const FOLDER_PATH = 'Client Files/Test Client/';
let confidence = 0.9;

function routerMode(on: boolean): void {
  if (on) {
    process.env['VIBE_AI_MODE'] = 'router';
    process.env['VIBE_AI_ROUTER_URL'] = 'https://router.test';
    process.env['VIBE_AI_TOKEN'] = 'tok';
  } else {
    delete process.env['VIBE_AI_MODE'];
    delete process.env['VIBE_AI_ROUTER_URL'];
    delete process.env['VIBE_AI_TOKEN'];
  }
  _resetAiRuntimeForTests();
  _clearRouterProviderCacheForTests();
  _resetAutoRenameGateForTests();
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  tmpDir = mkdtempSync(join(tmpdir(), 'auto-rename-'));
  storage = new MockStorageClient({ rootPath: tmpDir });
  const [row] = await harness.db
    .insert(clientFolders)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      storagePath: FOLDER_PATH,
      status: 'active',
    })
    .returning({ id: clientFolders.id });
  folderId = row!.id;
  await harness.db
    .insert(firmSettings)
    .values({ firmId: seed.firmId, autoRenameUploads: true })
    .onConflictDoUpdate({ target: firmSettings.firmId, set: { autoRenameUploads: true } });
  routerMode(true);
  confidence = 0.9;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/v1/chat/completions')) {
        return new Response(
          JSON.stringify({
            model: 'm',
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    doc_type: 'W-2',
                    issuer: 'Acme',
                    year: '2024',
                    period: null,
                    date: null,
                    confidence,
                    summary: '',
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  routerMode(false);
  await harness.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function seedFile(name: string, source = 'app'): Promise<string> {
  const storageKey = `${FOLDER_PATH}${name}`;
  await storage.put(storageKey, Buffer.from('Form W-2 Wage and Tax Statement '.repeat(20)));
  const [row] = await harness.db
    .insert(files)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      clientFolderId: folderId,
      subfolderPath: '',
      originalFilename: name,
      storageKey,
      mimeType: 'text/plain',
      sizeBytes: 10,
      source,
      visibility: 'private',
      pendingUpload: false,
    })
    .returning({ id: files.id });
  return row!.id;
}

function deps(): AiNamingDeps {
  return {
    db: harness.db,
    redis: new RedisMock() as unknown as Redis,
    fakeUserRoles: new Map(),
    storageClient: storage,
  };
}

describe('maybeEnqueueAutoRename gate', () => {
  it('enqueues only in router mode, for renameable sources, with the firm toggle on', async () => {
    const enqueue = vi.fn(async () => true);
    const job = { firmId: seed.firmId, fileId: 'f', actorAppUserId: null };
    expect(await maybeEnqueueAutoRename(harness.db, { ...job, source: 'app' }, enqueue)).toBe(true);
    expect(await maybeEnqueueAutoRename(harness.db, { ...job, source: 'generated' }, enqueue)).toBe(
      false,
    );
    routerMode(false);
    expect(await maybeEnqueueAutoRename(harness.db, { ...job, source: 'app' }, enqueue)).toBe(
      false,
    );
    routerMode(true);
    await harness.db
      .update(firmSettings)
      .set({ autoRenameUploads: false })
      .where(eq(firmSettings.firmId, seed.firmId));
    expect(await maybeEnqueueAutoRename(harness.db, { ...job, source: 'app' }, enqueue)).toBe(
      false,
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('never throws when the enqueue fails', async () => {
    const enqueue = vi.fn(async () => {
      throw new Error('redis down');
    });
    await expect(
      maybeEnqueueAutoRename(
        harness.db,
        { firmId: seed.firmId, fileId: 'f', actorAppUserId: null, source: 'app' },
        enqueue,
      ),
    ).resolves.toBe(false);
  });
});

describe('processAutoRenameJob', () => {
  it('renames when confidence clears the threshold and is idempotent afterwards', async () => {
    const fileId = await seedFile('scan.txt');
    const job = { firmId: seed.firmId, fileId, actorAppUserId: null };
    expect(await processAutoRenameJob(deps(), job)).toBe('renamed');
    const [row] = await harness.db.select().from(files).where(eq(files.id, fileId));
    expect(row!.originalFilename).toBe('2024 W-2 - Acme - Test Client Co.txt');
    expect(row!.originalUploadFilename).toBe('scan.txt');
    expect(await processAutoRenameJob(deps(), job)).toBe('skipped');
  });

  it('stores a suggestion instead of renaming on low confidence', async () => {
    confidence = 0.3;
    const fileId = await seedFile('scan2.txt');
    expect(
      await processAutoRenameJob(deps(), { firmId: seed.firmId, fileId, actorAppUserId: null }),
    ).toBe('suggested');
    const [row] = await harness.db.select().from(files).where(eq(files.id, fileId));
    expect(row!.originalFilename).toBe('scan2.txt');
    expect(row!.aiSuggestedFilename).toBe('2024 W-2 - Acme - Test Client Co.txt');
    expect(row!.aiRenameAttemptedAt).not.toBeNull();
    expect(row!.aiRenamedAt).toBeNull();
  });

  it('throws (so BullMQ retries) on a transient AI failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 503 })),
    );
    const fileId = await seedFile('scan3.txt');
    await expect(
      processAutoRenameJob(deps(), { firmId: seed.firmId, fileId, actorAppUserId: null }),
    ).rejects.toThrow(/transient/);
  });
});
