// SPDX-License-Identifier: Elastic-2.0
//
// Express middleware for staff auth. Cross-realm isolation: this only
// validates staff cookies signed with STAFF_JWT_SECRET. Portal middleware
// (Phase 16) is structurally identical but separate.

import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';

import { isStepUpFresh, type StaffSession } from '@vibe/core/auth';

import { loadConfig } from '../config';
import { readSessionCookie } from './cookies';
import type { SessionStore } from './session-store';

// Hard ceiling on a staff session's age regardless of activity.
const ABSOLUTE_SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      staffSession?: StaffSession;
    }
  }
}

export function staffAuthDeps(store: SessionStore): {
  requireAuth: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  requireStepUp: (req: Request, res: Response, next: NextFunction) => void;
  requireCsrf: (req: Request, res: Response, next: NextFunction) => void;
} {
  return {
    async requireAuth(req, res, next) {
      const sid = readSessionCookie(req, 'staff');
      if (!sid) {
        res.status(401).json({ error: 'no_session' });
        return;
      }
      const session = await store.get('staff', sid);
      if (!session || session.realm !== 'staff') {
        res.status(401).json({ error: 'invalid_session' });
        return;
      }
      // Absolute lifetime cap. The store's 7-day TTL is a sliding
      // inactivity window that a stolen-but-active cookie could ride
      // indefinitely; this is the hard ceiling that forces periodic
      // re-authentication regardless of activity.
      if (Date.now() - session.createdAt > ABSOLUTE_SESSION_MAX_MS) {
        await store.destroy('staff', sid);
        res.status(401).json({ error: 'session_expired' });
        return;
      }
      await store.touch('staff', sid);
      req.staffSession = session;
      next();
    },

    requireStepUp(req, res, next) {
      const session = req.staffSession;
      if (!session) {
        res.status(401).json({ error: 'no_session' });
        return;
      }
      const cfg = loadConfig();
      if (!isStepUpFresh(session, cfg.STEP_UP_TIMEOUT_MINUTES)) {
        res.status(403).json({ error: 'step_up_required' });
        return;
      }
      next();
    },

    requireCsrf(req, res, next) {
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        next();
        return;
      }
      const session = req.staffSession;
      if (!session) {
        res.status(401).json({ error: 'no_session' });
        return;
      }
      const header = req.header('x-csrf-token') ?? '';
      if (!constantTimeEquals(header, session.csrfToken)) {
        res.status(403).json({ error: 'csrf_mismatch' });
        return;
      }
      next();
    },
  };
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
