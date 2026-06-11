// SPDX-License-Identifier: Elastic-2.0
//
// Admin → Catalog → Tax payments backend. Two CRUD surfaces:
//
//   /tax-jurisdictions        — Federal, State - CA, Local - Oakland …
//   /tax-payment-types        — Income Tax, Estimate, Tax Notice …
//                               (scoped to a jurisdiction; carries the
//                                URL the portal links to)
//
// Both gated on taxonomy:write for CUD; taxonomy:read for list (every
// staff role has it, so the New Tax Payment form's dropdowns work for
// everyone with payment scheduling rights).

import express, { type Request, type Response, type Router } from 'express';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { taxJurisdictions, taxPaymentTypeCatalog } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface TaxCatalogDeps extends RbacDeps {
  db: Database | null;
}

// ---------- Jurisdictions ----------

const JurisdictionCreate = z.object({
  name: z.string().min(1).max(120),
  active: z.boolean().optional(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
});
const JurisdictionUpdate = JurisdictionCreate.partial();

export function createTaxJurisdictionRouter(deps: TaxCatalogDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', requirePermission(deps, 'taxonomy:read'), async (req: Request, res: Response) => {
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.json({ items: [] });
      return;
    }
    const items = await deps.db
      .select()
      .from(taxJurisdictions)
      .where(eq(taxJurisdictions.firmId, firmId))
      .orderBy(asc(taxJurisdictions.displayOrder), asc(taxJurisdictions.name));
    res.json({ items });
  });

  router.post(
    '/',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = JurisdictionCreate.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      try {
        const [row] = await deps.db
          .insert(taxJurisdictions)
          .values({
            firmId: session.firmId,
            name: parsed.data.name.trim(),
            active: parsed.data.active ?? true,
            displayOrder: parsed.data.displayOrder ?? 100,
            isSystem: false,
          })
          .returning({ id: taxJurisdictions.id });
        await emitAudit(deps.db, {
          action: 'CREATE',
          entityType: 'tax_jurisdiction',
          entityId: row?.id,
          actorAppUserId: session.appUserId,
          after: parsed.data,
        }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
        res.status(201).json({ id: row?.id });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          res.status(409).json({ error: 'duplicate_name' });
          return;
        }
        logger.error({ err }, 'tax_jurisdiction insert failed');
        res.status(500).json({ error: 'insert_failed' });
      }
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = JurisdictionUpdate.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.name !== undefined) updates['name'] = parsed.data.name.trim();
      if (parsed.data.active !== undefined) updates['active'] = parsed.data.active;
      if (parsed.data.displayOrder !== undefined) {
        updates['displayOrder'] = parsed.data.displayOrder;
      }
      const result = await deps.db
        .update(taxJurisdictions)
        .set(updates)
        .where(
          and(
            eq(taxJurisdictions.id, req.params['id']!),
            eq(taxJurisdictions.firmId, session.firmId),
          ),
        )
        .returning({ id: taxJurisdictions.id });
      if (result.length === 0) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'tax_jurisdiction',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: parsed.data,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.delete(
    '/:id',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select({ id: taxJurisdictions.id, isSystem: taxJurisdictions.isSystem })
        .from(taxJurisdictions)
        .where(
          and(
            eq(taxJurisdictions.id, req.params['id']!),
            eq(taxJurisdictions.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.isSystem) {
        res.status(409).json({
          error: 'system_row_undeletable',
          hint: 'Deactivate it instead — system rows cannot be deleted.',
        });
        return;
      }
      // ON DELETE CASCADE on tax_payment_type takes the dependent rows
      // with it; historical tax_payment.jurisdiction strings survive.
      await deps.db.delete(taxJurisdictions).where(eq(taxJurisdictions.id, row.id));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'tax_jurisdiction',
        entityId: row.id,
        actorAppUserId: session.appUserId,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  return router;
}

// ---------- Payment types ----------

const URL_RE = /^https?:\/\/[^\s]+$/i;
const TypeCreate = z.object({
  jurisdictionId: z.string().uuid(),
  name: z.string().min(1).max(120),
  paymentUrl: z.string().regex(URL_RE).max(2048).nullable().optional(),
  active: z.boolean().optional(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
});
const TypeUpdate = z.object({
  name: z.string().min(1).max(120).optional(),
  paymentUrl: z.string().regex(URL_RE).max(2048).nullable().optional(),
  active: z.boolean().optional(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
});

export function createTaxPaymentTypeRouter(deps: TaxCatalogDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router, ['jurisdictionId']);

  router.get('/', requirePermission(deps, 'taxonomy:read'), async (req: Request, res: Response) => {
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.json({ items: [] });
      return;
    }
    const conds = [eq(taxPaymentTypeCatalog.firmId, firmId)];
    const juris = req.query['jurisdictionId'];
    if (typeof juris === 'string' && juris) {
      conds.push(eq(taxPaymentTypeCatalog.jurisdictionId, juris));
    }
    const items = await deps.db
      .select()
      .from(taxPaymentTypeCatalog)
      .where(and(...conds))
      .orderBy(asc(taxPaymentTypeCatalog.displayOrder), asc(taxPaymentTypeCatalog.name));
    res.json({ items });
  });

  router.post(
    '/',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = TypeCreate.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      // Confirm the jurisdiction belongs to this firm (defense against
      // a stale id from another tab / cross-firm spoofing).
      const [juris] = await deps.db
        .select({ id: taxJurisdictions.id })
        .from(taxJurisdictions)
        .where(
          and(
            eq(taxJurisdictions.id, parsed.data.jurisdictionId),
            eq(taxJurisdictions.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!juris) {
        res.status(404).json({ error: 'jurisdiction_not_found' });
        return;
      }
      try {
        const [row] = await deps.db
          .insert(taxPaymentTypeCatalog)
          .values({
            firmId: session.firmId,
            jurisdictionId: parsed.data.jurisdictionId,
            name: parsed.data.name.trim(),
            paymentUrl: parsed.data.paymentUrl ?? null,
            active: parsed.data.active ?? true,
            displayOrder: parsed.data.displayOrder ?? 100,
            isSystem: false,
          })
          .returning({ id: taxPaymentTypeCatalog.id });
        await emitAudit(deps.db, {
          action: 'CREATE',
          entityType: 'tax_payment_type',
          entityId: row?.id,
          actorAppUserId: session.appUserId,
          after: parsed.data,
        }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
        res.status(201).json({ id: row?.id });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          res.status(409).json({ error: 'duplicate_name_in_jurisdiction' });
          return;
        }
        logger.error({ err }, 'tax_payment_type insert failed');
        res.status(500).json({ error: 'insert_failed' });
      }
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = TypeUpdate.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.name !== undefined) updates['name'] = parsed.data.name.trim();
      if (parsed.data.paymentUrl !== undefined) updates['paymentUrl'] = parsed.data.paymentUrl;
      if (parsed.data.active !== undefined) updates['active'] = parsed.data.active;
      if (parsed.data.displayOrder !== undefined) {
        updates['displayOrder'] = parsed.data.displayOrder;
      }
      const result = await deps.db
        .update(taxPaymentTypeCatalog)
        .set(updates)
        .where(
          and(
            eq(taxPaymentTypeCatalog.id, req.params['id']!),
            eq(taxPaymentTypeCatalog.firmId, session.firmId),
          ),
        )
        .returning({ id: taxPaymentTypeCatalog.id });
      if (result.length === 0) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'tax_payment_type',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: parsed.data,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.delete(
    '/:id',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select({ id: taxPaymentTypeCatalog.id, isSystem: taxPaymentTypeCatalog.isSystem })
        .from(taxPaymentTypeCatalog)
        .where(
          and(
            eq(taxPaymentTypeCatalog.id, req.params['id']!),
            eq(taxPaymentTypeCatalog.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.isSystem) {
        res.status(409).json({
          error: 'system_row_undeletable',
          hint: 'Deactivate it instead — system rows cannot be deleted.',
        });
        return;
      }
      await deps.db.delete(taxPaymentTypeCatalog).where(eq(taxPaymentTypeCatalog.id, row.id));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'tax_payment_type',
        entityId: row.id,
        actorAppUserId: session.appUserId,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  return router;
}
