// SPDX-License-Identifier: Elastic-2.0
//
// 0102 — staff-initiated secure file sharing. Lets staff share any firm
// file with an outside recipient: emailed, expiring, revocable, audited
// link with view/download control and optional PDF watermark. Gated by
// storage:file:publish (sharing externally is a publish-class action).

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { fileShares, files, firms } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';
import {
  createFileShare,
  deliverShare,
  revokeFileShare,
  type ShareVerifyChannel,
} from '../sharing/file-share-helper';

export interface StaffFileShareDeps extends RbacDeps {
  db: Database | null;
  portalBaseUrl: string;
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
  sendSms?: (args: { to: string; body: string }) => Promise<void>;
}

const CreateSchema = z.object({
  recipientName: z.string().max(200).optional(),
  recipientEmail: z.string().email().max(254),
  recipientPhone: z.string().max(40).nullable().optional(),
  organization: z.string().max(200).optional(),
  role: z.string().max(120).optional(),
  accessLevel: z.enum(['view', 'download']).default('view'),
  expiresInDays: z.number().int().min(1).max(90).optional(),
  watermark: z.boolean().default(false),
  require2fa: z.boolean().default(false),
  verifyChannel: z.enum(['NONE', 'EMAIL', 'SMS']).default('NONE'),
  personalMessage: z.string().max(4000).optional(),
  note: z.string().max(1000).optional(),
});

export function createStaffFileShareRouter(deps: StaffFileShareDeps): Router {
  const router = express.Router();
  const includeTokenForTesting = process.env['NODE_ENV'] !== 'production';

  // POST /:id/share — create + deliver a share for one file.
  router.post(
    '/:id/share',
    requirePermission(deps, 'storage:file:publish'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      const d = parsed.data;
      const [file] = await deps.db
        .select({
          id: files.id,
          firmId: files.firmId,
          clientId: files.clientId,
          deletedAt: files.deletedAt,
          pendingUpload: files.pendingUpload,
        })
        .from(files)
        .where(eq(files.id, req.params['id']!))
        .limit(1);
      if (!file || file.firmId !== session.firmId || file.deletedAt || file.pendingUpload) {
        res.status(404).json({ error: 'file_not_found' });
        return;
      }

      const expiresAt = d.expiresInDays
        ? new Date(Date.now() + d.expiresInDays * 86_400_000)
        : null;
      const result = await createFileShare(deps.db, {
        firmId: session.firmId,
        clientId: file.clientId,
        fileId: file.id,
        createdByAppUserId: session.appUserId,
        accessLevel: d.accessLevel,
        recipientName: d.recipientName ?? null,
        recipientEmail: d.recipientEmail,
        recipientPhone: d.recipientPhone ?? null,
        organization: d.organization ?? null,
        role: d.role ?? null,
        personalMessage: d.personalMessage ?? null,
        require2fa: d.require2fa,
        verifyChannel: d.verifyChannel as ShareVerifyChannel,
        watermark: d.watermark,
        note: d.note ?? null,
        expiresAt,
      });
      if (!result.ok) {
        res.status(429).json({ error: result.error });
        return;
      }

      const link = `${deps.portalBaseUrl}/api/shared/${result.token}`;
      const [firm] = await deps.db
        .select({ name: firms.name })
        .from(firms)
        .where(eq(firms.id, session.firmId))
        .limit(1);
      let delivered = { emailed: false, smsed: false };
      try {
        delivered = await deliverShare({
          sendEmail: deps.sendEmail,
          sendSms: deps.sendSms,
          recipientEmail: d.recipientEmail,
          recipientPhone: d.recipientPhone ?? null,
          verifyChannel: d.verifyChannel,
          recipientName: d.recipientName ?? null,
          personalMessage: d.personalMessage ?? null,
          senderLabel: firm?.name ?? 'Your accountant',
          link,
          expiresAt: result.expiresAt,
        });
        if (delivered.emailed || delivered.smsed) {
          await deps.db
            .update(fileShares)
            .set({ deliveredAt: new Date() })
            .where(eq(fileShares.id, result.shareId));
        }
      } catch (err) {
        logger.error({ err, shareId: result.shareId }, 'file share delivery failed');
      }

      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'file_share',
        entityId: result.shareId,
        actorAppUserId: session.appUserId,
        after: {
          fileId: file.id,
          recipientEmail: d.recipientEmail,
          accessLevel: d.accessLevel,
          watermark: d.watermark,
          delivered,
        },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);

      res.status(201).json({
        ok: true,
        shareId: result.shareId,
        expiresAt: result.expiresAt.toISOString(),
        delivered,
        ...(includeTokenForTesting ? { token: result.token, link } : {}),
      });
    },
  );

  // GET /:id/shares — list (redacted) shares for one file.
  router.get(
    '/:id/shares',
    requirePermission(deps, 'storage:file:publish'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const rows = await deps.db
        .select({
          id: fileShares.id,
          recipientName: fileShares.recipientName,
          recipientEmail: fileShares.recipientEmail,
          organization: fileShares.organization,
          accessLevel: fileShares.accessLevel,
          watermark: fileShares.watermark,
          status: fileShares.status,
          expiresAt: fileShares.expiresAt,
          createdAt: fileShares.createdAt,
          revokedAt: fileShares.revokedAt,
          deliveredAt: fileShares.deliveredAt,
          accessCount: fileShares.accessCount,
          lastViewedAt: fileShares.lastViewedAt,
        })
        .from(fileShares)
        .where(and(eq(fileShares.fileId, req.params['id']!), eq(fileShares.firmId, session.firmId)))
        .orderBy(desc(fileShares.createdAt));
      res.json({ items: rows });
    },
  );

  // POST /shares/:shareId/revoke
  router.post(
    '/shares/:shareId/revoke',
    requirePermission(deps, 'storage:file:publish'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select({ id: fileShares.id })
        .from(fileShares)
        .where(
          and(eq(fileShares.id, req.params['shareId']!), eq(fileShares.firmId, session.firmId)),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'share_not_found' });
        return;
      }
      await revokeFileShare(deps.db, row.id);
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'file_share',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: { revoked: true },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  return router;
}
