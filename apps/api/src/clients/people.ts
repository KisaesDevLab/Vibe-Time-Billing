// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Unified "People" view for a client (0114). Reconciles the firm's
// directory (client_contact) with portal logins (client_portal_access →
// portal_identity) into one list, so the same human shows once instead of
// twice. Each entry is one of:
//   - linked        : a contact who also has portal access
//   - contact_only  : a directory contact with no portal access
//   - portal_only   : a 3rd-party login (advisor/attorney) not in the directory
//   - invited       : a pending invitation (no identity yet)
//
// The access→contact link is the explicit client_contact_id FK; for legacy
// rows that predate it we lazily self-heal by matching email, so the view
// is reconciled even before a re-invite.

import { and, eq, inArray, ne } from 'drizzle-orm';
import { type Request, type Response, type Router } from 'express';

import type { Database } from '@vibe/db';
import {
  clientContacts,
  clientPortalAccess,
  clients,
  persons,
  portalIdentity,
  portalInvitation,
} from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface PeopleRoutesDeps extends RbacDeps {
  db: Database | null;
}

type Kind = 'linked' | 'contact_only' | 'portal_only' | 'invited';

export function mountPeopleRoutes(router: Router, deps: PeopleRoutesDeps): void {
  router.get(
    '/:id/people',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ people: [] });
        return;
      }
      const clientId = req.params['id']!;
      const [client] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, clientId), eq(clients.firmId, firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'not_found' });
        return;
      }

      const contacts = await deps.db
        .select({
          id: clientContacts.id,
          personId: clientContacts.personId,
          fullName: persons.fullName,
          email: persons.email,
          phone: persons.phone,
          mobile: persons.mobile,
          roleId: clientContacts.roleId,
          isPrimary: clientContacts.isPrimary,
          isBilling: clientContacts.isBilling,
        })
        .from(clientContacts)
        .innerJoin(persons, eq(persons.id, clientContacts.personId))
        .where(eq(clientContacts.clientId, clientId));

      // 0115 — cross-client surfacing: which OTHER clients each of these
      // people is also a contact of (one query, firm-scoped).
      const personIds = [...new Set(contacts.map((c) => c.personId))];
      const alsoRows = personIds.length
        ? await deps.db
            .select({
              personId: clientContacts.personId,
              clientId: clients.id,
              clientName: clients.name,
            })
            .from(clientContacts)
            .innerJoin(clients, eq(clients.id, clientContacts.clientId))
            .where(
              and(
                eq(clients.firmId, firmId),
                inArray(clientContacts.personId, personIds),
                ne(clientContacts.clientId, clientId),
              ),
            )
        : [];
      const alsoByPerson = new Map<string, { clientId: string; name: string }[]>();
      for (const r of alsoRows) {
        const list = alsoByPerson.get(r.personId) ?? [];
        if (!list.some((x) => x.clientId === r.clientId)) {
          list.push({ clientId: r.clientId, name: r.clientName });
        }
        alsoByPerson.set(r.personId, list);
      }

      const accesses = await deps.db
        .select({
          id: clientPortalAccess.id,
          portalIdentityId: clientPortalAccess.portalIdentityId,
          clientContactId: clientPortalAccess.clientContactId,
          role: clientPortalAccess.role,
          status: clientPortalAccess.status,
          invitedAt: clientPortalAccess.invitedAt,
          acceptedAt: clientPortalAccess.acceptedAt,
          revokedAt: clientPortalAccess.revokedAt,
          fullName: portalIdentity.fullName,
          primaryEmail: portalIdentity.primaryEmail,
          primaryPhone: portalIdentity.primaryPhone,
          identityStatus: portalIdentity.status,
          lastLoginAt: portalIdentity.lastLoginAt,
        })
        .from(clientPortalAccess)
        .innerJoin(portalIdentity, eq(portalIdentity.id, clientPortalAccess.portalIdentityId))
        .where(eq(clientPortalAccess.clientId, clientId));

      const pending = await deps.db
        .select({
          id: portalInvitation.id,
          invitedEmail: portalInvitation.invitedEmail,
          invitedPhone: portalInvitation.invitedPhone,
          proposedFullName: portalInvitation.proposedFullName,
          proposedRole: portalInvitation.proposedRole,
          deliveryChannel: portalInvitation.deliveryChannel,
          expiresAt: portalInvitation.expiresAt,
        })
        .from(portalInvitation)
        .where(
          and(
            eq(portalInvitation.clientId, clientId),
            eq(portalInvitation.firmId, firmId),
            eq(portalInvitation.status, 'ACTIVE'),
          ),
        );

      // Self-heal: link legacy accesses to a same-client contact by email.
      const contactByEmail = new Map<string, string>();
      for (const c of contacts) {
        if (c.email) contactByEmail.set(c.email.toLowerCase(), c.id);
      }
      for (const a of accesses) {
        if (!a.clientContactId && a.primaryEmail) {
          const match = contactByEmail.get(a.primaryEmail.toLowerCase());
          if (match) {
            a.clientContactId = match;
            await deps.db
              .update(clientPortalAccess)
              .set({ clientContactId: match })
              .where(eq(clientPortalAccess.id, a.id));
          }
        }
      }

      const contactsWithAlso = contacts.map((c) => ({
        ...c,
        alsoOn: alsoByPerson.get(c.personId) ?? [],
      }));

      interface Entry {
        key: string;
        kind: Kind;
        contact: (typeof contactsWithAlso)[number] | null;
        access: (typeof accesses)[number] | null;
        pendingInvitation: (typeof pending)[number] | null;
      }
      const byContactId = new Map<string, Entry>();
      const entries: Entry[] = [];
      for (const c of contactsWithAlso) {
        const e: Entry = {
          key: `c:${c.id}`,
          kind: 'contact_only',
          contact: c,
          access: null,
          pendingInvitation: null,
        };
        byContactId.set(c.id, e);
        entries.push(e);
      }
      for (const a of accesses) {
        const linked = a.clientContactId ? byContactId.get(a.clientContactId) : undefined;
        if (linked) {
          linked.access = a;
          linked.kind = 'linked';
        } else {
          entries.push({
            key: `a:${a.id}`,
            kind: 'portal_only',
            contact: null,
            access: a,
            pendingInvitation: null,
          });
        }
      }
      for (const inv of pending) {
        const match = inv.invitedEmail
          ? byContactId.get(
              contacts.find((c) => c.email?.toLowerCase() === inv.invitedEmail!.toLowerCase())
                ?.id ?? '',
            )
          : undefined;
        // Attach to a contact that doesn't already have an active access.
        if (match && !match.access) {
          match.pendingInvitation = inv;
        } else {
          entries.push({
            key: `i:${inv.id}`,
            kind: 'invited',
            contact: null,
            access: null,
            pendingInvitation: inv,
          });
        }
      }

      // Sort: directory people first (primary, then billing, then name),
      // then 3rd-party logins, then standalone pending invites.
      const order: Record<Kind, number> = {
        linked: 0,
        contact_only: 0,
        portal_only: 1,
        invited: 2,
      };
      entries.sort((x, y) => {
        if (order[x.kind] !== order[y.kind]) return order[x.kind] - order[y.kind];
        const xc = x.contact;
        const yc = y.contact;
        if (xc && yc) {
          if (xc.isPrimary !== yc.isPrimary) return xc.isPrimary ? -1 : 1;
          if (xc.isBilling !== yc.isBilling) return xc.isBilling ? -1 : 1;
          return xc.fullName.localeCompare(yc.fullName);
        }
        const xn =
          xc?.fullName ?? x.access?.fullName ?? x.pendingInvitation?.proposedFullName ?? '';
        const yn =
          yc?.fullName ?? y.access?.fullName ?? y.pendingInvitation?.proposedFullName ?? '';
        return xn.localeCompare(yn);
      });

      res.json({ people: entries });
    },
  );
}
