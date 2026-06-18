// SPDX-License-Identifier: Elastic-2.0
//
// CP1 — Tax Payments staff API.
//
// Mounted at /api/staff/tax-payments. Six endpoints:
//   GET    /              — list, filtered by status / due-date window / clientId
//   GET    /:id           — single row detail
//   POST   /              — create (partner only; emits CREATE audit)
//   PATCH  /:id           — update mutable fields (partner only; emits UPDATE audit)
//   POST   /:id/mark-paid — flip to PAID with paid_date + confirmation_number
//   POST   /:id/void      — soft-delete via status='VOIDED'
//
// All mutations route through `emitAudit` so the audit log captures
// every state change with actor + before/after.
//
// State machine:
//   SCHEDULED → PAID    (mark-paid)
//   SCHEDULED → VOIDED  (void)
//   PAID      → (terminal — use credit-memo via AR flow to refund)

import express, { type Request, type Response, type Router } from 'express';
import { and, asc, desc, eq, gte, ilike, inArray, lte, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import {
  clientPortalAccess,
  clients,
  engagements,
  portalIdentity,
  taxPayments,
  taxReturns,
} from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { getBlockedClientIdsCached } from '../clients/access';
import { addUuidIdGuard, uuidQueryParam } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface TaxPaymentRoutesDeps extends RbacDeps {
  db: Database | null;
  // 0091 followup — bulk reminder dispatch. Both are optional so the
  // router still mounts in environments without mail/SMS configured
  // (the reminder endpoint will surface a 503 in that case).
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
  sendSms?: (args: { to: string; body: string }) => Promise<void>;
}

// 0090 — `paymentUrl` is the resolved URL the portal links to so the
// client can pay online. The FE looks it up from the tax_payment_type
// catalog when the user picks the type, then sends it here. Stored
// denormalized so the link is stable even if the catalog row is later
// edited or removed.
const URL_RE = /^https?:\/\/[^\s]+$/i;
const CreateSchema = z.object({
  clientId: z.string().uuid(),
  engagementId: z.string().uuid().nullable().optional(),
  taxReturnId: z.string().uuid().nullable().optional(),
  jurisdiction: z.string().min(1).max(120),
  paymentType: z.string().min(1).max(120),
  paymentUrl: z.string().regex(URL_RE).max(2048).nullable().optional(),
  taxYear: z.number().int().min(1900).max(2200).optional(),
  amountCents: z.number().int().min(0),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().max(2000).optional(),
});

const PatchSchema = z.object({
  jurisdiction: z.string().min(1).max(120).optional(),
  paymentType: z.string().min(1).max(120).optional(),
  paymentUrl: z.string().regex(URL_RE).max(2048).nullable().optional(),
  taxYear: z.number().int().min(1900).max(2200).nullable().optional(),
  amountCents: z.number().int().min(0).optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const MarkPaidSchema = z.object({
  paidDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  confirmationNumber: z.string().max(120).optional(),
});

const VoidSchema = z.object({ reason: z.string().min(1).max(400) });

export function createTaxPaymentRouter(deps: TaxPaymentRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  // ----- list --------------------------------------------------------

  router.get(
    '/',
    requirePermission(deps, 'tax_payment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const conds = [eq(taxPayments.firmId, session.firmId)];
      const returnFilter = uuidQueryParam(req.query['returnId']);
      if (returnFilter) conds.push(eq(taxPayments.taxReturnId, returnFilter));
      const clientFilter = uuidQueryParam(req.query['clientId']);
      if (clientFilter && clientFilter !== 'invalid') {
        conds.push(eq(taxPayments.clientId, clientFilter));
      }
      // 0165 — hide restricted clients' tax payments.
      const blockedClientIds = await getBlockedClientIdsCached(
        deps,
        req,
        session.appUserId,
        session.firmId,
      );
      if (blockedClientIds.length) conds.push(notInArray(taxPayments.clientId, blockedClientIds));
      const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
      if (status === 'SCHEDULED' || status === 'PAID' || status === 'VOIDED') {
        conds.push(eq(taxPayments.status, status));
      }
      const dueFrom = typeof req.query['dueFrom'] === 'string' ? req.query['dueFrom'] : null;
      if (dueFrom && /^\d{4}-\d{2}-\d{2}$/.test(dueFrom)) {
        conds.push(gte(taxPayments.dueDate, dueFrom));
      }
      const dueTo = typeof req.query['dueTo'] === 'string' ? req.query['dueTo'] : null;
      if (dueTo && /^\d{4}-\d{2}-\d{2}$/.test(dueTo)) {
        conds.push(lte(taxPayments.dueDate, dueTo));
      }
      // Per-column substring filters. Match the firm-wide payments page
      // — one input per visible column, case-insensitive, ILIKE %term%.
      const clientQ = strParam(req.query['clientQ']);
      const jurisdictionQ = strParam(req.query['jurisdictionQ']);
      const typeQ = strParam(req.query['typeQ']);
      if (clientQ) conds.push(ilike(clients.name, `%${clientQ}%`));
      if (jurisdictionQ) conds.push(ilike(taxPayments.jurisdiction, `%${jurisdictionQ}%`));
      if (typeQ) conds.push(ilike(taxPayments.paymentType, `%${typeQ}%`));

      const sortBy =
        typeof req.query['sortBy'] === 'string' ? (req.query['sortBy'] as string) : 'dueDate';
      const dir = req.query['dir'] === 'asc' ? 'asc' : 'desc';
      const orderCol = (() => {
        switch (sortBy) {
          case 'client':
            return clients.name;
          case 'jurisdiction':
            return taxPayments.jurisdiction;
          case 'type':
            return taxPayments.paymentType;
          case 'amount':
            return taxPayments.amountCents;
          case 'dueDate':
          default:
            return taxPayments.dueDate;
        }
      })();
      const orderExpr = dir === 'asc' ? asc(orderCol) : desc(orderCol);

      const items = await deps.db
        .select({
          id: taxPayments.id,
          clientId: taxPayments.clientId,
          clientName: clients.name,
          engagementId: taxPayments.engagementId,
          jurisdiction: taxPayments.jurisdiction,
          paymentType: taxPayments.paymentType,
          paymentUrl: taxPayments.paymentUrl,
          taxYear: taxPayments.taxYear,
          amountCents: taxPayments.amountCents,
          dueDate: taxPayments.dueDate,
          status: taxPayments.status,
          paidDate: taxPayments.paidDate,
          confirmationNumber: taxPayments.confirmationNumber,
          notes: taxPayments.notes,
          taxReturnId: taxPayments.taxReturnId,
          createdAt: taxPayments.createdAt,
          updatedAt: taxPayments.updatedAt,
        })
        .from(taxPayments)
        .innerJoin(clients, eq(clients.id, taxPayments.clientId))
        .where(and(...conds))
        .orderBy(orderExpr)
        .limit(500);
      res.json({ items });
    },
  );

  // ----- detail ------------------------------------------------------

  router.get(
    '/:id',
    requirePermission(deps, 'tax_payment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(taxPayments)
        .where(and(eq(taxPayments.id, req.params['id']!), eq(taxPayments.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ taxPayment: row });
    },
  );

  // ----- create ------------------------------------------------------

  router.post(
    '/',
    requirePermission(deps, 'tax_payment:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      // Client must belong to the firm.
      const [client] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, parsed.data.clientId), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      // If engagement supplied, it must belong to that client.
      if (parsed.data.engagementId) {
        const [eng] = await deps.db
          .select({ id: engagements.id })
          .from(engagements)
          .where(
            and(
              eq(engagements.id, parsed.data.engagementId),
              eq(engagements.clientId, parsed.data.clientId),
            ),
          )
          .limit(1);
        if (!eng) {
          res.status(400).json({ error: 'engagement_not_in_client' });
          return;
        }
      }
      // If a tax return is supplied, it must belong to the same client.
      if (parsed.data.taxReturnId) {
        const [tr] = await deps.db
          .select({ id: taxReturns.id })
          .from(taxReturns)
          .where(
            and(
              eq(taxReturns.id, parsed.data.taxReturnId),
              eq(taxReturns.firmId, session.firmId),
              eq(taxReturns.clientId, parsed.data.clientId),
            ),
          )
          .limit(1);
        if (!tr) {
          res.status(400).json({ error: 'tax_return_not_in_client' });
          return;
        }
      }
      const [row] = await deps.db
        .insert(taxPayments)
        .values({
          firmId: session.firmId,
          clientId: parsed.data.clientId,
          engagementId: parsed.data.engagementId ?? null,
          taxReturnId: parsed.data.taxReturnId ?? null,
          jurisdiction: parsed.data.jurisdiction,
          paymentType: parsed.data.paymentType,
          paymentUrl: parsed.data.paymentUrl ?? null,
          taxYear: parsed.data.taxYear ?? null,
          amountCents: parsed.data.amountCents,
          dueDate: parsed.data.dueDate,
          notes: parsed.data.notes ?? null,
          status: 'SCHEDULED',
          createdById: session.appUserId,
        })
        .returning({ id: taxPayments.id });
      if (!row) throw new Error('tax_payment_insert_failed');
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'tax_payment',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: {
          clientId: parsed.data.clientId,
          jurisdiction: parsed.data.jurisdiction,
          paymentType: parsed.data.paymentType,
          amountCents: parsed.data.amountCents,
          dueDate: parsed.data.dueDate,
        },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: row.id });
    },
  );

  // ----- patch (only when SCHEDULED) ---------------------------------

  router.patch(
    '/:id',
    requirePermission(deps, 'tax_payment:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = PatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [prior] = await deps.db
        .select()
        .from(taxPayments)
        .where(and(eq(taxPayments.id, req.params['id']!), eq(taxPayments.firmId, session.firmId)))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (prior.status !== 'SCHEDULED') {
        res.status(409).json({ error: 'not_editable', currentStatus: prior.status });
        return;
      }
      const patch: Record<string, unknown> = {};
      if (parsed.data.jurisdiction != null) patch['jurisdiction'] = parsed.data.jurisdiction;
      if (parsed.data.paymentType != null) patch['paymentType'] = parsed.data.paymentType;
      if (parsed.data.taxYear !== undefined) patch['taxYear'] = parsed.data.taxYear;
      if (parsed.data.amountCents != null) patch['amountCents'] = parsed.data.amountCents;
      if (parsed.data.dueDate != null) patch['dueDate'] = parsed.data.dueDate;
      if (parsed.data.notes !== undefined) patch['notes'] = parsed.data.notes;
      patch['updatedAt'] = new Date();
      await deps.db.update(taxPayments).set(patch).where(eq(taxPayments.id, prior.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'tax_payment',
        entityId: prior.id,
        actorAppUserId: session.appUserId,
        before: prior,
        after: patch,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // ----- mark-paid ---------------------------------------------------

  router.post(
    '/:id/mark-paid',
    requirePermission(deps, 'tax_payment:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = MarkPaidSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(taxPayments)
        .where(and(eq(taxPayments.id, req.params['id']!), eq(taxPayments.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.status !== 'SCHEDULED') {
        res.status(409).json({ error: 'not_schedulable', currentStatus: row.status });
        return;
      }
      await deps.db
        .update(taxPayments)
        .set({
          status: 'PAID',
          paidDate: parsed.data.paidDate,
          confirmationNumber: parsed.data.confirmationNumber ?? null,
          updatedAt: new Date(),
        })
        .where(eq(taxPayments.id, row.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'tax_payment',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        before: { status: 'SCHEDULED' },
        after: {
          status: 'PAID',
          paidDate: parsed.data.paidDate,
          confirmationNumber: parsed.data.confirmationNumber ?? null,
        },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // ----- void --------------------------------------------------------
  // Soft-delete. Only allowed from SCHEDULED — PAID rows route through
  // the existing AR credit-memo flow for refunds.

  router.post(
    '/:id/void',
    requirePermission(deps, 'tax_payment:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = VoidSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(taxPayments)
        .where(and(eq(taxPayments.id, req.params['id']!), eq(taxPayments.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.status === 'VOIDED') {
        res.json({ ok: true, alreadyVoided: true });
        return;
      }
      if (row.status === 'PAID') {
        res.status(409).json({ error: 'cannot_void_paid', currentStatus: row.status });
        return;
      }
      await deps.db
        .update(taxPayments)
        .set({ status: 'VOIDED', updatedAt: new Date() })
        .where(eq(taxPayments.id, row.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'tax_payment',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        before: { status: row.status },
        after: { status: 'VOIDED', reason: parsed.data.reason },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // ----- bulk reminder ---------------------------------------------
  //
  // Body: { paymentIds: uuid[], channels: ('email' | 'sms')[] }
  // For every distinct client referenced by the payments, look up its
  // ACTIVE portal contacts, then dispatch one message per channel per
  // contact summarizing all of that client's selected upcoming
  // payments. Returns per-client outcomes so the UI can render a
  // success / partial / skipped breakdown.
  //
  // Permission: tax_payment:write (sending external comms is a write-
  // class action). Audit row per client touched.

  const BulkRemindSchema = z.object({
    paymentIds: z.array(z.string().uuid()).min(1).max(500),
    channels: z.array(z.enum(['email', 'sms'])).min(1),
    note: z.string().max(500).optional(),
  });

  router.post(
    '/bulk-remind',
    requirePermission(deps, 'tax_payment:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = BulkRemindSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const wantsEmail = parsed.data.channels.includes('email');
      const wantsSms = parsed.data.channels.includes('sms');
      if (wantsEmail && !deps.sendEmail) {
        res.status(503).json({ error: 'email_dispatch_not_configured' });
        return;
      }
      if (wantsSms && !deps.sendSms) {
        res.status(503).json({ error: 'sms_dispatch_not_configured' });
        return;
      }

      // Load the selected payments, scoped to the firm.
      const payments = await deps.db
        .select({
          id: taxPayments.id,
          clientId: taxPayments.clientId,
          clientName: clients.name,
          jurisdiction: taxPayments.jurisdiction,
          paymentType: taxPayments.paymentType,
          paymentUrl: taxPayments.paymentUrl,
          amountCents: taxPayments.amountCents,
          dueDate: taxPayments.dueDate,
          status: taxPayments.status,
        })
        .from(taxPayments)
        .innerJoin(clients, eq(clients.id, taxPayments.clientId))
        .where(
          and(
            eq(taxPayments.firmId, session.firmId),
            inArray(taxPayments.id, parsed.data.paymentIds),
          ),
        );

      // Group by client.
      type Group = (typeof payments)[number] & { _grouped?: never };
      const byClient = new Map<string, { name: string; items: Group[] }>();
      for (const p of payments) {
        const g = byClient.get(p.clientId);
        if (g) g.items.push(p as Group);
        else byClient.set(p.clientId, { name: p.clientName, items: [p as Group] });
      }

      // Resolve portal contacts per client (ACTIVE access only).
      const contactsByClient = new Map<
        string,
        Array<{ email: string | null; phone: string | null; name: string }>
      >();
      if (byClient.size > 0) {
        const clientIds = Array.from(byClient.keys());
        const contactRows = await deps.db
          .select({
            clientId: clientPortalAccess.clientId,
            email: portalIdentity.primaryEmail,
            phone: portalIdentity.primaryPhone,
            name: portalIdentity.fullName,
          })
          .from(clientPortalAccess)
          .innerJoin(portalIdentity, eq(portalIdentity.id, clientPortalAccess.portalIdentityId))
          .where(
            and(
              inArray(clientPortalAccess.clientId, clientIds),
              eq(clientPortalAccess.status, 'ACTIVE'),
            ),
          );
        for (const c of contactRows) {
          const list = contactsByClient.get(c.clientId) ?? [];
          list.push({ email: c.email, phone: c.phone, name: c.name });
          contactsByClient.set(c.clientId, list);
        }
      }

      const fmtCents = (n: number): string => `$${(n / 100).toFixed(2)}`;
      const fmtDate = (d: string | Date): string => {
        const s = typeof d === 'string' ? d : new Date(d).toISOString().slice(0, 10);
        return s;
      };
      const noteBlock = parsed.data.note ? `\n\nFrom your CPA:\n${parsed.data.note}\n` : '';

      const results: Array<{
        clientId: string;
        clientName: string;
        sentEmail: number;
        sentSms: number;
        skipped: string[];
        errors: string[];
      }> = [];

      for (const [clientId, group] of byClient) {
        const contacts = contactsByClient.get(clientId) ?? [];
        const skipped: string[] = [];
        const errors: string[] = [];
        let sentEmail = 0;
        let sentSms = 0;

        if (contacts.length === 0) {
          skipped.push('no_active_portal_contacts');
        }
        // Compose the message body once per client (same for every contact).
        const lines = group.items
          .map(
            (p) =>
              `• ${fmtDate(p.dueDate)} — ${p.jurisdiction} ${p.paymentType}: ${fmtCents(
                p.amountCents,
              )}${p.paymentUrl ? ` (${p.paymentUrl})` : ''}`,
          )
          .join('\n');
        const totalCents = group.items.reduce((acc, p) => acc + p.amountCents, 0);
        const subject = `Upcoming tax payment reminder — ${group.name}`;
        const body = `Hi from your CPA — this is a quick reminder of the following scheduled tax payments:\n\n${lines}\n\nTotal: ${fmtCents(
          totalCents,
        )}${noteBlock}\nIf you have already submitted any of these, please ignore this notice.`;
        const smsBody = `Tax payment reminder: ${group.items.length} due (${fmtCents(
          totalCents,
        )}). See email or your portal for details.`;

        for (const c of contacts) {
          if (wantsEmail) {
            if (!c.email) {
              skipped.push(`${c.name}: no_email`);
            } else {
              try {
                await deps.sendEmail!({ to: c.email, subject, body });
                sentEmail += 1;
              } catch (err) {
                errors.push(`${c.name} email: ${err instanceof Error ? err.message : 'failed'}`);
              }
            }
          }
          if (wantsSms) {
            if (!c.phone) {
              skipped.push(`${c.name}: no_phone`);
            } else {
              try {
                await deps.sendSms!({ to: c.phone, body: smsBody });
                sentSms += 1;
              } catch (err) {
                errors.push(`${c.name} sms: ${err instanceof Error ? err.message : 'failed'}`);
              }
            }
          }
        }

        results.push({
          clientId,
          clientName: group.name,
          sentEmail,
          sentSms,
          skipped,
          errors,
        });

        // Per-client audit so the timeline picks up the reminder event.
        await emitAudit(deps.db, {
          action: 'UPDATE',
          entityType: 'tax_payment',
          // Use first payment id as the anchor entity — full id list lives in after.
          entityId: group.items[0]!.id,
          actorAppUserId: session.appUserId,
          after: {
            kind: 'bulk_remind',
            clientId,
            paymentIds: group.items.map((p) => p.id),
            channels: parsed.data.channels,
            sentEmail,
            sentSms,
            skipped,
            errors,
          },
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
        }).catch((err: unknown) => logger.error({ err }, 'bulk-remind audit failed'));
      }

      const summary = results.reduce(
        (acc, r) => ({
          clients: acc.clients + 1,
          emailsSent: acc.emailsSent + r.sentEmail,
          smsSent: acc.smsSent + r.sentSms,
          clientsWithoutContact:
            acc.clientsWithoutContact +
            (r.skipped.length > 0 && r.sentEmail === 0 && r.sentSms === 0 ? 1 : 0),
        }),
        { clients: 0, emailsSent: 0, smsSent: 0, clientsWithoutContact: 0 },
      );
      res.json({ results, summary });
    },
  );

  return router;
}

function strParam(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

// Surface sql for downstream maintenance; unused-import lint guard.
void sql;
