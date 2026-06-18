// SPDX-License-Identifier: Elastic-2.0
//
// Firm-wide People directory (0115 follow-up). The person directory is
// firm-global — one row per human — but until now it could only be viewed
// one client at a time. This router exposes it directly:
//
//   GET   /api/staff/people            — searchable, paginated directory
//   GET   /api/staff/people/:id        — one person + every client they touch
//   PATCH /api/staff/people/:id        — edit canonical name/email/phone
//
// The list unions two sources: the `person` table, and portal_identity rows
// that have no person link (standalone 3rd parties — outside advisors with a
// login but no directory record). Per-client portal enable/disable is NOT
// here — it reuses the existing /api/staff/portal-invites grant/revoke/
// restore endpoints, keyed by the access ids this router returns.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import {
  clientContacts,
  clientPortalAccess,
  clients,
  persons,
  portalIdentity,
  portalInvitation,
} from '@vibe/db/schema';
import { normalizePhone } from '@vibe/core/auth';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { updatePerson } from '../clients/person-helpers';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface PeopleRoutesDeps extends RbacDeps {
  db: Database | null;
}

type Kind = 'person' | 'portal_identity';

const PatchSchema = z.object({
  fullName: z.string().min(1).max(200).optional(),
  email: z.string().email().max(254).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  mobile: z.string().max(40).nullable().optional(),
});

export function createPeopleRouter(deps: PeopleRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  // ---------------------------------------------------------------
  // GET / — firm-wide directory list. Optional `clientId` switches on
  // the typeahead annotations (onThisClient / alsoOn) used by the
  // add-contact search field on a client's People card.
  // ---------------------------------------------------------------
  router.get('/', requirePermission(deps, 'client:read'), async (req: Request, res: Response) => {
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.json({ rows: [], total: 0 });
      return;
    }
    const db = deps.db;
    const q = typeof req.query['q'] === 'string' ? req.query['q'].trim().toLowerCase() : '';
    const clientId =
      typeof req.query['clientId'] === 'string' && req.query['clientId']
        ? req.query['clientId']
        : null;
    const page = Math.max(1, Number(req.query['page']) || 1);
    // Cap lifted to 1000 so the staff People directory can load the full
    // firm set and run filter/sort/search client-side (standard table view).
    const pageSize = Math.min(1000, Math.max(1, Number(req.query['pageSize']) || 25));

    // Load firm-scoped sources once, reconcile in memory. Single-firm
    // appliance, so the working set is bounded.
    const personRows = await db
      .select({
        id: persons.id,
        fullName: persons.fullName,
        email: persons.email,
        phone: persons.phone,
        mobile: persons.mobile,
        status: persons.status,
      })
      .from(persons)
      .where(eq(persons.firmId, firmId));
    const identityRows = await db
      .select({
        id: portalIdentity.id,
        personId: portalIdentity.personId,
        fullName: portalIdentity.fullName,
        email: portalIdentity.primaryEmail,
        phone: portalIdentity.primaryPhone,
        status: portalIdentity.status,
      })
      .from(portalIdentity)
      .where(eq(portalIdentity.firmId, firmId));
    const contactRows = await db
      .select({
        personId: clientContacts.personId,
        clientId: clientContacts.clientId,
        clientName: clients.name,
      })
      .from(clientContacts)
      .innerJoin(clients, eq(clients.id, clientContacts.clientId))
      .where(eq(clients.firmId, firmId));
    const accessRows = await db
      .select({
        portalIdentityId: clientPortalAccess.portalIdentityId,
        clientId: clientPortalAccess.clientId,
        status: clientPortalAccess.status,
      })
      .from(clientPortalAccess)
      .innerJoin(clients, eq(clients.id, clientPortalAccess.clientId))
      .where(eq(clients.firmId, firmId));

    const identitiesByPerson = new Map<string, string[]>();
    for (const i of identityRows) {
      if (!i.personId) continue;
      const list = identitiesByPerson.get(i.personId) ?? [];
      list.push(i.id);
      identitiesByPerson.set(i.personId, list);
    }
    const activeByIdentity = new Set<string>();
    const clientsByIdentity = new Map<string, Set<string>>();
    for (const a of accessRows) {
      const set = clientsByIdentity.get(a.portalIdentityId) ?? new Set<string>();
      set.add(a.clientId);
      clientsByIdentity.set(a.portalIdentityId, set);
      if (a.status === 'ACTIVE') activeByIdentity.add(a.portalIdentityId);
    }
    const contactsByPerson = new Map<string, { clientId: string; name: string }[]>();
    for (const c of contactRows) {
      const list = contactsByPerson.get(c.personId) ?? [];
      if (!list.some((x) => x.clientId === c.clientId)) {
        list.push({ clientId: c.clientId, name: c.clientName });
      }
      contactsByPerson.set(c.personId, list);
    }

    interface Row {
      key: string;
      kind: Kind;
      id: string;
      fullName: string;
      email: string | null;
      phone: string | null;
      mobile: string | null;
      status: string;
      hasPortalAccess: boolean;
      clientCount: number;
      onThisClient?: boolean;
      alsoOn?: { clientId: string; name: string }[];
    }
    const rows: Row[] = [];
    for (const p of personRows) {
      const ids = identitiesByPerson.get(p.id) ?? [];
      rows.push({
        key: `p:${p.id}`,
        kind: 'person',
        id: p.id,
        fullName: p.fullName,
        email: p.email,
        phone: p.phone,
        mobile: p.mobile,
        status: p.status,
        hasPortalAccess: ids.some((id) => activeByIdentity.has(id)),
        clientCount: (contactsByPerson.get(p.id) ?? []).length,
      });
    }
    for (const i of identityRows) {
      if (i.personId) continue; // person-linked identities show under their person
      rows.push({
        key: `i:${i.id}`,
        kind: 'portal_identity',
        id: i.id,
        fullName: i.fullName,
        email: i.email,
        phone: i.phone,
        mobile: null,
        status: i.status,
        hasPortalAccess: activeByIdentity.has(i.id),
        clientCount: (clientsByIdentity.get(i.id) ?? new Set()).size,
      });
    }

    let filtered = rows;
    if (q) {
      filtered = rows.filter(
        (r) =>
          r.fullName.toLowerCase().includes(q) ||
          (r.email?.toLowerCase().includes(q) ?? false) ||
          (r.phone?.toLowerCase().includes(q) ?? false),
      );
    }
    filtered.sort((a, b) => a.fullName.localeCompare(b.fullName));
    const total = filtered.length;
    const pageRows = filtered.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);

    if (clientId) {
      for (const r of pageRows) {
        const assoc = r.kind === 'person' ? (contactsByPerson.get(r.id) ?? []) : [];
        r.onThisClient = assoc.some((a) => a.clientId === clientId);
        r.alsoOn = assoc.filter((a) => a.clientId !== clientId);
      }
    }

    res.json({ rows: pageRows, total, page, pageSize });
  });

  // ---------------------------------------------------------------
  // GET /:id — one person and every client they're tied to (as a
  // directory contact and/or via portal access), with the access id
  // the UI needs to drive enable/disable.
  // ---------------------------------------------------------------
  router.get(
    '/:id',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const db = deps.db;
      const id = req.params['id']!;

      // Resolve to a canonical person when possible; an :id that is a
      // portal_identity linked to a person resolves to that person.
      const personCols = {
        id: persons.id,
        fullName: persons.fullName,
        email: persons.email,
        phone: persons.phone,
        mobile: persons.mobile,
        status: persons.status,
      };
      let person =
        (
          await db
            .select(personCols)
            .from(persons)
            .where(and(eq(persons.id, id), eq(persons.firmId, firmId)))
            .limit(1)
        )[0] ?? null;
      let identity: {
        id: string;
        fullName: string;
        email: string | null;
        phone: string | null;
        status: string;
      } | null = null;
      if (!person) {
        const [ident] = await db
          .select({
            id: portalIdentity.id,
            personId: portalIdentity.personId,
            fullName: portalIdentity.fullName,
            email: portalIdentity.primaryEmail,
            phone: portalIdentity.primaryPhone,
            status: portalIdentity.status,
          })
          .from(portalIdentity)
          .where(and(eq(portalIdentity.id, id), eq(portalIdentity.firmId, firmId)))
          .limit(1);
        if (ident?.personId) {
          person =
            (
              await db
                .select(personCols)
                .from(persons)
                .where(and(eq(persons.id, ident.personId), eq(persons.firmId, firmId)))
                .limit(1)
            )[0] ?? null;
        }
        if (!person) identity = ident ?? null;
      }
      if (!person && !identity) {
        res.status(404).json({ error: 'not_found' });
        return;
      }

      const kind: Kind = person ? 'person' : 'portal_identity';
      const base = person
        ? {
            id: person.id,
            fullName: person.fullName,
            email: person.email,
            phone: person.phone,
            mobile: person.mobile,
            status: person.status,
          }
        : {
            id: identity!.id,
            fullName: identity!.fullName,
            email: identity!.email,
            phone: identity!.phone,
            mobile: null as string | null,
            status: identity!.status,
          };

      // Portal identities for this person (auth credentials live there).
      let identityIds: string[] = [];
      if (person) {
        const ids = await db
          .select({ id: portalIdentity.id })
          .from(portalIdentity)
          .where(and(eq(portalIdentity.personId, person.id), eq(portalIdentity.firmId, firmId)));
        identityIds = ids.map((x) => x.id);
      } else if (identity) {
        identityIds = [identity.id];
      }

      const contactRows = person
        ? await db
            .select({
              contactId: clientContacts.id,
              clientId: clientContacts.clientId,
              clientName: clients.name,
            })
            .from(clientContacts)
            .innerJoin(clients, eq(clients.id, clientContacts.clientId))
            .where(and(eq(clientContacts.personId, person.id), eq(clients.firmId, firmId)))
        : [];
      const accessRows = identityIds.length
        ? await db
            .select({
              accessId: clientPortalAccess.id,
              clientId: clientPortalAccess.clientId,
              clientName: clients.name,
              status: clientPortalAccess.status,
              role: clientPortalAccess.role,
              clientContactId: clientPortalAccess.clientContactId,
            })
            .from(clientPortalAccess)
            .innerJoin(clients, eq(clients.id, clientPortalAccess.clientId))
            .where(
              and(
                inArray(clientPortalAccess.portalIdentityId, identityIds),
                eq(clients.firmId, firmId),
              ),
            )
        : [];

      // Pending invitations (no access/identity yet) matched by contact value.
      const pendConds = [];
      if (base.email) pendConds.push(eq(portalInvitation.invitedEmail, base.email));
      if (base.phone) pendConds.push(eq(portalInvitation.invitedPhone, base.phone));
      const pendRows = pendConds.length
        ? await db
            .select({
              invitationId: portalInvitation.id,
              clientId: portalInvitation.clientId,
              clientName: clients.name,
              role: portalInvitation.proposedRole,
            })
            .from(portalInvitation)
            .innerJoin(clients, eq(clients.id, portalInvitation.clientId))
            .where(
              and(
                eq(portalInvitation.firmId, firmId),
                eq(portalInvitation.status, 'ACTIVE'),
                or(...pendConds),
              ),
            )
        : [];

      interface ClientEntry {
        clientId: string;
        clientName: string;
        contactId: string | null;
        accessId: string | null;
        accessStatus: string | null;
        role: string | null;
        invitationId: string | null;
      }
      const byClient = new Map<string, ClientEntry>();
      const ensure = (clientId: string, clientName: string): ClientEntry => {
        let e = byClient.get(clientId);
        if (!e) {
          e = {
            clientId,
            clientName,
            contactId: null,
            accessId: null,
            accessStatus: null,
            role: null,
            invitationId: null,
          };
          byClient.set(clientId, e);
        }
        if (clientName) e.clientName = clientName;
        return e;
      };
      for (const c of contactRows) ensure(c.clientId, c.clientName).contactId = c.contactId;
      for (const a of accessRows) {
        const e = ensure(a.clientId, a.clientName);
        e.accessId = a.accessId;
        e.accessStatus = a.status;
        e.role = a.role;
        if (a.clientContactId && !e.contactId) e.contactId = a.clientContactId;
      }
      for (const inv of pendRows) {
        const e = ensure(inv.clientId, inv.clientName);
        if (!e.accessId) {
          e.invitationId = inv.invitationId;
          if (!e.accessStatus) e.accessStatus = 'INVITED';
          if (!e.role) e.role = inv.role;
        }
      }
      const clientsOut = [...byClient.values()].sort((a, b) =>
        a.clientName.localeCompare(b.clientName),
      );

      res.json({ kind, ...base, clients: clientsOut });
    },
  );

  // ---------------------------------------------------------------
  // PATCH /:id — edit the canonical identity fields. For a person this
  // updates the shared person row (propagates to every client); for a
  // standalone portal identity it edits the login record.
  // ---------------------------------------------------------------
  router.patch(
    '/:id',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const parsed = PatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const db = deps.db;
      const id = req.params['id']!;
      const session = req.staffSession!;
      const data = parsed.data;

      const [person] = await db
        .select({ id: persons.id })
        .from(persons)
        .where(and(eq(persons.id, id), eq(persons.firmId, firmId)))
        .limit(1);
      if (person) {
        try {
          await updatePerson(db, person.id, data);
        } catch (err) {
          logger.warn({ err }, 'person update failed');
          res.status(409).json({ error: 'email_in_use' });
          return;
        }
        await emitAudit(db, {
          action: 'UPDATE',
          entityType: 'person',
          entityId: person.id,
          actorAppUserId: session.appUserId,
          after: data,
        }).catch(() => undefined);
        res.json({ ok: true, kind: 'person' });
        return;
      }

      // Standalone portal identity (no person row).
      const [ident] = await db
        .select({ id: portalIdentity.id })
        .from(portalIdentity)
        .where(and(eq(portalIdentity.id, id), eq(portalIdentity.firmId, firmId)))
        .limit(1);
      if (!ident) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const updates: Record<string, unknown> = {};
      if (data.fullName !== undefined) updates['fullName'] = data.fullName;
      if (data.email !== undefined) updates['primaryEmail'] = data.email;
      if (data.phone !== undefined) {
        const p = data.phone;
        if (p === null || p === '') {
          updates['primaryPhone'] = null;
        } else {
          const normalized = normalizePhone(p);
          if (!normalized) {
            res.status(400).json({ error: 'invalid_phone' });
            return;
          }
          updates['primaryPhone'] = normalized;
        }
      }
      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'no_changes' });
        return;
      }
      try {
        await db
          .update(portalIdentity)
          .set({ ...updates, updatedAt: new Date() })
          .where(eq(portalIdentity.id, ident.id));
      } catch (err) {
        logger.warn({ err }, 'portal identity update failed');
        res.status(409).json({ error: 'email_in_use' });
        return;
      }
      await emitAudit(db, {
        action: 'UPDATE',
        entityType: 'portal_identity',
        entityId: ident.id,
        actorAppUserId: session.appUserId,
        after: updates,
      }).catch(() => undefined);
      res.json({ ok: true, kind: 'portal_identity' });
    },
  );

  return router;
}
