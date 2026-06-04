// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Public, anonymous document-intake API. Mounted at /api/public/intake/*
// OUTSIDE the /api/staff auth+csrf chain and the portal chain — isolated
// like /api/shared so a bug in authed middleware can't gate (or expose)
// this surface, and so the intake Caddy site can safely proxy ONLY this
// prefix.
//
// Phase B ships the shell: a permissive (credential-less) CORS gate, a
// per-IP sliding-window rate limit on every route, and a health probe the
// SPA uses to confirm reachability. Phase C adds the real endpoints
// (GET /staff, POST /session, proxied POST /session/:id/files, complete,
// headshot). All of those will additionally gate on isIntakeEnabled.

import express, { type Request, type Response, type Router, type NextFunction } from 'express';
import type { Redis } from 'ioredis';

import type { Database } from '@vibe/db';
import { checkAndIncrement } from '@vibe/core/auth';

import { logger } from '../logger';

export interface IntakePublicDeps {
  db: Database | null;
  redis: Redis;
}

// Per-IP request ceiling across the whole public surface. Generous enough
// for the SPA's load-time probe + a normal upload session, tight enough to
// blunt scripted abuse. Per-session/file limits land in Phase C.
const IP_WINDOW_SECONDS = 60;
const IP_MAX_PER_WINDOW = 120;

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
  return (first ?? req.ip ?? '0.0.0.0').trim();
}

export function createIntakePublicRouter(deps: IntakePublicDeps): Router {
  const router = express.Router();

  // CORS: the SPA is served same-origin (Caddy hosts it and proxies this
  // path), so credentials are never needed. Reflect the request origin and
  // explicitly forbid credentials — an anonymous, cookie-less surface.
  router.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', 'false');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Per-IP rate limit on every public intake route.
  router.use((req: Request, res: Response, next: NextFunction) => {
    const ip = clientIp(req);
    void checkAndIncrement(deps.redis, {
      key: `rl:intake:ip:${ip}`,
      windowSeconds: IP_WINDOW_SECONDS,
      max: IP_MAX_PER_WINDOW,
    })
      .then((limit) => {
        if (!limit.allowed) {
          res.setHeader('Retry-After', String(limit.retryAfterSeconds));
          res.status(429).json({ error: 'rate_limited' });
          return;
        }
        next();
      })
      .catch((err: unknown) => {
        // Fail open on limiter errors — Redis hiccups must not take the
        // public surface down — but record it.
        logger.warn({ err }, 'intake rate limiter error; allowing request');
        next();
      });
  });

  // Reachability probe for the SPA. Intentionally reveals nothing about the
  // firm or whether intake is enabled — just that the service is up.
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  return router;
}
