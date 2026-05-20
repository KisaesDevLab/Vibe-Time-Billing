// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Attachment metadata endpoints. Bytes live on disk under /uploads — this
// surface tracks owner+filename+size and returns a storage_path the
// frontend can use to fetch via a signed URL (signing TBD).

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { attachments } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

export interface AttachmentRoutesDeps extends RbacDeps {
  db: Database | null;
}

const CreateSchema = z.object({
  ownerType: z.enum(['engagement', 'invoice', 'client', 'time_entry', 'engagement_letter']),
  ownerId: z.string().uuid(),
  filename: z.string().min(1).max(400),
  mimeType: z.string().max(120),
  sizeBytes: z.number().int().nonnegative(),
  storagePath: z.string().min(1).max(500),
});

export function createAttachmentRouter(deps: AttachmentRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/by-owner/:ownerType/:ownerId',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(attachments)
        .where(
          and(
            eq(attachments.firmId, session.firmId),
            eq(attachments.ownerType, req.params['ownerType']!),
            eq(attachments.ownerId, req.params['ownerId']!),
          ),
        )
        .orderBy(desc(attachments.uploadedAt));
      res.json({ items });
    },
  );

  router.post('/', requirePermission(deps, 'client:write'), async (req: Request, res: Response) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(201).json({ ok: true });
      return;
    }
    const [row] = await deps.db
      .insert(attachments)
      .values({
        firmId: session.firmId,
        ownerType: parsed.data.ownerType,
        ownerId: parsed.data.ownerId,
        filename: parsed.data.filename,
        mimeType: parsed.data.mimeType,
        sizeBytes: parsed.data.sizeBytes,
        storagePath: parsed.data.storagePath,
        uploadedById: session.appUserId,
      })
      .returning({ id: attachments.id });
    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'attachment',
      entityId: row?.id,
      actorAppUserId: session.appUserId,
      after: {
        ownerType: parsed.data.ownerType,
        ownerId: parsed.data.ownerId,
        filename: parsed.data.filename,
      },
      ip: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.status(201).json({ id: row?.id });
  });

  router.delete(
    '/:id',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const deleted = await deps.db
        .delete(attachments)
        .where(and(eq(attachments.id, req.params['id']!), eq(attachments.firmId, session.firmId)))
        .returning({ id: attachments.id });
      if (deleted.length === 0) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'attachment',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { deleted: true },
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
