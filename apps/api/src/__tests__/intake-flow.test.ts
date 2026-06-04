// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Phase C — anonymous intake flow. Exercises the full public surface over
// supertest against a pglite DB + in-memory storage: staff listing, the
// enabled-gate, session create (PII encrypted at rest), raw-body upload to
// the quarantine prefix, type/size rejection, and complete (enqueue).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { Readable } from 'node:stream';
import { eq, sql } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { firmConfig, intakeFiles, intakeSessions, intakeStaffCards } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import { createIntakePublicRouter } from '../intake/public-routes';
import { resetApplianceFirmIdForTests } from '../intake/firm';
import { unwrapIntakeRecordKey, decField } from '../intake/crypto';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let redis: Redis;
let sealDir: string;
let storage: StorageClient & { objects: Map<string, Buffer> };
let enqueued: Array<{ sessionId: string; firmId: string }>;

// Minimal in-memory StorageClient — only the methods the router touches.
function memStorage(): StorageClient & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    kind: 'mock',
    objects,
    // eslint-disable-next-line @typescript-eslint/require-await
    async put(key: string, body: Buffer | Readable) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
      objects.set(key, buf);
      return { etag: `etag-${buf.byteLength}` };
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async get(key: string) {
      const buf = objects.get(key);
      if (!buf) throw new Error('not_found');
      return {
        body: Readable.from(buf),
        meta: { key, size: buf.byteLength, contentType: 'image/jpeg' },
      };
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async head(key: string) {
      const buf = objects.get(key);
      return buf ? { key, size: buf.byteLength } : null;
    },
    // unused by the router under test
    list: () => {
      throw new Error('not implemented');
    },
    delete: async () => undefined,
    copy: async () => ({ etag: 'x' }),
    presignGet: async () => 'mock://get',
    presignPut: async () => 'mock://put',
  } as unknown as StorageClient & { objects: Map<string, Buffer> };
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/public/intake',
    createIntakePublicRouter({
      db: harness.db,
      redis,
      storageClient: storage,
      enqueue: async (job) => {
        enqueued.push(job);
      },
    }),
  );
  return app;
}

async function enableIntake(visible: boolean): Promise<void> {
  await harness.db.insert(firmConfig).values({ firmId: seed.firmId, intakeEnabled: true });
  await harness.db.insert(intakeStaffCards).values({
    firmId: seed.firmId,
    userId: seed.appUserId,
    isVisible: visible,
    acceptingUploads: true,
    displayTitle: 'Tax Manager',
  });
}

beforeEach(async () => {
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-intake-flow-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  resetApplianceFirmIdForTests();
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  storage = memStorage();
  enqueued = [];

  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  const mgr = getFirmKeyManager(harness.db);
  await mgr.bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
  setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
});

afterEach(async () => {
  resetFirmKeyManagerForTests();
  resetApplianceFirmIdForTests();
  await harness.close();
  await rm(sealDir, { recursive: true, force: true });
});

describe('intake flow — enabled gate', () => {
  it('GET /staff returns 404 when intake is disabled', async () => {
    const res = await request(buildApp()).get('/api/public/intake/staff');
    expect(res.status).toBe(404);
  });

  it('GET /staff lists visible, upload-accepting cards when enabled', async () => {
    await enableIntake(true);
    const res = await request(buildApp()).get('/api/public/intake/staff');
    expect(res.status).toBe(200);
    expect(res.body.staff).toHaveLength(1);
    expect(res.body.staff[0]).toMatchObject({
      id: seed.appUserId,
      name: 'Sarah Chen',
      title: 'Tax Manager',
      hasHeadshot: false,
    });
  });

  it('hidden cards are not listed', async () => {
    await enableIntake(false);
    const res = await request(buildApp()).get('/api/public/intake/staff');
    expect(res.status).toBe(200);
    expect(res.body.staff).toHaveLength(0);
  });

  it('headshot 404s when none is set', async () => {
    await enableIntake(true);
    const res = await request(buildApp()).get(
      `/api/public/intake/staff/${seed.appUserId}/headshot`,
    );
    expect(res.status).toBe(404);
  });
});

describe('intake flow — session + upload + complete', () => {
  beforeEach(async () => {
    await enableIntake(true);
  });

  async function createSession(): Promise<string> {
    const res = await request(buildApp()).post('/api/public/intake/session').send({
      targetStaffId: seed.appUserId,
      clientName: 'Jane Client',
      clientEmail: 'jane@example.com',
      message: 'Here are my W-2s',
    });
    expect(res.status).toBe(201);
    return res.body.sessionId as string;
  }

  it('rejects a session with neither email nor phone', async () => {
    const res = await request(buildApp())
      .post('/api/public/intake/session')
      .send({ targetStaffId: seed.appUserId, clientName: 'Jane' });
    expect(res.status).toBe(400);
  });

  it('rejects a session targeting a non-visible staff member', async () => {
    const res = await request(buildApp())
      .post('/api/public/intake/session')
      .send({ targetStaffId: seed.clientId, clientName: 'Jane', clientEmail: 'j@e.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('staff_unavailable');
  });

  it('stores PII MFK-encrypted (recoverable, not plaintext)', async () => {
    const sessionId = await createSession();
    const [row] = await harness.db
      .select()
      .from(intakeSessions)
      .where(eq(intakeSessions.id, sessionId))
      .limit(1);
    expect(row!.clientNameEnc).not.toBeNull();
    // Ciphertext must not contain the plaintext.
    expect(Buffer.from(row!.clientNameEnc!).toString('utf8')).not.toContain('Jane');
    const dek = unwrapIntakeRecordKey(harness.db, seed.firmId, row!.wrappedDek);
    expect(decField(dek, row!.clientNameEnc)).toBe('Jane Client');
    expect(decField(dek, row!.clientEmailEnc)).toBe('jane@example.com');
  });

  it('uploads a file to the quarantine prefix and records it', async () => {
    const sessionId = await createSession();
    const res = await request(buildApp())
      .post(`/api/public/intake/session/${sessionId}/files`)
      .query({ filename: 'w2.pdf', mimeType: 'application/pdf' })
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('%PDF-1.4 fake pdf bytes'));
    expect(res.status).toBe(201);
    const fileId = res.body.fileId as string;

    const [f] = await harness.db
      .select()
      .from(intakeFiles)
      .where(eq(intakeFiles.id, fileId))
      .limit(1);
    expect(f!.objectKey).toBe(`intake/quarantine/${sessionId}/${fileId}`);
    expect(f!.scanStatus).toBe('pending');
    expect(storage.objects.has(f!.objectKey)).toBe(true);
    // Filename is encrypted at rest.
    expect(Buffer.from(f!.originalFilenameEnc!).toString('utf8')).not.toContain('w2.pdf');
  });

  it('rejects a blocked file type', async () => {
    const sessionId = await createSession();
    const res = await request(buildApp())
      .post(`/api/public/intake/session/${sessionId}/files`)
      .query({ filename: 'evil.exe', mimeType: 'application/octet-stream' })
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('MZ...'));
    expect(res.status).toBe(415);
  });

  it('rejects an empty body', async () => {
    const sessionId = await createSession();
    const res = await request(buildApp())
      .post(`/api/public/intake/session/${sessionId}/files`)
      .query({ filename: 'w2.pdf', mimeType: 'application/pdf' })
      .set('Content-Type', 'application/pdf')
      .send(Buffer.alloc(0));
    expect(res.status).toBe(400);
  });

  it('complete requires at least one file', async () => {
    const sessionId = await createSession();
    const res = await request(buildApp()).post(`/api/public/intake/session/${sessionId}/complete`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no_files');
  });

  it('complete enqueues the worker job after an upload', async () => {
    const sessionId = await createSession();
    await request(buildApp())
      .post(`/api/public/intake/session/${sessionId}/files`)
      .query({ filename: 'w2.pdf', mimeType: 'application/pdf' })
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('%PDF-1.4 bytes'));
    const res = await request(buildApp()).post(`/api/public/intake/session/${sessionId}/complete`);
    expect(res.status).toBe(200);
    expect(enqueued).toEqual([{ sessionId, firmId: seed.firmId }]);
  });

  it('upload 404s for an unknown session', async () => {
    const res = await request(buildApp())
      .post('/api/public/intake/session/00000000-0000-0000-0000-000000000000/files')
      .query({ filename: 'w2.pdf', mimeType: 'application/pdf' })
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('bytes'));
    expect(res.status).toBe(404);
  });

  it('caps files per session', async () => {
    const sessionId = await createSession();
    // Force the count past the cap by inserting rows directly.
    const rows = Array.from({ length: 30 }, () => ({
      sessionId,
      objectKey: 'k',
      byteSize: 1,
      kind: 'upload' as const,
      scanStatus: 'pending' as const,
    }));
    await harness.db.insert(intakeFiles).values(rows);
    const count = await harness.db
      .select({ n: sql<number>`count(*)::int` })
      .from(intakeFiles)
      .where(eq(intakeFiles.sessionId, sessionId));
    expect(Number(count[0]!.n)).toBe(30);

    const res = await request(buildApp())
      .post(`/api/public/intake/session/${sessionId}/files`)
      .query({ filename: 'extra.pdf', mimeType: 'application/pdf' })
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('%PDF more'));
    expect(res.status).toBe(409);
  });
});
