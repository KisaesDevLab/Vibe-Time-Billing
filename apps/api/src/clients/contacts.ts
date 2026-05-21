// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// v2 Sprint B (workstream 1.2) — multi-contact CRUD endpoints. Mounted
// at /api/staff/clients/:id/contacts by createClientRouter.
//
// Mutations enforce the unique isPrimary/isBilling-per-client invariants
// via partial unique indexes (0027). When the caller flips isPrimary or
// isBilling on a contact, we clear the existing flag from sibling
// contacts in the same transaction so the index never trips.

import { z } from 'zod';
import { and, eq, ne } from 'drizzle-orm';
import { type Request, type Response, type Router } from 'express';

import type { Database } from '@vibe/db';
import { clientContacts, clients } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface ContactRoutesDeps extends RbacDeps {
  db: Database | null;
}

const ContactCreateSchema = z.object({
  fullName: z.string().min(1).max(200),
  roleId: z.string().uuid().nullable().optional(),
  email: z.string().email().max(254).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  mobile: z.string().max(40).nullable().optional(),
  isPrimary: z.boolean().optional(),
  isBilling: z.boolean().optional(),
  isPortalIdentity: z.boolean().optional(),
});

const ContactPatchSchema = ContactCreateSchema.partial();

async function ensureClientInFirm(
  db: Database,
  clientId: string,
  firmId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.firmId, firmId)))
    .limit(1);
  return Boolean(row);
}

/**
 * Attach the four contact endpoints to an existing client router. Called
 * by createClientRouter inside `apps/api/src/clients/routes.ts`.
 *
 *   GET    /:id/contacts
 *   POST   /:id/contacts
 *   PATCH  /:id/contacts/:contactId
 *   DELETE /:id/contacts/:contactId
 */
export function mountContactRoutes(router: Router, deps: ContactRoutesDeps): void {
  router.get(
    '/:id/contacts',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const clientId = req.params['id']!;
      if (!(await ensureClientInFirm(deps.db, clientId, firmId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const items = await deps.db
        .select()
        .from(clientContacts)
        .where(eq(clientContacts.clientId, clientId));
      res.json({ items });
    },
  );

  router.post(
    '/:id/contacts',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const parsed = ContactCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const clientId = req.params['id']!;
      if (!(await ensureClientInFirm(deps.db, clientId, firmId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const data = parsed.data;
      const created = await deps.db.transaction(async (tx) => {
        if (data.isPrimary === true) {
          await tx
            .update(clientContacts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(eq(clientContacts.clientId, clientId));
        }
        if (data.isBilling === true) {
          await tx
            .update(clientContacts)
            .set({ isBilling: false, updatedAt: new Date() })
            .where(eq(clientContacts.clientId, clientId));
        }
        const [row] = await tx
          .insert(clientContacts)
          .values({
            clientId,
            fullName: data.fullName,
            roleId: data.roleId ?? null,
            email: data.email ?? null,
            phone: data.phone ?? null,
            mobile: data.mobile ?? null,
            isPrimary: data.isPrimary ?? false,
            isBilling: data.isBilling ?? false,
            isPortalIdentity: data.isPortalIdentity ?? false,
          })
          .returning();
        return row;
      });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client_contact',
        entityId: created?.id ?? null,
        actorAppUserId: req.staffSession!.appUserId,
        after: created
          ? {
              clientId,
              fullName: created.fullName,
              isPrimary: created.isPrimary,
              isBilling: created.isBilling,
            }
          : { clientId },
      }).catch(() => undefined);
      res.status(201).json({ contact: created });
    },
  );

  router.patch(
    '/:id/contacts/:contactId',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const parsed = ContactPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const clientId = req.params['id']!;
      const contactId = req.params['contactId']!;
      if (!(await ensureClientInFirm(deps.db, clientId, firmId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [existing] = await deps.db
        .select()
        .from(clientContacts)
        .where(and(eq(clientContacts.id, contactId), eq(clientContacts.clientId, clientId)))
        .limit(1);
      if (!existing) {
        res.status(404).json({ error: 'contact_not_found' });
        return;
      }
      const data = parsed.data;
      const updated = await deps.db.transaction(async (tx) => {
        if (data.isPrimary === true) {
          await tx
            .update(clientContacts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(and(eq(clientContacts.clientId, clientId), ne(clientContacts.id, contactId)));
        }
        if (data.isBilling === true) {
          await tx
            .update(clientContacts)
            .set({ isBilling: false, updatedAt: new Date() })
            .where(and(eq(clientContacts.clientId, clientId), ne(clientContacts.id, contactId)));
        }
        const [row] = await tx
          .update(clientContacts)
          .set({
            ...(data.fullName !== undefined ? { fullName: data.fullName } : {}),
            ...(data.roleId !== undefined ? { roleId: data.roleId } : {}),
            ...(data.email !== undefined ? { email: data.email } : {}),
            ...(data.phone !== undefined ? { phone: data.phone } : {}),
            ...(data.mobile !== undefined ? { mobile: data.mobile } : {}),
            ...(data.isPrimary !== undefined ? { isPrimary: data.isPrimary } : {}),
            ...(data.isBilling !== undefined ? { isBilling: data.isBilling } : {}),
            ...(data.isPortalIdentity !== undefined
              ? { isPortalIdentity: data.isPortalIdentity }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(clientContacts.id, contactId))
          .returning();
        return row;
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_contact',
        entityId: contactId,
        actorAppUserId: req.staffSession!.appUserId,
        before: { isPrimary: existing.isPrimary, isBilling: existing.isBilling },
        after: updated ? { isPrimary: updated.isPrimary, isBilling: updated.isBilling } : null,
      }).catch(() => undefined);
      res.json({ contact: updated });
    },
  );

  router.delete(
    '/:id/contacts/:contactId',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const clientId = req.params['id']!;
      const contactId = req.params['contactId']!;
      if (!(await ensureClientInFirm(deps.db, clientId, firmId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [existing] = await deps.db
        .select()
        .from(clientContacts)
        .where(and(eq(clientContacts.id, contactId), eq(clientContacts.clientId, clientId)))
        .limit(1);
      if (!existing) {
        res.status(404).json({ error: 'contact_not_found' });
        return;
      }
      await deps.db.delete(clientContacts).where(eq(clientContacts.id, contactId));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'client_contact',
        entityId: contactId,
        actorAppUserId: req.staffSession!.appUserId,
        before: {
          fullName: existing.fullName,
          isPrimary: existing.isPrimary,
          isBilling: existing.isBilling,
        },
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );
}
