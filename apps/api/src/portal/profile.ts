// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Portal identity profile + payment-method endpoints (Phase 16).
// Operations on the session's identity — read profile, update preferences,
// list payment methods, soft-delete a payment method.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';

import { createHash, randomInt } from 'node:crypto';

import type { Database } from '@vibe/db';
import {
  clientPortalAccess,
  invoices,
  paymentMethod,
  payments,
  persons,
  portalAltContact,
  portalIdentity,
} from '@vibe/db/schema';
import { sql as drz } from 'drizzle-orm';
import type { AnySession } from '@vibe/core/auth';

import { emitAudit } from '../auth/audit';
import { constantTimeEquals } from '../lib/constant-time';
import { logger } from '../logger';
import { firmScope, renderTemplate } from '../notifications/templating';
import { createClientSetupIntent, confirmClientSetupIntent } from '../payments/saved-methods';
import { createManualAchMethod, verifyMicrodeposits } from '../payments/manual-ach';

// Phase 19 #22 — alt-contact OTP timing constants.
const OTP_TTL_MS = 10 * 60_000;
const OTP_SEND_RATE_LIMIT_MS = 60_000;
const OTP_MAX_ATTEMPTS = 5;

export interface PortalProfileDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
  sessionStore?: {
    put: (session: AnySession) => Promise<void>;
    // CP5 — used by /sessions endpoints. Optional so tests can pass a
    // minimal store; the routes 503 when these are missing.
    listForUser?: (realm: 'portal', subjectId: string) => Promise<AnySession[]>;
    destroyOthers?: (realm: 'portal', subjectId: string, keepSid: string) => Promise<number>;
  };
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
  sendSms?: (args: { to: string; body: string }) => Promise<void>;
}

const PreferenceSchema = z.object({
  preferredMethod: z.enum(['EMAIL', 'SMS']).optional(),
  fullName: z.string().min(1).max(200).optional(),
});

export function createPortalProfileRouter(deps: PortalProfileDeps): Router {
  const router = express.Router();

  router.get('/me', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ identity: null });
      return;
    }
    const [identity] = await deps.db
      .select({
        id: portalIdentity.id,
        fullName: portalIdentity.fullName,
        primaryEmail: portalIdentity.primaryEmail,
        primaryPhone: portalIdentity.primaryPhone,
        preferredMethod: portalIdentity.preferredMethod,
        status: portalIdentity.status,
      })
      .from(portalIdentity)
      .where(eq(portalIdentity.id, session.portalIdentityId))
      .limit(1);
    res.json({ identity });
  });

  router.patch('/me', deps.requireAuth, async (req: Request, res: Response) => {
    const parsed = PreferenceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ ok: true });
      return;
    }
    await deps.db
      .update(portalIdentity)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(portalIdentity.id, session.portalIdentityId));
    res.json({ ok: true });
  });

  router.get('/payment-methods', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const items = await deps.db
      .select({
        id: paymentMethod.id,
        kind: paymentMethod.kind,
        provider: paymentMethod.provider,
        lastFour: paymentMethod.lastFour,
        displayLabel: paymentMethod.displayLabel,
        brand: paymentMethod.brand,
        expMonth: paymentMethod.expMonth,
        expYear: paymentMethod.expYear,
        isDefault: paymentMethod.isDefault,
        status: paymentMethod.status,
        verificationStatus: paymentMethod.verificationStatus,
      })
      .from(paymentMethod)
      .where(
        and(
          eq(paymentMethod.portalIdentityId, session.portalIdentityId),
          eq(paymentMethod.status, 'ACTIVE'),
        ),
      );
    res.json({ items });
  });

  // Confirm the signed-in identity still has ACTIVE access to its active client
  // (activeClientId in the session is only validated at switch time).
  async function requireActiveClientAccess(session: {
    portalIdentityId: string;
    activeClientId: string;
  }): Promise<boolean> {
    if (!deps.db || !session.activeClientId) return false;
    const [access] = await deps.db
      .select({ clientId: clientPortalAccess.clientId })
      .from(clientPortalAccess)
      .where(
        and(
          eq(clientPortalAccess.portalIdentityId, session.portalIdentityId),
          eq(clientPortalAccess.clientId, session.activeClientId),
          eq(clientPortalAccess.status, 'ACTIVE'),
        ),
      )
      .limit(1);
    return Boolean(access);
  }

  // Begin a save-a-method flow (Stripe Payment Element client_secret). The
  // saved method is stamped with this identity so it appears in the list above.
  const PortalSetupSchema = z.object({
    achVerificationMethod: z.enum(['automatic', 'instant', 'microdeposits']).optional(),
  });
  router.post('/payment-methods/setup-intent', deps.requireAuth, async (req, res) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = PortalSetupSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    if (!(await requireActiveClientAccess(session))) {
      res.status(403).json({ error: 'client_not_accessible' });
      return;
    }
    const r = await createClientSetupIntent(deps.db, session.firmId, session.activeClientId, {
      portalIdentityId: session.portalIdentityId,
      achVerificationMethod: parsed.data.achVerificationMethod,
    });
    if ('error' in r) {
      res.status(r.error === 'client_not_found' ? 404 : 400).json({ error: r.error });
      return;
    }
    res.json(r);
  });

  // Persist the method after the browser confirms the SetupIntent.
  const PortalConfirmSchema = z.object({
    setupIntentId: z.string().min(1).max(120),
    mandateText: z.string().max(20_000).optional(),
  });
  router.post('/payment-methods/confirm', deps.requireAuth, async (req, res) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = PortalConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    if (!(await requireActiveClientAccess(session))) {
      res.status(403).json({ error: 'client_not_accessible' });
      return;
    }
    let out;
    try {
      out = await confirmClientSetupIntent(
        deps.db,
        session.firmId,
        session.activeClientId,
        parsed.data.setupIntentId,
        { portalIdentityId: session.portalIdentityId, mandateText: parsed.data.mandateText },
      );
    } catch (err) {
      logger.error({ err }, 'portal saved-method confirm failed');
      res.status(502).json({ error: 'stripe_error' });
      return;
    }
    if (!out.ok) {
      res.status(400).json({ error: out.error });
      return;
    }
    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'payment_method',
      entityId: out.paymentMethodId,
      actorPortalIdentityId: session.portalIdentityId,
      after: { clientId: session.activeClientId, kind: 'saved', via: 'portal' },
    }).catch(() => undefined);
    res.status(201).json({ ok: true, paymentMethodId: out.paymentMethodId });
  });

  // Manual ACH — save a bank from routing + account numbers (no bank login).
  const PortalManualAchSchema = z.object({
    routingNumber: z.string().regex(/^\d{9}$/),
    accountNumber: z.string().regex(/^\d{4,17}$/),
    accountHolderType: z.enum(['individual', 'company']),
    accountHolderName: z.string().min(1).max(200),
  });
  router.post('/payment-methods/manual-ach', deps.requireAuth, async (req, res) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = PortalManualAchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    if (!(await requireActiveClientAccess(session))) {
      res.status(403).json({ error: 'client_not_accessible' });
      return;
    }
    let out;
    try {
      out = await createManualAchMethod({
        db: deps.db,
        firmId: session.firmId,
        clientId: session.activeClientId,
        portalIdentityId: session.portalIdentityId,
        routingNumber: parsed.data.routingNumber,
        accountNumber: parsed.data.accountNumber,
        accountHolderType: parsed.data.accountHolderType,
        accountHolderName: parsed.data.accountHolderName,
      });
    } catch (err) {
      logger.error({ err }, 'portal manual-ach create failed');
      res.status(502).json({ error: 'stripe_error' });
      return;
    }
    if (!out.ok) {
      res.status(out.error === 'client_not_found' ? 404 : 400).json({ error: out.error });
      return;
    }
    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'payment_method',
      entityId: out.paymentMethodId,
      actorPortalIdentityId: session.portalIdentityId,
      after: { clientId: session.activeClientId, kind: 'ach_manual', via: 'portal' },
    }).catch(() => undefined);
    res
      .status(201)
      .json({ ok: true, paymentMethodId: out.paymentMethodId, verification: out.verification });
  });

  // Verify micro-deposits for a pending manual ACH bank.
  const PortalVerifySchema = z
    .object({
      amounts: z.array(z.number().int().positive()).length(2).optional(),
      descriptorCode: z.string().min(1).max(40).optional(),
    })
    .refine((v) => Boolean(v.amounts) || Boolean(v.descriptorCode), {
      message: 'amounts_or_descriptor_required',
    });
  router.post('/payment-methods/:id/verify-microdeposits', deps.requireAuth, async (req, res) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = PortalVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    // Ownership: the method must belong to this identity.
    const [owned] = await deps.db
      .select({ id: paymentMethod.id })
      .from(paymentMethod)
      .where(
        and(
          eq(paymentMethod.id, req.params['id']!),
          eq(paymentMethod.portalIdentityId, session.portalIdentityId),
        ),
      )
      .limit(1);
    if (!owned) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    let out;
    try {
      out = await verifyMicrodeposits({
        db: deps.db,
        firmId: session.firmId,
        clientId: session.activeClientId,
        paymentMethodId: req.params['id']!,
        amounts: parsed.data.amounts as [number, number] | undefined,
        descriptorCode: parsed.data.descriptorCode,
      });
    } catch (err) {
      logger.error({ err }, 'portal verify-microdeposits failed');
      res.status(502).json({ error: 'stripe_error' });
      return;
    }
    if (!out.ok) {
      res.status(out.error === 'payment_method_not_found' ? 404 : 400).json({ error: out.error });
      return;
    }
    res.json({ ok: true });
  });

  router.delete('/payment-methods/:id', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ ok: true });
      return;
    }
    const [pm] = await deps.db
      .select({ id: paymentMethod.id, isDefault: paymentMethod.isDefault })
      .from(paymentMethod)
      .where(
        and(
          eq(paymentMethod.id, req.params['id']!),
          eq(paymentMethod.portalIdentityId, session.portalIdentityId),
        ),
      )
      .limit(1);
    if (!pm) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Soft delete by flipping status — the row is still referenced by
    // historical payments via providerToken lookups, so keep the row.
    await deps.db
      .update(paymentMethod)
      .set({ status: 'REVOKED', isDefault: false, updatedAt: new Date() })
      .where(eq(paymentMethod.id, pm.id));
    logger.info({ paymentMethodId: pm.id }, 'portal payment method removed');
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------
  // Statement of account (Phase 19 #18). All invoices for the active
  // client with paid/outstanding totals.
  // ---------------------------------------------------------------
  router.get('/statement', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ invoices: [], totals: null });
      return;
    }
    if (!session.activeClientId) {
      res.status(400).json({ error: 'no_active_client' });
      return;
    }
    // Confirm the identity actually has access to the active client.
    const [access] = await deps.db
      .select({ clientId: clientPortalAccess.clientId })
      .from(clientPortalAccess)
      .where(
        and(
          eq(clientPortalAccess.portalIdentityId, session.portalIdentityId),
          eq(clientPortalAccess.clientId, session.activeClientId),
          eq(clientPortalAccess.status, 'ACTIVE'),
        ),
      )
      .limit(1);
    if (!access) {
      res.status(403).json({ error: 'client_not_accessible' });
      return;
    }
    const rows = await deps.db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        issueDate: invoices.issueDate,
        dueDate: invoices.dueDate,
        totalCents: invoices.totalCents,
        paidCents: invoices.paidCents,
        status: invoices.status,
      })
      .from(invoices)
      // Only finalized invoices are visible to clients — never DRAFT (or
      // VOIDED), which would also wrongly inflate the billed/outstanding
      // totals below. Mirrors the invoice-list and letters filters.
      .where(
        and(
          eq(invoices.clientId, session.activeClientId),
          drz`${invoices.status} IN ('SENT', 'OVERDUE', 'PARTIALLY_PAID', 'PAID')`,
        ),
      )
      .orderBy(invoices.issueDate);
    const totalBilled = rows.reduce((a, r) => a + Number(r.totalCents), 0);
    const totalPaid = rows.reduce((a, r) => a + Number(r.paidCents), 0);
    res.json({
      invoices: rows,
      totals: {
        billedCents: totalBilled,
        paidCents: totalPaid,
        outstandingCents: totalBilled - totalPaid,
      },
    });
  });

  // ---------------------------------------------------------------
  // Auto-pay enrollment (Phase 19 #17). Sets which payment method
  // should be charged automatically when an invoice posts.
  // ---------------------------------------------------------------
  router.post(
    '/payment-methods/:id/set-autopay',
    deps.requireAuth,
    async (req: Request, res: Response) => {
      const session = req.portalSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [pm] = await deps.db
        .select({ id: paymentMethod.id })
        .from(paymentMethod)
        .where(
          and(
            eq(paymentMethod.id, req.params['id']!),
            eq(paymentMethod.portalIdentityId, session.portalIdentityId),
            eq(paymentMethod.status, 'ACTIVE'),
          ),
        )
        .limit(1);
      if (!pm) {
        res.status(404).json({ error: 'payment_method_not_found' });
        return;
      }
      // Mark the chosen one as default. Other default-flagged rows are
      // cleared so only one is the autopay target at a time.
      await deps.db.transaction(async (tx) => {
        await tx
          .update(paymentMethod)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(eq(paymentMethod.portalIdentityId, session.portalIdentityId));
        await tx
          .update(paymentMethod)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(eq(paymentMethod.id, pm.id));
      });

      // Phase 10 #31 — auto-resume plans paused for autopay failures.
      // When the identity adopts a new payment method as autopay, any
      // recurring plans for clients they have ACTIVE access to that
      // were paused for PAYMENT_FAILED reason flip back to ACTIVE with
      // the failure counter reset. The next-run worker picks up where
      // it left off.
      if (session.activeClientId) {
        const { recurringBillingPlans, engagements } = await import('@vibe/db/schema');
        const resumed = await deps.db
          .update(recurringBillingPlans)
          .set({
            status: 'ACTIVE',
            pausedAt: null,
            pausedReason: null,
            consecutiveFailureCount: 0,
          })
          .where(
            and(
              eq(recurringBillingPlans.status, 'PAUSED'),
              eq(recurringBillingPlans.pausedReason, 'PAYMENT_FAILED'),
              drz`${recurringBillingPlans.engagementId} IN (
                SELECT ${engagements.id} FROM ${engagements}
                WHERE ${engagements.clientId} = ${session.activeClientId}
              )`,
            ),
          )
          .returning({ id: recurringBillingPlans.id });
        if (resumed.length > 0) {
          logger.info(
            { count: resumed.length, clientId: session.activeClientId },
            'recurring plans auto-resumed after payment-method update',
          );
        }
      }

      res.json({ ok: true });
    },
  );

  // ---------------------------------------------------------------
  // Recent payments for the active client (Phase 19 #16 — view-only).
  // ---------------------------------------------------------------
  router.get('/payments', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    if (!session.activeClientId) {
      res.status(400).json({ error: 'no_active_client' });
      return;
    }
    const items = await deps.db
      .select({
        id: payments.id,
        amountCents: payments.amountCents,
        refundedAmountCents: payments.refundedAmountCents,
        invoiceId: payments.invoiceId,
        invoiceNumber: invoices.invoiceNumber,
        receivedAt: payments.receivedAt,
        status: payments.status,
      })
      .from(payments)
      .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
      .where(eq(invoices.clientId, session.activeClientId))
      .orderBy(drz`${payments.receivedAt} DESC`)
      .limit(50);
    res.json({ items });
  });

  // ---------------------------------------------------------------
  // Notification preferences for the active client (Phase 16/19).
  // ---------------------------------------------------------------
  router.get('/notification-preferences', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ preferences: null });
      return;
    }
    const [row] = await deps.db
      .select({ prefs: clientPortalAccess.notificationPreferences })
      .from(clientPortalAccess)
      .where(
        and(
          eq(clientPortalAccess.portalIdentityId, session.portalIdentityId),
          eq(clientPortalAccess.clientId, session.activeClientId),
        ),
      )
      .limit(1);
    res.json({ preferences: row?.prefs ?? null });
  });

  router.patch(
    '/notification-preferences',
    deps.requireAuth,
    async (req: Request, res: Response) => {
      const session = req.portalSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const body = req.body as { preferences?: unknown };
      if (!body.preferences || typeof body.preferences !== 'object') {
        res.status(400).json({ error: 'preferences_required' });
        return;
      }
      const channels = (v: unknown): ('EMAIL' | 'SMS')[] =>
        Array.isArray(v) ? v.filter((c): c is 'EMAIL' | 'SMS' => c === 'EMAIL' || c === 'SMS') : [];
      const incoming = body.preferences as Record<string, unknown>;
      const sanitized = {
        newInvoice: channels(incoming['newInvoice']),
        paymentConfirmation: channels(incoming['paymentConfirmation']),
        paymentFailed: channels(incoming['paymentFailed']),
        documentReady: channels(incoming['documentReady']),
        autoPayUpcoming: channels(incoming['autoPayUpcoming']),
        statementMonthly: channels(incoming['statementMonthly']),
        // P4.2 — Connect addendum H.4: pay-to-unlock file release.
        deliverableUnlocked: channels(incoming['deliverableUnlocked']),
      };
      await deps.db
        .update(clientPortalAccess)
        .set({ notificationPreferences: sanitized })
        .where(
          and(
            eq(clientPortalAccess.portalIdentityId, session.portalIdentityId),
            eq(clientPortalAccess.clientId, session.activeClientId),
          ),
        );
      res.json({ ok: true, preferences: sanitized });
    },
  );

  // ---------------------------------------------------------------
  // 0221 — bulk-email preference. The firm's bulk emails target the
  // directory PERSON, so the toggle only exists when this login is
  // linked to one (standalone third-party logins have nothing to set).
  // ---------------------------------------------------------------
  router.get('/bulk-email-preference', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ available: false, optOut: false });
      return;
    }
    const [ident] = await deps.db
      .select({ personId: portalIdentity.personId })
      .from(portalIdentity)
      .where(eq(portalIdentity.id, session.portalIdentityId))
      .limit(1);
    if (!ident?.personId) {
      res.json({ available: false, optOut: false });
      return;
    }
    const [person] = await deps.db
      .select({ optOut: persons.bulkEmailOptOut })
      .from(persons)
      .where(eq(persons.id, ident.personId))
      .limit(1);
    res.json({ available: Boolean(person), optOut: person?.optOut ?? false });
  });

  router.patch('/bulk-email-preference', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ ok: true });
      return;
    }
    const optOut = (req.body as { optOut?: unknown })?.optOut;
    if (typeof optOut !== 'boolean') {
      res.status(400).json({ error: 'opt_out_required' });
      return;
    }
    const [ident] = await deps.db
      .select({ personId: portalIdentity.personId })
      .from(portalIdentity)
      .where(eq(portalIdentity.id, session.portalIdentityId))
      .limit(1);
    if (!ident?.personId) {
      res.status(404).json({ error: 'no_linked_person' });
      return;
    }
    await deps.db
      .update(persons)
      .set({ bulkEmailOptOut: optOut, updatedAt: new Date() })
      .where(eq(persons.id, ident.personId));
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'person',
      entityId: ident.personId,
      actorPortalIdentityId: session.portalIdentityId,
      after: { bulkEmailOptOut: optOut, via: 'portal_preference' },
    }).catch(() => undefined);
    res.json({ ok: true, optOut });
  });

  // ---------------------------------------------------------------
  // Pay-to-unlock signal (Phase 13 #24, 14 #13, 16 #20). Combines two
  // gating rules into one response:
  //   1. Explicit: any invoice with pay_to_unlock_attachments=true that
  //      still has balance. The firm sets this on the invoice when
  //      generating it; clearing it fires the client.unlocked webhook.
  //   2. Heuristic: any invoice ≥30 days past due (default — until the
  //      firm wires explicit gates, this catches chronic non-payers).
  // Response carries { unlocked, blockers, gatingKind: 'EXPLICIT' |
  //   'OVERDUE' } per blocker so the UI can render appropriate copy.
  // ---------------------------------------------------------------
  router.get('/pay-to-unlock', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ unlocked: true, blockers: [] });
      return;
    }
    if (!session.activeClientId) {
      res.status(400).json({ error: 'no_active_client' });
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const rows = await deps.db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        dueDate: invoices.dueDate,
        totalCents: invoices.totalCents,
        paidCents: invoices.paidCents,
        payToUnlockAttachments: invoices.payToUnlockAttachments,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.clientId, session.activeClientId),
          drz`${invoices.status} IN ('SENT', 'OVERDUE', 'PARTIALLY_PAID')`,
        ),
      )
      .limit(200);
    const blockers = rows
      .filter((r) => Number(r.totalCents) - Number(r.paidCents) > 0)
      .filter((r) => r.payToUnlockAttachments || (r.dueDate && r.dueDate <= cutoff))
      .map((r) => ({
        invoiceId: r.id,
        invoiceNumber: r.invoiceNumber,
        dueDate: r.dueDate,
        balanceCents: Number(r.totalCents) - Number(r.paidCents),
        daysOverdue: r.dueDate
          ? Math.max(0, Math.floor((Date.parse(today) - Date.parse(r.dueDate)) / 86_400_000))
          : 0,
        gatingKind: r.payToUnlockAttachments ? ('EXPLICIT' as const) : ('OVERDUE' as const),
      }));
    res.json({ unlocked: blockers.length === 0, blockers });
  });

  // ---------------------------------------------------------------
  // Public branding (no auth — used by the portal shell to render
  // logo + accent color before the login screen). Looks up the firm
  // by host header.
  // ---------------------------------------------------------------
  router.get('/branding', async (_req: Request, res: Response) => {
    if (!deps.db) {
      res.json({ branding: null });
      return;
    }
    const { firmSettings, firms } = await import('@vibe/db/schema');
    // Single-firm appliance — just grab the first row.
    const [first] = await deps.db.select({ id: firms.id }).from(firms).limit(1);
    if (!first) {
      res.json({ branding: null });
      return;
    }
    const [b] = await deps.db
      .select({
        displayName: firmSettings.brandDisplayName,
        logoUrl: firmSettings.brandLogoUrl,
        accentColor: firmSettings.brandAccentColor,
        supportEmail: firmSettings.brandSupportEmail,
        supportPhone: firmSettings.brandSupportPhone,
      })
      .from(firmSettings)
      .where(eq(firmSettings.firmId, first.id))
      .limit(1);
    res.json({ branding: b ?? null });
  });

  // ---------------------------------------------------------------
  // Entity switcher (Phase 19 #21). List clients this identity has
  // ACTIVE portal access to and switch the active one. The active
  // client scopes every other portal endpoint.
  // ---------------------------------------------------------------
  router.get('/clients', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ items: [], activeClientId: session.activeClientId });
      return;
    }
    const { clients } = await import('@vibe/db/schema');
    const rows = await deps.db
      .select({
        id: clients.id,
        name: clients.name,
        role: clientPortalAccess.role,
        accessId: clientPortalAccess.id,
      })
      .from(clientPortalAccess)
      .innerJoin(clients, eq(clients.id, clientPortalAccess.clientId))
      .where(
        and(
          eq(clientPortalAccess.portalIdentityId, session.portalIdentityId),
          eq(clientPortalAccess.status, 'ACTIVE'),
        ),
      );
    res.json({ items: rows, activeClientId: session.activeClientId });
  });

  router.post('/clients/switch', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    const target = typeof req.body?.clientId === 'string' ? req.body.clientId : null;
    if (!target) {
      res.status(400).json({ error: 'clientId_required' });
      return;
    }
    if (!deps.db || !deps.sessionStore) {
      res.json({ ok: true, activeClientId: target });
      return;
    }
    const [access] = await deps.db
      .select({ clientId: clientPortalAccess.clientId })
      .from(clientPortalAccess)
      .where(
        and(
          eq(clientPortalAccess.portalIdentityId, session.portalIdentityId),
          eq(clientPortalAccess.clientId, target),
          eq(clientPortalAccess.status, 'ACTIVE'),
        ),
      )
      .limit(1);
    if (!access) {
      res.status(403).json({ error: 'no_access' });
      return;
    }
    // Mutate the session in place. The session-store put() replaces the
    // Redis blob with the same sid + new activeClientId.
    const updated = { ...session, activeClientId: target };
    await deps.sessionStore.put(updated);
    res.json({ ok: true, activeClientId: target });
  });

  // ---------------------------------------------------------------
  // Alternate-contact OTP flow (Phase 19 #22). Identities can add
  // secondary emails / phones, verify them with a one-time code, and
  // remove them. Primary contact stays where it is on portal_identity.
  // ---------------------------------------------------------------
  const AltAddSchema = z.object({
    channel: z.enum(['EMAIL', 'SMS']),
    value: z.string().min(3).max(254),
  });
  const AltVerifySchema = z.object({ code: z.string().min(4).max(12) });

  router.get('/alt-contacts', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const rows = await deps.db
      .select({
        id: portalAltContact.id,
        channel: portalAltContact.channel,
        value: portalAltContact.value,
        verifiedAt: portalAltContact.verifiedAt,
        createdAt: portalAltContact.createdAt,
      })
      .from(portalAltContact)
      .where(eq(portalAltContact.portalIdentityId, session.portalIdentityId));
    res.json({ items: rows });
  });

  router.post('/alt-contacts', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    const parsed = AltAddSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const hash = createHash('sha256').update(code).digest('hex');
    const expires = new Date(Date.now() + OTP_TTL_MS);

    // Upsert at the (identity, channel, value) grain — re-adding resets
    // the OTP rather than duplicating the row.
    const [existing] = await deps.db
      .select({ id: portalAltContact.id, sentAt: portalAltContact.otpLastSentAt })
      .from(portalAltContact)
      .where(
        and(
          eq(portalAltContact.portalIdentityId, session.portalIdentityId),
          eq(portalAltContact.channel, parsed.data.channel),
          eq(portalAltContact.value, parsed.data.value),
        ),
      )
      .limit(1);

    // Sliding-window rate limit (Q29): one send per minute per row.
    if (existing?.sentAt && Date.now() - existing.sentAt.getTime() < OTP_SEND_RATE_LIMIT_MS) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }

    let rowId: string;
    if (existing) {
      await deps.db
        .update(portalAltContact)
        .set({
          otpHash: hash,
          otpExpiresAt: expires,
          otpAttempts: 0,
          otpLastSentAt: new Date(),
          verifiedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(portalAltContact.id, existing.id));
      rowId = existing.id;
    } else {
      const [inserted] = await deps.db
        .insert(portalAltContact)
        .values({
          portalIdentityId: session.portalIdentityId,
          channel: parsed.data.channel,
          value: parsed.data.value,
          otpHash: hash,
          otpExpiresAt: expires,
          otpLastSentAt: new Date(),
        })
        .returning({ id: portalAltContact.id });
      rowId = inserted!.id;
    }

    // Dispatch the code. Best-effort; the row still exists if delivery
    // fails so the identity can retry. Report dispatch outcome honestly
    // so the UI can show a retry affordance instead of pretending it
    // succeeded.
    let dispatched = false;
    let dispatchSkipped = false;
    try {
      if (parsed.data.channel === 'EMAIL' && deps.sendEmail) {
        const rendered = await renderTemplate({
          db: deps.db,
          firmId: session.firmId,
          kind: 'email_otp',
          channel: 'EMAIL',
          fallback: {
            subject: 'Verify your contact',
            body: `Your Vibe verification code: ${code}`,
          },
          context: { firm: await firmScope(deps.db, session.firmId), auth: { code } },
        });
        await deps.sendEmail({
          to: parsed.data.value,
          subject: rendered.subject ?? 'Verify your contact',
          body: rendered.body,
        });
        dispatched = true;
      } else if (parsed.data.channel === 'SMS' && deps.sendSms) {
        const rendered = await renderTemplate({
          db: deps.db,
          firmId: session.firmId,
          kind: 'sms_otp',
          channel: 'SMS',
          fallback: { body: `Your Vibe verification code: ${code}` },
          context: { firm: await firmScope(deps.db, session.firmId), auth: { code } },
        });
        await deps.sendSms({
          to: parsed.data.value,
          body: rendered.body,
        });
        dispatched = true;
      } else {
        // No provider wired for this channel.
        dispatchSkipped = true;
      }
    } catch (err) {
      logger.error({ err }, 'alt-contact OTP dispatch failed');
    }
    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'portal_alt_contact',
      entityId: rowId,
      actorPortalIdentityId: session.portalIdentityId,
      after: { channel: parsed.data.channel, dispatched, dispatchSkipped },
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.json({ id: rowId, sent: dispatched, dispatchSkipped });
  });

  router.post('/alt-contacts/:id/verify', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    const parsed = AltVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const [row] = await deps.db
      .select()
      .from(portalAltContact)
      .where(
        and(
          eq(portalAltContact.id, req.params['id']!),
          eq(portalAltContact.portalIdentityId, session.portalIdentityId),
        ),
      )
      .limit(1);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (row.verifiedAt) {
      res.json({ verified: true });
      return;
    }
    if (!row.otpHash || !row.otpExpiresAt || row.otpExpiresAt.getTime() < Date.now()) {
      res.status(410).json({ error: 'otp_expired' });
      return;
    }
    if (row.otpAttempts >= OTP_MAX_ATTEMPTS) {
      res.status(429).json({ error: 'too_many_attempts' });
      return;
    }
    const hash = createHash('sha256').update(parsed.data.code).digest('hex');
    if (!constantTimeEquals(hash, row.otpHash)) {
      await deps.db
        .update(portalAltContact)
        .set({ otpAttempts: row.otpAttempts + 1, updatedAt: new Date() })
        .where(eq(portalAltContact.id, row.id));
      res.status(401).json({ error: 'invalid_code' });
      return;
    }
    await deps.db
      .update(portalAltContact)
      .set({
        verifiedAt: new Date(),
        otpHash: null,
        otpExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(portalAltContact.id, row.id));
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'portal_alt_contact',
      entityId: row.id,
      actorPortalIdentityId: session.portalIdentityId,
      after: { channel: row.channel, verified: true },
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.json({ verified: true });
  });

  router.delete('/alt-contacts/:id', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const targetId = req.params['id']!;
    await deps.db
      .delete(portalAltContact)
      .where(
        and(
          eq(portalAltContact.id, targetId),
          eq(portalAltContact.portalIdentityId, session.portalIdentityId),
        ),
      );
    await emitAudit(deps.db, {
      action: 'ARCHIVE',
      entityType: 'portal_alt_contact',
      entityId: targetId,
      actorPortalIdentityId: session.portalIdentityId,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.json({ ok: true });
  });

  // ----- CP5 — active sessions list + revoke ------------------------
  // Sessions live in Redis only (no DB persistence — see CLAUDE.md
  // non-negotiable #2). The reverse index in session-store keys all
  // sids per portalIdentityId so we can enumerate without SCAN.

  router.get('/sessions', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.sessionStore?.listForUser) {
      res.status(503).json({ error: 'sessions_unavailable' });
      return;
    }
    const all = await deps.sessionStore.listForUser('portal', session.portalIdentityId);
    // Privacy: never return the full sid or csrfToken — clients only
    // get a stable hash they can reference for revoke.
    const items = all.map((s) => ({
      id: createHash('sha256').update(s.sid).digest('hex').slice(0, 16),
      sid: s.sid, // server-side echo; the UI strips this from any display
      isCurrent: s.sid === session.sid,
      ip: s.ip,
      userAgent: s.userAgent,
      createdAt: new Date(s.createdAt).toISOString(),
      lastSeenAt: new Date(s.lastSeenAt).toISOString(),
    }));
    res.json({
      // Strip the raw sid from the response — the client only needs
      // the short id for revoke + the metadata for display.
      items: items.map(({ sid, ...rest }) => {
        void sid;
        return rest;
      }),
    });
  });

  router.post('/sessions/revoke-others', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.sessionStore?.destroyOthers) {
      res.status(503).json({ error: 'sessions_unavailable' });
      return;
    }
    const destroyed = await deps.sessionStore.destroyOthers(
      'portal',
      session.portalIdentityId,
      session.sid,
    );
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'portal_session',
      entityId: null,
      actorPortalIdentityId: session.portalIdentityId,
      activeClientId: session.activeClientId,
      after: { action: 'revoke_others', destroyedCount: destroyed },
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.json({ ok: true, destroyed });
  });

  return router;
}
