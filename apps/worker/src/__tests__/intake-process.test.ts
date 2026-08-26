// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Phase D — intake-process worker pipeline. Exercises the clean path
// (scan → assemble PNG pages into a PDF → mark received → notify), the
// infected path (mark rejected), and idempotent skip of an already-handled
// session. The scanner is injected so no live clamd is required.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { Readable } from 'node:stream';

import {
  buildPgliteHarness,
  seedMinimalFirm,
  type PgliteHarness,
} from '../../../api/src/__tests__/_pglite-harness';
import { intakeFiles, intakeSessions, intakeStaffCards } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import { runIntakeProcess } from '../jobs/intake-process';

const silentLog = pino({ enabled: false });

// 1x1 PNG — valid bytes pdf-lib.embedPng accepts.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let harness: PgliteHarness;
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

beforeEach(async () => {
  harness = await buildPgliteHarness();
  storage = memStorage();
});
afterEach(async () => {
  await harness.close();
});

async function seedSession(): Promise<{ firmId: string; staffId: string; sessionId: string }> {
  const seed = await seedMinimalFirm(harness.db);
  await harness.db.insert(intakeStaffCards).values({
    firmId: seed.firmId,
    userId: seed.appUserId,
    isVisible: true,
    acceptingUploads: true,
    notifyEmail: true,
    notifySms: false,
  });
  const [s] = await harness.db
    .insert(intakeSessions)
    .values({
      firmId: seed.firmId,
      targetStaffId: seed.appUserId,
      wrappedDek: Buffer.from('dummy-wrapped-dek'),
      status: 'pending_scan',
    })
    .returning({ id: intakeSessions.id });
  return { firmId: seed.firmId, staffId: seed.appUserId, sessionId: s!.id };
}

async function addUpload(sessionId: string, mime: string, bytes: Buffer): Promise<string> {
  const [f] = await harness.db
    .insert(intakeFiles)
    .values({
      sessionId,
      objectKey: 'pending',
      mimeType: mime,
      byteSize: bytes.byteLength,
      kind: 'upload',
      scanStatus: 'pending',
    })
    .returning({ id: intakeFiles.id });
  const key = `intake/quarantine/${sessionId}/${f!.id}`;
  await harness.db.update(intakeFiles).set({ objectKey: key }).where(eq(intakeFiles.id, f!.id));
  storage.objects.set(key, bytes);
  return f!.id;
}

describe('runIntakeProcess', () => {
  it('clean path: scans, assembles a PDF, marks received, notifies', async () => {
    const { firmId, sessionId } = await seedSession();
    await addUpload(sessionId, 'image/png', PNG_1x1);
    await addUpload(sessionId, 'image/png', PNG_1x1);

    const emails: Array<{ to: string }> = [];
    const result = await runIntakeProcess(
      harness.db,
      storage,
      silentLog,
      { sessionId, firmId },
      {
        scan: async () => ({ status: 'clean' }),
        sendEmail: async (a) => {
          emails.push({ to: a.to });
        },
      },
    );

    expect(result.outcome).toBe('received');
    expect(result.scanned).toBe(2);
    expect(result.assembledPdf).toBe(true);

    const [sess] = await harness.db
      .select({ status: intakeSessions.status })
      .from(intakeSessions)
      .where(eq(intakeSessions.id, sessionId));
    expect(sess!.status).toBe('received');

    const files = await harness.db
      .select({ kind: intakeFiles.kind, scanStatus: intakeFiles.scanStatus })
      .from(intakeFiles)
      .where(eq(intakeFiles.sessionId, sessionId));
    expect(files.filter((f) => f.kind === 'upload').every((f) => f.scanStatus === 'clean')).toBe(
      true,
    );
    const scan = files.find((f) => f.kind === 'scan');
    expect(scan).toBeTruthy();
    expect(scan!.scanStatus).toBe('clean');
    // staff card notify_email=true → one email
    expect(emails).toHaveLength(1);
  });

  it('hands the staff notification to the API instead of sending generic copy', async () => {
    const { firmId, sessionId } = await seedSession();
    await addUpload(sessionId, 'image/png', PNG_1x1);

    const emails: Array<{ to: string }> = [];
    const notifyJobs: Array<{ sessionId: string; firmId: string; fileCount: number }> = [];
    await runIntakeProcess(
      harness.db,
      storage,
      silentLog,
      { sessionId, firmId },
      {
        scan: async () => ({ status: 'clean' }),
        sendEmail: async (a) => {
          emails.push({ to: a.to });
        },
        enqueueNotify: async (job) => {
          notifyJobs.push(job);
        },
      },
    );

    // The API composes it (it can decrypt the submitter's details); the
    // worker must not also send its own generic copy.
    expect(notifyJobs).toEqual([{ sessionId, firmId, fileCount: 1 }]);
    expect(emails).toHaveLength(0);
  });

  it('falls back to generic copy when the notify enqueue fails', async () => {
    const { firmId, sessionId } = await seedSession();
    await addUpload(sessionId, 'image/png', PNG_1x1);

    const emails: Array<{ to: string; subject: string }> = [];
    await runIntakeProcess(
      harness.db,
      storage,
      silentLog,
      { sessionId, firmId },
      {
        scan: async () => ({ status: 'clean' }),
        sendEmail: async (a) => {
          emails.push({ to: a.to, subject: a.subject });
        },
        enqueueNotify: async () => {
          throw new Error('redis down');
        },
      },
    );

    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toBe('New document submission received');
  });

  it('infected path: marks the file infected and the session rejected', async () => {
    const { firmId, sessionId } = await seedSession();
    const fileId = await addUpload(sessionId, 'application/pdf', Buffer.from('%PDF evil'));

    const result = await runIntakeProcess(
      harness.db,
      storage,
      silentLog,
      { sessionId, firmId },
      {
        scan: async () => ({ status: 'infected', signature: 'Eicar-Test-Signature' }),
      },
    );

    expect(result.outcome).toBe('rejected');
    expect(result.infected).toBe(1);
    const [f] = await harness.db
      .select({ scanStatus: intakeFiles.scanStatus })
      .from(intakeFiles)
      .where(eq(intakeFiles.id, fileId));
    expect(f!.scanStatus).toBe('infected');
    const [sess] = await harness.db
      .select({ status: intakeSessions.status })
      .from(intakeSessions)
      .where(eq(intakeSessions.id, sessionId));
    expect(sess!.status).toBe('rejected');
  });

  it('is idempotent: a non-pending session is skipped', async () => {
    const { firmId, sessionId } = await seedSession();
    await harness.db
      .update(intakeSessions)
      .set({ status: 'received' })
      .where(eq(intakeSessions.id, sessionId));
    const result = await runIntakeProcess(
      harness.db,
      storage,
      silentLog,
      { sessionId, firmId },
      {
        scan: async () => ({ status: 'clean' }),
      },
    );
    expect(result.outcome).toBe('skipped');
  });

  // 0230 — the AI-label job fires once on the received path only, and a
  // failed enqueue never fails the pipeline.
  it('enqueues the AI-label job on received, not on rejected, tolerating enqueue errors', async () => {
    const { firmId, sessionId } = await seedSession();
    await addUpload(sessionId, 'application/pdf', Buffer.from('%PDF-1.4 real'));
    const calls: Array<{ sessionId: string; firmId: string }> = [];
    const received = await runIntakeProcess(
      harness.db,
      storage,
      silentLog,
      { sessionId, firmId },
      {
        scan: async () => ({ status: 'clean' }),
        enqueueAiLabel: async (j) => {
          calls.push(j);
        },
      },
    );
    expect(received.outcome).toBe('received');
    expect(calls).toEqual([{ sessionId, firmId }]);
    // The clean rows were flipped to 'pending' alongside the enqueue
    // ('pending' means "a label job exists"; the column defaults 'skipped').
    const flipped = await harness.db
      .select({ aiLabelStatus: intakeFiles.aiLabelStatus })
      .from(intakeFiles)
      .where(eq(intakeFiles.sessionId, sessionId));
    expect(flipped.every((f) => f.aiLabelStatus === 'pending')).toBe(true);

    const { sessionId: s2, firmId: firm2 } = await seedSession();
    await addUpload(s2, 'application/pdf', Buffer.from('%PDF evil'));
    const rejected = await runIntakeProcess(
      harness.db,
      storage,
      silentLog,
      { sessionId: s2, firmId: firm2 },
      {
        scan: async () => ({ status: 'infected', signature: 'Eicar-Test-Signature' }),
        enqueueAiLabel: async (j) => {
          calls.push(j);
        },
      },
    );
    expect(rejected.outcome).toBe('rejected');
    expect(calls).toHaveLength(1); // no enqueue for the rejected session

    const { sessionId: s3, firmId: firm3 } = await seedSession();
    await addUpload(s3, 'application/pdf', Buffer.from('%PDF-1.4 fine'));
    const survived = await runIntakeProcess(
      harness.db,
      storage,
      silentLog,
      { sessionId: s3, firmId: firm3 },
      {
        scan: async () => ({ status: 'clean' }),
        enqueueAiLabel: async () => {
          throw new Error('redis down');
        },
      },
    );
    expect(survived.outcome).toBe('received'); // enqueue failure is non-fatal
    // …and the pending flip was reverted, so no permanent "AI labeling…".
    const reverted = await harness.db
      .select({ aiLabelStatus: intakeFiles.aiLabelStatus })
      .from(intakeFiles)
      .where(eq(intakeFiles.sessionId, s3));
    expect(reverted.every((f) => f.aiLabelStatus === 'skipped')).toBe(true);
  });

  it('non-image clean files do not produce an assembled PDF', async () => {
    const { firmId, sessionId } = await seedSession();
    await addUpload(sessionId, 'application/pdf', Buffer.from('%PDF-1.4 real'));
    const result = await runIntakeProcess(
      harness.db,
      storage,
      silentLog,
      { sessionId, firmId },
      {
        scan: async () => ({ status: 'clean' }),
      },
    );
    expect(result.outcome).toBe('received');
    expect(result.assembledPdf).toBe(false);
  });
});
