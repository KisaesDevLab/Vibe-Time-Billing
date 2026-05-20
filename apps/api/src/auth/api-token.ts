// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
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

import type { Database } from '@vibe/db';
import { mcpTokens } from '@vibe/db/schema';

export interface ApiTokenClaims {
  tokenId: string;
  firmId: string;
  allowedTools: string[];
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
