// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0223 — AI file naming: suggest (router call shape, guards), apply
// (provenance + audit), revert, stored suggestion, and the bulk routes'
// router-only gate. The router is a stubbed global fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { eq } from 'drizzle-orm';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';

import { auditLog, clientFolders, files, firmSettings } from '@vibe/db/schema';
import { MockStorageClient } from '@vibe/storage';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { _resetAiRuntimeForTests } from '../ai/ai-runtime';
import { _clearRouterProviderCacheForTests } from '../ai/vibe-router';
import {
  applyAiRename,
  recordSuggestionOnly,
  revertAiRename,
  suggestFileName,
  type AiNamingDeps,
} from '../files/ai-naming';
import { mountAiNamingRoutes } from '../files/ai-naming-routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let storage: MockStorageClient;
let tmpDir: string;
let folderId: string;
const FOLDER_PATH = 'Client Files/Test Client/';

interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}
const captured: Captured[] = [];
let routerReply: () => Record<string, unknown> = () => ({
  doc_type: 'W-2',
  issuer: 'Acme Corp',
  year: '2024',
  period: null,
  date: null,
  confidence: 0.92,
  summary: 'A W-2 wage statement.',
});

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
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  tmpDir = mkdtempSync(join(tmpdir(), 'ai-naming-'));
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
  captured.length = 0;
  routerMode(true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      captured.push({ url: u, body, headers: (init?.headers as Record<string, string>) ?? {} });
      if (u.endsWith('/v1/chat/completions')) {
        return new Response(
          JSON.stringify({
            id: 'r1',
            model: 'router-local-vision',
            choices: [{ message: { role: 'assistant', content: JSON.stringify(routerReply()) } }],
            usage: { prompt_tokens: 120, completion_tokens: 40 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ registered: [] }), { status: 200 });
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  routerMode(false);
  await harness.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function seedFile(name: string, body: Buffer | string, mime = 'text/plain', source = 'app') {
  const storageKey = `${FOLDER_PATH}${name}`;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  await storage.put(storageKey, buf);
  const [row] = await harness.db
    .insert(files)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      clientFolderId: folderId,
      subfolderPath: '',
      originalFilename: name,
      storageKey,
      mimeType: mime,
      sizeBytes: buf.byteLength,
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
    fakeUserRoles: new Map([[seed.appUserId, ['admin' as const]]]),
    storageClient: storage,
  };
}

describe('suggestFileName', () => {
  it('sends context + schema to the router and composes the name from the firm pattern', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const fileId = await seedFile('IMG_4412.PNG', png, 'image/png');
    const r = await suggestFileName(deps(), {
      firmId: seed.firmId,
      fileId,
      actorId: seed.appUserId,
      mode: 'bulk',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposed).toMatch(/^2024 W-2 - Acme Corp - .+\.png$/);
    expect(r.confidence).toBe(0.92);
    expect(r.strategy).toBe('image');
    expect(r.model).toBe('router-local-vision');

    const call = captured.find((c) => c.url.endsWith('/v1/chat/completions'))!;
    expect(call.headers['x-vibe-task-class'] ?? call.headers['x-task-class']).toBe(
      'timebill_file_naming',
    );
    const msgs = call.body['messages'] as Array<{ role: string; content: unknown }>;
    const user = msgs.find((m) => m.role === 'user')!;
    expect(Array.isArray(user.content)).toBe(true);
    const parts = user.content as Array<{ type: string }>;
    expect(parts.some((p) => p.type === 'image_url')).toBe(true);
    expect(JSON.stringify(call.body)).toContain('json_schema');
    expect(call.headers['x-vibe-client']).toBe(seed.clientId);
  });

  it('is a no-op outside router mode', async () => {
    routerMode(false);
    const fileId = await seedFile('a.txt', 'hello');
    const r = await suggestFileName(deps(), { firmId: seed.firmId, fileId, mode: 'bulk' });
    expect(r).toMatchObject({ ok: false, skippedReason: 'not_router_mode' });
    expect(captured).toHaveLength(0);
  });

  it('skips generated files, pending uploads and already-renamed files (auto mode)', async () => {
    const gen = await seedFile('letter.pdf', '%PDF', 'application/pdf', 'generated');
    expect(
      await suggestFileName(deps(), { firmId: seed.firmId, fileId: gen, mode: 'bulk' }),
    ).toMatchObject({
      ok: false,
      skippedReason: 'generated_source',
    });
    const pending = await seedFile('p.txt', 'x');
    await harness.db.update(files).set({ pendingUpload: true }).where(eq(files.id, pending));
    expect(
      await suggestFileName(deps(), { firmId: seed.firmId, fileId: pending, mode: 'bulk' }),
    ).toMatchObject({
      ok: false,
      skippedReason: 'pending_upload',
    });
    const done = await seedFile('d.txt', 'x');
    await harness.db.update(files).set({ aiRenamedAt: new Date() }).where(eq(files.id, done));
    expect(
      await suggestFileName(deps(), { firmId: seed.firmId, fileId: done, mode: 'auto' }),
    ).toMatchObject({
      ok: false,
      skippedReason: 'already_ai_renamed',
    });
    // bulk mode may re-suggest an already renamed file
    expect(
      (await suggestFileName(deps(), { firmId: seed.firmId, fileId: done, mode: 'bulk' })).ok,
    ).toBe(true);
  });

  it('rejects model output that does not match the contract', async () => {
    routerReply = () => ({ nonsense: true });
    const fileId = await seedFile('a.txt', 'hello world '.repeat(30));
    const r = await suggestFileName(deps(), { firmId: seed.firmId, fileId, mode: 'bulk' });
    expect(r).toMatchObject({ ok: false, skippedReason: 'invalid_output' });
    routerReply = () => ({
      doc_type: 'W-2',
      issuer: null,
      year: '2024',
      period: null,
      date: null,
      confidence: 0.9,
      summary: '',
    });
  });
});

describe('apply / revert / suggestion', () => {
  it('applyAiRename renames, records the original once, audits; revert restores', async () => {
    const fileId = await seedFile('scan0023.txt', 'hello');
    const d = deps();
    const a = await applyAiRename(d, {
      firmId: seed.firmId,
      fileId,
      newFilename: '2024 W-2 - Acme Corp - Test Client.txt',
      actorId: seed.appUserId,
      confidence: 0.9,
      model: 'm',
    });
    expect(a.ok).toBe(true);
    let [row] = await harness.db.select().from(files).where(eq(files.id, fileId));
    expect(row!.originalFilename).toBe('2024 W-2 - Acme Corp - Test Client.txt');
    expect(row!.originalUploadFilename).toBe('scan0023.txt');
    expect(row!.aiRenamedAt).not.toBeNull();
    expect(row!.aiRenameConfidence).toBeCloseTo(0.9);
    expect(await storage.head(row!.storageKey)).not.toBeNull();
    expect(await storage.head(`${FOLDER_PATH}scan0023.txt`)).toBeNull();

    // A second AI rename keeps the very first original.
    await applyAiRename(d, {
      firmId: seed.firmId,
      fileId,
      newFilename: 'second.txt',
      actorId: seed.appUserId,
      confidence: 0.8,
    });
    [row] = await harness.db.select().from(files).where(eq(files.id, fileId));
    expect(row!.originalUploadFilename).toBe('scan0023.txt');

    const audits = await harness.db.select().from(auditLog).where(eq(auditLog.entityId, fileId));
    expect(audits.some((x) => (x.afterJson as { aiRename?: boolean })?.aiRename === true)).toBe(
      true,
    );

    const rev = await revertAiRename(d, { firmId: seed.firmId, fileId, actorId: seed.appUserId });
    expect(rev.ok).toBe(true);
    [row] = await harness.db.select().from(files).where(eq(files.id, fileId));
    expect(row!.originalFilename).toBe('scan0023.txt');
    expect(row!.aiRenamedAt).toBeNull();
    expect(row!.originalUploadFilename).toBe('scan0023.txt');

    const again = await revertAiRename(d, { firmId: seed.firmId, fileId, actorId: seed.appUserId });
    expect(again).toMatchObject({ ok: false, code: 'not_ai_renamed' });
  });

  it('recordSuggestionOnly stores a suggestion without renaming', async () => {
    const fileId = await seedFile('x.txt', 'hello');
    await recordSuggestionOnly(harness.db, fileId, {
      proposed: 'maybe.txt',
      confidence: 0.4,
      model: 'm',
    });
    const [row] = await harness.db.select().from(files).where(eq(files.id, fileId));
    expect(row!.originalFilename).toBe('x.txt');
    expect(row!.aiSuggestedFilename).toBe('maybe.txt');
    expect(row!.aiRenameAttemptedAt).not.toBeNull();
  });
});

describe('routes', () => {
  function app(): express.Express {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      req.staffSession = { firmId: seed.firmId, appUserId: seed.appUserId } as never;
      next();
    });
    const router = express.Router();
    mountAiNamingRoutes(router, deps());
    a.use('/c', router);
    return a;
  }

  it('404s outside router mode and validates payloads', async () => {
    const request = (await import('supertest')).default;
    routerMode(false);
    const r = await request(app())
      .post(`/c/${seed.clientId}/files/ai-rename/suggest`)
      .send({ fileIds: [] });
    expect(r.status).toBe(404);
    routerMode(true);
    const bad = await request(app())
      .post(`/c/${seed.clientId}/files/ai-rename/suggest`)
      .send({ fileIds: [] });
    expect(bad.status).toBe(400);
  });

  it('suggest → apply → revert round trip, scoped to the client', async () => {
    const request = (await import('supertest')).default;
    const fileId = await seedFile('scan.txt', 'Form W-2 Wage and Tax Statement '.repeat(20));
    const s = await request(app())
      .post(`/c/${seed.clientId}/files/ai-rename/suggest`)
      .send({ fileIds: [fileId] });
    expect(s.status).toBe(200);
    expect(s.body.items[0].proposed).toMatch(/\.txt$/);
    const other = await request(app())
      .post(`/c/00000000-0000-0000-0000-000000000000/files/ai-rename/suggest`)
      .send({ fileIds: [fileId] });
    expect(other.body.items[0].skippedReason).toBe('file_not_found');

    const ap = await request(app())
      .post(`/c/${seed.clientId}/files/ai-rename/apply`)
      .send({ items: [{ fileId, newFilename: s.body.items[0].proposed, confidence: 0.9 }] });
    expect(ap.status).toBe(200);
    expect(ap.body.renamed).toHaveLength(1);

    const rv = await request(app())
      .post(`/c/${seed.clientId}/files/${fileId}/ai-rename/revert`)
      .send();
    expect(rv.status).toBe(200);
    expect(rv.body.originalFilename).toBe('scan.txt');
  });

  it('honours the firm pattern from firm_settings', async () => {
    const request = (await import('supertest')).default;
    await harness.db
      .insert(firmSettings)
      .values({ firmId: seed.firmId, fileNamingPattern: '{client_id} {year} {doc_type}' })
      .onConflictDoUpdate({
        target: firmSettings.firmId,
        set: { fileNamingPattern: '{client_id} {year} {doc_type}' },
      });
    const fileId = await seedFile('a.txt', 'Form W-2 Wage and Tax Statement '.repeat(20));
    const s = await request(app())
      .post(`/c/${seed.clientId}/files/ai-rename/suggest`)
      .send({ fileIds: [fileId] });
    expect(s.body.items[0].proposed).toMatch(/^.*2024 W-2\.txt$/);
  });
});
