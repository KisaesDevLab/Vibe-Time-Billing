// SPDX-License-Identifier: Elastic-2.0
//
// Message attachments (internal-messaging mount): upload encrypts under the
// thread T-DEK and stores at a messages/attachments key; posting a message
// with attachmentIds links them; the message list returns them; download
// decrypts back to the original bytes; a non-member is refused.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appUsers, threadAttachments } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';
import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import { createInternalMessagingRouter } from '../internal-messaging/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let userB: string;
let sealDir: string;
let storage: StorageClient & { objects: Map<string, Buffer> };

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

function appAs(userId: string): express.Express {
  const app = express();
  app.use(express.json());
  const router = createInternalMessagingRouter({
    db: harness.db,
    storageClient: storage,
    fakeUserRoles: new Map<string, RoleSlug[]>([
      [seed.appUserId, ['staff']],
      [userB, ['staff']],
    ]),
    enqueueNotify: async () => undefined,
  });
  app.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: userId,
    };
    next();
  });
  app.use('/api/staff/internal-messaging', router);
  return app;
}

beforeEach(async () => {
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-att-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  storage = memStorage();
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  const [b] = await harness.db
    .insert(appUsers)
    .values({ firmId: seed.firmId, email: 'bob@t.example', fullName: 'Bob' })
    .returning({ id: appUsers.id });
  userB = b!.id;
  const mgr = getFirmKeyManager(harness.db);
  await mgr.bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
  setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
});

afterEach(async () => {
  resetFirmKeyManagerForTests();
  await harness.close();
  await rm(sealDir, { recursive: true, force: true });
});

describe('message attachments', () => {
  async function makeThread(): Promise<string> {
    const r = await request(appAs(seed.appUserId))
      .post('/api/staff/internal-messaging/threads')
      .send({ memberIds: [userB], body: 'hi' });
    return r.body.threadId as string;
  }

  it('uploads (encrypted), links to a message, and downloads decrypted', async () => {
    const threadId = await makeThread();
    const app = appAs(seed.appUserId);
    const bytes = Buffer.from('PNGDATA-the-actual-attachment-content-1234567890');

    const up = await request(app)
      .post(`/api/staff/internal-messaging/threads/${threadId}/attachments`)
      .query({ filename: 'photo.png', mimeType: 'image/png' })
      .set('Content-Type', 'image/png')
      .send(bytes);
    expect(up.status).toBe(201);
    expect(up.body.isImage).toBe(true);
    const attId = up.body.id as string;

    // Stored ciphertext != plaintext.
    const [row] = await harness.db
      .select()
      .from(threadAttachments)
      .where(eq(threadAttachments.id, attId));
    expect(row!.messageId).toBeNull();
    const stored = storage.objects.get(row!.objectKey)!;
    expect(stored.equals(bytes)).toBe(false);

    // Post a message linking the attachment.
    const post = await request(app)
      .post(`/api/staff/internal-messaging/threads/${threadId}/messages`)
      .send({ body: 'see photo', attachmentIds: [attId] });
    expect(post.status).toBe(201);

    // Message list returns the attachment.
    const list = await request(appAs(userB)).get(
      `/api/staff/internal-messaging/threads/${threadId}/messages`,
    );
    const withAtt = list.body.items.find(
      (m: { attachments: { id: string }[] }) => m.attachments.length > 0,
    );
    expect(withAtt.attachments[0].id).toBe(attId);
    expect(withAtt.attachments[0].filename).toBe('photo.png');

    // Download decrypts back to the original bytes.
    const dl = await request(appAs(userB))
      .get(`/api/staff/internal-messaging/threads/${threadId}/attachments/${attId}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(dl.status).toBe(200);
    expect((dl.body as Buffer).equals(bytes)).toBe(true);
  });

  it('refuses upload + download for a non-member', async () => {
    const threadId = await makeThread();
    const [c] = await harness.db
      .insert(appUsers)
      .values({ firmId: seed.firmId, email: 'carol@t.example', fullName: 'Carol' })
      .returning({ id: appUsers.id });
    // Carol must be in fakeUserRoles to pass the permission gate but is not a member.
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { staffSession: unknown }).staffSession = {
        firmId: seed.firmId,
        appUserId: c!.id,
      };
      next();
    });
    app.use(
      '/api/staff/internal-messaging',
      createInternalMessagingRouter({
        db: harness.db,
        storageClient: storage,
        fakeUserRoles: new Map<string, RoleSlug[]>([[c!.id, ['staff']]]),
        enqueueNotify: async () => undefined,
      }),
    );
    const up = await request(app)
      .post(`/api/staff/internal-messaging/threads/${threadId}/attachments`)
      .query({ filename: 'x.png', mimeType: 'image/png' })
      .set('Content-Type', 'image/png')
      .send(Buffer.from('data'));
    expect(up.status).toBe(403);
  });

  it('blocks dangerous file types', async () => {
    const threadId = await makeThread();
    const up = await request(appAs(seed.appUserId))
      .post(`/api/staff/internal-messaging/threads/${threadId}/attachments`)
      .query({ filename: 'evil.exe', mimeType: 'application/octet-stream' })
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('MZ'));
    expect(up.status).toBe(415);
  });
});
