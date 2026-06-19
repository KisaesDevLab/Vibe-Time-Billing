// SPDX-License-Identifier: Elastic-2.0
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
  adjustments,
  appUsers,
  billingBatchEntries,
  billingBatches,
  clientRequests,
  clients,
  engagementThreadLinks,
  engagements,
  invoices,
  messages,
  offices,
  recurringBillingPlans,
  timeEntries,
} from '@vibe/db/schema';
import { MCP_TOOL_KEYS, isToolAllowed, type McpToolKey } from '@vibe/core/mcp';
import { rollup, rollupBy, type AllocationRow } from '@vibe/core/reporting';

import { emitAudit } from '../auth/audit';
import { requireApiToken } from '../auth/api-token';
import { getBlockedClientIds } from '../clients/access';
import { batchDecryptForThread } from '../engagement-messaging/thread-crypto';
import { linkTimeEntryMessages } from '../time-entries/routes';
import { logger } from '../logger';

export interface McpRoutesDeps {
  db: Database | null;
}

const CallSchema = z.object({
  tool: z.string(),
  args: z.record(z.unknown()).optional(),
});

// Tools added in P5.3 — Connect addendum J.1–J.5. The audit
// pipeline tags these so an operator can filter "all calls that
// touched encrypted messaging or client requests".
const CONNECT_TOOL_KEYS = new Set<string>([
  'summarize_engagement_thread',
  'list_unresolved_client_requests',
  'link_message_to_time_entry',
  'suggest_billable_messages',
  'draft_pre_bill_narrative',
]);

/**
 * Replace UUID-shaped values in MCP tool args with their first 8
 * chars + '…' so the audit log stays human-scannable without keeping
 * full identifiers in plaintext for every call.
 */
function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)) {
      out[k] = `${v.slice(0, 8)}…`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

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
      const result = await dispatch(deps, tool, args, {
        firmId: token.firmId,
        tokenId: token.tokenId,
        createdById: token.createdById,
      });
      // P5.4 — J.13 — every MCP call audit-logs the token actor, the
      // tool, the inputs (sans sensitive args), and the egress
      // destination so an operator can reconstruct who-asked-what.
      const isConnectTool = CONNECT_TOOL_KEYS.has(tool);
      await emitAudit(deps.db, {
        action: 'MCP_CALL',
        entityType: 'mcp_tool',
        entityId: null,
        actorMcpTokenId: token.tokenId,
        after: {
          tool,
          args: redactArgs(args),
          // Connect tools that surface decrypted message content are
          // considered "local-only" because the decryption happens
          // server-side; the MCP transport itself is the egress edge.
          egressDestination: isConnectTool ? 'local-server' : 'local-server',
          piiRedacted: isConnectTool, // Connect tools redact identifiers in audit
        },
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

/** Engagement ids whose client belongs to the firm — the firm's full set of
 *  engagements, used to scope time-entry reads/writes for MCP tokens. The
 *  blocked set (0165) removes engagements of restricted clients the token's
 *  creator can't access. */
async function firmEngagementIdSet(
  db: Database,
  firmId: string,
  blocked: ReadonlySet<string>,
): Promise<string[]> {
  const rows = await db
    .select({ id: engagements.id, clientId: engagements.clientId })
    .from(engagements)
    .innerJoin(clients, eq(clients.id, engagements.clientId))
    .where(eq(clients.firmId, firmId));
  return rows.filter((r) => !blocked.has(r.clientId)).map((r) => r.id);
}

async function dispatch(
  deps: McpRoutesDeps,
  tool: McpToolKey,
  args: Record<string, unknown>,
  token: { firmId: string; tokenId: string; createdById: string | null },
): Promise<unknown> {
  if (!deps.db) throw new Error('db_unavailable');
  // 0165 — restricted clients the token's creating user can't access.
  // A null creator is treated as having no special access, so every
  // restricted client is blocked.
  const blocked = new Set(
    await getBlockedClientIds({ db: deps.db }, token.createdById ?? '', token.firmId),
  );
  switch (tool) {
    case 'list_engagements': {
      const firmClientRows = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.firmId, token.firmId));
      const ids = firmClientRows.map((c) => c.id).filter((id) => !blocked.has(id));
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
      // Scope to the firm's engagements — never disclose time entries
      // outside the token's firm (the no-engagementId case previously
      // returned the whole appliance).
      const firmEngagementIds = await firmEngagementIdSet(deps.db, token.firmId, blocked);
      if (firmEngagementIds.length === 0) return { items: [] };
      const engagementId = String(args['engagementId'] ?? '');
      if (engagementId && !firmEngagementIds.includes(engagementId)) return { items: [] };
      const items = await deps.db
        .select()
        .from(timeEntries)
        .where(
          engagementId
            ? eq(timeEntries.engagementId, engagementId)
            : inArray(timeEntries.engagementId, firmEngagementIds),
        )
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
      // The target engagement must belong to the token's firm and not be a
      // restricted client the token's creator can't access (0165 — a blocked
      // engagement is absent from this set so it reads as not-in-firm).
      const firmEngagementIds = await firmEngagementIdSet(deps.db, token.firmId, blocked);
      if (!firmEngagementIds.includes(parsed.engagementId)) {
        throw new Error('engagement_not_in_firm');
      }
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
      if (blocked.has(eng.clientId)) throw new Error('client_restricted');
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
      if (blocked.has(scope.clientId)) throw new Error('client_restricted');
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
      const firmClients = (
        await deps.db
          .select({ id: clients.id })
          .from(clients)
          .where(eq(clients.firmId, token.firmId))
      ).filter((c) => !blocked.has(c.id));
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
              // The batch id lives on the adjustment, not the allocation —
              // adjustment_allocations.adjustment_id is an adjustments.id, so
              // join through adjustments to recover the billing_batch id.
              billingBatchId: adjustments.billingBatchId,
            })
            .from(adjustmentAllocations)
            .innerJoin(adjustments, eq(adjustments.id, adjustmentAllocations.adjustmentId))
        : [];
      const scoped: AllocationRow[] = rows
        .map((r) => {
          const engId = batchById.get(r.billingBatchId);
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

    // ===============================================================
    // P5.3 — Connect addendum J.1–J.5 — Connect tools.
    // ===============================================================
    case 'summarize_engagement_thread': {
      const Schema = z.object({
        engagementId: z.string().uuid(),
        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}/)
          .optional(),
        limit: z.number().int().positive().max(200).default(50),
      });
      const parsed = Schema.parse(args);
      // Resolve engagement → thread, scope-check the firm.
      const [link] = await deps.db
        .select({
          engagementId: engagementThreadLinks.engagementId,
          threadId: engagementThreadLinks.threadId,
          clientId: engagements.clientId,
        })
        .from(engagementThreadLinks)
        .innerJoin(engagements, eq(engagements.id, engagementThreadLinks.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(
          and(
            eq(engagementThreadLinks.engagementId, parsed.engagementId),
            eq(clients.firmId, token.firmId),
          ),
        )
        .limit(1);
      if (!link) throw new Error('engagement_thread_not_found_or_cross_firm');
      if (blocked.has(link.clientId)) throw new Error('client_restricted');
      const sinceClause = parsed.since ? drz`AND ${messages.createdAt} >= ${parsed.since}` : drz``;
      const rows = await deps.db.execute<{
        id: string;
        body_ciphertext: Uint8Array;
        created_at: Date;
        sender_app_user_id: string | null;
        sender_portal_identity_id: string | null;
      }>(
        drz`
          SELECT id, body_ciphertext, created_at, sender_app_user_id, sender_portal_identity_id
          FROM ${messages}
          WHERE thread_id = ${link.threadId}
          ${sinceClause}
          ORDER BY created_at ASC
          LIMIT ${parsed.limit}
        `,
      );
      const list = Array.isArray(rows)
        ? (rows as unknown as Array<{
            id: string;
            body_ciphertext: Uint8Array;
            created_at: Date;
            sender_app_user_id: string | null;
            sender_portal_identity_id: string | null;
          }>)
        : ((
            rows as unknown as {
              rows: Array<{
                id: string;
                body_ciphertext: Uint8Array;
                created_at: Date;
                sender_app_user_id: string | null;
                sender_portal_identity_id: string | null;
              }>;
            }
          ).rows ?? []);
      const ciphertexts = list.map((r) => r.body_ciphertext);
      const plaintexts = ciphertexts.length
        ? await batchDecryptForThread(
            { db: deps.db, firmId: token.firmId, threadId: link.threadId },
            ciphertexts,
          )
        : [];
      return {
        threadId: link.threadId,
        messages: list.map((r, i) => ({
          id: r.id,
          createdAt: r.created_at,
          senderKind: r.sender_app_user_id ? 'staff' : 'client',
          body: plaintexts[i] ?? '',
        })),
      };
    }

    case 'list_unresolved_client_requests': {
      const Schema = z.object({
        engagementId: z.string().uuid().optional(),
      });
      const parsed = Schema.parse(args);
      const conds = [eq(clientRequests.firmId, token.firmId), eq(clientRequests.status, 'OPEN')];
      if (parsed.engagementId) conds.push(eq(clientRequests.engagementId, parsed.engagementId));
      // 0165 — every client_request has a NOT NULL engagement; exclude
      // requests whose engagement belongs to a blocked (restricted) client.
      const rows = await deps.db
        .select({
          id: clientRequests.id,
          engagementId: clientRequests.engagementId,
          clientId: engagements.clientId,
          title: clientRequests.title,
          body: clientRequests.body,
          assignedAppUserId: clientRequests.assignedAppUserId,
          dueDate: clientRequests.dueDate,
          createdAt: clientRequests.createdAt,
        })
        .from(clientRequests)
        .innerJoin(engagements, eq(engagements.id, clientRequests.engagementId))
        .where(and(...conds))
        .orderBy(desc(clientRequests.createdAt))
        .limit(200);
      const items = rows
        .filter((r) => !blocked.has(r.clientId))
        .map(({ clientId: _clientId, ...rest }) => rest);
      return { items };
    }

    case 'link_message_to_time_entry': {
      const Schema = z.object({
        timeEntryId: z.string().uuid(),
        messageIds: z.array(z.string().uuid()).min(1).max(50),
      });
      const parsed = Schema.parse(args);
      // Validate cross-firm: time entry must belong to a firm engagement.
      const [te] = await deps.db
        .select({
          id: timeEntries.id,
          engagementId: timeEntries.engagementId,
          appUserId: timeEntries.appUserId,
          clientId: engagements.clientId,
        })
        .from(timeEntries)
        .innerJoin(engagements, eq(engagements.id, timeEntries.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(eq(timeEntries.id, parsed.timeEntryId), eq(clients.firmId, token.firmId)))
        .limit(1);
      if (!te) throw new Error('time_entry_not_found_or_cross_firm');
      if (blocked.has(te.clientId)) throw new Error('client_restricted');
      await linkTimeEntryMessages(deps.db, {
        engagementId: te.engagementId,
        timeEntryId: te.id,
        messageIds: parsed.messageIds,
        // MCP token is the actor; we don't have an app_user. Use the
        // time entry's owning user as a fallback so audit attribution
        // remains plausible. The MCP-level audit row already names the
        // token, so the actor here is informational.
        appUserId: te.appUserId,
      });
      return { timeEntryId: te.id, linkedCount: parsed.messageIds.length };
    }

    case 'suggest_billable_messages': {
      const Schema = z.object({
        engagementId: z.string().uuid(),
        periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
        periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
        limit: z.number().int().positive().max(200).default(50),
      });
      const parsed = Schema.parse(args);
      const [link] = await deps.db
        .select({ threadId: engagementThreadLinks.threadId, clientId: engagements.clientId })
        .from(engagementThreadLinks)
        .innerJoin(engagements, eq(engagements.id, engagementThreadLinks.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(
          and(
            eq(engagementThreadLinks.engagementId, parsed.engagementId),
            eq(clients.firmId, token.firmId),
          ),
        )
        .limit(1);
      if (!link) throw new Error('engagement_thread_not_found_or_cross_firm');
      if (blocked.has(link.clientId)) throw new Error('client_restricted');
      // Pull messages in window not yet linked to a time entry. Anti-
      // join via NOT EXISTS is the cleanest expression in raw SQL.
      const rows = await deps.db.execute<{
        id: string;
        body_ciphertext: Uint8Array;
        created_at: Date;
        sender_kind: string;
      }>(
        drz`
          SELECT m.id, m.body_ciphertext, m.created_at,
                 CASE WHEN m.sender_app_user_id IS NOT NULL THEN 'staff' ELSE 'client' END AS sender_kind
          FROM ${messages} m
          WHERE m.thread_id = ${link.threadId}
            AND m.created_at >= ${parsed.periodStart}
            AND m.created_at < ${parsed.periodEnd}::date + interval '1 day'
            AND NOT EXISTS (
              SELECT 1
              FROM vibetb.time_entry_message_link l
              WHERE l.message_id = m.id
            )
          ORDER BY m.created_at ASC
          LIMIT ${parsed.limit}
        `,
      );
      const list = Array.isArray(rows)
        ? (rows as unknown as Array<{
            id: string;
            body_ciphertext: Uint8Array;
            created_at: Date;
            sender_kind: string;
          }>)
        : ((
            rows as unknown as {
              rows: Array<{
                id: string;
                body_ciphertext: Uint8Array;
                created_at: Date;
                sender_kind: string;
              }>;
            }
          ).rows ?? []);
      const ciphertexts = list.map((r) => r.body_ciphertext);
      const plaintexts = ciphertexts.length
        ? await batchDecryptForThread(
            { db: deps.db, firmId: token.firmId, threadId: link.threadId },
            ciphertexts,
          )
        : [];
      return {
        threadId: link.threadId,
        candidates: list.map((r, i) => ({
          messageId: r.id,
          createdAt: r.created_at,
          senderKind: r.sender_kind,
          body: plaintexts[i] ?? '',
        })),
      };
    }

    case 'draft_pre_bill_narrative': {
      const Schema = z.object({
        invoiceId: z.string().uuid(),
      });
      const parsed = Schema.parse(args);
      const [inv] = await deps.db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          totalCents: invoices.totalCents,
          firmId: invoices.firmId,
          clientId: invoices.clientId,
          primaryEngagementId: invoices.primaryEngagementId,
        })
        .from(invoices)
        .where(eq(invoices.id, parsed.invoiceId))
        .limit(1);
      if (!inv) throw new Error('invoice_not_found');
      if (inv.firmId !== token.firmId) throw new Error('cross_firm_denied');
      if (blocked.has(inv.clientId)) throw new Error('client_restricted');
      // Pull WIP context. For a single-engagement invoice we resolve
      // via primary_engagement_id; the multi-engagement consolidated
      // case (line_items) is left for a future tool refinement.
      const batches = inv.primaryEngagementId
        ? await deps.db
            .select({ id: billingBatches.id })
            .from(billingBatches)
            .where(eq(billingBatches.engagementId, inv.primaryEngagementId))
        : [];
      const batchIds = batches.map((b) => b.id);
      const entries = batchIds.length
        ? await deps.db
            .select({
              entryId: billingBatchEntries.timeEntryId,
              action: billingBatchEntries.action,
            })
            .from(billingBatchEntries)
            .where(inArray(billingBatchEntries.billingBatchId, batchIds))
        : [];
      const includedIds = entries.filter((e) => e.action === 'INCLUDE').map((e) => e.entryId);
      const times = includedIds.length
        ? await deps.db
            .select({
              id: timeEntries.id,
              hours: timeEntries.hours,
              description: timeEntries.description,
              standardAmountCents: timeEntries.standardAmountCents,
              entryDate: timeEntries.entryDate,
            })
            .from(timeEntries)
            .where(inArray(timeEntries.id, includedIds))
        : [];
      return {
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        totalCents: inv.totalCents,
        timeEntries: times.map((t) => ({
          id: t.id,
          date: t.entryDate,
          hours: Number(t.hours),
          description: t.description,
          standardAmountCents: t.standardAmountCents,
        })),
      };
    }

    // ===============================================================
    // Expanded catalog — read / write / reporting / automation.
    // ===============================================================
    case 'list_clients': {
      const rows = await deps.db
        .select({
          id: clients.id,
          name: clients.name,
          status: clients.status,
          partnerInChargeId: clients.partnerInChargeId,
        })
        .from(clients)
        .where(eq(clients.firmId, token.firmId))
        .limit(500);
      return { items: rows.filter((c) => !blocked.has(c.id)) };
    }

    case 'list_invoices': {
      const Schema = z.object({
        status: z.enum(['DRAFT', 'SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOIDED']).optional(),
        limit: z.number().int().positive().max(200).default(100),
      });
      const parsed = Schema.parse(args);
      const conds = [eq(invoices.firmId, token.firmId)];
      if (parsed.status) conds.push(eq(invoices.status, parsed.status));
      const rows = await deps.db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          clientId: invoices.clientId,
          status: invoices.status,
          totalCents: invoices.totalCents,
          paidCents: invoices.paidCents,
          issueDate: invoices.issueDate,
          dueDate: invoices.dueDate,
        })
        .from(invoices)
        .where(and(...conds))
        .orderBy(desc(invoices.issueDate))
        .limit(parsed.limit);
      return { items: rows.filter((r) => !blocked.has(r.clientId)) };
    }

    case 'get_ar_aging': {
      const today = new Date().toISOString().slice(0, 10);
      const rows = await deps.db
        .select({
          clientId: invoices.clientId,
          outstandingCents: drz<number>`${invoices.totalCents} - ${invoices.paidCents}`,
          dueDate: invoices.dueDate,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.firmId, token.firmId),
            inArray(invoices.status, ['SENT', 'PARTIALLY_PAID', 'OVERDUE']),
          ),
        );
      const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
      const todayMs = new Date(today).getTime();
      for (const r of rows) {
        if (blocked.has(r.clientId)) continue;
        const out = Number(r.outstandingCents);
        if (out <= 0) continue;
        const days = r.dueDate
          ? Math.floor((todayMs - new Date(r.dueDate).getTime()) / 86_400_000)
          : 0;
        if (days <= 0) buckets.current += out;
        else if (days <= 30) buckets.d1_30 += out;
        else if (days <= 60) buckets.d31_60 += out;
        else if (days <= 90) buckets.d61_90 += out;
        else buckets.d90_plus += out;
      }
      return {
        asOf: today,
        buckets,
        totalOutstandingCents: Object.values(buckets).reduce((a, b) => a + b, 0),
      };
    }

    case 'update_engagement': {
      const Schema = z
        .object({
          engagementId: z.string().uuid(),
          status: z.enum(['PROPOSED', 'ACTIVE', 'PAUSED', 'CLOSED', 'ARCHIVED']).optional(),
          name: z.string().min(1).max(200).optional(),
        })
        .refine((v) => v.status !== undefined || v.name !== undefined, { message: 'no_fields' });
      const parsed = Schema.parse(args);
      const firmEngagementIds = await firmEngagementIdSet(deps.db, token.firmId, blocked);
      if (!firmEngagementIds.includes(parsed.engagementId)) {
        throw new Error('engagement_not_in_firm');
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.status !== undefined) patch['status'] = parsed.status;
      if (parsed.name !== undefined) patch['name'] = parsed.name;
      await deps.db.update(engagements).set(patch).where(eq(engagements.id, parsed.engagementId));
      return { id: parsed.engagementId, updated: true };
    }

    case 'create_client': {
      const Schema = z.object({
        name: z.string().min(1).max(200),
        // A client needs a partner-in-charge + office (both NOT NULL); both
        // must belong to the token's firm.
        partnerInChargeId: z.string().uuid(),
        officeId: z.string().uuid(),
      });
      const parsed = Schema.parse(args);
      const [partner] = await deps.db
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(and(eq(appUsers.id, parsed.partnerInChargeId), eq(appUsers.firmId, token.firmId)))
        .limit(1);
      if (!partner) throw new Error('partner_not_in_firm');
      const [office] = await deps.db
        .select({ id: offices.id })
        .from(offices)
        .where(and(eq(offices.id, parsed.officeId), eq(offices.firmId, token.firmId)))
        .limit(1);
      if (!office) throw new Error('office_not_in_firm');
      const [row] = await deps.db
        .insert(clients)
        .values({
          firmId: token.firmId,
          name: parsed.name,
          partnerInChargeId: parsed.partnerInChargeId,
          officeId: parsed.officeId,
        })
        .returning({ id: clients.id });
      return { id: row?.id };
    }

    case 'query_mrr': {
      const rows = await deps.db
        .select({
          frequency: recurringBillingPlans.frequency,
          amountCents: recurringBillingPlans.amountCents,
        })
        .from(recurringBillingPlans)
        .innerJoin(engagements, eq(engagements.id, recurringBillingPlans.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(eq(clients.firmId, token.firmId), eq(recurringBillingPlans.status, 'ACTIVE')));
      const monthly = (freq: string, amt: number): number => {
        switch (freq) {
          case 'WEEKLY':
            return Math.round((amt * 52) / 12);
          case 'BIWEEKLY':
            return Math.round((amt * 26) / 12);
          case 'MONTHLY':
            return amt;
          case 'QUARTERLY':
            return Math.round(amt / 3);
          case 'SEMIANNUAL':
            return Math.round(amt / 6);
          case 'ANNUAL':
            return Math.round(amt / 12);
          default:
            return 0;
        }
      };
      const mrr = rows.reduce((a, r) => a + monthly(r.frequency, Number(r.amountCents)), 0);
      return { mrrCents: mrr, arrCents: mrr * 12, planCount: rows.length };
    }

    case 'pause_recurring_plan':
    case 'resume_recurring_plan': {
      const Schema = z.object({ planId: z.string().uuid() });
      const parsed = Schema.parse(args);
      const [plan] = await deps.db
        .select({
          id: recurringBillingPlans.id,
          clientId: engagements.clientId,
          firmId: clients.firmId,
        })
        .from(recurringBillingPlans)
        .innerJoin(engagements, eq(engagements.id, recurringBillingPlans.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(eq(recurringBillingPlans.id, parsed.planId))
        .limit(1);
      if (!plan || plan.firmId !== token.firmId) throw new Error('plan_not_found_or_cross_firm');
      if (blocked.has(plan.clientId)) throw new Error('client_restricted');
      const nextStatus = tool === 'pause_recurring_plan' ? 'PAUSED' : 'ACTIVE';
      await deps.db
        .update(recurringBillingPlans)
        .set({ status: nextStatus })
        .where(eq(recurringBillingPlans.id, parsed.planId));
      return { planId: parsed.planId, status: nextStatus };
    }
  }
}
