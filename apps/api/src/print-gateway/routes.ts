// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Staff print endpoints: list the gateway's printers for the picker,
// report/remember the user's default printer. Mounted at /api/staff/print.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { appUsers } from '@vibe/db/schema';

import { type RbacDeps } from '../auth/rbac-middleware';
import { listAssignments, resolvePreselectPrinter } from './assignments';
import { listPrinters } from './client';
import { resolvePrintGateway } from './config';

export interface PrintRoutesDeps extends RbacDeps {
  db: Database | null;
}

export function createPrintRouter(deps: PrintRoutesDeps): Router {
  const router = express.Router();

  // Effective state for the print picker: whether the gateway is usable +
  // this user's remembered default printer.
  router.get('/me', async (req: Request, res: Response) => {
    const session = req.staffSession;
    if (!session || !deps.db) {
      res.json({ enabled: false, defaultPrinterId: null });
      return;
    }
    const gateway = await resolvePrintGateway(deps.db, session.firmId);
    const [user] = await deps.db
      .select({
        defaultPrinterId: appUsers.defaultPrinterId,
        defaultOfficeId: appUsers.defaultOfficeId,
      })
      .from(appUsers)
      .where(eq(appUsers.id, session.appUserId))
      .limit(1);
    const defaultPrinterId = await resolvePreselectPrinter(deps.db, session.firmId, {
      userDefaultPrinterId: user?.defaultPrinterId ?? null,
      userOfficeId: user?.defaultOfficeId ?? null,
      firmDefault: gateway?.defaultPrinterId ?? null,
    });
    res.json({ enabled: Boolean(gateway?.enabled), defaultPrinterId });
  });

  // Live printer list from the gateway, annotated with each printer's
  // office assignment so the picker can group by location.
  router.get('/printers', async (req: Request, res: Response) => {
    const session = req.staffSession;
    if (!session || !deps.db) {
      res.status(503).json({ error: 'gateway_not_configured' });
      return;
    }
    const gateway = await resolvePrintGateway(deps.db, session.firmId);
    if (!gateway || !gateway.enabled) {
      res.status(503).json({ error: 'gateway_not_configured' });
      return;
    }
    try {
      const [printers, assignments] = await Promise.all([
        listPrinters(gateway),
        listAssignments(deps.db, session.firmId),
      ]);
      const byId = new Map(assignments.map((a) => [a.gatewayPrinterId, a]));
      const annotated = printers
        .map((p) => {
          const a = byId.get(p.id);
          return {
            id: p.id,
            name: a?.label || p.name,
            officeId: a?.officeId ?? null,
            officeName: a?.officeName ?? null,
            enabled: a ? a.enabled : true,
          };
        })
        .filter((p) => p.enabled);
      res.json({ printers: annotated });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'gateway_unreachable' });
    }
  });

  const DefaultSchema = z.object({ printerId: z.number().int().positive().nullable() });
  router.put('/default-printer', async (req: Request, res: Response) => {
    const session = req.staffSession;
    if (!session || !deps.db) {
      res.status(401).json({ error: 'no_session' });
      return;
    }
    const parsed = DefaultSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    await deps.db
      .update(appUsers)
      .set({ defaultPrinterId: parsed.data.printerId })
      .where(eq(appUsers.id, session.appUserId));
    res.json({ ok: true });
  });

  return router;
}
