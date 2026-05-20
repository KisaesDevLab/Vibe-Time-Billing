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
import { and, between, desc, eq, inArray, isNull, lte, sql as drz } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  adjustmentAllocations,
  billingBatchEntries,
  billingBatches,
  clients,
  engagements,
  recurringBillingPlans,
  timeEntries,
} from '@vibe/db/schema';
import { MCP_TOOL_KEYS, isToolAllowed, type McpToolKey } from '@vibe/core/mcp';
import { rollup, rollupBy, type AllocationRow } from '@vibe/core/reporting';

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
    case 'generate_pre_bill': {
      // Create a billing batch from unbilled time entries for a given
      // engagement + period. Mirrors the HTTP POST /billing-batches behavior
      // but scoped strictly to the token's firm.
      const Schema = z.object({
        engagementId: z.string().uuid(),
        periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      });
      const parsed = Schema.parse(args);
      const [eng] = await deps.db
        .select({ id: engagements.id, clientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, parsed.engagementId))
        .limit(1);
      if (!eng) throw new Error('engagement_not_found');
      const [client] = await deps.db
        .select({ firmId: clients.firmId })
        .from(clients)
        .where(eq(clients.id, eng.clientId))
        .limit(1);
      if (!client || client.firmId !== token.firmId) {
        throw new Error('cross_firm_denied');
      }
      const batchId = await deps.db.transaction(async (tx) => {
        const [batch] = await tx
          .insert(billingBatches)
          .values({
            engagementId: eng.id,
            periodStart: parsed.periodStart,
            periodEnd: parsed.periodEnd,
            // No actor user — token-driven creation. The DB requires a
            // non-null creator FK so we punt: write the firm's first
            // partner as a placeholder. (Future schema change: allow
            // mcp_token_id as alternate creator.)
            createdById: (
              await tx
                .select({ id: clients.partnerInChargeId })
                .from(clients)
                .where(eq(clients.id, eng.clientId))
                .limit(1)
            )[0]?.id as string,
          })
          .returning({ id: billingBatches.id });
        if (!batch) throw new Error('batch_insert_failed');
        const rows = await tx
          .select({ id: timeEntries.id })
          .from(timeEntries)
          .where(
            and(
              eq(timeEntries.engagementId, eng.id),
              isNull(timeEntries.billingBatchId),
              between(timeEntries.entryDate, parsed.periodStart, parsed.periodEnd),
            ),
          );
        if (rows.length > 0) {
          await tx.insert(billingBatchEntries).values(
            rows.map((r) => ({
              billingBatchId: batch.id,
              timeEntryId: r.id,
              action: 'INCLUDE' as const,
            })),
          );
          for (const r of rows) {
            await tx
              .update(timeEntries)
              .set({ billingBatchId: batch.id })
              .where(eq(timeEntries.id, r.id));
          }
        }
        return batch.id;
      });
      return { billingBatchId: batchId };
    }
    case 'suggest_adjustment': {
      // Compute a suggested write-down/up amount based on the current WIP
      // and a target realization pct. Does NOT write — agent decides
      // whether to call create_adjustment downstream.
      const Schema = z.object({
        engagementId: z.string().uuid(),
        targetRealizationPct: z.number().min(0).max(2),
      });
      const parsed = Schema.parse(args);
      const [scope] = await deps.db
        .select({ id: engagements.id, clientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, parsed.engagementId))
        .limit(1);
      if (!scope) throw new Error('engagement_not_found');
      const [client] = await deps.db
        .select({ firmId: clients.firmId })
        .from(clients)
        .where(eq(clients.id, scope.clientId))
        .limit(1);
      if (!client || client.firmId !== token.firmId) throw new Error('cross_firm_denied');
      const [wip] = await deps.db
        .select({
          total: drz<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`,
        })
        .from(timeEntries)
        .where(and(eq(timeEntries.engagementId, scope.id), eq(timeEntries.status, 'SUBMITTED')));
      const wipCents = Number(wip?.total ?? 0);
      const adjustedTarget = Math.round(wipCents * parsed.targetRealizationPct);
      return {
        engagementId: scope.id,
        currentWipCents: wipCents,
        targetRealizationPct: parsed.targetRealizationPct,
        suggestedAdjustmentCents: adjustedTarget - wipCents,
        method: 'WRITE_DOWN_TO_TARGET',
        warning: wipCents === 0 ? 'no_wip_to_adjust' : undefined,
      };
    }
    case 'query_realization': {
      // Same rollup as /api/staff/reports/realization but scoped to the
      // token's firm. Returns a single dimension at a time.
      const Schema = z.object({
        dimension: z.enum(['firm', 'timekeeper', 'engagement', 'client']).default('firm'),
      });
      const parsed = Schema.parse(args);
      const firmClients = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.firmId, token.firmId));
      if (firmClients.length === 0) return { dimension: parsed.dimension, items: [] };
      const firmEngs = await deps.db
        .select({ id: engagements.id, clientId: engagements.clientId })
        .from(engagements)
        .where(
          inArray(
            engagements.clientId,
            firmClients.map((c) => c.id),
          ),
        );
      const engById = new Map(firmEngs.map((e) => [e.id, e.clientId]));
      const batches = await deps.db
        .select({ id: billingBatches.id, engagementId: billingBatches.engagementId })
        .from(billingBatches)
        .where(
          inArray(
            billingBatches.engagementId,
            firmEngs.map((e) => e.id),
          ),
        );
      const batchById = new Map(batches.map((b) => [b.id, b.engagementId]));
      const rows = batches.length
        ? await deps.db
            .select({
              appUserId: adjustmentAllocations.appUserId,
              originalValueCents: adjustmentAllocations.originalValueCents,
              adjustedValueCents: adjustmentAllocations.adjustedValueCents,
              adjustmentId: adjustmentAllocations.adjustmentId,
            })
            .from(adjustmentAllocations)
        : [];
      const scoped: AllocationRow[] = rows
        .map((r) => {
          const engId = batchById.get(r.adjustmentId);
          const cid = engId ? engById.get(engId) : undefined;
          if (!engId || !cid) return null;
          return {
            appUserId: r.appUserId,
            engagementId: engId,
            clientId: cid,
            originalValueCents: r.originalValueCents,
            adjustedValueCents: r.adjustedValueCents,
          } as AllocationRow;
        })
        .filter((x): x is AllocationRow => x !== null);
      if (parsed.dimension === 'firm') {
        return { dimension: 'firm', summary: rollup(scoped) };
      }
      const keyFn = {
        timekeeper: (r: AllocationRow) => r.appUserId,
        engagement: (r: AllocationRow) => r.engagementId,
        client: (r: AllocationRow) => r.clientId,
      }[parsed.dimension];
      const map = rollupBy(scoped, keyFn);
      return {
        dimension: parsed.dimension,
        items: Array.from(map.entries()).map(([key, value]) => ({ key, ...value })),
      };
    }
  }
}
