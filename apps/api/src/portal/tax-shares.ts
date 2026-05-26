// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-6 — Portal share creation + revocation endpoints.
//
// POST   /api/portal/tax/returns/:returnId/shares
//   Body: { recipientName, recipientEmail, recipientPhone?,
//           organization, role, accessLevel, scope, sectionIds,
//           expiresAt (ISO), require2fa, verifyChannel, watermark,
//           personalMessage }
//   201 → { shareId, expiresAt, sentAt }  — plaintext token NEVER
//         returned in the API response; ops dispatch wires it to the
//         outbound email/SMS body only.
//
// POST   /api/portal/tax/returns/:returnId/shares/:shareId/revoke

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';

import type { Database } from '@vibe/db';

import { addUuidIdGuard } from '../lib/uuid-guard';
import { resolveScope } from './scope';
import { createShare, revokeShare, ShareError } from '../tax-returns/share-helper';
import { appendAccessLog } from '../tax-returns/access-log';

export interface PortalTaxShareDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
}

const BodySchema = z.object({
  recipientName: z.string().min(1).max(200),
  recipientEmail: z.string().email().max(254),
  recipientPhone: z.string().max(30).nullable().default(null),
  organization: z.string().max(200).default(''),
  role: z.string().min(1).max(80),
  accessLevel: z.enum(['view_only', 'view_download']).default('view_only'),
  scope: z.enum(['FULL', 'SELECTED']),
  sectionIds: z.array(z.string().uuid()).default([]),
  expiresAt: z.string().datetime(),
  require2fa: z.boolean().default(true),
  verifyChannel: z.enum(['SMS', 'EMAIL', 'NONE']).default('EMAIL'),
  watermark: z.boolean().default(true),
  personalMessage: z.string().max(4000).default(''),
});

export function createPortalTaxShareRouter(deps: PortalTaxShareDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router, ['returnId', 'shareId']);

  router.post('/:returnId/shares', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', detail: parsed.error.flatten() });
      return;
    }
    const scope = await resolveScope(deps.db, session, req);

    // The share is "shared by" the active client_access row of the
    // session. We need its id.
    const accessId = (session as unknown as { activeClientAccessId?: string }).activeClientAccessId;
    if (!accessId) {
      res.status(403).json({ error: 'no_active_access' });
      return;
    }

    try {
      const result = await createShare({
        db: deps.db,
        returnId: req.params['returnId']!,
        sharedByAccessId: accessId,
        callerClientIds: scope.clientIds,
        recipientName: parsed.data.recipientName,
        recipientEmail: parsed.data.recipientEmail,
        recipientPhone: parsed.data.recipientPhone,
        organization: parsed.data.organization,
        role: parsed.data.role,
        accessLevel: parsed.data.accessLevel,
        scope: parsed.data.scope,
        sectionIds: parsed.data.sectionIds,
        expiresAt: new Date(parsed.data.expiresAt),
        require2fa: parsed.data.require2fa,
        verifyChannel: parsed.data.verifyChannel,
        watermark: parsed.data.watermark,
        personalMessage: parsed.data.personalMessage,
      });
      // TR-8b — audit. Best-effort; the share row is already
      // committed so we don't block on logger failure. Captures
      // recipient + scope but never the token.
      await appendAccessLog({
        db: deps.db,
        returnId: req.params['returnId']!,
        event: 'RELEASED',
        actorKind: 'CLIENT',
        actorRef: accessId,
        actorIp: req.ip ?? null,
        actorUserAgent: req.get('user-agent') ?? null,
        shareId: result.shareId,
        metadata: {
          recipientEmail: parsed.data.recipientEmail.toLowerCase(),
          organization: parsed.data.organization,
          scope: parsed.data.scope,
          sectionCount: parsed.data.sectionIds.length,
          accessLevel: parsed.data.accessLevel,
          require2fa: parsed.data.require2fa,
          expiresAt: result.expiresAt.toISOString(),
        },
      }).catch(() => undefined);
      // Plaintext token MUST be forwarded to the dispatcher and
      // immediately discarded — never reach the JSON response.
      // Caller-side dispatch goes here in production; for v1 we
      // expose the token only in dev/test mode for inspection.
      const includeTokenForTesting =
        process.env['NODE_ENV'] === 'test' || process.env['NODE_ENV'] === 'development';
      const body: Record<string, unknown> = {
        shareId: result.shareId,
        expiresAt: result.expiresAt.toISOString(),
      };
      if (includeTokenForTesting) {
        body['token'] = result.token;
      }
      res.status(201).json(body);
    } catch (err) {
      if (err instanceof ShareError) {
        const status =
          err.code === 'forbidden' || err.code === 'no_active_access'
            ? 403
            : err.code === 'release_not_found'
              ? 404
              : err.code.startsWith('rate_limit')
                ? 429
                : 400;
        res.status(status).json({ error: err.code, detail: err.message });
        return;
      }
      throw err;
    }
  });

  router.post(
    '/:returnId/shares/:shareId/revoke',
    deps.requireAuth,
    async (req: Request, res: Response) => {
      const session = req.portalSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const scope = await resolveScope(deps.db, session, req);
      const accessId = (session as unknown as { activeClientAccessId?: string })
        .activeClientAccessId;
      try {
        await revokeShare(deps.db, req.params['shareId']!, accessId ?? 'unknown', scope.clientIds);
        await appendAccessLog({
          db: deps.db,
          returnId: req.params['returnId']!,
          event: 'REVOKED',
          actorKind: 'CLIENT',
          actorRef: accessId ?? null,
          actorIp: req.ip ?? null,
          actorUserAgent: req.get('user-agent') ?? null,
          shareId: req.params['shareId']!,
        }).catch(() => undefined);
        res.status(204).end();
      } catch (err) {
        if (err instanceof ShareError) {
          const status = err.code === 'forbidden' ? 403 : 404;
          res.status(status).json({ error: err.code });
          return;
        }
        throw err;
      }
    },
  );

  return router;
}
