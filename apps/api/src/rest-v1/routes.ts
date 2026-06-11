// SPDX-License-Identifier: Elastic-2.0
//
// REST API v1 (Phase 21). Token-authenticated read/write surface for
// integrators. Uses the same `mcp_token` table as the MCP server, with
// `allowed_tools` claim controlling per-route access. Every mutation
// emits an audit row with the token id as the actor.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import type { Redis } from 'ioredis';
import { clients, engagements, invoices, timeEntries } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requireApiToken, requireApiTokenRateLimit, requireToolScope } from '../auth/api-token';
import { logger } from '../logger';

export interface RestRoutesDeps {
  db: Database | null;
  redis?: Redis;
}

const TimeEntryCreateSchema = z.object({
  engagementId: z.string().uuid(),
  appUserId: z.string().uuid(),
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hours: z.number().positive().max(24),
  workCodeId: z.string().uuid().optional(),
  description: z.string().max(2000).optional(),
  // Caller provides the snapshot rate — they should look it up via
  // /v1/rates/resolve first (future endpoint). For now we trust the caller.
  standardRateSnapshotCents: z.number().int().nonnegative(),
});

export function createRestV1Router(deps: RestRoutesDeps): Router {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));
  router.use(requireApiToken(deps.db));
  router.use(requireApiTokenRateLimit(deps.redis));

  router.get(
    '/engagements',
    requireToolScope('list_engagements'),
    async (req: Request, res: Response) => {
      const token = req.apiToken!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const firmClientRows = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.firmId, token.firmId));
      const ids = firmClientRows.map((c) => c.id);
      if (ids.length === 0) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select({
          id: engagements.id,
          name: engagements.name,
          clientId: engagements.clientId,
          status: engagements.status,
          feeStructure: engagements.feeStructure,
        })
        .from(engagements)
        .where(inArray(engagements.clientId, ids))
        .limit(500);
      res.json({ items });
    },
  );

  router.get(
    '/time-entries',
    requireToolScope('get_time_entries'),
    async (req: Request, res: Response) => {
      const QuerySchema = z.object({
        engagementId: z.string().uuid().optional(),
        start: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        end: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(200),
      });
      const parsed = QuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_query' });
        return;
      }
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const conds = [] as ReturnType<typeof eq>[];
      if (parsed.data.engagementId)
        conds.push(eq(timeEntries.engagementId, parsed.data.engagementId));
      if (parsed.data.start) conds.push(gte(timeEntries.entryDate, parsed.data.start));
      if (parsed.data.end) conds.push(lte(timeEntries.entryDate, parsed.data.end));
      const items = await deps.db
        .select()
        .from(timeEntries)
        .where(conds.length === 0 ? undefined : and(...conds))
        .orderBy(desc(timeEntries.entryDate))
        .limit(parsed.data.limit);
      res.json({ items });
    },
  );

  router.post(
    '/time-entries',
    requireToolScope('create_time_entry'),
    async (req: Request, res: Response) => {
      const parsed = TimeEntryCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
        return;
      }
      const token = req.apiToken!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .insert(timeEntries)
        .values({
          engagementId: parsed.data.engagementId,
          appUserId: parsed.data.appUserId,
          workCodeId: parsed.data.workCodeId ?? null,
          entryDate: parsed.data.entryDate,
          hours: parsed.data.hours.toString(),
          description: parsed.data.description ?? '',
          standardRateSnapshotCents: parsed.data.standardRateSnapshotCents,
          standardAmountCents: Math.round(
            parsed.data.standardRateSnapshotCents * parsed.data.hours,
          ),
        })
        .returning({ id: timeEntries.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'time_entry',
        entityId: row?.id,
        actorMcpTokenId: token.tokenId,
        after: parsed.data,
        ip: req.ip ?? null,
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: row?.id });
    },
  );

  router.get(
    '/invoices',
    requireToolScope('list_invoices'),
    async (req: Request, res: Response) => {
      const token = req.apiToken!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(invoices)
        .where(eq(invoices.firmId, token.firmId))
        .orderBy(desc(invoices.issueDate))
        .limit(500);
      res.json({ items });
    },
  );

  return router;
}
