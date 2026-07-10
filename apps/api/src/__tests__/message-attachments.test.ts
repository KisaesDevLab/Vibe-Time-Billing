// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
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

import { appUsers, clientFolders, files, threadAttachments } from '@vibe/db/schema';
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

  // 0154 — file an attachment into a client folder. Internal threads have
  // no client, so the caller supplies one; the filed copy is plaintext
  // (decrypted), internal-only, and the original attachment is untouched.
  async function uploadAttachment(threadId: string, bytes: Buffer): Promise<string> {
    const up = await request(appAs(seed.appUserId))
      .post(`/api/staff/internal-messaging/threads/${threadId}/attachments`)
      .query({ filename: 'statement.pdf', mimeType: 'application/pdf' })
      .set('Content-Type', 'application/pdf')
      .send(bytes);
    expect(up.status).toBe(201);
    return up.body.id as string;
  }

  it('files an attachment into a chosen client folder (decrypted, internal-only)', async () => {
    await harness.db.insert(clientFolders).values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      storagePath: 'Test Client Co/',
    });
    const threadId = await makeThread();
    const bytes = Buffer.from('%PDF-1.7 the real statement bytes 0123456789');
    const attId = await uploadAttachment(threadId, bytes);

    const res = await request(appAs(seed.appUserId))
      .post(`/api/staff/internal-messaging/threads/${threadId}/attachments/${attId}/file-to-folder`)
      .send({ clientId: seed.clientId, subfolderPath: 'Correspondence' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    const fileRows = await harness.db.select().from(files).where(eq(files.firmId, seed.firmId));
    expect(fileRows).toHaveLength(1);
    expect(fileRows[0]!.visibility).toBe('private');
    expect(fileRows[0]!.source).toBe('message_attachment');
    expect(fileRows[0]!.subfolderPath).toBe('Correspondence/');
    // The filed copy is the decrypted plaintext (the attachment object is
    // ciphertext); prove they differ and the copy matches the original.
    const filed = storage.objects.get(fileRows[0]!.storageKey)!;
    expect(filed.equals(bytes)).toBe(true);

    // The original attachment row is untouched.
    const [att] = await harness.db
      .select()
      .from(threadAttachments)
      .where(eq(threadAttachments.id, attId));
    expect(att!.messageId).toBeNull();
    expect(storage.objects.get(att!.objectKey)!.equals(bytes)).toBe(false);
  });

  it('requires a client on an internal (client-less) thread', async () => {
    const threadId = await makeThread();
    const attId = await uploadAttachment(threadId, Buffer.from('%PDF data'));
    const res = await request(appAs(seed.appUserId))
      .post(`/api/staff/internal-messaging/threads/${threadId}/attachments/${attId}/file-to-folder`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('client_required');
  });

  it('400s when the chosen client has no bound folder', async () => {
    const threadId = await makeThread();
    const attId = await uploadAttachment(threadId, Buffer.from('%PDF data'));
    const res = await request(appAs(seed.appUserId))
      .post(`/api/staff/internal-messaging/threads/${threadId}/attachments/${attId}/file-to-folder`)
      .send({ clientId: seed.clientId });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('client_folder_not_bound');
  });
});
