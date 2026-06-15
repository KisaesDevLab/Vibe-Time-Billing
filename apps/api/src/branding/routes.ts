// SPDX-License-Identifier: Elastic-2.0
//
// Firm logo upload + public branding asset serving.
//
//  - Admin (firm:settings:write): a two-leg presigned-PUT upload (mirrors the
//    client-file pattern) for the wide logo and a square icon source. On
//    "complete" the wide logo's effective URL (brand_logo_url) is pointed at
//    the public endpoint; the square source is resized into the PWA/Apple
//    icons. Firms can still paste an external URL instead.
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

const PRESIGN_TTL_SECONDS = 15 * 60;
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];
const ICON_TYPES = ['image/png', 'image/jpeg', 'image/webp']; // raster only — canvas can't decode SVG

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

const UploadUrlSchema = z.object({
  kind: z.enum(['logo', 'icon']),
  contentType: z.string().min(1).max(120),
});
const CompleteSchema = z.object({ kind: z.enum(['logo', 'icon']) });

export function createBrandingAdminRouter(deps: BrandingAdminDeps): Router {
  const router = express.Router();

  router.post(
    '/upload-url',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const parsed = UploadUrlSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const { kind, contentType } = parsed.data;
      const allowed = kind === 'logo' ? LOGO_TYPES : ICON_TYPES;
      if (!allowed.includes(contentType)) {
        res.status(400).json({ error: 'unsupported_type', allowed });
        return;
      }
      const storage = getStorage(deps.storageClient);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const key = kind === 'logo' ? LOGO_KEY : ICON_SOURCE_KEY;
      const url = await storage.presignPut(key, { contentType }, PRESIGN_TTL_SECONDS);
      res.json({ url, key });
    },
  );

  router.post(
    '/complete',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const parsed = CompleteSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
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
      const [settings] = await deps.db
        .select({
          version: firmSettings.brandAssetsVersion,
          accent: firmSettings.brandAccentColor,
        })
        .from(firmSettings)
        .where(eq(firmSettings.firmId, firmId))
        .limit(1);
      const version = (settings?.version ?? 0) + 1;

      if (parsed.data.kind === 'logo') {
        const meta = await storage.head(LOGO_KEY);
        if (!meta) {
          res.status(400).json({ error: 'upload_not_found' });
          return;
        }
        await deps.db
          .update(firmSettings)
          .set({
            brandLogoStorageKey: LOGO_KEY,
            brandLogoUrl: `${deps.appBaseUrl}/api/portal/branding/logo?v=${version}`,
            brandAssetsVersion: version,
            updatedAt: new Date(),
          })
          .where(eq(firmSettings.firmId, firmId));
      } else {
        // Read the uploaded square source and resize into the icon set.
        const { body } = await storage.get(ICON_SOURCE_KEY);
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(chunk as Buffer);
        const source = Buffer.concat(chunks);
        const accent = settings?.accent ?? undefined;
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
        await deps.db
          .update(firmSettings)
          .set({
            brandIconStorageKey: ICON_SOURCE_KEY,
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
        after: { brandingAsset: parsed.data.kind, uploaded: true },
      }).catch(() => undefined);
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

async function firstFirmBranding(
  db: Database,
): Promise<{
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
