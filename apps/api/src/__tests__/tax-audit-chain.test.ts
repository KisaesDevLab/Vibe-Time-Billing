// SPDX-License-Identifier: Elastic-2.0
//
// TR-8b — End-to-end audit-chain test.
//
// Drives the lifecycle: staff creates a release → client creates a
// share → recipient views → client revokes. Verifies the
// tax_return_access_log captures each event with the right actor
// kind + share id linkage.

import { Readable } from 'node:stream';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';

import type { StorageClient } from '@vibe/storage';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import {
  clientFolders,
  files,
  taxReturnAccessLog,
  taxReturnReleases,
  taxReturnSections,
  taxReturns,
} from '@vibe/db/schema';
import { createTaxReturnRouter } from '../tax-returns/routes';
import { createPortalTaxShareRouter } from '../portal/tax-shares';
import { createShareRecipientRouter } from '../share-public/tax-recipient';

const SOURCE_KEY = 'Test Client Co/Tax Returns/2025-1040.pdf';

async function makeSourcePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([300, 300]);
  return Buffer.from(await doc.save());
}

function storageWith(entries: Record<string, Buffer>): StorageClient {
  return {
    kind: 'mock',
    async get(key: string) {
      const bytes = entries[key];
      if (!bytes) throw new Error(`object not found: ${key}`);
      return { body: Readable.from(bytes), meta: {} };
    },
  } as unknown as StorageClient;
}

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

async function setup(): Promise<{
  firmId: string;
  appUserId: string;
  clientId: string;
  accessId: string;
  returnId: string;
  releaseId: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  // Seed a source PDF file so the recipient /pdf render path can deliver
  // bytes (and thus log a real VIEW on delivery).
  const [folder] = await harness.db
    .insert(clientFolders)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      storagePath: 'Test Client Co',
    })
    .returning({ id: clientFolders.id });
  const [file] = await harness.db
    .insert(files)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      clientFolderId: folder!.id,
      originalFilename: '2025-1040.pdf',
      storageKey: SOURCE_KEY,
      mimeType: 'application/pdf',
      sizeBytes: 1024,
    })
    .returning({ id: files.id });
  const [r] = await harness.db
    .insert(taxReturns)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      sourceFileId: file!.id,
      taxYear: 2025,
      formCode: '1040',
      title: 'T',
      status: 'PARSED',
      totalPages: 5,
    })
    .returning();
  await harness.db.insert(taxReturnSections).values({
    returnId: r!.id,
    ordinal: 0,
    rawTitle: 'Form 1040',
    normalizedTitle: 'Form 1040',
    kind: 'MAIN_FORM',
    startPage: 1,
    endPage: 5,
  });
  const identity = await harness.db.execute(
    sql`INSERT INTO portal_identity (firm_id, full_name, primary_email)
        VALUES (${seed.firmId}, 'C', 'c@x.example') RETURNING id`,
  );
  const identityId = (identity as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const access = await harness.db.execute(
    sql`INSERT INTO client_portal_access (portal_identity_id, client_id, status, role)
        VALUES (${identityId}, ${seed.clientId}, 'ACTIVE', 'FULL') RETURNING id`,
  );
  const accessId = (access as unknown as { rows: { id: string }[] }).rows[0]!.id;
  return {
    firmId: seed.firmId,
    appUserId: seed.appUserId,
    clientId: seed.clientId,
    accessId,
    returnId: r!.id,
    releaseId: '', // populated by the test as it goes
  };
}

describe('TR-8b — full audit chain', () => {
  it('release → share → view → revoke produces a complete access log', async () => {
    const f = await setup();

    // --- 1. Staff creates a release (audit: RELEASED actor=STAFF) ---
    const staffRouter = createTaxReturnRouter({
      db: harness.db,
      fakeUserRoles: new Map([[f.appUserId, ['partner']]]),
    });
    const staffApp = express();
    staffApp.use(express.json());
    staffApp.use((req, _res, next) => {
      (req as unknown as { staffSession: unknown }).staffSession = {
        firmId: f.firmId,
        appUserId: f.appUserId,
      };
      next();
    });
    staffApp.use(staffRouter);

    const relRes = await request(staffApp).post(`/${f.returnId}/releases`).send({
      releasedToClientId: f.clientId,
      scope: 'FULL',
      sectionIds: [],
      clientCanDownload: true,
      coverNote: null,
    });
    expect(relRes.status).toBe(201);
    const releaseId = (relRes.body as { releaseId: string }).releaseId;

    // --- 2. Client creates a share (audit: SHARED actor=CLIENT) ---
    const portalApp = express();
    portalApp.use(express.json());
    portalApp.use((req, _res, next) => {
      (req as unknown as { portalSession: unknown }).portalSession = {
        portalIdentityId: 'unused',
        activeClientId: f.clientId,
        activeClientAccessId: f.accessId,
      };
      next();
    });
    portalApp.use(
      createPortalTaxShareRouter({
        db: harness.db,
        requireAuth: (_req, _res, next) => next(),
        portalBaseUrl: 'https://portal.example.test',
      }),
    );

    const shareRes = await request(portalApp)
      .post(`/${f.returnId}/shares`)
      .send({
        recipientName: 'Banker',
        recipientEmail: 'banker@chase.example',
        organization: 'Chase',
        role: 'lender',
        accessLevel: 'view_only',
        scope: 'FULL',
        sectionIds: [],
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
        require2fa: false,
        verifyChannel: 'NONE',
        watermark: true,
        personalMessage: '',
      });
    expect(shareRes.status).toBe(201);
    const shareId = (shareRes.body as { shareId: string }).shareId;
    // The recipient link carries the token: …/shared/tax/<token>.
    const shareUrl = (shareRes.body as { shareUrl: string }).shareUrl;
    expect(shareUrl).toContain('/shared/tax/');
    const token = shareUrl.split('/shared/tax/')[1]!;
    expect(token).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,}$/);

    // --- 3. Recipient hits 2FA verify (audit: 2FA_PASSED) + view (VIEW) ---
    const recipientApp = express();
    recipientApp.use(express.json());
    recipientApp.use(
      '/shared/tax',
      createShareRecipientRouter({
        db: harness.db,
        storage: storageWith({ [SOURCE_KEY]: await makeSourcePdf(5) }),
      }),
    );

    const verifyRes = await request(recipientApp)
      .post(`/shared/tax/${token}/2fa/verify`)
      .send({ code: '000000' });
    expect(verifyRes.status).toBe(200);

    // Storage is wired, so the scoped PDF renders and a VIEW is logged
    // on delivery.
    const pdfRes = await request(recipientApp).get(`/shared/tax/${token}/pdf`);
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers['content-type']).toContain('application/pdf');

    // --- 4. Client revokes (audit: REVOKED actor=CLIENT) ---
    const revokeRes = await request(portalApp).post(`/${f.returnId}/shares/${shareId}/revoke`);
    expect(revokeRes.status).toBe(204);

    // --- 5. Verify the access log ---
    const log = await harness.db
      .select()
      .from(taxReturnAccessLog)
      .where(sql`return_id = ${f.returnId}`);

    // Expect at least: RELEASED-staff, RELEASED-client (share),
    // 2FA_PASSED-recipient, VIEW-recipient, REVOKED-client.
    const events = log.map((r) => ({
      event: r.event,
      actorKind: r.actorKind,
      shareId: r.shareId,
    }));
    expect(events.length).toBeGreaterThanOrEqual(5);

    // Staff RELEASED (no share id)
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'RELEASED', actorKind: 'STAFF', shareId: null }),
    );
    // Client SHARED (3rd-party share created — has share id)
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'SHARED', actorKind: 'CLIENT', shareId }),
    );
    // 2FA pass + VIEW from recipient
    expect(events).toContainEqual(
      expect.objectContaining({ event: '2FA_PASSED', actorKind: 'RECIPIENT', shareId }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'VIEW', actorKind: 'RECIPIENT', shareId }),
    );
    // Client REVOKED (linked to share)
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'REVOKED', actorKind: 'CLIENT', shareId }),
    );

    // Use releaseId to silence unused-var
    void releaseId;
    void taxReturnReleases;
  });
});
