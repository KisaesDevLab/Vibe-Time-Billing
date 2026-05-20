// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// MCP server HTTP shim (Phase 22). Exposes the tool catalog from
// @vibe/core/mcp as JSON-RPC-flavored endpoints. Token auth + per-tool
// scope enforcement is shared with the REST API.
//
// Each tool call audit-logs with the token id as actor (CLAUDE.md
// locked decision Q13). The real MCP protocol lives over WebSocket; this
// HTTP shim is enough to drive integration tests and Cowork-style HTTP
// MCP clients without taking on a WebSocket dep right now.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, lte } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, engagements, recurringBillingPlans, timeEntries } from '@vibe/db/schema';
import { MCP_TOOL_KEYS, isToolAllowed, type McpToolKey } from '@vibe/core/mcp';

import { emitAudit } from '../auth/audit';
import { requireApiToken } from '../auth/api-token';
import { logger } from '../logger';

export interface McpRoutesDeps {
  db: Database | null;
}

const CallSchema = z.object({
  tool: z.string(),
  args: z.record(z.unknown()).optional(),
});

export function createMcpRouter(deps: McpRoutesDeps): Router {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));
  router.use(requireApiToken(deps.db));

  router.get('/tools', (_req: Request, res: Response) => {
    res.json({ tools: MCP_TOOL_KEYS });
  });

  router.post('/call', async (req: Request, res: Response) => {
    const parsed = CallSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_envelope' });
      return;
    }
    const tool = parsed.data.tool as McpToolKey;
    if (!MCP_TOOL_KEYS.includes(tool)) {
      res.status(404).json({ error: 'unknown_tool', tool });
      return;
    }
    const token = req.apiToken!;
    const claims = {
      tokenId: token.tokenId,
      firmId: token.firmId,
      allowedTools: token.allowedTools as McpToolKey[],
    };
    if (!isToolAllowed(claims, tool)) {
      res.status(403).json({ error: 'scope_denied', required: tool });
      return;
    }

    const args = parsed.data.args ?? {};
    try {
      const result = await dispatch(deps, tool, args, token);
      await emitAudit(deps.db, {
        action: 'MCP_CALL',
        entityType: 'mcp_tool',
        entityId: null,
        actorMcpTokenId: token.tokenId,
        after: { tool, args },
        ip: req.ip ?? null,
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'tool_failed';
      res.status(500).json({ error: 'tool_failed', detail: msg });
    }
  });

  return router;
}

async function dispatch(
  deps: McpRoutesDeps,
  tool: McpToolKey,
  args: Record<string, unknown>,
  token: { firmId: string; tokenId: string },
): Promise<unknown> {
  if (!deps.db) throw new Error('db_unavailable');
  switch (tool) {
    case 'list_engagements': {
      const firmClientRows = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.firmId, token.firmId));
      const ids = firmClientRows.map((c) => c.id);
      if (ids.length === 0) return { items: [] };
      const items = await deps.db
        .select({
          id: engagements.id,
          name: engagements.name,
          status: engagements.status,
          feeStructure: engagements.feeStructure,
        })
        .from(engagements)
        .where(inArray(engagements.clientId, ids))
        .limit(200);
      return { items };
    }
    case 'get_time_entries': {
      const engagementId = String(args['engagementId'] ?? '');
      const conds = [] as ReturnType<typeof eq>[];
      if (engagementId) conds.push(eq(timeEntries.engagementId, engagementId));
      const items = await deps.db
        .select()
        .from(timeEntries)
        .where(conds.length === 0 ? undefined : and(...conds))
        .orderBy(desc(timeEntries.entryDate))
        .limit(200);
      return { items };
    }
    case 'create_time_entry': {
      const Schema = z.object({
        engagementId: z.string().uuid(),
        appUserId: z.string().uuid(),
        entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        hours: z.number().positive(),
        workCodeId: z.string().uuid().optional(),
        description: z.string().max(2000).optional(),
        standardRateSnapshotCents: z.number().int().nonnegative(),
      });
      const parsed = Schema.parse(args);
      const [row] = await deps.db
        .insert(timeEntries)
        .values({
          engagementId: parsed.engagementId,
          appUserId: parsed.appUserId,
          workCodeId: parsed.workCodeId ?? null,
          entryDate: parsed.entryDate,
          hours: parsed.hours.toString(),
          description: parsed.description ?? '',
          standardRateSnapshotCents: parsed.standardRateSnapshotCents,
          standardAmountCents: Math.round(parsed.standardRateSnapshotCents * parsed.hours),
        })
        .returning({ id: timeEntries.id });
      return { id: row?.id };
    }
    case 'query_recurring_plans': {
      const today = new Date().toISOString().slice(0, 10);
      const items = await deps.db
        .select()
        .from(recurringBillingPlans)
        .where(
          and(
            eq(recurringBillingPlans.status, 'ACTIVE'),
            lte(recurringBillingPlans.nextRunDate, today),
          ),
        )
        .limit(200);
      return { items };
    }
    case 'generate_pre_bill':
    case 'suggest_adjustment':
    case 'query_realization': {
      // These are wired in their HTTP equivalents under /api/staff; the
      // MCP server reuses those code paths in a future commit. Returning
      // a structured "not_yet" so agents fail fast with a clear signal.
      return { status: 'not_yet_implemented', tool };
    }
  }
}
