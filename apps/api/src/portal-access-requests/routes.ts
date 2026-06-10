// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Staff side of self-service portal access requests. Lists PENDING
// requests (one per person+client) for review under Approvals, and lets a
// reviewer approve (granting portal access at a chosen role, reusing the
// portal-invite grant path) or deny. Gated on client:portal-access:manage.

import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { clients, persons, portalAccessRequest } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { grantOrInvitePortalAccess } from '../portal-invites/grant';

export interface PortalAccessRequestDeps extends RbacDeps {
  db: Database | null;
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
  sendSms?: (args: { to: string; body: string }) => Promise<void>;
  portalBaseUrl: string;
}

const ApproveSchema = z.object({
  role: z.enum(['FULL', 'VIEW_ONLY', 'PAY_ONLY']).default('FULL'),
});

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

export function createPortalAccessRequestRouter(deps: PortalAccessRequestDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  // List pending requests (one row per person+client).
  router.get(
    '/',
    requirePermission(deps, 'client:portal-access:manage'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const rows = await deps.db
        .select({
          id: portalAccessRequest.id,
          personId: portalAccessRequest.personId,
          personName: persons.fullName,
          personEmail: persons.email,
          personPhone: persons.phone,
          clientId: portalAccessRequest.clientId,
          clientName: clients.name,
          submittedEmail: portalAccessRequest.submittedEmail,
          submittedPhone: portalAccessRequest.submittedPhone,
          idType: portalAccessRequest.idType,
          idValue: portalAccessRequest.idValue,
          createdAt: portalAccessRequest.createdAt,
        })
        .from(portalAccessRequest)
        .innerJoin(persons, eq(persons.id, portalAccessRequest.personId))
        .innerJoin(clients, eq(clients.id, portalAccessRequest.clientId))
        .where(
          and(eq(portalAccessRequest.firmId, firmId), eq(portalAccessRequest.status, 'PENDING')),
        )
        .orderBy(desc(portalAccessRequest.createdAt))
        .limit(500);
      const items = rows.map((r) => ({
        id: r.id,
        personId: r.personId,
        personName: r.personName,
        clientId: r.clientId,
        clientName: r.clientName,
        email: r.submittedEmail ?? r.personEmail,
        phone: r.submittedPhone ?? r.personPhone,
        idType: r.idType,
        idValue: r.idValue,
        createdAt: r.createdAt,
      }));
      res.json({ items });
    },
  );

  router.get(
    '/count',
    requirePermission(deps, 'client:portal-access:manage'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ pending: 0 });
        return;
      }
      const [row] = await deps.db
        .select({ c: sql<number>`COUNT(*)` })
        .from(portalAccessRequest)
        .where(
          and(eq(portalAccessRequest.firmId, firmId), eq(portalAccessRequest.status, 'PENDING')),
        );
      res.json({ pending: Number(row?.c ?? 0) });
    },
  );

  // Approve — grant portal access at the chosen role, mark APPROVED.
  router.post(
    '/:id/approve',
    requirePermission(deps, 'client:portal-access:manage'),
    async (req: Request, res: Response) => {
      const parsed = ApproveSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const db = deps.db;
      const [reqRow] = await db
        .select({
          id: portalAccessRequest.id,
          status: portalAccessRequest.status,
          personId: portalAccessRequest.personId,
          clientId: portalAccessRequest.clientId,
          clientContactId: portalAccessRequest.clientContactId,
          submittedEmail: portalAccessRequest.submittedEmail,
          submittedPhone: portalAccessRequest.submittedPhone,
          personName: persons.fullName,
          personEmail: persons.email,
          personPhone: persons.phone,
          clientName: clients.name,
        })
        .from(portalAccessRequest)
        .innerJoin(persons, eq(persons.id, portalAccessRequest.personId))
        .innerJoin(clients, eq(clients.id, portalAccessRequest.clientId))
        .where(
          and(
            eq(portalAccessRequest.id, req.params['id']!),
            eq(portalAccessRequest.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!reqRow) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (reqRow.status !== 'PENDING') {
        res.status(409).json({ error: 'already_decided', status: reqRow.status });
        return;
      }

      const email = reqRow.submittedEmail ?? reqRow.personEmail ?? null;
      const phone = reqRow.submittedPhone ?? reqRow.personPhone ?? null;
      const grant = await grantOrInvitePortalAccess(
        {
          db,
          sendEmail: deps.sendEmail,
          sendSms: deps.sendSms,
          portalBaseUrl: deps.portalBaseUrl,
        },
        {
          firmId: session.firmId,
          client: { id: reqRow.clientId, name: reqRow.clientName },
          fullName: reqRow.personName,
          email,
          phone,
          role: parsed.data.role,
          deliveryChannel: email ? 'EMAIL' : 'SMS',
          clientContactId: reqRow.clientContactId ?? undefined,
          personId: reqRow.personId,
          actorAppUserId: session.appUserId,
          ip: clientIp(req),
          userAgent: req.header('user-agent') ?? null,
        },
      );
      if (!grant.ok) {
        res.status(400).json({ error: grant.error });
        return;
      }
      await db
        .update(portalAccessRequest)
        .set({ status: 'APPROVED', decidedBy: session.appUserId, decidedAt: new Date() })
        .where(eq(portalAccessRequest.id, reqRow.id));
      await emitAudit(db, {
        action: 'UPDATE',
        entityType: 'portal_access_request',
        entityId: reqRow.id,
        actorAppUserId: session.appUserId,
        after: { status: 'APPROVED', clientId: reqRow.clientId, role: parsed.data.role },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, granted: grant.deduped ? 'active' : 'invited' });
    },
  );

  // Deny — record the decision, no portal access, no notification.
  router.post(
    '/:id/deny',
    requirePermission(deps, 'client:portal-access:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [reqRow] = await deps.db
        .select({ id: portalAccessRequest.id, status: portalAccessRequest.status })
        .from(portalAccessRequest)
        .where(
          and(
            eq(portalAccessRequest.id, req.params['id']!),
            eq(portalAccessRequest.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!reqRow) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (reqRow.status !== 'PENDING') {
        res.status(409).json({ error: 'already_decided', status: reqRow.status });
        return;
      }
      await deps.db
        .update(portalAccessRequest)
        .set({ status: 'DENIED', decidedBy: session.appUserId, decidedAt: new Date() })
        .where(eq(portalAccessRequest.id, reqRow.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'portal_access_request',
        entityId: reqRow.id,
        actorAppUserId: session.appUserId,
        after: { status: 'DENIED' },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  return router;
}
