// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0206 follow-up — staff-readable voice-call outcome log. Backs the
// "Recent voice calls" card on Admin → Messaging and the per-client
// call history (?clientId=). Read-only; the rows are written by the
// shared placement engine + the Twilio status callback.

import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq, gte } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, voiceCalls } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { uuidQueryParam } from '../lib/uuid-guard';

export interface VoiceRoutesDeps extends RbacDeps {
  db: Database | null;
}

export function createVoiceRouter(deps: VoiceRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/calls',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const days = Math.min(Math.max(parseInt(String(req.query['days'] ?? '14'), 10) || 14, 1), 90);
      const clientId = uuidQueryParam(req.query['clientId']);
      if (clientId === 'invalid') {
        res.status(400).json({ error: 'invalid_uuid_param' });
        return;
      }
      const since = new Date(Date.now() - days * 86_400_000);
      const rows = await deps.db
        .select({
          id: voiceCalls.id,
          createdAt: voiceCalls.createdAt,
          kind: voiceCalls.kind,
          toNumber: voiceCalls.toNumber,
          status: voiceCalls.status,
          voice: voiceCalls.voice,
          fallbackSmsSent: voiceCalls.fallbackSmsSent,
          error: voiceCalls.error,
          clientId: voiceCalls.clientId,
          clientName: clients.name,
          appointmentId: voiceCalls.appointmentId,
        })
        .from(voiceCalls)
        .leftJoin(clients, eq(clients.id, voiceCalls.clientId))
        .where(
          and(
            eq(voiceCalls.firmId, firmId),
            gte(voiceCalls.createdAt, since),
            clientId ? eq(voiceCalls.clientId, clientId) : undefined,
          ),
        )
        .orderBy(desc(voiceCalls.createdAt))
        .limit(200);
      res.json({ windowDays: days, items: rows });
    },
  );

  return router;
}
