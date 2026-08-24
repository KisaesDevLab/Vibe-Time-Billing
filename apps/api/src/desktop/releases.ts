// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-3 — desktop shell release channel. The Tauri updater polls a static
// manifest; we serve it (and the installers it points at) straight from a
// directory on the appliance so publishing a build is "copy files, done".
//
//   GET /desktop/latest.json    updater manifest (public: version, notes,
//                               pub_date, platforms[*].{signature,url})
//   GET /desktop/dl/:file       installer / signature artefact
//   GET /desktop/status         (staff) { configured, version }
//
// Layout of DESKTOP_RELEASES_DIR:
//   latest.json
//   Vibe-Time-Billing_0.2.0_x64-setup.exe
//   Vibe-Time-Billing_0.2.0_x64-setup.exe.sig
//
// Tauri's updater sends no cookies, so the manifest and downloads are
// public by design. They carry no firm data — only version strings and
// signed binaries; integrity comes from the minisign signature verified
// against the pubkey baked into tauri.conf.json.

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import express, { type Request, type Response, type Router } from 'express';

import { logger } from '../logger';

export interface DesktopReleasesDeps {
  releasesDir: string | null;
  /** Public origin of the staff app (APP_BASE_URL). Used to absolutise
   *  relative download URLs; falls back to the request's host when unset
   *  or left at the dev default. */
  baseUrl?: string | null;
}

const SAFE_FILE = /^[A-Za-z0-9._-]{1,160}$/;

function contentTypeFor(file: string): string {
  if (file.endsWith('.sig')) return 'text/plain; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.exe') || file.endsWith('.msi')) return 'application/octet-stream';
  if (file.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (file.endsWith('.AppImage') || file.endsWith('.deb')) return 'application/octet-stream';
  return 'application/octet-stream';
}

export async function readManifest(
  releasesDir: string | null,
): Promise<Record<string, unknown> | null> {
  if (!releasesDir) return null;
  try {
    const raw = await readFile(path.join(releasesDir, 'latest.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed === 'object' && parsed ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The build workflow writes *relative* download URLs (`/desktop/dl/<file>`)
 * because one installer serves every firm; the Tauri updater, however,
 * requires absolute URLs. Resolve them against the origin the shell is
 * talking to (behind Caddy, `trust proxy` makes req.protocol/host right).
 */
export function absolutize(
  manifest: Record<string, unknown>,
  origin: string,
): Record<string, unknown> {
  const platforms = manifest['platforms'];
  if (!platforms || typeof platforms !== 'object') return manifest;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(platforms as Record<string, unknown>)) {
    if (v && typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string') {
      const url = (v as { url: string }).url;
      out[k] = { ...(v as object), url: url.startsWith('/') ? origin + url : url };
    } else {
      out[k] = v;
    }
  }
  return { ...manifest, platforms: out };
}

/** Public routes → mount at /desktop. */
export function createDesktopReleasesRouter(deps: DesktopReleasesDeps): Router {
  const router = express.Router();

  router.get('/latest.json', async (req: Request, res: Response) => {
    const manifest = await readManifest(deps.releasesDir);
    if (!manifest) {
      res.status(404).json({ error: 'no_release' });
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    const configured = deps.baseUrl?.replace(/\/+$/, '');
    const origin =
      configured && !/localhost|127\.0\.0\.1/.test(configured)
        ? configured
        : `${req.protocol}://${req.get('host') ?? 'localhost'}`;
    res.json(absolutize(manifest, origin));
  });

  router.get('/dl/:file', async (req: Request, res: Response) => {
    const file = String(req.params['file'] ?? '');
    if (!deps.releasesDir || !SAFE_FILE.test(file) || file === 'latest.json') {
      res.status(404).end();
      return;
    }
    const abs = path.join(deps.releasesDir, file);
    // Belt and braces: the regex already forbids separators.
    if (path.dirname(abs) !== path.resolve(deps.releasesDir)) {
      res.status(404).end();
      return;
    }
    try {
      const st = await stat(abs);
      if (!st.isFile()) {
        res.status(404).end();
        return;
      }
      res.setHeader('Content-Type', contentTypeFor(file));
      res.setHeader('Content-Length', String(st.size));
      res.setHeader('Cache-Control', 'public, max-age=300');
      createReadStream(abs)
        .on('error', (err) => {
          logger.warn({ err, file }, 'desktop release stream failed');
          if (!res.headersSent) res.status(500).end();
          else res.end();
        })
        .pipe(res);
    } catch {
      res.status(404).end();
    }
  });

  return router;
}

/** Staff-only status → mount at /api/staff/desktop/releases. */
export function createDesktopReleaseStatusRouter(deps: DesktopReleasesDeps): Router {
  const router = express.Router();
  router.get('/status', async (_req: Request, res: Response) => {
    const manifest = await readManifest(deps.releasesDir);
    res.json({
      configured: !!deps.releasesDir,
      version: typeof manifest?.['version'] === 'string' ? manifest['version'] : null,
      pubDate: typeof manifest?.['pub_date'] === 'string' ? manifest['pub_date'] : null,
    });
  });
  return router;
}
