// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R6 — Client portal retainer list + detail + ledger view.
//
// Scoped to session.activeClientId. The ledger response is
// privacy-filtered: strips description, internal staff name, and
// app_user_id. Clients see only date + hours-delta + balance.

import express, { type Request, type Response, type Router } from 'express';
import { and, asc, desc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, firms, retainerLedger, retainers } from '@vibe/db/schema';

import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { buildActivityStatementHtml } from '../retainers/exports';
import { renderHtmlToPdf } from '../pdf/render';

export interface PortalRetainerDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
}

export function createPortalRetainerRouter(deps: PortalRetainerDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const items = await deps.db
      .select({
        id: retainers.id,
        name: retainers.name,
        returnType: retainers.returnType,
        taxYear: retainers.taxYear,
        tier: retainers.tier,
        hoursPurchased: retainers.hoursPurchased,
        hoursConsumed: retainers.hoursConsumed,
        expiryDate: retainers.expiryDate,
        status: retainers.status,
        purchaseDate: retainers.purchaseDate,
      })
      .from(retainers)
      .where(eq(retainers.clientId, session.activeClientId))
      .orderBy(desc(retainers.createdAt))
      .limit(200);
    res.json({ items });
  });

  router.get('/:id', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const [row] = await deps.db
      .select()
      .from(retainers)
      .where(
        and(eq(retainers.id, req.params['id']!), eq(retainers.clientId, session.activeClientId)),
      )
      .limit(1);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Privacy-filtered ledger: never include description / staff name /
    // app_user_id. Date + delta + balance + kind only.
    const ledger = await deps.db
      .select({
        id: retainerLedger.id,
        kind: retainerLedger.kind,
        hoursDelta: retainerLedger.hoursDelta,
        hoursBalanceAfter: retainerLedger.hoursBalanceAfter,
        createdAt: retainerLedger.createdAt,
      })
      .from(retainerLedger)
      .where(eq(retainerLedger.retainerId, row.id))
      .orderBy(desc(retainerLedger.createdAt))
      .limit(200);
    res.json({
      retainer: {
        id: row.id,
        name: row.name,
        returnType: row.returnType,
        taxYear: row.taxYear,
        tier: row.tier,
        hoursPurchased: row.hoursPurchased,
        hoursConsumed: row.hoursConsumed,
        expiryDate: row.expiryDate,
        status: row.status,
        purchaseDate: row.purchaseDate,
      },
      ledger,
    });
  });

  // R6-followup — Retainer Activity Statement PDF. Privacy-filtered:
  // no description, no app_user_id, no staff name. Renders the same
  // shape the JSON ledger emits, just on paper.
  router.get('/:id/statement.pdf', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const [row] = await deps.db
      .select()
      .from(retainers)
      .where(
        and(eq(retainers.id, req.params['id']!), eq(retainers.clientId, session.activeClientId)),
      )
      .limit(1);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const ledger = await deps.db
      .select({
        createdAt: retainerLedger.createdAt,
        kind: retainerLedger.kind,
        hoursDelta: retainerLedger.hoursDelta,
        hoursBalanceAfter: retainerLedger.hoursBalanceAfter,
      })
      .from(retainerLedger)
      .where(eq(retainerLedger.retainerId, row.id))
      .orderBy(asc(retainerLedger.createdAt))
      .limit(500);
    const [firm] = await deps.db
      .select({ name: firms.name })
      .from(firms)
      .where(eq(firms.id, row.firmId))
      .limit(1);
    const [client] = await deps.db
      .select({ name: clients.name })
      .from(clients)
      .where(eq(clients.id, row.clientId))
      .limit(1);
    const html = buildActivityStatementHtml({
      firmName: firm?.name ?? 'Firm',
      clientName: client?.name ?? 'Client',
      retainer: {
        name: row.name,
        returnType: row.returnType,
        taxYear: row.taxYear,
        tier: row.tier,
        hoursPurchased: row.hoursPurchased,
        hoursConsumed: row.hoursConsumed,
        purchaseDate: row.purchaseDate,
        expiryDate: row.expiryDate,
        status: row.status,
      },
      ledger,
      asOfDate: new Date().toISOString().slice(0, 10),
    });
    try {
      const pdf = await renderHtmlToPdf(html);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="retainer-${row.id}-statement.pdf"`,
      );
      res.send(pdf);
    } catch (err) {
      // Dev fallback: ship HTML when puppeteer isn't installed.
      logger.warn({ err }, 'puppeteer unavailable — returning HTML instead');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    }
  });

  return router;
}
