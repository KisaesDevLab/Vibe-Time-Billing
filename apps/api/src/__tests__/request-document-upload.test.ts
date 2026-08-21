// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0220 — direct DOCUMENT-item upload on client requests (the 0219
// document_requests consolidation). Covers: staff create with a target
// subfolder, portal upload → file lands in that subfolder + attachment
// row + item FULFILLED + parent roll-up, and the guards (non-DOCUMENT
// item, closed request).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import {
  clientFolders,
  clientRequestAttachments,
  clientRequestItems,
  clientRequests,
  files,
} from '@vibe/db/schema';
import type { Database } from '@vibe/db';
import { MockStorageClient } from '@vibe/storage';

import { createPortalRequestsRouter } from '../portal/requests';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let storage: MockStorageClient;
let tmpDir: string;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  await seedIdentity();
  tmpDir = mkdtempSync(join(tmpdir(), 'req-doc-upload-'));
  storage = new MockStorageClient({ rootPath: tmpDir });
});

afterEach(async () => {
  await harness.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const FOLDER_PATH = 'Client Files/Test Client/';
let identityId: string;

async function seedIdentity(): Promise<void> {
  const r = await harness.db.execute(
    (await import('drizzle-orm')).sql`
      INSERT INTO portal_identity (firm_id, full_name, primary_email)
      VALUES (${seed.firmId}, 'Portal Pat', 'pat@client.example') RETURNING id`,
  );
  identityId = (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

async function bindFolder(): Promise<void> {
  await harness.db.insert(clientFolders).values({
    firmId: seed.firmId,
    clientId: seed.clientId,
    storagePath: FOLDER_PATH,
    status: 'active',
  });
}

async function makeRequest(
  itemKinds: ('DOCUMENT' | 'QUESTION')[],
  targetSubfolderPath = 'Income Tax/2026/',
): Promise<{ requestId: string; itemIds: string[] }> {
  const [reqRow] = await harness.db
    .insert(clientRequests)
    .values({
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      title: '2026 tax prep documents',
      status: 'OPEN',
      targetSubfolderPath,
    })
    .returning({ id: clientRequests.id });
  const requestId = reqRow!.id;
  const itemIds: string[] = [];
  for (const [i, kind] of itemKinds.entries()) {
    const [item] = await harness.db
      .insert(clientRequestItems)
      .values({
        clientRequestId: requestId,
        ordinal: i,
        label: `Item ${i}`,
        itemKind: kind,
        required: true,
      })
      .returning({ id: clientRequestItems.id });
    itemIds.push(item!.id);
  }
  return { requestId, itemIds };
}

function buildRouter() {
  return createPortalRequestsRouter({
    db: harness.db as Database,
    requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
    storageClient: storage,
  });
}

async function invokeUpload(
  router: ReturnType<typeof buildRouter>,
  requestId: string,
  itemId: string,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; body: unknown }> {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(n: number) {
      this.statusCode = n;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  const stack = (
    router as unknown as {
      stack: {
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: { handle: (...a: unknown[]) => unknown }[];
        };
      }[];
    }
  ).stack;
  const layer = stack.find(
    (l) => l.route && l.route.path === '/:id/items/:itemId/upload' && l.route.methods['post'],
  );
  if (!layer?.route) throw new Error('upload route not registered');
  const handler = layer.route.stack[layer.route.stack.length - 1]!.handle;
  const req = {
    body,
    params: { id: requestId, itemId },
    query: {},
    portalSession: {
      firmId: seed.firmId,
      activeClientId: seed.clientId,
      portalIdentityId: identityId,
    },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
  await (handler as (rq: unknown, rs: unknown) => Promise<void>)(req, res);
  return res;
}

const GOOD_BODY = {
  originalFilename: 'w2.pdf',
  mimeType: 'application/pdf',
  contentBase64: Buffer.from('W2DATA').toString('base64'),
};

describe('0220 — portal DOCUMENT-item upload', () => {
  it('stores the file in the target subfolder, attaches, fulfills, rolls up', async () => {
    await bindFolder();
    const { requestId, itemIds } = await makeRequest(['DOCUMENT']);
    const res = await invokeUpload(buildRouter(), requestId, itemIds[0]!, GOOD_BODY);
    expect(res.statusCode).toBe(201);
    const fileId = (res.body as { fileId: string }).fileId;

    const [fileRow] = await harness.db.select().from(files).where(eq(files.id, fileId));
    expect(fileRow!.subfolderPath).toBe('Income Tax/2026/');
    expect(fileRow!.storageKey).toBe(`${FOLDER_PATH}Income Tax/2026/w2.pdf`);
    expect(fileRow!.visibility).toBe('private');
    expect(await storage.head(fileRow!.storageKey)).not.toBeNull();

    const [att] = await harness.db
      .select()
      .from(clientRequestAttachments)
      .where(eq(clientRequestAttachments.clientRequestId, requestId));
    expect(att!.fileId).toBe(fileId);
    expect(att!.clientRequestItemId).toBe(itemIds[0]);
    expect(att!.uploadedByPortalIdentityId).toBe(identityId);

    const [item] = await harness.db
      .select()
      .from(clientRequestItems)
      .where(eq(clientRequestItems.id, itemIds[0]!));
    expect(item!.status).toBe('FULFILLED');
    expect(item!.fulfilledByFileId).toBe(fileId);

    // Sole required item fulfilled → parent rolls up.
    const [reqRow] = await harness.db
      .select()
      .from(clientRequests)
      .where(eq(clientRequests.id, requestId));
    expect(reqRow!.status).toBe('FULFILLED');
  });

  it('does not roll up while other required items stay open', async () => {
    await bindFolder();
    const { requestId, itemIds } = await makeRequest(['DOCUMENT', 'DOCUMENT']);
    await invokeUpload(buildRouter(), requestId, itemIds[0]!, GOOD_BODY);
    const [reqRow] = await harness.db
      .select()
      .from(clientRequests)
      .where(eq(clientRequests.id, requestId));
    expect(reqRow!.status).toBe('OPEN');
  });

  it('refuses a QUESTION item and a closed request', async () => {
    await bindFolder();
    const { requestId, itemIds } = await makeRequest(['QUESTION', 'DOCUMENT']);
    const wrongKind = await invokeUpload(buildRouter(), requestId, itemIds[0]!, GOOD_BODY);
    expect(wrongKind.statusCode).toBe(409);
    expect((wrongKind.body as { error: string }).error).toBe('not_a_document_item');

    await harness.db
      .update(clientRequests)
      .set({ status: 'DISMISSED' })
      .where(eq(clientRequests.id, requestId));
    const closed = await invokeUpload(buildRouter(), requestId, itemIds[1]!, GOOD_BODY);
    expect(closed.statusCode).toBe(409);
    expect((closed.body as { error: string }).error).toBe('request_closed');
  });

  it('refuses when the client folder is not bound', async () => {
    const { requestId, itemIds } = await makeRequest(['DOCUMENT']);
    const res = await invokeUpload(buildRouter(), requestId, itemIds[0]!, GOOD_BODY);
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toBe('client_folder_not_bound');
  });
});
