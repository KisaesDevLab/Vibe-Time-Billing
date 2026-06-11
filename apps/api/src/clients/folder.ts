// SPDX-License-Identifier: Elastic-2.0
//
// Phase 9 of FILE_MANAGER_ADDENDUM.md — folder modification endpoints.
//
//   POST /:id/folder/rename       — enqueue a folder-rename job
//   POST /:id/folder/resolve      — admin "Resume / Rollback" on a
//                                    stuck renaming row (clears the
//                                    renaming status one way or another)
//   GET  /:id/folder/progress     — SSE stream of storage-progress
//                                    events for the client's folder
//
// Permission gates per Phase 7:
//   - rename / resolve: storage:folder:rename + storage:folder:reconcile
//   - progress (read-only): storage:folder:view

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { Queue } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clientFolders } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';

export interface FolderRoutesDeps extends RbacDeps {
  db: Database | null;
  redis: Redis;
}

interface FolderRenameJobPayload {
  clientFolderId: string;
  firmId: string;
  newName: string;
  actorAppUserId: string | null;
}

const RenameSchema = z.object({
  newName: z.string().min(1).max(240),
});

const ResolveSchema = z.object({
  action: z.enum(['mark_active', 'mark_missing']),
  reason: z.string().max(500).optional(),
});

const STORAGE_MUTATION_QUEUE = 'storage-mutation';
const PROGRESS_CHANNEL_PREFIX = 'storage-progress:';

function buildMutationQueue(): Queue<FolderRenameJobPayload> {
  const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const connection = new IORedis(url, { maxRetriesPerRequest: null });
  return new Queue<FolderRenameJobPayload>(STORAGE_MUTATION_QUEUE, { connection });
}

export function mountFolderRoutes(router: Router, deps: FolderRoutesDeps): void {
  // Build the queue lazily inside a closure so tests can run without
  // a real Redis (the route returns 503 if BullMQ can't connect).
  let queue: Queue<FolderRenameJobPayload> | null = null;
  function getQueue(): Queue<FolderRenameJobPayload> | null {
    if (queue) return queue;
    try {
      queue = buildMutationQueue();
      return queue;
    } catch {
      return null;
    }
  }

  router.post(
    '/:id/folder/rename',
    requirePermission(deps, 'storage:folder:rename'),
    async (req: Request, res: Response) => {
      const parsed = RenameSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(202).json({ ok: true });
        return;
      }
      // Verify the client is bound. We dispatch by client_folders.id, not
      // client.id, so the lookup runs through the existing binding.
      const [folder] = await deps.db
        .select({ id: clientFolders.id, status: clientFolders.status })
        .from(clientFolders)
        .where(
          and(
            eq(clientFolders.clientId, req.params['id']!),
            eq(clientFolders.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!folder) {
        res.status(404).json({ error: 'client_folder_not_bound' });
        return;
      }
      if (folder.status !== 'active') {
        res.status(409).json({ error: 'folder_not_active', status: folder.status });
        return;
      }
      const q = getQueue();
      if (!q) {
        res.status(503).json({ error: 'mutation_queue_unavailable' });
        return;
      }
      const job = await q.add(
        'folder-rename',
        {
          clientFolderId: folder.id,
          firmId: session.firmId,
          newName: parsed.data.newName,
          actorAppUserId: session.appUserId,
        },
        {
          attempts: 1, // Retries are user-driven via "Resume" — no auto-retry.
          removeOnComplete: { age: 24 * 3600 },
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      );
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_folder',
        entityId: folder.id,
        actorAppUserId: session.appUserId,
        after: { op: 'folder-rename', newName: parsed.data.newName, jobId: job.id },
      }).catch(() => undefined);
      res.status(202).json({ jobId: job.id, clientFolderId: folder.id });
    },
  );

  router.post(
    '/:id/folder/resolve',
    requirePermission(deps, 'storage:folder:reconcile'),
    async (req: Request, res: Response) => {
      const parsed = ResolveSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [folder] = await deps.db
        .select({ id: clientFolders.id, status: clientFolders.status })
        .from(clientFolders)
        .where(
          and(
            eq(clientFolders.clientId, req.params['id']!),
            eq(clientFolders.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!folder) {
        res.status(404).json({ error: 'client_folder_not_bound' });
        return;
      }
      const next = parsed.data.action === 'mark_active' ? 'active' : 'missing';
      await deps.db
        .update(clientFolders)
        .set({ status: next, updatedAt: new Date() })
        .where(eq(clientFolders.id, folder.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_folder',
        entityId: folder.id,
        actorAppUserId: session.appUserId,
        before: { status: folder.status },
        after: { status: next, reason: parsed.data.reason ?? null },
      }).catch(() => undefined);
      res.json({ ok: true, status: next });
    },
  );

  // SSE stream — subscribes to storage-progress:{client_folder_id} on
  // Redis and forwards every message as an `event: progress` frame.
  // One subscriber connection per request so the parent deps.redis is
  // never put into subscriber mode (it'd break unrelated GET/SET ops).
  router.get(
    '/:id/folder/progress',
    requirePermission(deps, 'storage:folder:view'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(404).json({ error: 'no_db' });
        return;
      }
      const [folder] = await deps.db
        .select({ id: clientFolders.id })
        .from(clientFolders)
        .where(
          and(
            eq(clientFolders.clientId, req.params['id']!),
            eq(clientFolders.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!folder) {
        res.status(404).json({ error: 'client_folder_not_bound' });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');

      const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
      const subscriber = new IORedis(url, { maxRetriesPerRequest: null });
      const channel = `${PROGRESS_CHANNEL_PREFIX}${folder.id}`;
      subscriber.subscribe(channel).catch((err: unknown) => {
        res.write(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`);
      });
      subscriber.on('message', (_chan, msg) => {
        res.write(`event: progress\ndata: ${msg}\n\n`);
      });
      // Heartbeat every 25s so intermediate proxies don't kill the
      // connection during long quiet periods between phases.
      const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(heartbeat);
        void subscriber.quit();
      });
    },
  );
}

export function buildFolderRouter(deps: FolderRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);
  mountFolderRoutes(router, deps);
  return router;
}
