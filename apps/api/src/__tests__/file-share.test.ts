// SPDX-License-Identifier: Elastic-2.0
//
// 0102 — unified secure file sharing (staff-initiated). Covers: create +
// delivery + permission gate, token resolution, status/view tracking,
// revoke, and the public redeem streaming a watermarked PDF (and 410 on
// revoked). A share authorizes a NON-client-visible file deliberately.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import type express from 'express';

import { clientFolders, fileShares, files } from '@vibe/db/schema';
import type { RoleSlug } from '@vibe/core/rbac';
import type { StorageClient } from '@vibe/storage';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createStaffFileShareRouter } from '../files/share-routes';
import { createSharePublicRouter } from '../share-public';
import { resolveFileShareToken } from '../sharing/file-share-helper';

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
      visibility: 'private', // deliberately NOT client_visible
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

// ---- fake req/res + invoke (full chain, runs requirePermission) ----
interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
  headers: Record<string, string>;
  body: unknown;
  redirectedTo: string | null;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
  setHeader(k: string, v: string): void;
  send(b: unknown): FakeRes;
  redirect(code: number, url: string): void;
  type(): FakeRes;
}
function makeRes(): FakeRes {
  return {
    statusCode: 200,
    jsonBody: undefined,
    headers: {},
    body: undefined,
    redirectedTo: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.jsonBody = b;
      return this;
    },
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    send(b) {
      this.body = b;
      return this;
    },
    redirect(code, url) {
      this.statusCode = code;
      this.redirectedTo = url;
    },
    type() {
      return this;
    },
  };
}
async function invoke(
  router: express.Router,
  method: 'get' | 'post',
  path: string,
  req: Record<string, unknown>,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const chain = route.stack;
  for (let i = 0; i < chain.length - 1; i++) {
    let advanced = false;
    await (chain[i]!.handle as (rq: unknown, rs: unknown, nx: () => void) => unknown)(
      req,
      res,
      () => {
        advanced = true;
      },
    );
    if (!advanced) return res;
  }
  await (chain[chain.length - 1]!.handle as (rq: unknown, rs: unknown) => unknown)(req, res);
  return res;
}
function staffReq(body: unknown, params: Record<string, string> = {}): Record<string, unknown> {
  return {
    body: body ?? {},
    params,
    query: {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
}

function staffRouter(roles: RoleSlug[], onEmail?: (m: { to: string; body: string }) => void) {
  return createStaffFileShareRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, roles]]),
    portalBaseUrl: 'https://portal.test',
    sendEmail: async (m) => {
      onEmail?.(m);
    },
  });
}

function mockStorage(): StorageClient {
  return {
    kind: 'mock',
    get: async () => ({ body: Readable.from([pdfBytes]), meta: {} }),
    presignGet: async () => 'https://example.com/presigned',
  } as unknown as StorageClient;
}

describe('staff file share', () => {
  it('creates + delivers a share (emails the link), gated by storage:file:publish', async () => {
    const sent: Array<{ to: string; body: string }> = [];
    const r = staffRouter(['partner'], (m) => sent.push(m));
    const res = await invoke(r, 'post', '/:id/share', {
      ...staffReq(
        {
          recipientName: 'Jane',
          recipientEmail: 'jane@lender.example',
          accessLevel: 'download',
          watermark: true,
          expiresInDays: 7,
        },
        { id: fileId },
      ),
    });
    expect(res.statusCode).toBe(201);
    const body = res.jsonBody as {
      shareId: string;
      token: string;
      delivered: { emailed: boolean };
    };
    expect(body.delivered.emailed).toBe(true);
    expect(sent[0]!.to).toBe('jane@lender.example');
    // 0150 — the email links the gated landing page, not the direct
    // download endpoint, and explains the access code.
    expect(sent[0]!.body).toContain('/shared/file/');
    expect(sent[0]!.body).not.toContain('/api/shared/');
    expect(sent[0]!.body).toContain('access code');
    // delivered_at stamped.
    const [row] = await harness.db.select().from(fileShares).where(eq(fileShares.id, body.shareId));
    expect(row!.deliveredAt).toBeTruthy();
    expect(row!.recipientEmail).toBe('jane@lender.example');

    // token round-trips through the resolver.
    const resolved = await resolveFileShareToken(harness.db, body.token);
    expect(resolved?.id).toBe(body.shareId);
  });

  it('403 for a role without storage:file:publish', async () => {
    const r = staffRouter(['senior']);
    const res = await invoke(r, 'post', '/:id/share', {
      ...staffReq({ recipientEmail: 'x@y.example' }, { id: fileId }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('revoke flips status and the link 410s', async () => {
    const r = staffRouter(['partner']);
    const create = await invoke(r, 'post', '/:id/share', {
      ...staffReq({ recipientEmail: 'a@b.example', watermark: true }, { id: fileId }),
    });
    const { shareId, token } = create.jsonBody as { shareId: string; token: string };
    const rev = await invoke(r, 'post', '/shares/:shareId/revoke', {
      ...staffReq({}, { shareId }),
    });
    expect(rev.statusCode).toBe(200);

    // 0150 — the direct endpoint only serves legacy (ungated) rows; flip
    // this share to legacy so the revoked-410 path is exercised.
    await harness.db.update(fileShares).set({ gated: false }).where(eq(fileShares.id, shareId));
    const redeem = createSharePublicRouter({ db: harness.db, storageClient: mockStorage() });
    const res = await invoke(redeem, 'get', '/:token', {
      params: { token },
      headers: {},
      get: () => undefined,
      ip: '127.0.0.1',
    });
    expect(res.statusCode).toBe(410);
  });
});

describe('public redeem', () => {
  it('streams a watermarked PDF for a watermark share (private file allowed via share)', async () => {
    const r = staffRouter(['partner']);
    const create = await invoke(r, 'post', '/:id/share', {
      ...staffReq(
        {
          recipientName: 'Jane',
          recipientEmail: 'j@x.example',
          accessLevel: 'view',
          watermark: true,
        },
        { id: fileId },
      ),
    });
    const { token, shareId } = create.jsonBody as { token: string; shareId: string };

    // 0150 — direct serving is legacy-only now; this test covers the
    // pre-0150 path, so mark the row ungated.
    await harness.db.update(fileShares).set({ gated: false }).where(eq(fileShares.id, shareId));
    const redeem = createSharePublicRouter({ db: harness.db, storageClient: mockStorage() });
    const res = await invoke(redeem, 'get', '/:token', {
      params: { token },
      headers: {},
      get: () => undefined,
      ip: '127.0.0.1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('inline');
    expect(Buffer.isBuffer(res.body)).toBe(true);

    // view tracking flipped SENT -> VIEWED.
    const [row] = await harness.db.select().from(fileShares).where(eq(fileShares.id, shareId));
    expect(row!.status).toBe('VIEWED');
    expect(row!.accessCount).toBe(1);
  });
});
