// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Portal identity profile + payment-method endpoints (Phase 16).
// Operations on the session's identity — read profile, update preferences,
// list payment methods, soft-delete a payment method.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  clientPortalAccess,
  invoices,
  paymentMethod,
  payments,
  portalIdentity,
} from '@vibe/db/schema';
import { sql as drz } from 'drizzle-orm';
import type { AnySession } from '@vibe/core/auth';

import { logger } from '../logger';

export interface PortalProfileDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
  sessionStore?: {
    put: (session: AnySession) => Promise<void>;
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
      .where(eq(invoices.clientId, session.activeClientId))
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
  // Pay-to-unlock signal (Phase 19 #20). Returns the list of overdue
  // invoices the client must clear before document/portal features are
  // re-enabled. The "unlock" itself is a gate the firm enables by
  // marking specific invoices as gating in admin (future field).
  // Until then the rule is: any invoice ≥30 days past due is "gating".
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
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.clientId, session.activeClientId),
          drz`${invoices.status} IN ('SENT', 'OVERDUE', 'PARTIALLY_PAID')`,
          drz`${invoices.dueDate} <= ${cutoff}::date`,
        ),
      )
      .limit(50);
    const blockers = rows
      .filter((r) => Number(r.totalCents) - Number(r.paidCents) > 0)
      .map((r) => ({
        invoiceId: r.id,
        invoiceNumber: r.invoiceNumber,
        dueDate: r.dueDate,
        balanceCents: Number(r.totalCents) - Number(r.paidCents),
        daysOverdue: r.dueDate
          ? Math.floor((Date.parse(today) - Date.parse(r.dueDate)) / 86_400_000)
          : 0,
      }));
    res.json({ unlocked: blockers.length === 0, blockers });
  });

  // ---------------------------------------------------------------
  // Public branding (no auth — used by the portal shell to render
  // logo + accent color before the login screen). Looks up the firm
  // by host header / commercial license token at boot.
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
    const { portalAltContact } = await import('@vibe/db/schema');
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
    const { portalAltContact } = await import('@vibe/db/schema');
    const { createHash, randomInt } = await import('node:crypto');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const hash = createHash('sha256').update(code).digest('hex');
    const expires = new Date(Date.now() + 10 * 60_000);

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
    if (existing?.sentAt && Date.now() - existing.sentAt.getTime() < 60_000) {
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
    // fails so the identity can retry.
    try {
      if (parsed.data.channel === 'EMAIL' && deps.sendEmail) {
        await deps.sendEmail({
          to: parsed.data.value,
          subject: 'Verify your contact',
          body: `Your Vibe verification code: ${code}`,
        });
      } else if (parsed.data.channel === 'SMS' && deps.sendSms) {
        await deps.sendSms({
          to: parsed.data.value,
          body: `Your Vibe verification code: ${code}`,
        });
      }
    } catch (err) {
      logger.error({ err }, 'alt-contact OTP dispatch failed');
    }
    res.json({ id: rowId, sent: true });
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
    const { portalAltContact } = await import('@vibe/db/schema');
    const { createHash } = await import('node:crypto');
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
    if (row.otpAttempts >= 5) {
      res.status(429).json({ error: 'too_many_attempts' });
      return;
    }
    const hash = createHash('sha256').update(parsed.data.code).digest('hex');
    if (hash !== row.otpHash) {
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
    res.json({ verified: true });
  });

  router.delete('/alt-contacts/:id', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const { portalAltContact } = await import('@vibe/db/schema');
    await deps.db
      .delete(portalAltContact)
      .where(
        and(
          eq(portalAltContact.id, req.params['id']!),
          eq(portalAltContact.portalIdentityId, session.portalIdentityId),
        ),
      );
    res.json({ ok: true });
  });

  return router;
}
