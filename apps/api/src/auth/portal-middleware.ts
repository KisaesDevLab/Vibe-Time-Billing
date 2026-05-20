// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Portal auth middleware. CLAUDE.md non-negotiable #2: zero cross-realm
// share. Distinct cookie name, distinct JWT key, distinct session prefix.

import type { NextFunction, Request, Response } from 'express';

import type { PortalSession } from '@vibe/core/auth';

import { loadConfig } from '../config';
import { readSessionCookie } from './cookies';
import type { SessionStore } from './session-store';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      portalSession?: PortalSession;
    }
  }
}

export function portalAuthDeps(store: SessionStore) {
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
      await store.touch('portal', sid);
      req.portalSession = s;
      next();
    },
  };
}
