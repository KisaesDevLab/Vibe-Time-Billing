// SPDX-License-Identifier: Elastic-2.0
//
// 0150 — gated file-share recipient API. Verifies the access-code flow
// end to end against the real express router: enumeration-uniform 404s,
// meta states, send-code dispatch + cooldown, verify lock ladder +
// auto-revoke + grant cookie attributes, content/download gating, and
// the legacy /api/shared guard (gated rows redirect; ungated still
// direct-serve).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';

import { auditLog, clientFolders, fileShareEvents, fileShares, files } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createFileRecipientRouter } from '../share-public/file-recipient';
import { createSharePublicRouter } from '../share-public';
import { createFileShare } from '../sharing/file-share-helper';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let fileId: string;
let pdfBytes: Buffer;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  const [folder] = await harness.db
    .insert(clientFolders)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      storagePath: `clients/${seed.clientId}`,
    })
    .returning({ id: clientFolders.id });
  const [f] = await harness.db
    .insert(files)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      clientFolderId: folder!.id,
      originalFilename: 'return.pdf',
      storageKey: `clients/${seed.clientId}/return.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 1234,
      visibility: 'private',
    })
    .returning({ id: files.id });
  fileId = f!.id;
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  pdfBytes = Buffer.from(await doc.save());
});
afterEach(async () => {
  await harness.close();
});

function mockStorage(): StorageClient {
  return {
    kind: 'mock',
    get: async () => ({ body: Readable.from([pdfBytes]), meta: {} }),
    presignGet: async () => 'https://example.com/presigned',
  } as unknown as StorageClient;
}

async function makeShare(opts: {
  accessLevel?: 'view' | 'download';
  watermark?: boolean;
}): Promise<{ shareId: string; token: string }> {
  const created = await createFileShare(harness.db, {
    firmId: seed.firmId,
    clientId: seed.clientId,
    fileId,
    createdByAppUserId: seed.appUserId,
    recipientName: 'Kurt Recipient',
    recipientEmail: 'kurt.recipient@example.com',
    accessLevel: opts.accessLevel ?? 'view',
    watermark: opts.watermark ?? false,
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
  });
  if (!created.ok) throw new Error('share create failed');
  return { shareId: created.shareId, token: created.token };
}

function buildApp(sent: Array<{ to: string; subject?: string; body: string }>) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/shared-file',
    createFileRecipientRouter({
      db: harness.db,
      storage: mockStorage(),
      sendEmail: async (m) => {
        sent.push(m);
      },
    }),
  );
  return app;
}

function codeFrom(sent: Array<{ body: string }>): string {
  const last = sent[sent.length - 1]!;
  const m = last.body.match(/\b(\d{6})\b/);
  if (!m) throw new Error('no code in mail');
  return m[1]!;
}

function cookieFrom(res: request.Response): string {
  const sc = res.headers['set-cookie'];
  const arr = Array.isArray(sc) ? sc : [sc];
  const found = arr.find((c) => c && c.startsWith('__vibe_fs_'));
  if (!found) throw new Error('no grant cookie');
  return found.split(';')[0]!;
}

describe('meta', () => {
  it('unknown and malformed tokens return identical 404 bodies', async () => {
    await makeShare({});
    const app = buildApp([]);
    const a = await request(app).get('/api/shared-file/short/meta');
    const b = await request(app).get(
      '/api/shared-file/00000000-0000-4000-8000-000000000000.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/meta',
    );
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(a.body).toEqual(b.body);
  });

  it('returns safe fields with masked destination; never the full email', async () => {
    const { token } = await makeShare({});
    const app = buildApp([]);
    const r = await request(app).get(`/api/shared-file/${token}/meta`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      state: 'ok',
      gated: true,
      verified: false,
      fileName: 'return.pdf',
      isPdf: true,
      accessLevel: 'view',
      channel: 'EMAIL',
    });
    expect(JSON.stringify(r.body)).not.toContain('kurt.recipient@example.com');
    expect(r.body.maskedDestination).toMatch(/^k.*t@example\.com$/);
  });

  it('revoked / expired shares surface friendly states', async () => {
    const { shareId, token } = await makeShare({});
    await harness.db
      .update(fileShares)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(fileShares.id, shareId));
    const app = buildApp([]);
    const r = await request(app).get(`/api/shared-file/${token}/meta`);
    expect(r.body).toEqual({ state: 'expired' });
  });
});

describe('send-code + verify', () => {
  it('delivers a 6-digit code, enforces the resend cooldown, logs events', async () => {
    const { shareId, token } = await makeShare({});
    const sent: Array<{ to: string; body: string }> = [];
    const app = buildApp(sent);

    const send = await request(app).post(`/api/shared-file/${token}/send-code`);
    expect(send.status).toBe(200);
    expect(send.body).toMatchObject({ ok: true, channel: 'EMAIL', cooldownSeconds: 60 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('kurt.recipient@example.com');
    expect(codeFrom(sent)).toMatch(/^\d{6}$/);

    const again = await request(app).post(`/api/shared-file/${token}/send-code`);
    expect(again.status).toBe(429);
    expect(again.body.error).toBe('cooldown');

    const events = await harness.db
      .select()
      .from(fileShareEvents)
      .where(eq(fileShareEvents.fileShareId, shareId));
    expect(events.map((e) => e.outcome)).toContain('otp_sent');
  });

  it('verify: wrong codes count down, lock at 5; correct code sets the grant cookie', async () => {
    const { token } = await makeShare({});
    const sent: Array<{ to: string; body: string }> = [];
    const app = buildApp(sent);
    await request(app).post(`/api/shared-file/${token}/send-code`);
    const code = codeFrom(sent);
    const wrong = code === '000000' ? '111111' : '000000';

    const bad = await request(app).post(`/api/shared-file/${token}/verify`).send({ code: wrong });
    expect(bad.status).toBe(401);
    expect(bad.body).toMatchObject({ error: 'invalid_code', attemptsRemaining: 4 });

    const good = await request(app).post(`/api/shared-file/${token}/verify`).send({ code });
    expect(good.status).toBe(200);
    const setCookie = String(good.headers['set-cookie']);
    expect(setCookie).toContain('__vibe_fs_');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/api/shared-file');
  });

  it('three exhausted challenges auto-revoke the share with an audit row', async () => {
    const { shareId, token } = await makeShare({});
    const sent: Array<{ to: string; body: string }> = [];
    const app = buildApp(sent);
    for (let round = 0; round < 3; round++) {
      // Bypass the 60s cooldown by backdating prior challenge rows.
      await harness.db.execute(
        // reason: time-travel for the cooldown window in tests.
        (await import('drizzle-orm'))
          .sql`UPDATE file_share_otp SET created_at = created_at - interval '10 minutes'`,
      );
      const send = await request(app).post(`/api/shared-file/${token}/send-code`);
      expect(send.status).toBe(200);
      const code = codeFrom(sent);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) {
        await request(app).post(`/api/shared-file/${token}/verify`).send({ code: wrong });
      }
    }
    const [share] = await harness.db.select().from(fileShares).where(eq(fileShares.id, shareId));
    expect(share!.status).toBe('REVOKED');
    const events = await harness.db
      .select()
      .from(fileShareEvents)
      .where(eq(fileShareEvents.fileShareId, shareId));
    expect(events.map((e) => e.outcome)).toContain('revoked_lockout');
    const audits = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityType, 'file_share'));
    expect(audits.some((a) => a.actorAppUserId == null)).toBe(true);
  });
});

describe('content + download gating', () => {
  async function verifiedCookie(app: express.Express, token: string, sent: { body: string }[]) {
    await request(app).post(`/api/shared-file/${token}/send-code`);
    const code = codeFrom(sent as Array<{ body: string }>);
    const good = await request(app).post(`/api/shared-file/${token}/verify`).send({ code });
    return cookieFrom(good);
  }

  it('content 403s without a grant and streams the PDF with one', async () => {
    const { shareId, token } = await makeShare({ watermark: true });
    const sent: Array<{ to: string; body: string }> = [];
    const app = buildApp(sent);

    const blocked = await request(app).get(`/api/shared-file/${token}/content`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('verification_required');

    const cookie = await verifiedCookie(app, token, sent);
    const ok = await request(app).get(`/api/shared-file/${token}/content`).set('Cookie', cookie);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('application/pdf');
    expect(ok.headers['content-disposition']).toContain('inline');

    const [share] = await harness.db.select().from(fileShares).where(eq(fileShares.id, shareId));
    expect(share!.status).toBe('VIEWED');
    expect(share!.accessCount).toBe(1);
  });

  it('download 403s on view-only shares even with a valid grant', async () => {
    const { token } = await makeShare({ accessLevel: 'view' });
    const sent: Array<{ to: string; body: string }> = [];
    const app = buildApp(sent);
    const cookie = await verifiedCookie(app, token, sent);
    const r = await request(app).get(`/api/shared-file/${token}/download`).set('Cookie', cookie);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('view_only');
  });

  it('download streams attachment for download-level shares', async () => {
    const { token } = await makeShare({ accessLevel: 'download' });
    const sent: Array<{ to: string; body: string }> = [];
    const app = buildApp(sent);
    const cookie = await verifiedCookie(app, token, sent);
    const r = await request(app).get(`/api/shared-file/${token}/download`).set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toContain('attachment');
  });
});

describe('legacy /api/shared guard', () => {
  it('gated rows 302 to the landing page with no bytes; ungated rows still serve', async () => {
    const { shareId, token } = await makeShare({ watermark: true });
    const legacy = express();
    legacy.use(
      '/api/shared',
      createSharePublicRouter({
        db: harness.db,
        storageClient: mockStorage(),
        portalBaseUrl: 'https://portal.test.example',
      }),
    );

    const gated = await request(legacy).get(`/api/shared/${token}`);
    expect(gated.status).toBe(302);
    expect(gated.headers['location']).toBe(`https://portal.test.example/shared/file/${token}`);
    const events = await harness.db
      .select()
      .from(fileShareEvents)
      .where(eq(fileShareEvents.fileShareId, shareId));
    expect(events.map((e) => e.outcome)).toContain('denied_gated');

    // Pre-0150 rows (gated=false) keep the direct flow.
    await harness.db.update(fileShares).set({ gated: false }).where(eq(fileShares.id, shareId));
    const direct = await request(legacy).get(`/api/shared/${token}`);
    expect(direct.status).toBe(200);
    expect(direct.headers['content-type']).toBe('application/pdf');
  });
});
