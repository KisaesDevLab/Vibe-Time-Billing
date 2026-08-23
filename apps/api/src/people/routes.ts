// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
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
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
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

import { resolveMergeTokens, type MergeContext } from '@vibe/core/proposals';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { updatePerson } from '../clients/person-helpers';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { markdownToHtml } from '../lib/markdown';
import { logger } from '../logger';
import { firmScope } from '../notifications/templating';

export interface PeopleRoutesDeps extends RbacDeps {
  db: Database | null;
  /** 0221 — firm mailer for the People-page bulk email. */
  sendStaffMail?: (args: {
    to: string;
    subject: string;
    body: string;
    html?: string;
  }) => Promise<void>;
}

type Kind = 'person' | 'portal_identity';

const PatchSchema = z.object({
  fullName: z.string().min(1).max(200).optional(),
  email: z.string().email().max(254).nullable().optional(),
  // 0224 — blank strings are stored as NULL so "mobile first, then phone"
  // fallbacks never land on ''.
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
  // 0221 — block/unblock this person from firm bulk emails.
  bulkEmailOptOut: z.boolean().optional(),
  // 0224 — automated texts / voice calls (do_not_call is the 0206 flag).
  smsOptOut: z.boolean().optional(),
  doNotCall: z.boolean().optional(),
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
    const pageSize = Math.min(100_000, Math.max(1, Number(req.query['pageSize']) || 25));

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
        bulkEmailOptOut: persons.bulkEmailOptOut,
        smsOptOut: persons.smsOptOut,
        doNotCall: persons.doNotCall,
      })
      .from(persons)
      // Archived people (e.g. merge losers) stay out of the directory.
      .where(and(eq(persons.firmId, firmId), ne(persons.status, 'ARCHIVED')));
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
    // 0221 — live (unexpired) pending invitations, matched to people by
    // the invited email/phone (invitations carry no person id).
    const inviteRows = await db
      .select({
        email: portalInvitation.invitedEmail,
        phone: portalInvitation.invitedPhone,
        expiresAt: portalInvitation.expiresAt,
      })
      .from(portalInvitation)
      .where(and(eq(portalInvitation.firmId, firmId), eq(portalInvitation.status, 'ACTIVE')));
    const nowMs = Date.now();
    const invitedEmails = new Set(
      inviteRows
        .filter((i) => i.expiresAt.getTime() > nowMs && i.email)
        .map((i) => i.email!.toLowerCase()),
    );
    const invitedPhones = new Set(
      inviteRows.filter((i) => i.expiresAt.getTime() > nowMs && i.phone).map((i) => i.phone!),
    );
    const invitePending = (email: string | null, phone: string | null, mobile: string | null) =>
      Boolean(
        (email && invitedEmails.has(email.toLowerCase())) ||
        (phone && invitedPhones.has(phone)) ||
        (mobile && invitedPhones.has(mobile)),
      );

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
      portalStatus: 'yes' | 'invited' | 'no';
      clientCount: number;
      bulkEmailOptOut: boolean;
      smsOptOut: boolean;
      doNotCall: boolean;
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
        portalStatus: ids.some((id) => activeByIdentity.has(id))
          ? 'yes'
          : invitePending(p.email, p.phone, p.mobile)
            ? 'invited'
            : 'no',
        clientCount: (contactsByPerson.get(p.id) ?? []).length,
        bulkEmailOptOut: p.bulkEmailOptOut,
        smsOptOut: p.smsOptOut,
        doNotCall: p.doNotCall,
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
        portalStatus: activeByIdentity.has(i.id)
          ? 'yes'
          : invitePending(i.email, i.phone, null)
            ? 'invited'
            : 'no',
        clientCount: (clientsByIdentity.get(i.id) ?? new Set()).size,
        bulkEmailOptOut: false,
        smsOptOut: false,
        doNotCall: false,
      });
    }

    // Column filters (multi-select → comma-separated) + sort, applied to the
    // reconciled set before the page slice so paging is correct firm-wide.
    const csv = (v: unknown): string[] =>
      typeof v === 'string'
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    const portalFilter = csv(req.query['portal']); // 'yes' | 'no'
    const kindFilter = csv(req.query['kind']); // 'person' | 'portal_identity'

    let filtered = rows;
    if (q) {
      filtered = filtered.filter(
        (r) =>
          r.fullName.toLowerCase().includes(q) ||
          (r.email?.toLowerCase().includes(q) ?? false) ||
          (r.phone?.toLowerCase().includes(q) ?? false),
      );
    }
    if (portalFilter.length > 0) {
      // Tri-state: 'yes' (active access) | 'invited' (pending invite) | 'no'.
      filtered = filtered.filter((r) => portalFilter.includes(r.portalStatus));
    }
    if (kindFilter.length > 0) {
      filtered = filtered.filter((r) => kindFilter.includes(r.kind));
    }
    // 0221 — presence filters ('blank' | 'not_blank') on email and phone,
    // so staff can find people who can't be invited (or bulk-invite only
    // those who can). Phone counts either landline or mobile.
    const emailFilter = csv(req.query['email']);
    if (emailFilter.length > 0) {
      filtered = filtered.filter((r) =>
        emailFilter.includes(r.email && r.email.trim() !== '' ? 'not_blank' : 'blank'),
      );
    }
    // 0224 — Phone filter matches the Phone column only; Mobile has its own.
    const phoneFilter = csv(req.query['phone']);
    if (phoneFilter.length > 0) {
      filtered = filtered.filter((r) =>
        phoneFilter.includes(r.phone && r.phone.trim() !== '' ? 'not_blank' : 'blank'),
      );
    }

    // 0224 — mobile column gets its own presence filter.
    const mobileFilter = csv(req.query['mobile']);
    if (mobileFilter.length > 0) {
      filtered = filtered.filter((r) =>
        mobileFilter.includes(r.mobile && r.mobile.trim() !== '' ? 'not_blank' : 'blank'),
      );
    }

    const sortCol = String(req.query['sort'] ?? 'name');
    const sortDir = String(req.query['dir'] ?? 'asc') === 'desc' ? -1 : 1;
    const cmp = (a: Row, b: Row): number => {
      switch (sortCol) {
        case 'email':
          return (a.email ?? '').localeCompare(b.email ?? '');
        case 'phone':
          return (a.phone ?? '').localeCompare(b.phone ?? '');
        case 'mobile':
          return (a.mobile ?? '').localeCompare(b.mobile ?? '');
        case 'clients':
          return a.clientCount - b.clientCount;
        default:
          return a.fullName.localeCompare(b.fullName);
      }
    };
    filtered.sort((a, b) => {
      const c = cmp(a, b) * sortDir;
      return c !== 0 ? c : a.fullName.localeCompare(b.fullName);
    });
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
        bulkEmailOptOut: persons.bulkEmailOptOut,
        smsOptOut: persons.smsOptOut,
        doNotCall: persons.doNotCall,
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
            bulkEmailOptOut: person.bulkEmailOptOut,
            smsOptOut: person.smsOptOut,
            doNotCall: person.doNotCall,
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
  // POST /merge — 0221. Collapse duplicate directory people into one.
  // Every table referencing person repoints to the survivor (live FK
  // list: client_contact, portal_identity, signature_signers,
  // booking_request, portal_access_request, voice_call); a duplicate
  // client_contact (survivor already on that client) merges its
  // primary/billing flags then archives. Merged person rows are soft-
  // archived with contact fields cleared (frees the firm-unique email
  // for the survivor backfill). Soft delete per CLAUDE.md — no rows die.
  // ---------------------------------------------------------------
  const MergeSchema = z.object({
    survivorId: z.string().uuid(),
    mergeIds: z.array(z.string().uuid()).max(20).default([]),
    // 0222 — standalone portal logins selected alongside: they can't be
    // merged (no person row) but they CAN be linked to the survivor,
    // which collapses them into the survivor's directory row.
    identityIds: z.array(z.string().uuid()).max(20).default([]),
  });
  router.post(
    '/merge',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const parsed = MergeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const db = deps.db;
      const { survivorId } = parsed.data;
      const mergeIds = parsed.data.mergeIds.filter((id) => id !== survivorId);
      const identityIds = parsed.data.identityIds;
      if (mergeIds.length === 0 && identityIds.length === 0) {
        res.status(400).json({ error: 'nothing_to_merge' });
        return;
      }

      const [survivor] = await db
        .select()
        .from(persons)
        .where(and(eq(persons.id, survivorId), eq(persons.firmId, session.firmId)))
        .limit(1);
      if (!survivor) {
        res.status(404).json({ error: 'survivor_not_found' });
        return;
      }
      const mergeRows = mergeIds.length
        ? await db
            .select()
            .from(persons)
            .where(and(inArray(persons.id, mergeIds), eq(persons.firmId, session.firmId)))
        : [];
      if (mergeRows.length !== mergeIds.length) {
        res.status(404).json({ error: 'person_not_found' });
        return;
      }
      // Standalone (or merge-loser-linked) portal logins to attach.
      const identityRowsToLink = identityIds.length
        ? await db
            .select({
              id: portalIdentity.id,
              personId: portalIdentity.personId,
              email: portalIdentity.primaryEmail,
              phone: portalIdentity.primaryPhone,
            })
            .from(portalIdentity)
            .where(
              and(
                inArray(portalIdentity.id, identityIds),
                eq(portalIdentity.firmId, session.firmId),
              ),
            )
        : [];
      if (identityRowsToLink.length !== identityIds.length) {
        res.status(404).json({ error: 'identity_not_found' });
        return;
      }

      await db.transaction(async (tx) => {
        // Survivor backfill candidates gathered before clearing sources.
        let fillEmail = survivor.email;
        let fillPhone = survivor.phone;
        let fillMobile = survivor.mobile;
        for (const m of mergeRows) {
          if (!fillEmail && m.email) fillEmail = m.email;
          if (!fillPhone && m.phone) fillPhone = m.phone;
          if (!fillMobile && m.mobile) fillMobile = m.mobile;
        }
        for (const i of identityRowsToLink) {
          if (!fillEmail && i.email) fillEmail = i.email;
          if (!fillPhone && i.phone) fillPhone = i.phone;
        }

        // Attach selected portal logins to the survivor. Only steal a
        // login already linked to a DIFFERENT person when that person is
        // itself being merged away.
        for (const i of identityRowsToLink) {
          if (i.personId && i.personId !== survivorId && !mergeIds.includes(i.personId)) continue;
          await tx
            .update(portalIdentity)
            .set({ personId: survivorId })
            .where(eq(portalIdentity.id, i.id));
        }

        for (const m of mergeRows) {
          // client_contact: repoint unless the survivor already has a
          // contact on that client — then merge flags + archive the dup.
          const mergedContacts = await tx
            .select()
            .from(clientContacts)
            .where(eq(clientContacts.personId, m.id));
          for (const mc of mergedContacts) {
            const [existing] = await tx
              .select({
                id: clientContacts.id,
                isPrimary: clientContacts.isPrimary,
                isBilling: clientContacts.isBilling,
              })
              .from(clientContacts)
              .where(
                and(
                  eq(clientContacts.clientId, mc.clientId),
                  eq(clientContacts.personId, survivorId),
                ),
              )
              .limit(1);
            if (!existing) {
              await tx
                .update(clientContacts)
                .set({ personId: survivorId, updatedAt: new Date() })
                .where(eq(clientContacts.id, mc.id));
              continue;
            }
            const promotePrimary = mc.isPrimary && !existing.isPrimary;
            const promoteBilling = mc.isBilling && !existing.isBilling;
            // Free the partial unique indexes before promoting.
            await tx
              .update(clientContacts)
              .set({
                status: 'ARCHIVED',
                isPrimary: false,
                isBilling: false,
                updatedAt: new Date(),
              })
              .where(eq(clientContacts.id, mc.id));
            if (promotePrimary || promoteBilling) {
              await tx
                .update(clientContacts)
                .set({
                  ...(promotePrimary ? { isPrimary: true } : {}),
                  ...(promoteBilling ? { isBilling: true } : {}),
                  updatedAt: new Date(),
                })
                .where(eq(clientContacts.id, existing.id));
            }
          }

          // Plain repoints (live FK list — see route comment).
          await tx.execute(
            sql`UPDATE portal_identity SET person_id = ${survivorId} WHERE person_id = ${m.id}`,
          );
          await tx.execute(
            sql`UPDATE signature_signers SET person_id = ${survivorId} WHERE person_id = ${m.id}`,
          );
          await tx.execute(
            sql`UPDATE booking_request SET person_id = ${survivorId} WHERE person_id = ${m.id}`,
          );
          await tx.execute(
            sql`UPDATE portal_access_request SET person_id = ${survivorId} WHERE person_id = ${m.id}`,
          );
          await tx.execute(
            sql`UPDATE voice_call SET person_id = ${survivorId} WHERE person_id = ${m.id}`,
          );

          // Soft-archive the merged person; clear contact fields so the
          // firm-unique email frees up for the survivor backfill.
          await tx
            .update(persons)
            .set({
              status: 'ARCHIVED',
              email: null,
              phone: null,
              mobile: null,
              updatedAt: new Date(),
            })
            .where(eq(persons.id, m.id));
        }

        // 0224 — an opt-out on any merged record survives: a number whose
        // owner said "no texts" must not become textable via the survivor.
        const anyOpt = (k: 'bulkEmailOptOut' | 'smsOptOut' | 'doNotCall'): boolean =>
          Boolean(survivor[k]) || mergeRows.some((m) => Boolean(m[k]));
        await tx
          .update(persons)
          .set({
            email: fillEmail,
            phone: fillPhone,
            mobile: fillMobile,
            bulkEmailOptOut: anyOpt('bulkEmailOptOut'),
            smsOptOut: anyOpt('smsOptOut'),
            doNotCall: anyOpt('doNotCall'),
            updatedAt: new Date(),
          })
          .where(eq(persons.id, survivorId));
      });

      await emitAudit(db, {
        action: 'UPDATE',
        entityType: 'person',
        entityId: survivorId,
        actorAppUserId: session.appUserId,
        after: { kind: 'people_merge', mergedIds: mergeIds, linkedIdentityIds: identityIds },
      }).catch(() => undefined);
      res.json({
        ok: true,
        merged: mergeIds.length,
        linkedIdentities: identityIds.length,
        survivorId,
      });
    },
  );

  // ---------------------------------------------------------------
  // POST /bulk-email — 0221. Email the selected People rows directly
  // (subject/body in Markdown with {{firm.*}} + {{person.name}} tokens).
  // Skips rows with no email and anyone who opted out of bulk email;
  // per-row results, never a batch-level failure.
  // ---------------------------------------------------------------
  const BulkEmailSchema = z.object({
    people: z
      .array(z.object({ kind: z.enum(['person', 'portal_identity']), id: z.string().uuid() }))
      .min(1)
      .max(500),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(20_000),
  });
  router.post(
    '/bulk-email',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const parsed = BulkEmailSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      if (!deps.sendStaffMail) {
        res.status(503).json({ error: 'mail_dispatch_not_configured' });
        return;
      }
      const db = deps.db;
      const firmTokens = await firmScope(db, session.firmId);

      interface SendResult {
        kind: Kind;
        id: string;
        fullName: string | null;
        sent: boolean;
        to: string | null;
        reason: string | null;
      }
      const results: SendResult[] = [];

      for (const target of parsed.data.people) {
        let fullName: string | null = null;
        let email: string | null = null;
        let optedOut = false;
        if (target.kind === 'person') {
          const [p] = await db
            .select({
              fullName: persons.fullName,
              email: persons.email,
              optOut: persons.bulkEmailOptOut,
            })
            .from(persons)
            .where(and(eq(persons.id, target.id), eq(persons.firmId, session.firmId)))
            .limit(1);
          if (!p) {
            results.push({ ...target, fullName: null, sent: false, to: null, reason: 'not_found' });
            continue;
          }
          fullName = p.fullName;
          email = p.email?.trim() || null;
          optedOut = p.optOut;
        } else {
          const [i] = await db
            .select({
              fullName: portalIdentity.fullName,
              email: portalIdentity.primaryEmail,
              personId: portalIdentity.personId,
            })
            .from(portalIdentity)
            .where(and(eq(portalIdentity.id, target.id), eq(portalIdentity.firmId, session.firmId)))
            .limit(1);
          if (!i) {
            results.push({ ...target, fullName: null, sent: false, to: null, reason: 'not_found' });
            continue;
          }
          fullName = i.fullName;
          email = i.email?.trim() || null;
          if (i.personId) {
            const [lp] = await db
              .select({ optOut: persons.bulkEmailOptOut })
              .from(persons)
              .where(eq(persons.id, i.personId))
              .limit(1);
            optedOut = lp?.optOut ?? false;
          }
        }
        if (optedOut) {
          results.push({ ...target, fullName, sent: false, to: null, reason: 'opted_out' });
          continue;
        }
        if (!email) {
          results.push({ ...target, fullName, sent: false, to: null, reason: 'no_email' });
          continue;
        }
        try {
          const ctx: MergeContext = { firm: firmTokens, person: { name: fullName ?? '' } };
          const subject = resolveMergeTokens(parsed.data.subject, ctx)
            .output.replace(/[\r\n]+/g, ' ')
            .trim();
          const bodyText = resolveMergeTokens(parsed.data.body, ctx).output;
          await deps.sendStaffMail({
            to: email,
            subject,
            body: bodyText,
            html: markdownToHtml(bodyText),
          });
          results.push({ ...target, fullName, sent: true, to: email, reason: null });
        } catch (err) {
          results.push({
            ...target,
            fullName,
            sent: false,
            to: email,
            reason: err instanceof Error ? err.message : 'send_failed',
          });
        }
      }

      await emitAudit(db, {
        action: 'UPDATE',
        entityType: 'people_bulk_email',
        entityId: null,
        actorAppUserId: session.appUserId,
        after: {
          requested: parsed.data.people.length,
          sent: results.filter((r) => r.sent).length,
          skipped: results.filter((r) => !r.sent).length,
          subject: parsed.data.subject,
        },
      }).catch(() => undefined);

      res.json({ ok: true, results });
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
        .select({
          id: persons.id,
          bulkEmailOptOut: persons.bulkEmailOptOut,
          smsOptOut: persons.smsOptOut,
          doNotCall: persons.doNotCall,
        })
        .from(persons)
        .where(and(eq(persons.id, id), eq(persons.firmId, firmId)))
        .limit(1);
      if (person) {
        const flags: Partial<typeof persons.$inferInsert> = {};
        if (data.bulkEmailOptOut !== undefined) flags.bulkEmailOptOut = data.bulkEmailOptOut;
        if (data.smsOptOut !== undefined) flags.smsOptOut = data.smsOptOut;
        if (data.doNotCall !== undefined) flags.doNotCall = data.doNotCall;
        const {
          bulkEmailOptOut: _skip,
          smsOptOut: _skip2,
          doNotCall: _skip3,
          ...personFields
        } = data;
        void _skip;
        void _skip2;
        void _skip3;
        // 0224 — flags + fields + audit in ONE transaction, so an
        // email_in_use rejection cannot leave the flags half-applied and
        // unaudited.
        try {
          await db.transaction(async (tx) => {
            if (Object.keys(flags).length) {
              await tx
                .update(persons)
                .set({ ...flags, updatedAt: new Date() })
                .where(eq(persons.id, person.id));
            }
            await updatePerson(tx, person.id, personFields);
            await emitAudit(tx as unknown as typeof db, {
              action: 'UPDATE',
              entityType: 'person',
              entityId: person.id,
              actorAppUserId: session.appUserId,
              before: {
                bulkEmailOptOut: person.bulkEmailOptOut,
                smsOptOut: person.smsOptOut,
                doNotCall: person.doNotCall,
              },
              after: data,
            });
          });
        } catch (err) {
          logger.warn({ err }, 'person update failed');
          res.status(409).json({ error: 'email_in_use' });
          return;
        }
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
