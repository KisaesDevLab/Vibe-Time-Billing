// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
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
import { clientContacts, clients, persons } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { findOrCreatePerson, updatePerson } from './person-helpers';

export interface ContactRoutesDeps extends RbacDeps {
  db: Database | null;
}

const ContactBaseSchema = z.object({
  fullName: z.string().min(1).max(200).optional(),
  roleId: z.string().uuid().nullable().optional(),
  email: z.string().email().max(254).nullable().optional(),
  // 0224 — blank → NULL so mobile→phone fallbacks never see ''.
  phone: z
    .string()
    .max(40)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v?.trim() || null)),
  mobile: z
    .string()
    .max(40)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v?.trim() || null)),
  isPrimary: z.boolean().optional(),
  isBilling: z.boolean().optional(),
  isPortalIdentity: z.boolean().optional(),
  // CAL-7 — per-contact appointment-reminder opt-out.
  receiveAppointmentReminders: z.boolean().optional(),
  // 0166 — per-contact engagement status-notification opt-out.
  receiveStatusNotifications: z.boolean().optional(),
  // 0206 — person-global automated-voice-call opt-out (canonical on person,
  // written via updatePerson so it propagates across every client).
  doNotCall: z.boolean().optional(),
  // Link an EXISTING firm person instead of creating one from the typed
  // name/email. When set, name/email/phone are ignored (canonical values
  // come from the person) and we skip findOrCreatePerson — this is how the
  // "search to add" typeahead avoids spawning duplicate people.
  personId: z.string().uuid().optional(),
});

// fullName is required only when creating a new person (no personId) — a
// caller linking an existing person needn't restate their name.
const ContactCreateSchema = ContactBaseSchema.refine(
  (d) => Boolean(d.personId) || Boolean(d.fullName && d.fullName.trim()),
  { message: 'fullName_or_personId_required', path: ['fullName'] },
);

const ContactPatchSchema = ContactBaseSchema.partial();

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
      // 0115 — name/email/phone are canonical on person; project them
      // flat so existing consumers see the same shape.
      const items = await deps.db
        .select({
          id: clientContacts.id,
          clientId: clientContacts.clientId,
          personId: clientContacts.personId,
          fullName: persons.fullName,
          email: persons.email,
          phone: persons.phone,
          mobile: persons.mobile,
          roleId: clientContacts.roleId,
          isPrimary: clientContacts.isPrimary,
          isBilling: clientContacts.isBilling,
          isPortalIdentity: clientContacts.isPortalIdentity,
          receiveAppointmentReminders: clientContacts.receiveAppointmentReminders,
          receiveStatusNotifications: clientContacts.receiveStatusNotifications,
          doNotCall: persons.doNotCall,
          status: clientContacts.status,
          createdAt: clientContacts.createdAt,
          updatedAt: clientContacts.updatedAt,
        })
        .from(clientContacts)
        .innerJoin(persons, eq(persons.id, clientContacts.personId))
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
      // Linking an existing person: verify it's a firm person and isn't
      // already a contact of this client. Done up-front so we can return a
      // precise 404/409 (the transaction catch below only sees a generic
      // constraint failure). There is no (client_id, person_id) unique
      // index, so this guard is what prevents a duplicate link.
      if (data.personId) {
        const [p] = await deps.db
          .select({ id: persons.id })
          .from(persons)
          .where(and(eq(persons.id, data.personId), eq(persons.firmId, firmId)))
          .limit(1);
        if (!p) {
          res.status(404).json({ error: 'person_not_found' });
          return;
        }
        const [dup] = await deps.db
          .select({ id: clientContacts.id })
          .from(clientContacts)
          .where(
            and(
              eq(clientContacts.clientId, clientId),
              eq(clientContacts.personId, data.personId),
              ne(clientContacts.status, 'ARCHIVED'),
            ),
          )
          .limit(1);
        if (dup) {
          res.status(409).json({ error: 'already_linked', contactId: dup.id });
          return;
        }
      }
      let created;
      try {
        created = await deps.db.transaction(async (tx) => {
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
          // 0115 — name/email/phone live on the firm-global person. When a
          // personId is supplied we link that existing person verbatim
          // (no field overwrite); otherwise find-or-create from the typed
          // fields.
          const personId =
            data.personId ??
            (await findOrCreatePerson(tx, {
              firmId,
              // Guaranteed present here by the create-schema refine (no
              // personId → fullName required).
              fullName: data.fullName ?? '',
              email: data.email ?? null,
              phone: data.phone ?? null,
              mobile: data.mobile ?? null,
            }));
          const [row] = await tx
            .insert(clientContacts)
            .values({
              clientId,
              personId,
              roleId: data.roleId ?? null,
              isPrimary: data.isPrimary ?? false,
              isBilling: data.isBilling ?? false,
              isPortalIdentity: data.isPortalIdentity ?? false,
            })
            .returning();
          return row;
        });
      } catch {
        res.status(409).json({ error: 'contact_in_use' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client_contact',
        entityId: created?.id ?? null,
        actorAppUserId: req.staffSession!.appUserId,
        after: created
          ? {
              clientId,
              personId: created.personId,
              fullName: data.fullName,
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
      let updated;
      try {
        updated = await deps.db.transaction(async (tx) => {
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
          // 0115 — name/email/phone/mobile are canonical on person. Editing
          // them updates the shared person row, so the change propagates to
          // this person across EVERY client they're a contact of (single
          // source of truth). Per-client flags stay on client_contact.
          await updatePerson(tx, existing.personId, data);
          const [row] = await tx
            .update(clientContacts)
            .set({
              ...(data.roleId !== undefined ? { roleId: data.roleId } : {}),
              ...(data.isPrimary !== undefined ? { isPrimary: data.isPrimary } : {}),
              ...(data.isBilling !== undefined ? { isBilling: data.isBilling } : {}),
              ...(data.isPortalIdentity !== undefined
                ? { isPortalIdentity: data.isPortalIdentity }
                : {}),
              ...(data.receiveAppointmentReminders !== undefined
                ? { receiveAppointmentReminders: data.receiveAppointmentReminders }
                : {}),
              ...(data.receiveStatusNotifications !== undefined
                ? { receiveStatusNotifications: data.receiveStatusNotifications }
                : {}),
              updatedAt: new Date(),
            })
            .where(eq(clientContacts.id, contactId))
            .returning();
          return row;
        });
      } catch {
        // Likely the (firm, lower(email)) unique index — another person in
        // the firm already uses that email.
        res.status(409).json({ error: 'contact_in_use' });
        return;
      }
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
