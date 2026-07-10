// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// API/MCP token middleware. Both the REST API (Phase 21) and the MCP
// server (Phase 22) use the same `mcp_token` table with a JSON
// `allowed_tools` claim. The token-issuance UI lives in admin (Phase 22).
//
// Wire format: `Authorization: Bearer <token>`. Tokens are hashed at
// rest (SHA-256); we hash the incoming token and look up by hash.

import { createHash } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import type { Database } from '@vibe/db';
import { mcpTokens } from '@vibe/db/schema';

export interface ApiTokenClaims {
  tokenId: string;
  firmId: string;
  allowedTools: string[];
  // 0165 — the staff user who created the token. Governs per-client
  // restriction for MCP calls (null → treated as no special access, so
  // all restricted clients are hidden).
  createdById: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiToken?: ApiTokenClaims;
    }
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function requireApiToken(db: Database | null) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) {
      res.status(401).json({ error: 'missing_token' });
      return;
    }
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const [row] = await db
      .select()
      .from(mcpTokens)
      .where(eq(mcpTokens.tokenHash, hashToken(match[1]!)))
      .limit(1);
    if (!row) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    if (row.revokedAt) {
      res.status(401).json({ error: 'token_revoked' });
      return;
    }
    if (row.expiresAt && row.expiresAt < new Date()) {
      res.status(401).json({ error: 'token_expired' });
      return;
    }
    // Touch last_used_at (best-effort, ignore errors)
    await db
      .update(mcpTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(mcpTokens.id, row.id))
      .catch(() => undefined);

    req.apiToken = {
      tokenId: row.id,
      firmId: row.firmId,
      allowedTools: row.allowedTools,
      createdById: row.createdById ?? null,
    };
    next();
  };
}

export function requireToolScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = req.apiToken;
    if (!token) {
      res.status(401).json({ error: 'no_token' });
      return;
    }
    if (!token.allowedTools.includes(scope) && !token.allowedTools.includes('*')) {
      res.status(403).json({ error: 'scope_denied', required: scope });
      return;
    }
    next();
  };
}

/**
 * Phase 21 #12 — per-token sliding-window rate limiter. Default 60
 * requests / minute / token; configurable via env API_TOKEN_RATE_LIMIT.
 * Uses a single INCR + EXPIRE pair (one round-trip on Lua-less Redis),
 * so cost is one extra Redis call per protected request. Tokens
 * exceeding the limit get a 429 with X-RateLimit-Reset and standard
 * Retry-After in seconds.
 *
 * Must be mounted AFTER requireApiToken so req.apiToken.tokenId is set.
 */
export function requireApiTokenRateLimit(
  redis: Redis | undefined,
  perMinute = parseInt(process.env['API_TOKEN_RATE_LIMIT'] ?? '60', 10) || 60,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!redis || !req.apiToken) {
      next();
      return;
    }
    const windowSeconds = 60;
    const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
    const key = `api-token-rate:${req.apiToken.tokenId}:${bucket}`;
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, windowSeconds * 2);
      if (count > perMinute) {
        const resetIn = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
        res.setHeader('Retry-After', String(resetIn));
        res.setHeader('X-RateLimit-Limit', String(perMinute));
        res.setHeader('X-RateLimit-Remaining', '0');
        res.setHeader('X-RateLimit-Reset', String(resetIn));
        res.status(429).json({ error: 'rate_limited', limitPerMinute: perMinute, resetIn });
        return;
      }
      res.setHeader('X-RateLimit-Limit', String(perMinute));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, perMinute - count)));
    } catch {
      // Redis offline → fail-open. The api-token middleware already
      // hit the DB, so a denied request would be worse than a
      // permitted one.
    }
    next();
  };
}
