// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CP11 — File share links (Build Plan §2.4, share half).
//
// Three portal endpoints (client-authenticated):
//   POST   /api/portal/files/:id/shares
//     Body: { expiresInDays?: 1|7|30, accessLevel?: 'view'|'download',
//             note?: string }
//     Returns: { token, url, expiresAt, accessLevel, shareId }
//     The raw token appears EXACTLY ONCE; the row stores sha256(token).
//
//   GET    /api/portal/files/:id/shares
//     Lists active shares the user previously created on this file.
//     Returns: { items: [{ id, accessLevel, expiresAt, accessCount,
//                          lastAccessedAt, note, revoked }] }
//
//   POST   /api/portal/files/shares/:shareId/revoke
//     Sets revoked_at on the row. Idempotent.
//
// Public endpoint lives in `share-public.ts`.

import { createHash, randomBytes } from 'node:crypto';

import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { files, fileShares } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface PortalFileShareDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
  portalBaseUrl?: string;
}

const CreateSchema = z.object({
  expiresInDays: z.number().int().min(1).max(365).optional(),
  accessLevel: z.enum(['view', 'download']).optional(),
  note: z.string().max(1000).optional(),
});

export function createPortalFileShareRouter(deps: PortalFileShareDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.post('/:id/shares', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const fileId = req.params['id']!;
    // File must be client-visible and owned by the active client.
    const [file] = await deps.db
      .select({
        id: files.id,
        firmId: files.firmId,
        clientId: files.clientId,
        visibility: files.visibility,
        deletedAt: files.deletedAt,
        pendingUpload: files.pendingUpload,
      })
      .from(files)
      .where(eq(files.id, fileId))
      .limit(1);
    if (
      !file ||
      file.clientId !== session.activeClientId ||
      file.deletedAt != null ||
      file.pendingUpload ||
      file.visibility !== 'client_visible'
    ) {
      res.status(404).json({ error: 'file_not_found' });
      return;
    }
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt =
      parsed.data.expiresInDays != null
        ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 3600_000)
        : null;
    const [row] = await deps.db
      .insert(fileShares)
      .values({
        firmId: file.firmId,
        clientId: file.clientId,
        fileId: file.id,
        createdByPortalIdentityId: session.portalIdentityId,
        tokenHash,
        accessLevel: parsed.data.accessLevel ?? 'view',
        expiresAt,
        note: parsed.data.note ?? null,
      })
      .returning({ id: fileShares.id });
    if (!row) throw new Error('file_share_insert_failed');
    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'file_share',
      entityId: row.id,
      actorPortalIdentityId: session.portalIdentityId,
      activeClientId: session.activeClientId,
      after: {
        fileId: file.id,
        accessLevel: parsed.data.accessLevel ?? 'view',
        expiresAt: expiresAt?.toISOString() ?? null,
      },
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

    const base = deps.portalBaseUrl ?? process.env['PORTAL_BASE_URL'] ?? 'https://portal.firm.com';
    res.status(201).json({
      shareId: row.id,
      token: rawToken,
      url: `${base.replace(/\/$/, '')}/shared/${rawToken}`,
      expiresAt: expiresAt?.toISOString() ?? null,
      accessLevel: parsed.data.accessLevel ?? 'view',
    });
  });

  router.get('/:id/shares', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const fileId = req.params['id']!;
    const items = await deps.db
      .select({
        id: fileShares.id,
        accessLevel: fileShares.accessLevel,
        expiresAt: fileShares.expiresAt,
        note: fileShares.note,
        accessCount: fileShares.accessCount,
        lastAccessedAt: fileShares.lastAccessedAt,
        createdAt: fileShares.createdAt,
        revokedAt: fileShares.revokedAt,
      })
      .from(fileShares)
      .where(
        and(
          eq(fileShares.fileId, fileId),
          eq(fileShares.clientId, session.activeClientId),
          // Hide expired + revoked rows from default list — UI can ask
          // for them via ?includeInactive=1 later. For v1, keep simple.
          isNull(fileShares.revokedAt),
          or(isNull(fileShares.expiresAt), gt(fileShares.expiresAt, new Date())),
        ),
      )
      .orderBy(desc(fileShares.createdAt))
      .limit(50);
    res.json({ items });
  });

  router.post('/shares/:shareId/revoke', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const shareId = req.params['shareId']!;
    const [share] = await deps.db
      .select({
        id: fileShares.id,
        clientId: fileShares.clientId,
        revokedAt: fileShares.revokedAt,
      })
      .from(fileShares)
      .where(eq(fileShares.id, shareId))
      .limit(1);
    if (!share || share.clientId !== session.activeClientId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (share.revokedAt) {
      res.json({ ok: true, alreadyRevoked: true });
      return;
    }
    await deps.db
      .update(fileShares)
      .set({ revokedAt: new Date() })
      .where(eq(fileShares.id, share.id));
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'file_share',
      entityId: share.id,
      actorPortalIdentityId: session.portalIdentityId,
      activeClientId: session.activeClientId,
      after: { revoked: true },
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.json({ ok: true });
  });

  return router;
}

// Suppress unused-import warning for sql (kept for future filter expansions).
void sql;
