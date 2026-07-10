// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0084 — portal-side request flow: GET detail, POST reply, POST
// needs-info, POST attachments, POST per-item fulfill. Cross-client
// isolation enforced on every endpoint.

import type { NextFunction, Request, Response, Router } from 'express';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { clientRequestAttachments, clientRequestItems, clientRequests } from '@vibe/db/schema';
import { createPortalRequestsRouter } from '../portal/requests';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

interface FakeReq {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  portalSession: { portalIdentityId: string; activeClientId: string };
  ip: string;
  get(_h: string): string | undefined;
}
interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
}
function makeRes(): FakeRes {
  return {
    statusCode: 200,
    jsonBody: undefined,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.jsonBody = b;
      return this;
    },
  };
}
async function invoke(
  router: Router,
  method: 'get' | 'post' | 'patch',
  path: string,
  req: FakeReq,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  // Skip requireAuth (first handler in stack); run the last handler.
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

const noopAuth = (_req: Request, _res: Response, next: NextFunction): void => next();

async function setupPortal(): Promise<{
  firmId: string;
  clientId: string;
  engagementId: string;
  portalIdentityId: string;
  fileId: string;
  router: Router;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const identity = await harness.db.execute(
    sql`INSERT INTO portal_identity (firm_id, full_name, primary_email)
        VALUES (${seed.firmId}, 'Client User', 'c@x.example') RETURNING id`,
  );
  const portalIdentityId = (identity as unknown as { rows: { id: string }[] }).rows[0]!.id;
  await harness.db.execute(
    sql`INSERT INTO client_portal_access (portal_identity_id, client_id, status, role)
        VALUES (${portalIdentityId}, ${seed.clientId}, 'ACTIVE', 'FULL')`,
  );
  // File belonging to this client (for attachment scope guard).
  const folder = await harness.db.execute(
    sql`INSERT INTO client_folders (firm_id, client_id, status, storage_path)
        VALUES (${seed.firmId}, ${seed.clientId}, 'active', 'a/b') RETURNING id`,
  );
  const folderId = (folder as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const file = await harness.db.execute(
    sql`INSERT INTO files (firm_id, client_id, client_folder_id, subfolder_path,
                          original_filename, mime_type, size_bytes, storage_key, visibility)
        VALUES (${seed.firmId}, ${seed.clientId}, ${folderId}, '',
                'w2.pdf', 'application/pdf', 1024, 'a/b/w2.pdf', 'client_visible')
        RETURNING id`,
  );
  const fileId = (file as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const router = createPortalRequestsRouter({ db: harness.db, requireAuth: noopAuth });
  return {
    firmId: seed.firmId,
    clientId: seed.clientId,
    engagementId: seed.engagementId,
    portalIdentityId,
    fileId,
    router,
  };
}

async function seedRequestWith(
  db: PgliteHarness['db'],
  firmId: string,
  engagementId: string,
  items?: Array<{ label: string; required: boolean }>,
): Promise<{ requestId: string; itemIds: string[] }> {
  const r = await db.execute(
    sql`INSERT INTO client_request (firm_id, engagement_id, title)
        VALUES (${firmId}, ${engagementId}, 'A request') RETURNING id`,
  );
  const requestId = (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const itemIds: string[] = [];
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const row = await db.execute(
        sql`INSERT INTO client_request_item (client_request_id, ordinal, label, required)
            VALUES (${requestId}, ${i}, ${it.label}, ${it.required}) RETURNING id`,
      );
      itemIds.push((row as unknown as { rows: { id: string }[] }).rows[0]!.id);
    }
  }
  return { requestId, itemIds };
}

describe('portal requests flow', () => {
  it('GET /:id returns request + items + attachments scoped to the client', async () => {
    const ctx = await setupPortal();
    const { requestId } = await seedRequestWith(harness.db, ctx.firmId, ctx.engagementId, [
      { label: 'W-2', required: true },
    ]);
    const r = await invoke(ctx.router, 'get', '/:id', {
      body: {},
      params: { id: requestId },
      query: {},
      portalSession: {
        portalIdentityId: ctx.portalIdentityId,
        activeClientId: ctx.clientId,
      },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(r.statusCode).toBe(200);
    const body = r.jsonBody as {
      request: { title: string };
      items: Array<{ label: string }>;
      attachments: unknown[];
    };
    expect(body.request.title).toBe('A request');
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.label).toBe('W-2');
    expect(body.attachments).toEqual([]);
  });

  it('POST /:id/reply saves client_reply_text without changing status', async () => {
    const ctx = await setupPortal();
    const { requestId } = await seedRequestWith(harness.db, ctx.firmId, ctx.engagementId);
    const r = await invoke(ctx.router, 'post', '/:id/reply', {
      body: { text: 'Here is my reply.' },
      params: { id: requestId },
      query: {},
      portalSession: {
        portalIdentityId: ctx.portalIdentityId,
        activeClientId: ctx.clientId,
      },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(r.statusCode).toBe(200);
    const [row] = await harness.db
      .select()
      .from(clientRequests)
      .where(eq(clientRequests.id, requestId));
    expect(row!.clientReplyText).toBe('Here is my reply.');
    expect(row!.status).toBe('OPEN');
  });

  it('POST /:id/needs-info flips status to NEEDS_INFO and stores text', async () => {
    const ctx = await setupPortal();
    const { requestId } = await seedRequestWith(harness.db, ctx.firmId, ctx.engagementId);
    const r = await invoke(ctx.router, 'post', '/:id/needs-info', {
      body: { text: 'Which year?' },
      params: { id: requestId },
      query: {},
      portalSession: {
        portalIdentityId: ctx.portalIdentityId,
        activeClientId: ctx.clientId,
      },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(r.statusCode).toBe(200);
    const [row] = await harness.db
      .select()
      .from(clientRequests)
      .where(eq(clientRequests.id, requestId));
    expect(row!.status).toBe('NEEDS_INFO');
    expect(row!.clientReplyText).toBe('Which year?');
  });

  it('POST /:id/attachments inserts attachment row; rejects file from another client', async () => {
    const ctx = await setupPortal();
    const { requestId } = await seedRequestWith(harness.db, ctx.firmId, ctx.engagementId);

    // Happy path.
    const ok = await invoke(ctx.router, 'post', '/:id/attachments', {
      body: { fileId: ctx.fileId },
      params: { id: requestId },
      query: {},
      portalSession: {
        portalIdentityId: ctx.portalIdentityId,
        activeClientId: ctx.clientId,
      },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(ok.statusCode).toBe(201);
    const attachments = await harness.db
      .select()
      .from(clientRequestAttachments)
      .where(eq(clientRequestAttachments.clientRequestId, requestId));
    expect(attachments).toHaveLength(1);

    // Make a file belonging to another client.
    const otherClient = await harness.db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
          VALUES (${ctx.firmId}, 'OtherCo',
                  (SELECT id FROM app_user WHERE firm_id = ${ctx.firmId} LIMIT 1),
                  (SELECT id FROM office WHERE firm_id = ${ctx.firmId} ORDER BY is_default DESC LIMIT 1))
          RETURNING id`,
    );
    const otherClientId = (otherClient as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherFolder = await harness.db.execute(
      sql`INSERT INTO client_folders (firm_id, client_id, status, storage_path)
          VALUES (${ctx.firmId}, ${otherClientId}, 'active', 'o/o') RETURNING id`,
    );
    const otherFolderId = (otherFolder as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherFile = await harness.db.execute(
      sql`INSERT INTO files (firm_id, client_id, client_folder_id, subfolder_path,
                              original_filename, mime_type, size_bytes, storage_key, visibility)
          VALUES (${ctx.firmId}, ${otherClientId}, ${otherFolderId}, '',
                  'x.pdf', 'application/pdf', 10, 'o/o/x.pdf', 'client_visible')
          RETURNING id`,
    );
    const otherFileId = (otherFile as unknown as { rows: { id: string }[] }).rows[0]!.id;

    const denied = await invoke(ctx.router, 'post', '/:id/attachments', {
      body: { fileId: otherFileId },
      params: { id: requestId },
      query: {},
      portalSession: {
        portalIdentityId: ctx.portalIdentityId,
        activeClientId: ctx.clientId,
      },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(denied.statusCode).toBe(404);
  });

  it('POST /:id/items/:itemId/fulfill rolls up parent when all required items done', async () => {
    const ctx = await setupPortal();
    const { requestId, itemIds } = await seedRequestWith(harness.db, ctx.firmId, ctx.engagementId, [
      { label: 'A', required: true },
      { label: 'B', required: false },
    ]);
    const r = await invoke(ctx.router, 'post', '/:id/items/:itemId/fulfill', {
      body: { fileId: ctx.fileId },
      params: { id: requestId, itemId: itemIds[0]! },
      query: {},
      portalSession: {
        portalIdentityId: ctx.portalIdentityId,
        activeClientId: ctx.clientId,
      },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    expect(r.statusCode).toBe(200);
    const [parent] = await harness.db
      .select()
      .from(clientRequests)
      .where(eq(clientRequests.id, requestId));
    expect(parent!.status).toBe('FULFILLED');
    const [item] = await harness.db
      .select()
      .from(clientRequestItems)
      .where(eq(clientRequestItems.id, itemIds[0]!));
    expect(item!.status).toBe('FULFILLED');
    expect(item!.fulfilledByPortalIdentityId).toBe(ctx.portalIdentityId);
  });

  it('cross-client request is 404 on detail, reply, needs-info, attachments, item-fulfill', async () => {
    const ctx = await setupPortal();
    // Another client's request — same firm, different client_id.
    const otherClient = await harness.db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
          VALUES (${ctx.firmId}, 'OtherCo',
                  (SELECT id FROM app_user WHERE firm_id = ${ctx.firmId} LIMIT 1),
                  (SELECT id FROM office WHERE firm_id = ${ctx.firmId} ORDER BY is_default DESC LIMIT 1))
          RETURNING id`,
    );
    const otherClientId = (otherClient as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const otherEng = await harness.db.execute(
      sql`INSERT INTO engagement (client_id, name, fee_structure)
          VALUES (${otherClientId}, 'Other', 'HOURLY') RETURNING id`,
    );
    const otherEngId = (otherEng as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const { requestId, itemIds } = await seedRequestWith(harness.db, ctx.firmId, otherEngId, [
      { label: 'i', required: true },
    ]);
    const baseReq = {
      body: {},
      query: {},
      portalSession: {
        portalIdentityId: ctx.portalIdentityId,
        activeClientId: ctx.clientId,
      },
      ip: '127.0.0.1',
      get: () => undefined,
    };
    expect(
      (
        await invoke(ctx.router, 'get', '/:id', {
          ...baseReq,
          params: { id: requestId },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await invoke(ctx.router, 'post', '/:id/reply', {
          ...baseReq,
          body: { text: 'hi' },
          params: { id: requestId },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await invoke(ctx.router, 'post', '/:id/needs-info', {
          ...baseReq,
          body: { text: 'hi' },
          params: { id: requestId },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await invoke(ctx.router, 'post', '/:id/attachments', {
          ...baseReq,
          body: { fileId: ctx.fileId },
          params: { id: requestId },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await invoke(ctx.router, 'post', '/:id/items/:itemId/fulfill', {
          ...baseReq,
          params: { id: requestId, itemId: itemIds[0]! },
        })
      ).statusCode,
    ).toBe(404);
  });
});
