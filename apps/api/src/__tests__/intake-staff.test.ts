// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Phase E — staff side: auto-match ranking, send-a-link round trip, and the
// inbox→disposition flow (decrypt PII, file into a client folder, write an
// intake_actions row, mark the session disposed).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clientFolders,
  files,
  intakeActions,
  intakeFiles,
  intakeSessions,
  intakeStaffCards,
} from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  type PgliteHarness,
} from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import { createIntakeStaffRouter } from '../intake/staff-routes';
import { suggestClients } from '../intake/auto-match';
import { createIntakeLink, resolveIntakeLink } from '../intake/links';
import { newIntakeRecordKey, encField } from '../intake/crypto';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
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

// Build an app whose staff session is the seeded admin user (RBAC: admin
// has every permission).
function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  const router = createIntakeStaffRouter({
    db: harness.db,
    storageClient: storage,
    fakeUserRoles: new Map([[seed.appUserId, ['admin']]]),
  });
  app.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  app.use('/api/staff/intake', router);
  return app;
}

beforeEach(async () => {
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-intake-staff-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  storage = memStorage();
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  const mgr = getFirmKeyManager(harness.db);
  await mgr.bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
  setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
  // Bind a client folder so disposition can land files.
  await harness.db.insert(clientFolders).values({
    firmId: seed.firmId,
    clientId: seed.clientId,
    storagePath: 'clients/test-client',
    status: 'active',
  });
  // Staff card for the target.
  await harness.db.insert(intakeStaffCards).values({
    firmId: seed.firmId,
    userId: seed.appUserId,
    isVisible: true,
    acceptingUploads: true,
  });
});

afterEach(async () => {
  resetFirmKeyManagerForTests();
  await harness.close();
  await rm(sealDir, { recursive: true, force: true });
});

async function makeReceivedSession(): Promise<string> {
  const { dek, wrappedDek } = newIntakeRecordKey(harness.db, seed.firmId);
  const [s] = await harness.db
    .insert(intakeSessions)
    .values({
      firmId: seed.firmId,
      targetStaffId: seed.appUserId,
      wrappedDek: Buffer.from(wrappedDek),
      clientNameEnc: encField(dek, 'Jane Client'),
      clientEmailEnc: encField(dek, 'jane@example.com'),
      status: 'received',
    })
    .returning({ id: intakeSessions.id });
  const sessionId = s!.id;
  const [f] = await harness.db
    .insert(intakeFiles)
    .values({
      sessionId,
      objectKey: 'pending',
      originalFilenameEnc: encField(dek, 'w2.pdf'),
      mimeType: 'application/pdf',
      byteSize: 9,
      kind: 'upload',
      scanStatus: 'clean',
    })
    .returning({ id: intakeFiles.id });
  const key = `intake/quarantine/${sessionId}/${f!.id}`;
  await harness.db.update(intakeFiles).set({ objectKey: key }).where(eq(intakeFiles.id, f!.id));
  storage.objects.set(key, Buffer.from('%PDF body'));
  return sessionId;
}

describe('auto-match', () => {
  it('ranks an exact email match highest', async () => {
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Jane Client',
      email: 'jane@example.com',
    });
    const matches = await suggestClients(harness.db, seed.firmId, {
      email: 'jane@example.com',
      name: 'Jane',
    });
    expect(matches[0]?.clientId).toBe(seed.clientId);
    expect(matches[0]?.reasons).toContain('email');
  });

  it('matches a phone by its last 10 digits', async () => {
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Jane',
      phone: '(555) 123-4567',
    });
    const matches = await suggestClients(harness.db, seed.firmId, { phone: '+1 555 123 4567' });
    expect(matches[0]?.clientId).toBe(seed.clientId);
    expect(matches[0]?.reasons).toContain('phone');
  });
});

describe('send-a-link', () => {
  it('round-trips a token', async () => {
    const { token, linkId } = await createIntakeLink(harness.db, {
      firmId: seed.firmId,
      createdByUserId: seed.appUserId,
      targetStaffId: seed.appUserId,
      recipientEmail: 'client@example.com',
      expiresInDays: 7,
    });
    const resolved = await resolveIntakeLink(harness.db, seed.firmId, token);
    expect(resolved?.linkId).toBe(linkId);
    expect(resolved?.targetStaffId).toBe(seed.appUserId);
    expect(await resolveIntakeLink(harness.db, seed.firmId, 'bogus-token-value')).toBeNull();
  });
});

describe('inbox + disposition', () => {
  it('lists received sessions with decrypted PII', async () => {
    await makeReceivedSession();
    const res = await request(buildApp()).get('/api/staff/intake/sessions?status=received');
    expect(res.status).toBe(200);
    expect(res.body.sessions[0].clientName).toBe('Jane Client');
    expect(res.body.sessions[0].fileCount).toBe(1);
  });

  it('detail surfaces files + auto-match suggestions', async () => {
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Jane',
      email: 'jane@example.com',
    });
    const sessionId = await makeReceivedSession();
    const res = await request(buildApp()).get(`/api/staff/intake/sessions/${sessionId}`);
    expect(res.status).toBe(200);
    expect(res.body.files[0].filename).toBe('w2.pdf');
    expect(res.body.suggestions[0].clientId).toBe(seed.clientId);
  });

  it('disposes a session into a client folder + writes an action', async () => {
    const sessionId = await makeReceivedSession();
    const res = await request(buildApp())
      .post(`/api/staff/intake/sessions/${sessionId}/dispose`)
      .send({ clientId: seed.clientId, category: 'correspondence' });
    expect(res.status).toBe(200);
    expect(res.body.moved).toBe(1);

    const filed = await harness.db
      .select({ id: files.id, clientId: files.clientId, source: files.source })
      .from(files)
      .where(eq(files.clientId, seed.clientId));
    expect(filed).toHaveLength(1);
    expect(filed[0]!.source).toBe('intake');

    const [sess] = await harness.db
      .select({ status: intakeSessions.status, matched: intakeSessions.matchedClientId })
      .from(intakeSessions)
      .where(eq(intakeSessions.id, sessionId));
    expect(sess!.status).toBe('disposed');
    expect(sess!.matched).toBe(seed.clientId);

    const actions = await harness.db
      .select({ action: intakeActions.action })
      .from(intakeActions)
      .where(eq(intakeActions.sessionId, sessionId));
    expect(actions[0]!.action).toBe('move');
  });

  it('previews a file inline', async () => {
    const sessionId = await makeReceivedSession();
    const [f] = await harness.db
      .select({ id: intakeFiles.id })
      .from(intakeFiles)
      .where(eq(intakeFiles.sessionId, sessionId));
    const res = await request(buildApp()).get(
      `/api/staff/intake/sessions/${sessionId}/files/${f!.id}/download?inline=1`,
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^inline/);
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  it('deletes a received file', async () => {
    const sessionId = await makeReceivedSession();
    const [f] = await harness.db
      .select({ id: intakeFiles.id })
      .from(intakeFiles)
      .where(eq(intakeFiles.sessionId, sessionId));
    const res = await request(buildApp()).delete(
      `/api/staff/intake/sessions/${sessionId}/files/${f!.id}`,
    );
    expect(res.status).toBe(200);
    const remaining = await harness.db
      .select({ id: intakeFiles.id })
      .from(intakeFiles)
      .where(eq(intakeFiles.sessionId, sessionId));
    expect(remaining).toHaveLength(0);
    // The session itself remains for further handling.
    const [sess] = await harness.db
      .select({ status: intakeSessions.status })
      .from(intakeSessions)
      .where(eq(intakeSessions.id, sessionId));
    expect(sess!.status).toBe('received');
  });

  it('rejects a session', async () => {
    const sessionId = await makeReceivedSession();
    const res = await request(buildApp())
      .post(`/api/staff/intake/sessions/${sessionId}/reject`)
      .send({ note: 'spam' });
    expect(res.status).toBe(200);
    const [sess] = await harness.db
      .select({ status: intakeSessions.status })
      .from(intakeSessions)
      .where(eq(intakeSessions.id, sessionId));
    expect(sess!.status).toBe('rejected');
  });
});
