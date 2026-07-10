// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// MCP / REST API token issuance & revocation (Phase 22 #12, 21 #13).
// Mints a one-time-display token, stores only its SHA-256 hash, lists
// existing tokens with their allowed-tool scope and last-used-at.

import { randomBytes } from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { mcpTokens } from '@vibe/db/schema';
import { MCP_TOOL_KEYS } from '@vibe/core/mcp';

import { emitAudit } from '../auth/audit';
import { hashToken } from '../auth/api-token';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface ApiTokenRoutesDeps extends RbacDeps {
  db: Database | null;
}

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  allowedTools: z.array(z.string()).min(1).max(64),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

const KNOWN_SCOPES = new Set<string>([
  ...MCP_TOOL_KEYS,
  'list_engagements',
  'get_time_entries',
  'create_time_entry',
  'list_invoices',
  '*',
]);

export function createApiTokenRouter(deps: ApiTokenRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get(
    '/',
    requirePermission(deps, 'admin:mcp:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select({
          id: mcpTokens.id,
          name: mcpTokens.name,
          allowedTools: mcpTokens.allowedTools,
          createdAt: mcpTokens.createdAt,
          lastUsedAt: mcpTokens.lastUsedAt,
          expiresAt: mcpTokens.expiresAt,
          revokedAt: mcpTokens.revokedAt,
        })
        .from(mcpTokens)
        .where(eq(mcpTokens.firmId, session.firmId))
        .orderBy(desc(mcpTokens.createdAt))
        .limit(200);
      res.json({ items });
    },
  );

  router.post(
    '/',
    requirePermission(deps, 'admin:mcp:manage'),
    async (req: Request, res: Response) => {
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const bad = parsed.data.allowedTools.filter((s) => !KNOWN_SCOPES.has(s));
      if (bad.length > 0) {
        res.status(400).json({ error: 'unknown_scopes', scopes: bad });
        return;
      }
      const session = req.staffSession!;
      const rawToken = `vtb_${randomBytes(24).toString('hex')}`;
      const tokenHash = hashToken(rawToken);
      const expiresAt = parsed.data.expiresInDays
        ? new Date(Date.now() + parsed.data.expiresInDays * 86_400_000)
        : null;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .insert(mcpTokens)
        .values({
          firmId: session.firmId,
          name: parsed.data.name,
          tokenHash,
          allowedTools: parsed.data.allowedTools,
          createdById: session.appUserId,
          expiresAt,
        })
        .returning({ id: mcpTokens.id });

      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'mcp_token',
        entityId: row?.id,
        actorAppUserId: session.appUserId,
        after: { name: parsed.data.name, allowedTools: parsed.data.allowedTools, expiresAt },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      // Token is shown exactly once.
      res.status(201).json({ id: row?.id, token: rawToken, name: parsed.data.name, expiresAt });
    },
  );

  router.get(
    '/:id/usage',
    requirePermission(deps, 'admin:mcp:manage'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const { auditLog } = await import('@vibe/db/schema');
      const { eq, desc } = await import('drizzle-orm');
      const items = await deps.db
        .select({
          id: auditLog.id,
          occurredAt: auditLog.occurredAt,
          action: auditLog.action,
          entityType: auditLog.entityType,
          afterJson: auditLog.afterJson,
        })
        .from(auditLog)
        .where(eq(auditLog.actorMcpTokenId, req.params['id']!))
        .orderBy(desc(auditLog.occurredAt))
        .limit(200);
      res.json({ items });
    },
  );

  router.post(
    '/:id/revoke',
    requirePermission(deps, 'admin:mcp:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(mcpTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(mcpTokens.id, req.params['id']!),
            eq(mcpTokens.firmId, session.firmId),
            isNull(mcpTokens.revokedAt),
          ),
        );
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'mcp_token',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { revoked: true },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  return router;
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}
