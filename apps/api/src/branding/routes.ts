// SPDX-License-Identifier: Elastic-2.0
//
// Firm logo upload + public branding asset serving.
//
//  - Admin (firm:settings:write): the wide logo and a square icon source are
//    POSTed as bytes through the API (small images), which stores them and sets
//    the wide logo's effective URL (brand_logo_url) to the public endpoint; the
//    square source is resized into the PWA/Apple icons. External URL still works.
//  - Public (no auth): serves the wide logo and the generated icons so the
//    portal login screen, shared pages, PDFs (Puppeteer), and the PWA manifest
//    can all fetch them without a session. Single-firm appliance → first firm.

import { type Request, type Response, type Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { firmSettings, firms } from '@vibe/db/schema';
import { buildStorageClient, type StorageClient } from '@vibe/storage';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';
import { ICON_SPECS, renderDefaultIcon, renderIconFromSource } from './icons';

const LOGO_KEY = 'branding/logo';
const ICON_SOURCE_KEY = 'branding/icon-source';
const iconKey = (name: string): string => `branding/${name}`;

const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];
const ICON_TYPES = ['image/png', 'image/jpeg', 'image/webp']; // raster only — canvas can't decode SVG
const MAX_BYTES = 5 * 1024 * 1024; // 5MB — plenty for a logo/icon

export interface BrandingAdminDeps extends RbacDeps {
  db: Database | null;
  storageClient?: StorageClient;
  /** Absolute base (APP_BASE_URL) for the stored effective logo URL. */
  appBaseUrl: string;
}

export interface BrandingPublicDeps {
  db: Database | null;
  storageClient?: StorageClient;
}

function getStorage(client?: StorageClient): StorageClient | null {
  if (client) return client;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}

async function streamBody(body: NodeJS.ReadableStream, res: Response): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    body.on('error', reject);
    body.on('end', resolve);
    body.pipe(res);
  });
}

// ---------------------------------------------------------------------------
// Admin: upload + remove
// ---------------------------------------------------------------------------

const UploadSchema = z.object({
  contentType: z.string().min(1).max(120),
  // data URL or bare base64 of the image bytes.
  dataBase64: z.string().min(1),
});

function decodeImage(dataBase64: string): Buffer {
  const comma = dataBase64.indexOf(',');
  const b64 =
    dataBase64.startsWith('data:') && comma >= 0 ? dataBase64.slice(comma + 1) : dataBase64;
  return Buffer.from(b64, 'base64');
}

async function bumpVersion(db: Database, firmId: string): Promise<number> {
  const [s] = await db
    .select({ v: firmSettings.brandAssetsVersion })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, firmId))
    .limit(1);
  return (s?.v ?? 0) + 1;
}

async function audit(db: Database, req: Request, kind: string): Promise<void> {
  await emitAudit(db, {
    action: 'UPDATE',
    entityType: 'firm_settings',
    entityId: req.staffSession!.firmId,
    actorAppUserId: req.staffSession!.appUserId,
    after: { brandingAsset: kind, uploaded: true },
  }).catch(() => undefined);
}

export function createBrandingAdminRouter(deps: BrandingAdminDeps): Router {
  const router = express.Router();

  // Upload the wide logo: stored as-is and served from the public endpoint.
  router.post(
    '/logo',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const parsed = UploadSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      if (!LOGO_TYPES.includes(parsed.data.contentType)) {
        res.status(400).json({ error: 'unsupported_type', allowed: LOGO_TYPES });
        return;
      }
      const buf = decodeImage(parsed.data.dataBase64);
      if (buf.length === 0 || buf.length > MAX_BYTES) {
        res.status(400).json({ error: 'invalid_size' });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const storage = getStorage(deps.storageClient);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      await storage.put(LOGO_KEY, buf, { contentType: parsed.data.contentType });
      const version = await bumpVersion(deps.db, firmId);
      await deps.db
        .update(firmSettings)
        .set({
          brandLogoStorageKey: LOGO_KEY,
          brandLogoUrl: `${deps.appBaseUrl}/api/portal/branding/logo?v=${version}`,
          brandAssetsVersion: version,
          updatedAt: new Date(),
        })
        .where(eq(firmSettings.firmId, firmId));
      await audit(deps.db, req, 'logo');
      res.json({ ok: true, version });
    },
  );

  // Upload the square icon source: resized into the PWA/Apple icon set.
  router.post(
    '/icon',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const parsed = UploadSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      if (!ICON_TYPES.includes(parsed.data.contentType)) {
        res.status(400).json({ error: 'unsupported_type', allowed: ICON_TYPES });
        return;
      }
      const source = decodeImage(parsed.data.dataBase64);
      if (source.length === 0 || source.length > MAX_BYTES) {
        res.status(400).json({ error: 'invalid_size' });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const storage = getStorage(deps.storageClient);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const [s] = await deps.db
        .select({ accent: firmSettings.brandAccentColor })
        .from(firmSettings)
        .where(eq(firmSettings.firmId, firmId))
        .limit(1);
      const accent = s?.accent ?? undefined;
      for (const [name, spec] of Object.entries(ICON_SPECS)) {
        let png: Buffer;
        try {
          png = await renderIconFromSource(source, spec, accent ?? undefined);
        } catch {
          res.status(400).json({ error: 'icon_decode_failed' });
          return;
        }
        await storage.put(iconKey(name), png, { contentType: 'image/png' });
      }
      await storage.put(ICON_SOURCE_KEY, source, { contentType: parsed.data.contentType });
      const version = await bumpVersion(deps.db, firmId);
      await deps.db
        .update(firmSettings)
        .set({
          brandIconStorageKey: ICON_SOURCE_KEY,
          brandAssetsVersion: version,
          updatedAt: new Date(),
        })
        .where(eq(firmSettings.firmId, firmId));
      await audit(deps.db, req, 'icon');
      res.json({ ok: true, version });
    },
  );

  router.delete(
    '/:kind',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const kind = req.params['kind'];
      if (kind !== 'logo' && kind !== 'icon') {
        res.status(400).json({ error: 'invalid_kind' });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const storage = getStorage(deps.storageClient);
      const [settings] = await deps.db
        .select({
          version: firmSettings.brandAssetsVersion,
          logoKey: firmSettings.brandLogoStorageKey,
        })
        .from(firmSettings)
        .where(eq(firmSettings.firmId, firmId))
        .limit(1);
      const version = (settings?.version ?? 0) + 1;

      if (kind === 'logo') {
        await storage?.delete(LOGO_KEY).catch(() => undefined);
        await deps.db
          .update(firmSettings)
          .set({
            brandLogoStorageKey: null,
            // Only clear the effective URL if it was our uploaded one.
            ...(settings?.logoKey ? { brandLogoUrl: null } : {}),
            brandAssetsVersion: version,
            updatedAt: new Date(),
          })
          .where(eq(firmSettings.firmId, firmId));
      } else {
        await storage?.delete(ICON_SOURCE_KEY).catch(() => undefined);
        for (const name of Object.keys(ICON_SPECS)) {
          await storage?.delete(iconKey(name)).catch(() => undefined);
        }
        await deps.db
          .update(firmSettings)
          .set({
            brandIconStorageKey: null,
            brandAssetsVersion: version,
            updatedAt: new Date(),
          })
          .where(eq(firmSettings.firmId, firmId));
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'firm_settings',
        entityId: firmId,
        actorAppUserId: req.staffSession!.appUserId,
        after: { brandingAsset: kind, removed: true },
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  return router;
}

// ---------------------------------------------------------------------------
// Public: serve logo + icons (no auth — single-firm appliance)
// ---------------------------------------------------------------------------

async function firstFirmBranding(db: Database): Promise<{
  logoKey: string | null;
  logoUrl: string | null;
  iconKey: string | null;
  accent: string | null;
} | null> {
  const [firm] = await db.select({ id: firms.id }).from(firms).limit(1);
  if (!firm) return null;
  const [s] = await db
    .select({
      logoKey: firmSettings.brandLogoStorageKey,
      logoUrl: firmSettings.brandLogoUrl,
      iconKey: firmSettings.brandIconStorageKey,
      accent: firmSettings.brandAccentColor,
    })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, firm.id))
    .limit(1);
  return s ?? { logoKey: null, logoUrl: null, iconKey: null, accent: null };
}

export function createBrandingPublicRouter(deps: BrandingPublicDeps): Router {
  const router = express.Router();

  router.get('/logo', async (_req: Request, res: Response) => {
    if (!deps.db) {
      res.status(404).end();
      return;
    }
    const b = await firstFirmBranding(deps.db);
    const storage = getStorage(deps.storageClient);
    if (b?.logoKey && storage) {
      try {
        const { body, meta } = await storage.get(b.logoKey);
        res.setHeader('Content-Type', meta.contentType ?? 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=300');
        await streamBody(body, res);
        return;
      } catch (err) {
        logger.error({ err }, 'branding logo stream failed');
      }
    }
    // No uploaded asset — redirect to an external URL if one is set.
    if (b?.logoUrl) {
      res.redirect(302, b.logoUrl);
      return;
    }
    res.status(404).end();
  });

  router.get('/:icon', async (req: Request, res: Response) => {
    const name = req.params['icon']!;
    const spec = ICON_SPECS[name];
    if (!spec) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    const b = deps.db ? await firstFirmBranding(deps.db) : null;
    const storage = getStorage(deps.storageClient);
    if (b?.iconKey && storage) {
      try {
        const { body } = await storage.get(iconKey(name));
        await streamBody(body, res);
        return;
      } catch {
        /* fall through to default */
      }
    }
    // No uploaded mark (or read failed) — render the accent-color default.
    res.end(renderDefaultIcon(spec, b?.accent ?? undefined));
  });

  return router;
}
