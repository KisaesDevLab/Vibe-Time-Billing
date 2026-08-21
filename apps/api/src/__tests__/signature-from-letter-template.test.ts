// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0221 — letter-template → signature-request bridge. Renders the letter
// (stubbed PDF), stores it as the request source, and pre-places the
// engagement-letter profile's fields (shifted to the LAST page) for
// signers with role 'client'.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { eq } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import {
  engagementLetterTemplates,
  signatureFieldPlacements,
  signatureRequests,
  signatureSigners,
} from '@vibe/db/schema';
import type { Database } from '@vibe/db';
import { MockStorageClient } from '@vibe/storage';

import { createSignaturesRouter } from '../signatures/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let storage: MockStorageClient;
let tmpDir: string;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  tmpDir = mkdtempSync(join(tmpdir(), 'sig-letter-'));
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

/** Two-page stub PDF standing in for the Puppeteer render. */
async function stubPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

async function invoke(
  body: Record<string, unknown>,
): Promise<{ statusCode: number; body: unknown }> {
  const router = createSignaturesRouter({
    db: harness.db as Database,
    fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    storageClient: storage,
    renderPdf: async () => stubPdf(),
  });
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
    (l) => l.route && l.route.path === '/from-letter-template' && l.route.methods['post'],
  );
  if (!layer?.route) throw new Error('route not registered');
  const handler = layer.route.stack[layer.route.stack.length - 1]!.handle;
  const req = {
    body,
    params: {},
    query: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
  await (handler as (rq: unknown, rs: unknown) => Promise<void>)(req, res);
  return res;
}

describe('0221 — signature request from letter template', () => {
  it('renders, stores source, seeds profile, places fields on the last page', async () => {
    const [tpl] = await harness.db
      .insert(engagementLetterTemplates)
      .values({
        firmId: seed.firmId,
        key: 'el_test',
        name: 'Engagement letter (test)',
        bodyHtml: '<p>Dear {{client.name}},</p>',
      })
      .returning({ id: engagementLetterTemplates.id });

    const res = await invoke({
      letterTemplateId: tpl!.id,
      clientId: seed.clientId,
      engagementId: seed.engagementId,
      signers: [{ name: 'Casey Client', email: 'casey@client.example' }],
    });
    expect(res.statusCode).toBe(201);
    const { id, pages, placements, profileApplied } = res.body as {
      id: string;
      pages: number;
      placements: number;
      profileApplied: boolean;
    };
    expect(pages).toBe(2);
    expect(profileApplied).toBe(true);
    expect(placements).toBeGreaterThan(0);

    const [reqRow] = await harness.db
      .select()
      .from(signatureRequests)
      .where(eq(signatureRequests.id, id));
    expect(reqRow!.status).toBe('draft');
    expect(reqRow!.formType).toBe('engagement-letter');
    expect(reqRow!.sourceFileKey).toBe(`signatures/${seed.firmId}/${id}/source.pdf`);
    expect(await storage.head(reqRow!.sourceFileKey!)).not.toBeNull();

    const signers = await harness.db
      .select()
      .from(signatureSigners)
      .where(eq(signatureSigners.requestId, id));
    expect(signers).toHaveLength(1);
    expect(signers[0]!.role).toBe('client');

    const placed = await harness.db
      .select()
      .from(signatureFieldPlacements)
      .where(eq(signatureFieldPlacements.requestId, id));
    expect(placed.length).toBe(placements);
    // Profile fields land on the LAST page of the rendered letter.
    expect(placed.every((p) => p.pageNumber === 2)).toBe(true);
    expect(placed.some((p) => p.fieldType === 'signature')).toBe(true);
  });

  it('404s on a template from another firm / unknown id', async () => {
    const res = await invoke({
      letterTemplateId: '00000000-0000-4000-8000-00000000dead',
      clientId: seed.clientId,
      signers: [{ name: 'Casey Client', email: 'casey@client.example' }],
    });
    expect(res.statusCode).toBe(404);
  });
});
