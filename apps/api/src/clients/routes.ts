// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Client management (Phase 6).

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq, ilike, inArray, or } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clientNotes, clients } from '@vibe/db/schema';
import { desc } from 'drizzle-orm';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

export interface ClientRoutesDeps extends RbacDeps {
  db: Database | null;
}

const ClientSchema = z.object({
  name: z.string().min(1).max(200),
  partnerInChargeId: z.string().uuid(),
  billingContactName: z.string().max(200).optional(),
  billingContactEmail: z.string().max(254).optional(),
  billingContactPhone: z.string().max(40).optional(),
  termsDays: z.number().int().min(0).max(365).optional(),
  invoiceConsolidationPreference: z.enum(['CONSOLIDATED', 'SEPARATE']).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

export function createClientRouter(deps: ClientRoutesDeps): Router {
  const router = express.Router();

  router.get('/', requirePermission(deps, 'client:read'), async (req: Request, res: Response) => {
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.json({ items: [] });
      return;
    }
    const q = (req.query['q'] ?? '').toString().trim();
    const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
    const partnerId = typeof req.query['partnerId'] === 'string' ? req.query['partnerId'] : null;
    const conds = [eq(clients.firmId, firmId)];
    if (q) {
      const like = or(ilike(clients.name, `%${q}%`));
      if (like) conds.push(like);
    }
    if (
      status === 'ACTIVE' ||
      status === 'ARCHIVED' ||
      status === 'PROSPECT' ||
      status === 'INACTIVE'
    ) {
      conds.push(eq(clients.status, status));
    }
    if (partnerId) conds.push(eq(clients.partnerInChargeId, partnerId));
    const items = await deps.db
      .select()
      .from(clients)
      .where(and(...conds))
      .limit(500);
    res.json({ items });
  });

  router.get(
    '/:id',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ client: null });
        return;
      }
      const [client] = await deps.db
        .select()
        .from(clients)
        .where(and(eq(clients.id, req.params['id']!), eq(clients.firmId, firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ client });
    },
  );

  router.post('/', requirePermission(deps, 'client:write'), async (req: Request, res: Response) => {
    const parsed = ClientSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const firmId = req.staffSession!.firmId;
    if (!deps.db) {
      res.status(201).json({ ok: true });
      return;
    }
    const session = req.staffSession!;
    const [row] = await deps.db
      .insert(clients)
      .values({ firmId, ...parsed.data })
      .returning({ id: clients.id });
    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'client',
      entityId: row?.id,
      actorAppUserId: session.appUserId,
      after: parsed.data,
      ip: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.status(201).json({ id: row?.id });
  });

  router.patch(
    '/:id',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const parsed = ClientSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      await deps.db
        .update(clients)
        .set(parsed.data)
        .where(and(eq(clients.firmId, firmId), eq(clients.id, req.params['id']!)));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: parsed.data,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // Legal-hold toggle (Phase 19 #12). When set, archive is blocked and
  // the retention worker preserves audit + ai_request_log entries.
  router.post(
    '/:id/legal-hold',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const body = req.body as { enabled?: unknown; reason?: unknown };
      const enabled = body.enabled === true;
      const reason = enabled && typeof body.reason === 'string' ? body.reason.slice(0, 1000) : null;
      await deps.db
        .update(clients)
        .set({
          legalHoldFlag: enabled,
          legalHoldReason: reason,
          legalHoldSetAt: enabled ? new Date() : null,
        })
        .where(and(eq(clients.firmId, firmId), eq(clients.id, req.params['id']!)));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { kind: 'legal_hold', enabled, reason },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, legalHoldFlag: enabled });
    },
  );

  router.patch(
    '/:id/archive',
    requirePermission(deps, 'client:archive'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      // Phase 19 #12 — legal-hold blocks archive.
      const [c] = await deps.db
        .select({ legalHoldFlag: clients.legalHoldFlag })
        .from(clients)
        .where(and(eq(clients.firmId, firmId), eq(clients.id, req.params['id']!)))
        .limit(1);
      if (c?.legalHoldFlag) {
        res.status(409).json({ error: 'legal_hold_active' });
        return;
      }
      await deps.db
        .update(clients)
        .set({ status: 'ARCHIVED' })
        .where(and(eq(clients.firmId, firmId), eq(clients.id, req.params['id']!)));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'client',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { status: 'ARCHIVED' },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/bulk-import',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true, created: 0 });
        return;
      }
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
      const partnerInChargeId =
        typeof req.body?.defaultPartnerId === 'string' ? req.body.defaultPartnerId : null;
      if (!rows || rows.length === 0 || !partnerInChargeId) {
        res.status(400).json({ error: 'rows_and_default_partner_required' });
        return;
      }
      const created: string[] = [];
      const skipped: { row: number; reason: string }[] = [];
      for (let i = 0; i < rows.length && i < 1000; i++) {
        const r = rows[i] as Record<string, unknown>;
        const name =
          typeof r['name'] === 'string' && r['name'].trim() ? r['name'].slice(0, 200) : null;
        if (!name) {
          skipped.push({ row: i, reason: 'missing_name' });
          continue;
        }
        try {
          const [newRow] = await deps.db
            .insert(clients)
            .values({
              firmId,
              name,
              partnerInChargeId,
              billingContactEmail:
                typeof r['billingContactEmail'] === 'string' ? r['billingContactEmail'] : null,
              billingContactPhone:
                typeof r['billingContactPhone'] === 'string' ? r['billingContactPhone'] : null,
              termsDays: typeof r['termsDays'] === 'number' ? r['termsDays'] : 30,
            })
            .returning({ id: clients.id });
          if (newRow) created.push(newRow.id);
        } catch (err) {
          skipped.push({
            row: i,
            reason: err instanceof Error ? err.message.slice(0, 200) : 'insert_failed',
          });
        }
      }
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client',
        actorAppUserId: session.appUserId,
        after: { kind: 'bulk_import', created: created.length, skipped: skipped.length },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ created: created.length, createdIds: created, skipped });
    },
  );

  router.get(
    '/export.csv',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.send('id,name,status\n');
        return;
      }
      const items = await deps.db
        .select({
          id: clients.id,
          name: clients.name,
          status: clients.status,
          billingContactEmail: clients.billingContactEmail,
          billingContactPhone: clients.billingContactPhone,
          termsDays: clients.termsDays,
          createdAt: clients.createdAt,
        })
        .from(clients)
        .where(eq(clients.firmId, firmId))
        .limit(10000);
      const header = [
        'id',
        'name',
        'status',
        'billing_email',
        'billing_phone',
        'terms_days',
        'created_at',
      ];
      const lines = [header.join(',')];
      for (const c of items) {
        lines.push(
          [
            c.id,
            csvCell(c.name),
            c.status,
            csvCell(c.billingContactEmail ?? ''),
            csvCell(c.billingContactPhone ?? ''),
            String(c.termsDays),
            c.createdAt.toISOString(),
          ].join(','),
        );
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="clients-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      res.send(lines.join('\n') + '\n');
    },
  );

  router.get(
    '/:id/notes',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const [client] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, req.params['id']!), eq(clients.firmId, firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const items = await deps.db
        .select()
        .from(clientNotes)
        .where(eq(clientNotes.clientId, client.id))
        .orderBy(desc(clientNotes.pinned), desc(clientNotes.createdAt))
        .limit(200);
      res.json({ items });
    },
  );

  router.delete(
    '/:id/notes/:noteId',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [client] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, req.params['id']!), eq(clients.firmId, firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db
        .delete(clientNotes)
        .where(and(eq(clientNotes.id, req.params['noteId']!), eq(clientNotes.clientId, client.id)));
      res.json({ ok: true });
    },
  );

  router.patch(
    '/:id/notes/:noteId/pin',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const pinned = req.body?.pinned === true;
      const [client] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, req.params['id']!), eq(clients.firmId, firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db
        .update(clientNotes)
        .set({ pinned })
        .where(and(eq(clientNotes.id, req.params['noteId']!), eq(clientNotes.clientId, client.id)));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/notes',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const body = typeof req.body?.body === 'string' ? req.body.body.slice(0, 8000) : null;
      if (!body) {
        res.status(400).json({ error: 'body_required' });
        return;
      }
      const pinned = req.body?.pinned === true;
      const [client] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, req.params['id']!), eq(clients.firmId, firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [row] = await deps.db
        .insert(clientNotes)
        .values({ clientId: client.id, authorId: session.appUserId, body, pinned })
        .returning({ id: clientNotes.id });
      res.status(201).json({ id: row?.id });
    },
  );

  // Bulk archive (or unarchive). Body: { clientIds: string[], status: 'ARCHIVED' | 'ACTIVE' }
  router.post(
    '/bulk-status',
    requirePermission(deps, 'client:archive'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ updated: 0 });
        return;
      }
      const body = req.body as { clientIds?: unknown; status?: unknown };
      const ids = Array.isArray(body.clientIds)
        ? body.clientIds.filter((x): x is string => typeof x === 'string')
        : [];
      const status = body.status === 'ARCHIVED' || body.status === 'ACTIVE' ? body.status : null;
      if (ids.length === 0 || !status) {
        res.status(400).json({ error: 'clientIds_and_status_required' });
        return;
      }
      const updated = await deps.db
        .update(clients)
        .set({ status })
        .where(and(eq(clients.firmId, session.firmId), inArray(clients.id, ids)))
        .returning({ id: clients.id });
      res.json({ updated: updated.length });
    },
  );

  return router;
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
