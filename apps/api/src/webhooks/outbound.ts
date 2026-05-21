// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Outbound webhook subscriptions (Phase 21). The firm registers an HTTPS
// URL + an event list, and the worker dispatches matching events to it
// with HMAC signature for verification. This surface is the CRUD —
// dispatch and retry live in the worker (apps/worker/src/jobs/webhook-dispatch.ts).

import crypto from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { webhookDeliveries, webhookEndpoints } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

export interface WebhookRoutesDeps extends RbacDeps {
  db: Database | null;
}

const KNOWN_EVENTS = [
  'invoice.sent',
  'invoice.paid',
  'invoice.overdue',
  'payment.received',
  'payment.failed',
  'engagement.created',
  'engagement.closed',
  'adjustment.applied',
  'pre_bill.generated',
  'client.created',
  'client.unlocked',
  'recurring_plan.invoice_generated',
] as const;

const CreateSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), 'must be https'),
  events: z.array(z.enum(KNOWN_EVENTS)).min(1).max(KNOWN_EVENTS.length),
});

const PatchSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((u) => u.startsWith('https://'), 'must be https')
      .optional(),
    events: z.array(z.enum(KNOWN_EVENTS)).min(1).max(KNOWN_EVENTS.length).optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  })
  .strict();

export function createWebhookRouter(deps: WebhookRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/known-events',
    requirePermission(deps, 'admin:webhooks:manage'),
    async (_req: Request, res: Response) => {
      res.json({ events: KNOWN_EVENTS });
    },
  );

  router.get(
    '/',
    requirePermission(deps, 'admin:webhooks:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select({
          id: webhookEndpoints.id,
          url: webhookEndpoints.url,
          events: webhookEndpoints.events,
          status: webhookEndpoints.status,
          createdAt: webhookEndpoints.createdAt,
        })
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.firmId, session.firmId));
      res.json({ items });
    },
  );

  router.post(
    '/',
    requirePermission(deps, 'admin:webhooks:manage'),
    async (req: Request, res: Response) => {
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      // Generate a 32-byte secret. We return it once in plaintext so the
      // firm can paste into their receiver; only the bcrypt-style SHA-256
      // is stored at rest.
      const secret = crypto.randomBytes(32).toString('hex');
      const secretHash = crypto.createHash('sha256').update(secret).digest('hex');
      const [row] = await deps.db
        .insert(webhookEndpoints)
        .values({
          firmId: session.firmId,
          url: parsed.data.url,
          secretHash,
          events: parsed.data.events,
        })
        .returning({ id: webhookEndpoints.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'webhook_endpoint',
        entityId: row?.id,
        actorAppUserId: session.appUserId,
        after: { url: parsed.data.url, events: parsed.data.events },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      // Return the plaintext secret ONLY in this response — never again.
      res.status(201).json({ id: row?.id, secret });
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'admin:webhooks:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const parsed = PatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const patch: Record<string, unknown> = {};
      if (parsed.data.url) patch['url'] = parsed.data.url;
      if (parsed.data.events) patch['events'] = parsed.data.events;
      if (parsed.data.status) patch['status'] = parsed.data.status;
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: 'no_fields' });
        return;
      }
      const updated = await deps.db
        .update(webhookEndpoints)
        .set(patch)
        .where(
          and(
            eq(webhookEndpoints.id, req.params['id']!),
            eq(webhookEndpoints.firmId, session.firmId),
          ),
        )
        .returning({ id: webhookEndpoints.id });
      if (updated.length === 0) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'webhook_endpoint',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: patch,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/rotate-secret',
    requirePermission(deps, 'admin:webhooks:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ secret: 'dev-no-db' });
        return;
      }
      const [endpoint] = await deps.db
        .select({ id: webhookEndpoints.id })
        .from(webhookEndpoints)
        .where(
          and(
            eq(webhookEndpoints.id, req.params['id']!),
            eq(webhookEndpoints.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!endpoint) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const secret = crypto.randomBytes(32).toString('hex');
      const secretHash = crypto.createHash('sha256').update(secret).digest('hex');
      await deps.db
        .update(webhookEndpoints)
        .set({ secretHash })
        .where(eq(webhookEndpoints.id, endpoint.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'webhook_endpoint',
        entityId: endpoint.id,
        actorAppUserId: session.appUserId,
        after: { kind: 'secret_rotated' },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ secret });
    },
  );

  router.delete(
    '/:id',
    requirePermission(deps, 'admin:webhooks:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const updated = await deps.db
        .update(webhookEndpoints)
        .set({ status: 'ARCHIVED' })
        .where(
          and(
            eq(webhookEndpoints.id, req.params['id']!),
            eq(webhookEndpoints.firmId, session.firmId),
          ),
        )
        .returning({ id: webhookEndpoints.id });
      if (updated.length === 0) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'webhook_endpoint',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { archived: true },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // Recent delivery attempts for an endpoint — useful for debugging.
  router.get(
    '/:id/deliveries',
    requirePermission(deps, 'admin:webhooks:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const [endpoint] = await deps.db
        .select({ id: webhookEndpoints.id })
        .from(webhookEndpoints)
        .where(
          and(
            eq(webhookEndpoints.id, req.params['id']!),
            eq(webhookEndpoints.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!endpoint) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const items = await deps.db
        .select({
          id: webhookDeliveries.id,
          eventType: webhookDeliveries.eventType,
          status: webhookDeliveries.status,
          attemptCount: webhookDeliveries.attemptCount,
          lastAttemptAt: webhookDeliveries.lastAttemptAt,
          nextAttemptAt: webhookDeliveries.nextAttemptAt,
          responseStatus: webhookDeliveries.responseStatus,
          createdAt: webhookDeliveries.createdAt,
        })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.webhookEndpointId, endpoint.id))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(100);
      res.json({ items });
    },
  );

  // Phase 21 #5 — webhook delivery log export. CSV/JSON download of the
  // last N (configurable, capped at 5000) deliveries for one endpoint.
  router.get(
    '/:id/deliveries/export',
    requirePermission(deps, 'admin:webhooks:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const [endpoint] = await deps.db
        .select({ id: webhookEndpoints.id, url: webhookEndpoints.url })
        .from(webhookEndpoints)
        .where(
          and(
            eq(webhookEndpoints.id, req.params['id']!),
            eq(webhookEndpoints.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!endpoint) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const limit = Math.min(
        Math.max(parseInt(String(req.query['limit'] ?? '1000'), 10) || 1000, 1),
        5000,
      );
      const format = String(req.query['format'] ?? 'json').toLowerCase();
      const items = await deps.db
        .select({
          id: webhookDeliveries.id,
          eventType: webhookDeliveries.eventType,
          status: webhookDeliveries.status,
          attemptCount: webhookDeliveries.attemptCount,
          lastAttemptAt: webhookDeliveries.lastAttemptAt,
          nextAttemptAt: webhookDeliveries.nextAttemptAt,
          responseStatus: webhookDeliveries.responseStatus,
          createdAt: webhookDeliveries.createdAt,
        })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.webhookEndpointId, endpoint.id))
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(limit);

      if (format === 'csv') {
        const header =
          'id,event_type,status,attempt_count,last_attempt_at,next_attempt_at,response_status,created_at';
        const csvEscape = (v: unknown): string => {
          if (v === null || v === undefined) return '';
          const s = v instanceof Date ? v.toISOString() : String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const rows = items.map((r) =>
          [
            r.id,
            r.eventType,
            r.status,
            r.attemptCount,
            r.lastAttemptAt,
            r.nextAttemptAt,
            r.responseStatus,
            r.createdAt,
          ]
            .map(csvEscape)
            .join(','),
        );
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="webhook-deliveries-${endpoint.id.slice(0, 8)}.csv"`,
        );
        res.send([header, ...rows].join('\n'));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="webhook-deliveries-${endpoint.id.slice(0, 8)}.json"`,
      );
      res.json({ endpoint: { id: endpoint.id, url: endpoint.url }, items, count: items.length });
    },
  );

  // Test-fire a delivery to one of the firm's endpoints with a sample
  // payload. Useful when wiring a receiver — verifies signature path.
  router.post(
    '/:id/test-fire',
    requirePermission(deps, 'admin:webhooks:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [endpoint] = await deps.db
        .select({ id: webhookEndpoints.id })
        .from(webhookEndpoints)
        .where(
          and(
            eq(webhookEndpoints.id, req.params['id']!),
            eq(webhookEndpoints.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!endpoint) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db.insert(webhookDeliveries).values({
        webhookEndpointId: endpoint.id,
        eventType: 'test.fire',
        payload: {
          eventType: 'test.fire',
          firmId: session.firmId,
          ts: new Date().toISOString(),
          test: true,
        },
        status: 'PENDING',
        nextAttemptAt: new Date(),
      });
      res.json({ ok: true, queued: true });
    },
  );

  // Aggregate delivery success rate per endpoint over a window.
  router.get(
    '/metrics',
    requirePermission(deps, 'admin:webhooks:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const days = Math.min(Math.max(parseInt(String(req.query['days'] ?? '7'), 10) || 7, 1), 90);
      const since = new Date(Date.now() - days * 86_400_000);
      const { sql: drz } = await import('drizzle-orm');
      const rows = await deps.db
        .select({
          endpointId: webhookDeliveries.webhookEndpointId,
          url: webhookEndpoints.url,
          total: drz<number>`COUNT(*)`,
          delivered: drz<number>`COUNT(*) FILTER (WHERE ${webhookDeliveries.status} = 'DELIVERED')`,
          failed: drz<number>`COUNT(*) FILTER (WHERE ${webhookDeliveries.status} = 'FAILED')`,
          avgAttempts: drz<number>`COALESCE(AVG(${webhookDeliveries.attemptCount}), 0)`,
        })
        .from(webhookDeliveries)
        .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.webhookEndpointId))
        .where(
          and(
            eq(webhookEndpoints.firmId, session.firmId),
            drz`${webhookDeliveries.createdAt} >= ${since}::timestamptz`,
          ),
        )
        .groupBy(webhookDeliveries.webhookEndpointId, webhookEndpoints.url);
      res.json({
        windowDays: days,
        items: rows.map((r) => ({
          endpointId: r.endpointId,
          url: r.url,
          total: Number(r.total),
          delivered: Number(r.delivered),
          failed: Number(r.failed),
          successRatePct:
            Number(r.total) > 0 ? (Number(r.delivered) / Number(r.total)) * 100 : null,
          avgAttempts: Number(r.avgAttempts),
        })),
      });
    },
  );

  // Manually re-queue a single delivery (e.g. after a receiver bug fix).
  router.post(
    '/:id/deliveries/:deliveryId/replay',
    requirePermission(deps, 'admin:webhooks:manage'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [endpoint] = await deps.db
        .select({ id: webhookEndpoints.id })
        .from(webhookEndpoints)
        .where(
          and(
            eq(webhookEndpoints.id, req.params['id']!),
            eq(webhookEndpoints.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!endpoint) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const updated = await deps.db
        .update(webhookDeliveries)
        .set({
          status: 'PENDING',
          attemptCount: 0,
          nextAttemptAt: new Date(),
          responseStatus: null,
          responseBody: null,
        })
        .where(
          and(
            eq(webhookDeliveries.id, req.params['deliveryId']!),
            eq(webhookDeliveries.webhookEndpointId, endpoint.id),
          ),
        )
        .returning({ id: webhookDeliveries.id });
      if (updated.length === 0) {
        res.status(404).json({ error: 'delivery_not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'webhook_delivery',
        entityId: req.params['deliveryId']!,
        actorAppUserId: session.appUserId,
        after: { kind: 'replay' },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, requeued: true });
    },
  );

  return router;
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}
