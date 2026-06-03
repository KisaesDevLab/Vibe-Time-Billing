// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-5 — Staff impersonation issue route.
//
// POST /api/staff/clients/:clientId/impersonate
//   Body: { accessId }
//   200 → { token, expiresAt, portalUrl } — token to be appended to
//         the portal URL as `?impersonate=<token>`. Expires in 5 min.
//
// The route requires `engagement:read` (partners + managers + senior).
// Plain staff cannot impersonate. We additionally audit-log every
// issuance with the staff user id + client id.

import express, { type Request, type Response, type Router } from 'express';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { appUsers, clients, clientPortalAccess } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { issueImpersonationToken, IMPERSONATION_TTL_SECONDS } from './impersonation';

export interface ImpersonationRouteDeps extends RbacDeps {
  db: Database | null;
  staffSecret: string;
  portalBaseUrl: string;
}

const BodySchema = z.object({
  accessId: z.string().uuid(),
});

export function createImpersonationRouter(deps: ImpersonationRouteDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router, ['clientId']);

  router.post(
    '/:clientId/impersonate',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = BodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const clientId = req.params['clientId']!;

      // Scope check: the client must belong to the caller's firm.
      const [client] = await deps.db
        .select({ id: clients.id, firmId: clients.firmId })
        .from(clients)
        .where(eq(clients.id, clientId))
        .limit(1);
      if (!client || client.firmId !== session.firmId) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }

      // The supplied access_id must reference a client_portal_access
      // row for this client.
      const [access] = await deps.db
        .select({ id: clientPortalAccess.id, clientId: clientPortalAccess.clientId })
        .from(clientPortalAccess)
        .where(
          and(
            eq(clientPortalAccess.id, parsed.data.accessId),
            eq(clientPortalAccess.clientId, clientId),
          ),
        )
        .limit(1);
      if (!access) {
        res.status(404).json({ error: 'access_not_found' });
        return;
      }

      // Staff email for the token claim (for portal banner display).
      const [staff] = await deps.db
        .select({ email: appUsers.email })
        .from(appUsers)
        .where(eq(appUsers.id, session.appUserId))
        .limit(1);
      const staffEmail = staff?.email ?? '';

      const { token, expiresAt } = await issueImpersonationToken({
        staffSecret: deps.staffSecret,
        clientId,
        accessId: parsed.data.accessId,
        staffUserId: session.appUserId,
        staffEmail,
      });

      // Audit log — staff actor + portal_identity captured via the
      // access row in the after payload. The portal-side exchange also
      // emits its own IMPERSONATE row when the token is redeemed; both
      // are needed because a token can be issued and never used.
      await emitAudit(deps.db, {
        action: 'IMPERSONATE',
        entityType: 'client_portal_access',
        entityId: parsed.data.accessId,
        actorAppUserId: session.appUserId,
        activeClientId: clientId,
        after: {
          phase: 'token_issued',
          clientId,
          accessId: parsed.data.accessId,
          staffEmail,
          expiresAt: expiresAt.toISOString(),
        },
        ip:
          (req.headers?.['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '').trim() ||
          null,
        userAgent: typeof req.header === 'function' ? (req.header('user-agent') ?? null) : null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      const portalUrl = `${deps.portalBaseUrl.replace(/\/$/, '')}/auth/impersonate?token=${encodeURIComponent(token)}`;

      res.status(201).json({
        token,
        expiresAt: expiresAt.toISOString(),
        portalUrl,
        ttlSeconds: IMPERSONATION_TTL_SECONDS,
      });
    },
  );

  return router;
}
