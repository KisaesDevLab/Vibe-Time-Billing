// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Per-client communications timeline (v2 Sprint C, workstream 1.5).
// GET is paginated; POST is for manual entries (call notes, meeting
// recap). Outbound auto-records happen elsewhere via recordOutbound().

import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { type Request, type Response, type Router } from 'express';

import type { Database } from '@vibe/db';
import { clientCommunications, clients } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface CommunicationRoutesDeps extends RbacDeps {
  db: Database | null;
}

const CommunicationCreateSchema = z.object({
  channel: z.enum(['EMAIL', 'SMS', 'CALL', 'MEETING', 'NOTE']),
  direction: z.enum(['INBOUND', 'OUTBOUND', 'INTERNAL']),
  subject: z.string().max(500).nullable().optional(),
  body: z.string().min(1).max(20000),
  occurredAt: z.string().datetime().optional(),
});

async function ensureClientInFirm(
  db: Database,
  clientId: string,
  firmId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.firmId, firmId)))
    .limit(1);
  return Boolean(row);
}

export function mountCommunicationRoutes(router: Router, deps: CommunicationRoutesDeps): void {
  router.get(
    '/:id/communications',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const clientId = req.params['id']!;
      if (!(await ensureClientInFirm(deps.db, clientId, firmId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const items = await deps.db
        .select()
        .from(clientCommunications)
        .where(eq(clientCommunications.clientId, clientId))
        .orderBy(desc(clientCommunications.occurredAt))
        .limit(200);
      res.json({ items });
    },
  );

  router.post(
    '/:id/communications',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const parsed = CommunicationCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const clientId = req.params['id']!;
      if (!(await ensureClientInFirm(deps.db, clientId, firmId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const data = parsed.data;
      const [row] = await deps.db
        .insert(clientCommunications)
        .values({
          firmId,
          clientId,
          channel: data.channel,
          direction: data.direction,
          subject: data.subject ?? null,
          body: data.body,
          occurredAt: data.occurredAt ? new Date(data.occurredAt) : new Date(),
          recordedById: req.staffSession!.appUserId,
        })
        .returning();
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client_communication',
        entityId: row?.id ?? null,
        actorAppUserId: req.staffSession!.appUserId,
        after: row ? { channel: row.channel, direction: row.direction } : null,
      }).catch(() => undefined);
      res.status(201).json({ communication: row });
    },
  );
}

/**
 * Auto-record an outbound communication. Called from the notification
 * dispatcher whenever a send succeeds (locked decision #3: always-on
 * for outbound). Failures here must not break the send; the caller
 * wraps in a try/catch and logs.
 */
export async function recordOutbound(args: {
  db: Database | null;
  firmId: string;
  clientId: string;
  channel: 'EMAIL' | 'SMS';
  subject?: string | null;
  body: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}): Promise<void> {
  if (!args.db) return;
  await args.db.insert(clientCommunications).values({
    firmId: args.firmId,
    clientId: args.clientId,
    channel: args.channel,
    direction: 'OUTBOUND',
    subject: args.subject ?? null,
    body: args.body,
    occurredAt: new Date(),
    recordedById: null,
    relatedEntityType: args.relatedEntityType ?? null,
    relatedEntityId: args.relatedEntityId ?? null,
  });
}
