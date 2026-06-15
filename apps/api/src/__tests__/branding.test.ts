// SPDX-License-Identifier: Elastic-2.0
//
// 0162 — firm logo upload + public branding serving. Proves: icon generation
// produces square PNGs; completing a logo upload points brand_logo_url at the
// public endpoint; completing an icon upload resizes the source into the icon
// set; the public endpoints serve the stored asset (or an accent default); and
// an external URL falls back via redirect.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Readable } from 'node:stream';
import { eq, sql } from 'drizzle-orm';
import { loadImage } from '@napi-rs/canvas';

import { firmSettings } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createBrandingAdminRouter, createBrandingPublicRouter } from '../branding/routes';
import { renderDefaultIcon, ICON_SPECS } from '../branding/icons';

// Minimal in-memory storage implementing only what the branding routes use.
function makeStorage(): {
  client: StorageClient;
  store: Map<string, { buf: Buffer; ct?: string }>;
} {
  const store = new Map<string, { buf: Buffer; ct?: string }>();
  const client = {
    kind: 'mock',
    presignPut: async (key: string) => `mock://${key}`,
    head: async (key: string) =>
      store.has(key)
        ? { key, size: store.get(key)!.buf.length, contentType: store.get(key)!.ct }
        : null,
    get: async (key: string) => {
      const v = store.get(key);
      if (!v) throw new Error('not_found');
      return { body: Readable.from(v.buf), meta: { key, size: v.buf.length, contentType: v.ct } };
    },
    put: async (key: string, body: Buffer, opts?: { contentType?: string }) => {
      store.set(key, { buf: body as Buffer, ct: opts?.contentType });
      return { etag: 'x' };
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as StorageClient;
  return { client, store };
}

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let storage: ReturnType<typeof makeStorage>;

function adminApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  app.use(
    '/api/staff/admin/branding',
    createBrandingAdminRouter({
      db: harness.db,
      storageClient: storage.client,
      appBaseUrl: 'https://app.example',
      fakeUserRoles: new Map([[seed.appUserId, ['admin']]]),
    }),
  );
  return app;
}

function publicApp(): express.Express {
  const app = express();
  app.use(
    '/api/portal/branding',
    createBrandingPublicRouter({ db: harness.db, storageClient: storage.client }),
  );
  return app;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  storage = makeStorage();
  await harness.db.execute(
    sql`INSERT INTO firm_settings (firm_id) VALUES (${seed.firmId})
        ON CONFLICT (firm_id) DO NOTHING`,
  );
});
afterEach(async () => {
  await harness.close();
});

describe('branding icon generation', () => {
  it('renders square PNGs at the requested sizes', async () => {
    const png = renderDefaultIcon(ICON_SPECS['icon-192.png']!);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); // PNG signature
    const img = await loadImage(png);
    expect(img.width).toBe(192);
    expect(img.height).toBe(192);
  });
});

describe('branding admin + public', () => {
  it('logo complete points brand_logo_url at the public endpoint', async () => {
    storage.store.set('branding/logo', { buf: Buffer.from('PNGDATA'), ct: 'image/png' });
    const res = await request(adminApp())
      .post('/api/staff/admin/branding/complete')
      .send({ kind: 'logo' });
    expect(res.status).toBe(200);
    const [s] = await harness.db
      .select()
      .from(firmSettings)
      .where(eq(firmSettings.firmId, seed.firmId));
    expect(s!.brandLogoStorageKey).toBe('branding/logo');
    expect(s!.brandLogoUrl).toBe('https://app.example/api/portal/branding/logo?v=1');
    expect(s!.brandAssetsVersion).toBe(1);
  });

  it('icon complete resizes the source into the icon set', async () => {
    // A valid square PNG source the canvas can decode.
    storage.store.set('branding/icon-source', {
      buf: renderDefaultIcon(ICON_SPECS['icon-512.png']!),
      ct: 'image/png',
    });
    const res = await request(adminApp())
      .post('/api/staff/admin/branding/complete')
      .send({ kind: 'icon' });
    expect(res.status).toBe(200);
    for (const name of Object.keys(ICON_SPECS)) {
      expect(storage.store.has(`branding/${name}`)).toBe(true);
    }
    const [s] = await harness.db
      .select()
      .from(firmSettings)
      .where(eq(firmSettings.firmId, seed.firmId));
    expect(s!.brandIconStorageKey).toBe('branding/icon-source');
  });

  it('serves a generated default icon when nothing is uploaded', async () => {
    const res = await request(publicApp()).get('/api/portal/branding/icon-192.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.body.length).toBeGreaterThan(100);
  });

  it('redirects the logo to an external URL when no asset is uploaded', async () => {
    await harness.db
      .update(firmSettings)
      .set({ brandLogoUrl: 'https://cdn.example/logo.png' })
      .where(eq(firmSettings.firmId, seed.firmId));
    const res = await request(publicApp()).get('/api/portal/branding/logo');
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('https://cdn.example/logo.png');
  });
});
