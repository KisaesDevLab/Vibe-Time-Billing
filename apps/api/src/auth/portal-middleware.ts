// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Portal auth middleware. CLAUDE.md non-negotiable #2: zero cross-realm
// share. Distinct cookie name, distinct JWT key, distinct session prefix.

import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';

import type { PortalSession } from '@vibe/core/auth';
import type { Database } from '@vibe/db';
import { firmSettings } from '@vibe/db/schema';

import { loadConfig } from '../config';
import { readSessionCookie } from './cookies';
import type { SessionStore } from './session-store';

// Phase 16 #27 — small cached lookup so we don't hit the DB on every
// portal request. Refreshes every 60 seconds; firm-settings changes
// take effect within that window.
let portalEnabledCache: { value: boolean | null; expiresAt: number } = {
  value: null,
  expiresAt: 0,
};
async function isPortalEnabled(db: Database, firmId: string): Promise<boolean> {
  const now = Date.now();
  if (portalEnabledCache.value !== null && portalEnabledCache.expiresAt > now) {
    return portalEnabledCache.value;
  }
  const [row] = await db
    .select({ enabled: firmSettings.portalEnabled })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, firmId))
    .limit(1);
  const value = row?.enabled ?? true;
  portalEnabledCache = { value, expiresAt: now + 60_000 };
  return value;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      portalSession?: PortalSession;
    }
  }
}

// TR-5 — view-as-client sessions auto-expire 60 minutes after
// `createdAt` regardless of the underlying cookie TTL. Keeps the
// blast radius of a stolen impersonation cookie small without
// requiring a custom Redis TTL path.
const IMPERSONATION_SOFT_TTL_MS = 60 * 60 * 1000;

// Endpoints a portal session is allowed to call even when the session
// is in read-only impersonation mode. /auth/logout and /auth/me are
// safety valves — log out always works, and /me drives the banner.
function isImpersonationAllowedPath(originalUrl: string): boolean {
  const path = originalUrl.split('?')[0] ?? originalUrl;
  return path.endsWith('/api/portal/auth/logout') || path.endsWith('/api/portal/auth/me');
}

export function portalAuthDeps(store: SessionStore, db?: Database | null) {
  return {
    async requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
      // License gate (non-negotiable #6).
      const cfg = loadConfig();
      if (!cfg.COMMERCIAL_LICENSE_TOKEN) {
        res.status(503).json({ error: 'portal_disabled', reason: 'no_commercial_license' });
        return;
      }
      const sid = readSessionCookie(req, 'portal');
      if (!sid) {
        res.status(401).json({ error: 'no_session' });
        return;
      }
      const s = await store.get('portal', sid);
      if (!s || s.realm !== 'portal') {
        res.status(401).json({ error: 'invalid_session' });
        return;
      }
      // Phase 16 #27 — firm toggle. After the session is resolved we
      // know firmId and can short-circuit if the firm has disabled the
      // portal in admin settings.
      if (db) {
        const enabled = await isPortalEnabled(db, s.firmId);
        if (!enabled) {
          res.status(503).json({ error: 'portal_disabled', reason: 'firm_disabled' });
          return;
        }
      }

      // TR-5 — impersonation gates. Apply *after* the firm/license
      // checks so the soft-TTL path destroys an expired session even
      // when the cookie's underlying Redis TTL hasn't fired yet.
      if (s.isImpersonation) {
        if (Date.now() - s.createdAt > IMPERSONATION_SOFT_TTL_MS) {
          await store.destroy('portal', sid);
          res.status(401).json({ error: 'impersonation_expired' });
          return;
        }
        const method = req.method.toUpperCase();
        if (
          method !== 'GET' &&
          method !== 'HEAD' &&
          method !== 'OPTIONS' &&
          !isImpersonationAllowedPath(req.originalUrl)
        ) {
          res.status(403).json({ error: 'impersonation_is_read_only' });
          return;
        }
      }

      await store.touch('portal', sid);
      req.portalSession = s;
      next();
    },
  };
}
