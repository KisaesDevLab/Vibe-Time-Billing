// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-3 — Staff tax-return release API.
//
// POST   /api/staff/tax/returns/:returnId/releases    create a release
// DELETE /api/staff/tax/returns/:returnId/releases/:releaseId  revoke
//
// Permissions:
//   • engagement:read = list + read
//   • engagement:write = create release
//   • engagement:write = revoke release
//
// The plan calls for partner/manager separation (manager marks for
// review, partner approves). v1 collapses both into `engagement:write`
// — RBAC is already permission-keyed and the role→permission map can
// add a finer-grained `tax:release` permission later.

import express, { type Request, type Response, type Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { taxReturns } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { createRelease, revokeRelease, ReleaseError } from './release-helper';
import { appendAccessLog, exportAccessLogCsv, listAccessLog } from './access-log';

export interface TaxReturnRoutesDeps extends RbacDeps {
  db: Database | null;
}

const CreateReleaseSchema = z.object({
  releasedToClientId: z.string().uuid(),
  scope: z.enum(['FULL', 'SELECTED']),
  sectionIds: z.array(z.string().uuid()).default([]),
  clientCanDownload: z.boolean().default(true),
  coverNote: z.string().max(2000).nullable().default(null),
});

export function createTaxReturnRouter(deps: TaxReturnRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router, ['returnId', 'releaseId']);

  router.post(
    '/:returnId/releases',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = CreateReleaseSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', detail: parsed.error.flatten() });
        return;
      }
      try {
        const result = await createRelease({
          db: deps.db,
          returnId: req.params['returnId']!,
          firmId: session.firmId,
          releasedToClientId: parsed.data.releasedToClientId,
          scope: parsed.data.scope,
          sectionIds: parsed.data.sectionIds,
          clientCanDownload: parsed.data.clientCanDownload,
          coverNote: parsed.data.coverNote,
          releasedByUserId: session.appUserId,
        });
        // TR-8 — audit. Best-effort; failure does not block the
        // release (which is already committed).
        await appendAccessLog({
          db: deps.db,
          returnId: req.params['returnId']!,
          event: 'RELEASED',
          actorKind: 'STAFF',
          actorRef: session.appUserId,
          actorIp: req.ip ?? null,
          actorUserAgent: req.get('user-agent') ?? null,
          metadata: {
            releaseId: result.releaseId,
            supersededReleaseId: result.supersededReleaseId,
            scope: parsed.data.scope,
          },
        }).catch(() => undefined);
        res.status(201).json(result);
      } catch (err) {
        if (err instanceof ReleaseError) {
          const status =
            err.code === 'forbidden' ? 403 : err.code.includes('not_found') ? 404 : 400;
          res.status(status).json({ error: err.code, detail: err.message });
          return;
        }
        throw err;
      }
    },
  );

  router.delete(
    '/:returnId/releases/:releaseId',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      try {
        await revokeRelease(deps.db, req.params['releaseId']!, session.appUserId, session.firmId);
        res.status(204).end();
      } catch (err) {
        if (err instanceof ReleaseError) {
          const status = err.code === 'forbidden' ? 403 : 404;
          res.status(status).json({ error: err.code, detail: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // TR-8 — staff access-log read endpoints.
  router.get(
    '/:returnId/access-log',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const cursorRaw = req.query['cursor'];
      let cursor: { at: string; id: string } | null = null;
      if (typeof cursorRaw === 'string' && cursorRaw.length > 0) {
        try {
          cursor = JSON.parse(Buffer.from(cursorRaw, 'base64url').toString('utf8'));
        } catch {
          res.status(400).json({ error: 'bad_cursor' });
          return;
        }
      }
      const result = await listAccessLog({
        db: deps.db,
        returnId: req.params['returnId']!,
        firmId: session.firmId,
        cursor,
        pageSize: 50,
        clientVisibleOnly: false,
      });
      const nextCursor =
        result.nextCursor === null
          ? null
          : Buffer.from(JSON.stringify(result.nextCursor)).toString('base64url');
      res.json({ items: result.items, nextCursor });
    },
  );

  router.get(
    '/:returnId/access-log.csv',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const csv = await exportAccessLogCsv({
        db: deps.db,
        returnId: req.params['returnId']!,
        firmId: session.firmId,
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="tax-return-access-log-${req.params['returnId']}.csv"`,
      );
      res.send(csv);
    },
  );

  // Helpful list for the staff UI: every return + latest live release
  // per client. Read-only; permission is engagement:read.
  router.get(
    '/',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const rows = await deps.db
        .select({
          id: taxReturns.id,
          clientId: taxReturns.clientId,
          taxYear: taxReturns.taxYear,
          formCode: taxReturns.formCode,
          title: taxReturns.title,
          status: taxReturns.status,
          releaseKind: taxReturns.releaseKind,
          totalPages: taxReturns.totalPages,
          releasedAt: taxReturns.releasedAt,
          createdAt: taxReturns.createdAt,
        })
        .from(taxReturns)
        .where(eq(taxReturns.firmId, session.firmId));
      res.json({ items: rows });
    },
  );

  return router;
}
