// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0230 — intake-arrival AI labeling: the API-side consumer that labels
// clean intake files (doc type / year / issuer / suggested name) before
// disposition. Driven directly (no BullMQ), router faked via fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';

import { firmSettings, intakeFiles, intakeSessions } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import { _resetAiRuntimeForTests } from '../ai/ai-runtime';
import { _clearRouterProviderCacheForTests } from '../ai/vibe-router';
import { newIntakeRecordKey, encField } from '../intake/crypto';
import { processIntakeAiLabelJob } from '../intake/ai-label-queue';
import type { AiNamingDeps } from '../files/ai-naming';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let sealDir: string;
let storage: StorageClient & { objects: Map<string, Buffer> };
let confidence = 0.9;

function memStorage(): StorageClient & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    kind: 'mock',
    objects,
    async put(key: string, body: Buffer | Readable) {
      objects.set(key, Buffer.isBuffer(body) ? body : Buffer.alloc(0));
      return { etag: 'e' };
    },
    async get(key: string) {
      const buf = objects.get(key);
      if (!buf) throw new Error('not_found');
      return { body: Readable.from(buf), meta: { key, size: buf.byteLength } };
    },
    async head(key: string) {
      const buf = objects.get(key);
      return buf ? { key, size: buf.byteLength } : null;
    },
    list: () => {
      throw new Error('ni');
    },
    delete: async () => undefined,
    copy: async () => ({ etag: 'x' }),
    presignGet: async () => 'mock://g',
    presignPut: async () => 'mock://p',
  } as unknown as StorageClient & { objects: Map<string, Buffer> };
}

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

function fakeRouter(content: () => string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/v1/chat/completions')) {
        return new Response(
          JSON.stringify({
            model: 'm-test',
            choices: [{ message: { content: content() } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    }),
  );
}

beforeEach(async () => {
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-intake-ai-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  storage = memStorage();
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  const mgr = getFirmKeyManager(harness.db);
  await mgr.bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
  setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
  await harness.db
    .insert(firmSettings)
    .values({ firmId: seed.firmId, autoRenameUploads: true })
    .onConflictDoUpdate({ target: firmSettings.firmId, set: { autoRenameUploads: true } });
  routerMode(true);
  confidence = 0.9;
  fakeRouter(() =>
    JSON.stringify({
      doc_type: 'W-2',
      issuer: 'Acme',
      year: '2024',
      period: null,
      date: null,
      confidence,
      summary: '',
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  routerMode(false);
  resetFirmKeyManagerForTests();
  await harness.close();
  await rm(sealDir, { recursive: true, force: true });
});

async function makeReceivedSession(opts: { files?: number; status?: string } = {}): Promise<{
  sessionId: string;
  fileIds: string[];
}> {
  const { dek, wrappedDek } = newIntakeRecordKey(harness.db, seed.firmId);
  const [s] = await harness.db
    .insert(intakeSessions)
    .values({
      firmId: seed.firmId,
      targetStaffId: seed.appUserId,
      wrappedDek: Buffer.from(wrappedDek),
      clientNameEnc: encField(dek, 'Jane Client'),
      status: opts.status ?? 'received',
    })
    .returning({ id: intakeSessions.id });
  const sessionId = s!.id;
  const fileIds: string[] = [];
  for (let i = 0; i < (opts.files ?? 1); i++) {
    const key = `intake/quarantine/${sessionId}/f${i}`;
    const [f] = await harness.db
      .insert(intakeFiles)
      .values({
        sessionId,
        objectKey: key,
        originalFilenameEnc: encField(dek, `scan-${i}.pdf`),
        mimeType: 'text/plain',
        byteSize: 9,
        kind: 'upload',
        scanStatus: 'clean',
      })
      .returning({ id: intakeFiles.id });
    fileIds.push(f!.id);
    storage.objects.set(key, Buffer.from('Form W-2 Wage and Tax Statement '.repeat(20)));
  }
  return { sessionId, fileIds };
}

function deps(): AiNamingDeps {
  return {
    db: harness.db,
    redis: new RedisMock() as unknown as Redis,
    fakeUserRoles: new Map(),
    storageClient: storage,
  };
}

describe('processIntakeAiLabelJob', () => {
  it('labels clean files with fields + a client-less suggested name', async () => {
    const { sessionId, fileIds } = await makeReceivedSession();
    const outcome = await processIntakeAiLabelJob(deps(), { sessionId, firmId: seed.firmId });
    expect(outcome).toBe('labeled');
    const [row] = await harness.db
      .select()
      .from(intakeFiles)
      .where(eq(intakeFiles.id, fileIds[0]!));
    expect(row!.aiLabelStatus).toBe('labeled');
    expect(row!.aiDocType).toBe('W-2');
    expect(row!.aiTaxYear).toBe(2024);
    expect(row!.aiIssuer).toBe('Acme');
    // Default pattern '{year} {doc_type} - {issuer} - {client}' with the
    // client slot empty collapses its separator; extension preserved.
    expect(row!.aiSuggestedName).toBe('2024 W-2 - Acme.pdf');
    expect(row!.aiConfidence).toBeCloseTo(0.9);
    expect(row!.aiLabelModel).toBe('m-test');
  });

  it('re-run touches nothing (only pending rows are labeled)', async () => {
    const { sessionId, fileIds } = await makeReceivedSession();
    await processIntakeAiLabelJob(deps(), { sessionId, firmId: seed.firmId });
    await harness.db
      .update(intakeFiles)
      .set({ aiIssuer: 'HandEdited' })
      .where(eq(intakeFiles.id, fileIds[0]!));
    const outcome = await processIntakeAiLabelJob(deps(), { sessionId, firmId: seed.firmId });
    expect(outcome).toBe('skipped');
    const [row] = await harness.db
      .select()
      .from(intakeFiles)
      .where(eq(intakeFiles.id, fileIds[0]!));
    expect(row!.aiIssuer).toBe('HandEdited');
  });

  it('marks rows skipped when the firm toggle is off', async () => {
    await harness.db
      .update(firmSettings)
      .set({ autoRenameUploads: false })
      .where(eq(firmSettings.firmId, seed.firmId));
    const { sessionId, fileIds } = await makeReceivedSession();
    expect(await processIntakeAiLabelJob(deps(), { sessionId, firmId: seed.firmId })).toBe(
      'skipped',
    );
    const [row] = await harness.db
      .select()
      .from(intakeFiles)
      .where(eq(intakeFiles.id, fileIds[0]!));
    expect(row!.aiLabelStatus).toBe('skipped');
  });

  it('marks rows skipped outside router mode', async () => {
    routerMode(false);
    const { sessionId, fileIds } = await makeReceivedSession();
    expect(await processIntakeAiLabelJob(deps(), { sessionId, firmId: seed.firmId })).toBe(
      'skipped',
    );
    const [row] = await harness.db
      .select()
      .from(intakeFiles)
      .where(eq(intakeFiles.id, fileIds[0]!));
    expect(row!.aiLabelStatus).toBe('skipped');
  });

  it('marks rows skipped when the session is no longer received', async () => {
    const { sessionId, fileIds } = await makeReceivedSession({ status: 'disposed' });
    expect(await processIntakeAiLabelJob(deps(), { sessionId, firmId: seed.firmId })).toBe(
      'skipped',
    );
    const [row] = await harness.db
      .select()
      .from(intakeFiles)
      .where(eq(intakeFiles.id, fileIds[0]!));
    expect(row!.aiLabelStatus).toBe('skipped');
  });

  it('marks a row failed on invalid model output and continues', async () => {
    // First call: JSON that parses but violates the zod contract (year is
    // not 4 digits). Non-JSON is already swallowed by the SDK layer and
    // surfaces as a transient failure instead.
    let call = 0;
    fakeRouter(() =>
      JSON.stringify({
        doc_type: 'W-2',
        issuer: 'Acme',
        year: call++ === 0 ? 'twenty' : '2024',
        period: null,
        date: null,
        confidence: 0.9,
        summary: '',
      }),
    );
    const { sessionId, fileIds } = await makeReceivedSession({ files: 2 });
    const outcome = await processIntakeAiLabelJob(deps(), { sessionId, firmId: seed.firmId });
    expect(outcome).toBe('partial');
    const rows = await harness.db
      .select()
      .from(intakeFiles)
      .where(eq(intakeFiles.sessionId, sessionId));
    const statuses = rows.map((r) => r.aiLabelStatus).sort();
    expect(statuses).toEqual(['failed', 'labeled']);
    expect(fileIds).toHaveLength(2);
  });

  it('throws for retry on transient AI failure, marks failed on the final attempt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 503 })),
    );
    const { sessionId, fileIds } = await makeReceivedSession();
    await expect(
      processIntakeAiLabelJob(
        deps(),
        { sessionId, firmId: seed.firmId },
        { attemptsMade: 0, maxAttempts: 3 },
      ),
    ).rejects.toThrow(/transient/);
    const outcome = await processIntakeAiLabelJob(
      deps(),
      { sessionId, firmId: seed.firmId },
      { attemptsMade: 2, maxAttempts: 3 },
    );
    expect(outcome).toBe('failed'); // total failure is not a no-op 'skipped'
    const [row] = await harness.db
      .select()
      .from(intakeFiles)
      .where(eq(intakeFiles.id, fileIds[0]!));
    expect(row!.aiLabelStatus).toBe('failed');
  });

  it("router's no_vision_provider code is a one-shot skip, not a retry burn", async () => {
    // The router SDK throws VibeAiError with the body's error.code; the
    // provider rethrow must preserve .code for onError to see it.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message: 'no vision-capable model is configured',
                type: 'router_error',
                code: 'no_vision_provider',
              },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const { sessionId, fileIds } = await makeReceivedSession();
    const outcome = await processIntakeAiLabelJob(
      deps(),
      { sessionId, firmId: seed.firmId },
      { attemptsMade: 0, maxAttempts: 3 }, // NOT the final attempt — must still skip
    );
    expect(outcome).toBe('skipped');
    const [row] = await harness.db
      .select()
      .from(intakeFiles)
      .where(eq(intakeFiles.id, fileIds[0]!));
    expect(row!.aiLabelStatus).toBe('skipped');
  });

  it('an all-null label is failed, never stored as an empty suggestion', async () => {
    fakeRouter(() =>
      JSON.stringify({
        doc_type: null,
        issuer: null,
        year: null,
        period: null,
        date: null,
        confidence: 0.95,
        summary: '',
      }),
    );
    const { sessionId, fileIds } = await makeReceivedSession();
    const outcome = await processIntakeAiLabelJob(deps(), { sessionId, firmId: seed.firmId });
    expect(outcome).toBe('failed');
    const [row] = await harness.db
      .select()
      .from(intakeFiles)
      .where(eq(intakeFiles.id, fileIds[0]!));
    expect(row!.aiLabelStatus).toBe('failed');
    expect(row!.aiSuggestedName).toBeNull();
  });

  it('page images embedded in an assembled scan are skipped — only the PDF is labeled', async () => {
    const { dek, wrappedDek } = newIntakeRecordKey(harness.db, seed.firmId);
    const [s] = await harness.db
      .insert(intakeSessions)
      .values({
        firmId: seed.firmId,
        targetStaffId: seed.appUserId,
        wrappedDek: Buffer.from(wrappedDek),
        status: 'received',
      })
      .returning({ id: intakeSessions.id });
    const sessionId = s!.id;
    const mk = async (kind: string, mime: string, name: string): Promise<string> => {
      const key = `intake/quarantine/${sessionId}/${name}`;
      const [f] = await harness.db
        .insert(intakeFiles)
        .values({
          sessionId,
          objectKey: key,
          originalFilenameEnc: encField(dek, name),
          mimeType: mime,
          byteSize: 9,
          kind,
          scanStatus: 'clean',
        })
        .returning({ id: intakeFiles.id });
      storage.objects.set(key, Buffer.from('Form W-2 Wage and Tax Statement '.repeat(20)));
      return f!.id;
    };
    const img1 = await mk('upload', 'image/jpeg', 'page1.jpg');
    const img2 = await mk('upload', 'image/png', 'page2.png');
    const pdfUpload = await mk('upload', 'application/pdf', 'w9.pdf');
    const scan = await mk('scan', 'application/pdf', 'assembled.pdf');

    const outcome = await processIntakeAiLabelJob(deps(), { sessionId, firmId: seed.firmId });
    expect(outcome).toBe('labeled');
    const byId = new Map(
      (await harness.db.select().from(intakeFiles).where(eq(intakeFiles.sessionId, sessionId))).map(
        (r) => [r.id, r],
      ),
    );
    expect(byId.get(img1)!.aiLabelStatus).toBe('skipped');
    expect(byId.get(img2)!.aiLabelStatus).toBe('skipped');
    expect(byId.get(pdfUpload)!.aiLabelStatus).toBe('labeled');
    expect(byId.get(scan)!.aiLabelStatus).toBe('labeled');
  });
});
