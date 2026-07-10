// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Quick-find global search (Phase 4 cmd-K-style). Returns up to ~30
// matches across clients, engagements, invoices, and users for the
// active firm. Case-insensitive prefix-ish via ILIKE.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq, ilike, inArray, or } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { appUsers, clients, engagements, invoices } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface SearchRoutesDeps extends RbacDeps {
  db: Database | null;
}

export function createSearchRouter(deps: SearchRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/quick-find',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const raw = String(req.query['q'] ?? '').trim();
      if (raw.length < 2) {
        res.json({ items: [] });
        return;
      }
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const like = `%${raw.replace(/[%_]/g, '\\$&')}%`;

      const firmClients = await deps.db
        .select({ id: clients.id, name: clients.name })
        .from(clients)
        .where(and(eq(clients.firmId, session.firmId), ilike(clients.name, like)))
        .limit(10);
      const clientIds = (
        await deps.db
          .select({ id: clients.id })
          .from(clients)
          .where(eq(clients.firmId, session.firmId))
      ).map((c) => c.id);

      const engRows = clientIds.length
        ? await deps.db
            .select({ id: engagements.id, name: engagements.name, clientId: engagements.clientId })
            .from(engagements)
            .where(and(inArray(engagements.clientId, clientIds), ilike(engagements.name, like)))
            .limit(10)
        : [];

      const invRows = await deps.db
        .select({
          id: invoices.id,
          number: invoices.invoiceNumber,
          clientId: invoices.clientId,
        })
        .from(invoices)
        .where(and(eq(invoices.firmId, session.firmId), or(ilike(invoices.invoiceNumber, like))))
        .limit(10);

      const userRows = await deps.db
        .select({ id: appUsers.id, fullName: appUsers.fullName, email: appUsers.email })
        .from(appUsers)
        .where(
          and(
            eq(appUsers.firmId, session.firmId),
            or(ilike(appUsers.fullName, like), ilike(appUsers.email, like)),
          ),
        )
        .limit(10);

      const items = [
        ...firmClients.map((c) => ({
          kind: 'client' as const,
          id: c.id,
          label: c.name,
          href: `/clients/${c.id}`,
        })),
        ...engRows.map((e) => ({
          kind: 'engagement' as const,
          id: e.id,
          label: e.name,
          href: `/engagements/${e.id}`,
        })),
        ...invRows.map((i) => ({
          kind: 'invoice' as const,
          id: i.id,
          label: `Invoice ${i.number}`,
          href: `/invoices?q=${encodeURIComponent(i.number)}`,
        })),
        ...userRows.map((u) => ({
          kind: 'user' as const,
          id: u.id,
          label: `${u.fullName} <${u.email}>`,
          href: `/admin/users`,
        })),
      ];
      res.json({ items });
    },
  );

  return router;
}
