// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The Files tab's "File sharing activity" card. Every row it renders was
// already being written to the database and had no staff-facing read path:
//   GET /files/client/:id/shares          — links sent for this client
//   GET /files/shares/:shareId/events     — one share's recipient trail
//   GET /files/client/:id/portal-activity — what the client did in the portal

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import type { RoleSlug } from '@vibe/core/rbac';
import { clientFolders, fileAccessLog, fileShareEvents, files } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createStaffFileShareRouter } from '../files/share-routes';
import { createFileShare } from '../sharing/file-share-helper';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let fileId: string;

function app(role: RoleSlug = 'admin'): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  a.use(
    '/api/staff/files',
    createStaffFileShareRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, [role]]]),
      portalBaseUrl: 'https://portal.test',
    }),
  );
  return a;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  const [folder] = await harness.db
    .insert(clientFolders)
    .values({ firmId: seed.firmId, clientId: seed.clientId, storagePath: 'Test Client Co' })
    .returning({ id: clientFolders.id });
  const [row] = await harness.db
    .insert(files)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      clientFolderId: folder!.id,
      subfolderPath: 'Tax Returns/',
      originalFilename: '2025 Form 1040.pdf',
      storageKey: 'Test Client Co/Tax Returns/2025 Form 1040.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 42,
      source: 'upload',
    })
    .returning({ id: files.id });
  fileId = row!.id;
});
afterEach(async () => {
  await harness.close();
});

async function seedShare(recipientEmail = 'cpa@bank.example'): Promise<string> {
  const r = await createFileShare(harness.db, {
    firmId: seed.firmId,
    clientId: seed.clientId,
    fileId,
    createdByAppUserId: seed.appUserId,
    accessLevel: 'download',
    recipientName: 'Loan Officer',
    recipientEmail,
    organization: 'Big Bank',
  });
  if (!r.ok) throw new Error(r.error);
  return r.shareId;
}

describe('client share list', () => {
  it('lists this client’s shares with the file they point at', async () => {
    const shareId = await seedShare();

    const res = await request(app()).get(`/api/staff/files/client/${seed.clientId}/shares`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: shareId,
      filename: '2025 Form 1040.pdf',
      recipientEmail: 'cpa@bank.example',
      recipientName: 'Loan Officer',
      organization: 'Big Bank',
      accessLevel: 'download',
      status: 'SENT',
      accessCount: 0,
      lastViewedAt: null,
    });
  });

  it('scopes to the client and the firm', async () => {
    await seedShare();
    const other = await request(app()).get(
      `/api/staff/files/client/${seed.appUserId}/shares`, // a uuid that isn't this client
    );
    expect(other.body.items).toHaveLength(0);
  });

  it('needs the publish permission', async () => {
    await seedShare();
    const res = await request(app('staff')).get(`/api/staff/files/client/${seed.clientId}/shares`);
    expect(res.status).toBe(403);
  });
});

describe('share activity trail', () => {
  it('returns the recipient-side events, newest first', async () => {
    const shareId = await seedShare();
    // The sequence a real recipient produces: code sent, verified, file served.
    await harness.db.insert(fileShareEvents).values([
      {
        fileShareId: shareId,
        outcome: 'otp_sent',
        ip: '10.0.0.9',
        occurredAt: new Date('2026-08-26T14:52:00Z'),
      },
      {
        fileShareId: shareId,
        outcome: 'otp_verified',
        ip: '10.0.0.9',
        occurredAt: new Date('2026-08-26T14:53:00Z'),
      },
      {
        fileShareId: shareId,
        outcome: 'allowed',
        ip: '10.0.0.9',
        userAgent: 'Mozilla/5.0',
        occurredAt: new Date('2026-08-26T14:53:10Z'),
      },
    ]);

    const res = await request(app()).get(`/api/staff/files/shares/${shareId}/events`);
    expect(res.status).toBe(200);
    expect(res.body.share).toMatchObject({ id: shareId, filename: '2025 Form 1040.pdf' });
    expect(res.body.events.map((e: { outcome: string }) => e.outcome)).toEqual([
      'allowed',
      'otp_verified',
      'otp_sent',
    ]);
    expect(res.body.events[0].userAgent).toBe('Mozilla/5.0');
  });

  it('404s a share from another firm', async () => {
    const res = await request(app()).get(`/api/staff/files/shares/${seed.clientId}/events`);
    expect(res.status).toBe(404);
  });
});

describe('portal file activity', () => {
  it('reports what the client did with their own files in the portal', async () => {
    await harness.db.insert(fileAccessLog).values([
      {
        firmId: seed.firmId,
        clientId: seed.clientId,
        fileId,
        outcome: 'allowed',
        ip: '203.0.113.4',
        occurredAt: new Date('2026-08-26T12:00:00Z'),
      },
      {
        firmId: seed.firmId,
        clientId: seed.clientId,
        fileId,
        outcome: 'denied_visibility',
        ip: '203.0.113.4',
        occurredAt: new Date('2026-08-26T11:00:00Z'),
      },
    ]);

    const res = await request(app()).get(
      `/api/staff/files/client/${seed.clientId}/portal-activity`,
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    // Newest first, and the filename is resolved for display.
    expect(res.body.items[0]).toMatchObject({
      outcome: 'allowed',
      filename: '2025 Form 1040.pdf',
      ip: '203.0.113.4',
    });
    expect(res.body.items[1].outcome).toBe('denied_visibility');
  });

  it('is empty for a client with no portal file access', async () => {
    const res = await request(app()).get(
      `/api/staff/files/client/${seed.clientId}/portal-activity`,
    );
    expect(res.body.items).toEqual([]);
  });
});
