// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Staff API for a client's saved payment methods (card / ACH bank). The
// browser drives the Stripe Payment Element with the client_secret returned
// by /setup-intent, then posts the setup-intent id back to /confirm so the
// server persists the method. Mounted at /api/staff/payment-methods.

import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import {
  achVerifyLinks,
  clientContacts,
  clients,
  firms,
  paymentMethod,
  persons,
} from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { getBlockedClientIdsCached } from '../clients/access';
import { getBillingContact } from '../clients/billing-contact';
import { emitAudit } from '../auth/audit';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import {
  confirmClientSetupIntent,
  createClientSetupIntent,
  listClientMethods,
} from './saved-methods';
import { createManualAchMethod, verifyMicrodeposits } from './manual-ach';
import { createAchVerifyLink } from './ach-verify-link';

export interface SavedMethodsDeps extends RbacDeps {
  db: Database | null;
  /** Firm mailer — used by the micro-deposit verification reminder. */
  sendStaffMail?: (args: {
    to: string;
    subject: string;
    body: string;
    html?: string;
  }) => Promise<void>;
  /** Firm SMS sender — optional text-message delivery for the reminder. */
  sendSms?: (args: { to: string; body: string }) => Promise<void>;
  /** Portal origin — the public verify page lives on the portal host. */
  portalBaseUrl?: string;
}

async function clientBlocked(
  deps: SavedMethodsDeps,
  req: Request,
  clientId: string,
): Promise<boolean> {
  const s = req.staffSession!;
  const blocked = await getBlockedClientIdsCached(deps, req, s.appUserId, s.firmId);
  return blocked.includes(clientId);
}

export function createSavedMethodsRouter(deps: SavedMethodsDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  // Begin a save flow — returns the SetupIntent client_secret + publishable key.
  // achVerificationMethod lets the caller force manual routing/account entry
  // ('microdeposits') vs instant bank-login ('instant') in the Payment Element.
  const SetupSchema = z.object({
    clientId: z.string().uuid(),
    achVerificationMethod: z.enum(['automatic', 'instant', 'microdeposits']).optional(),
  });
  router.post(
    '/setup-intent',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = SetupSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      if (await clientBlocked(deps, req, parsed.data.clientId)) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const r = await createClientSetupIntent(
        deps.db,
        req.staffSession!.firmId,
        parsed.data.clientId,
        { achVerificationMethod: parsed.data.achVerificationMethod },
      );
      if ('error' in r) {
        res.status(r.error === 'client_not_found' ? 404 : 400).json({ error: r.error });
        return;
      }
      res.json(r);
    },
  );

  // Manual ACH — save a bank from raw routing + account numbers (no bank
  // login). Verified asynchronously via micro-deposits; not chargeable until
  // /:id/verify-microdeposits succeeds.
  const ManualAchSchema = z.object({
    clientId: z.string().uuid(),
    routingNumber: z.string().regex(/^\d{9}$/),
    accountNumber: z.string().regex(/^\d{4,17}$/),
    accountHolderType: z.enum(['individual', 'company']),
    accountHolderName: z.string().min(1).max(200),
  });
  router.post(
    '/manual-ach',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = ManualAchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const s = req.staffSession!;
      if (await clientBlocked(deps, req, parsed.data.clientId)) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      let out;
      try {
        out = await createManualAchMethod({
          db: deps.db,
          firmId: s.firmId,
          clientId: parsed.data.clientId,
          routingNumber: parsed.data.routingNumber,
          accountNumber: parsed.data.accountNumber,
          accountHolderType: parsed.data.accountHolderType,
          accountHolderName: parsed.data.accountHolderName,
        });
      } catch (err) {
        logger.error({ err }, 'manual-ach create failed');
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
        actorAppUserId: s.appUserId,
        after: {
          clientId: parsed.data.clientId,
          kind: 'ach_manual',
          verification: out.verification,
        },
      }).catch(() => undefined);
      res
        .status(201)
        .json({ ok: true, paymentMethodId: out.paymentMethodId, verification: out.verification });
    },
  );

  // Verify the two micro-deposits (or descriptor code) for a pending manual
  // ACH bank — flips it to chargeable.
  const VerifySchema = z
    .object({
      clientId: z.string().uuid(),
      amounts: z.array(z.number().int().positive()).length(2).optional(),
      descriptorCode: z.string().min(1).max(40).optional(),
    })
    .refine((v) => Boolean(v.amounts) || Boolean(v.descriptorCode), {
      message: 'amounts_or_descriptor_required',
    });
  router.post(
    '/:id/verify-microdeposits',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = VerifySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const s = req.staffSession!;
      if (await clientBlocked(deps, req, parsed.data.clientId)) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      let out;
      try {
        out = await verifyMicrodeposits({
          db: deps.db,
          firmId: s.firmId,
          clientId: parsed.data.clientId,
          paymentMethodId: req.params['id']!,
          amounts: parsed.data.amounts as [number, number] | undefined,
          descriptorCode: parsed.data.descriptorCode,
        });
      } catch (err) {
        logger.error({ err }, 'verify-microdeposits failed');
        res.status(502).json({ error: 'stripe_error' });
        return;
      }
      if (!out.ok) {
        res.status(out.error === 'payment_method_not_found' ? 404 : 400).json({ error: out.error });
        return;
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'payment_method',
        entityId: req.params['id']!,
        actorAppUserId: s.appUserId,
        after: { verification: 'verified' },
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // Persist the method after the browser confirms the SetupIntent.
  const ConfirmSchema = z.object({
    clientId: z.string().uuid(),
    setupIntentId: z.string().min(1).max(120),
    mandateText: z.string().max(20_000).optional(),
  });
  router.post(
    '/confirm',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = ConfirmSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const s = req.staffSession!;
      if (await clientBlocked(deps, req, parsed.data.clientId)) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      let out;
      try {
        out = await confirmClientSetupIntent(
          deps.db,
          s.firmId,
          parsed.data.clientId,
          parsed.data.setupIntentId,
          { mandateText: parsed.data.mandateText },
        );
      } catch (err) {
        logger.error({ err }, 'saved-method confirm failed');
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
        actorAppUserId: s.appUserId,
        after: { clientId: parsed.data.clientId, kind: 'saved' },
      }).catch(() => undefined);
      res.status(201).json({ ok: true, paymentMethodId: out.paymentMethodId });
    },
  );

  // 0218 — firm-wide list of manual-ACH banks still awaiting micro-deposit
  // verification (the /payments "Pending ACH" tab).
  router.get(
    '/pending-verification',
    requirePermission(deps, 'payment:read'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const s = req.staffSession!;
      const rows = await deps.db
        .select({
          id: paymentMethod.id,
          clientId: paymentMethod.clientId,
          clientName: clients.name,
          displayLabel: paymentMethod.displayLabel,
          lastFour: paymentMethod.lastFour,
          createdAt: paymentMethod.createdAt,
        })
        .from(paymentMethod)
        .leftJoin(clients, eq(clients.id, paymentMethod.clientId))
        .where(
          and(
            eq(paymentMethod.firmId, s.firmId),
            eq(paymentMethod.status, 'ACTIVE'),
            eq(paymentMethod.verificationStatus, 'PENDING_MICRODEPOSIT'),
          ),
        )
        .orderBy(desc(paymentMethod.createdAt));

      const blocked = await getBlockedClientIdsCached(deps, req, s.appUserId, s.firmId);
      const visible = rows.filter((r) => !r.clientId || !blocked.includes(r.clientId));

      // Latest reminder per method (appliance scale — one small query).
      const links = await deps.db
        .select({
          paymentMethodId: achVerifyLinks.paymentMethodId,
          createdAt: achVerifyLinks.createdAt,
        })
        .from(achVerifyLinks)
        .where(eq(achVerifyLinks.firmId, s.firmId));
      const lastReminder = new Map<string, Date>();
      for (const l of links) {
        const prev = lastReminder.get(l.paymentMethodId);
        if (!prev || l.createdAt > prev) lastReminder.set(l.paymentMethodId, l.createdAt);
      }

      res.json({
        items: visible.map((r) => ({
          ...r,
          lastReminderAt: lastReminder.get(r.id) ?? null,
        })),
      });
    },
  );

  // 0218 — send the client a public (no-login) link to confirm the
  // micro-deposit amounts, by email and/or SMS, to a chosen contact (or the
  // billing/primary contact by default). One token is minted per send and
  // delivered on every requested channel; older links keep working until
  // they expire or the method verifies. Mirrors the invoice pay-link send:
  // a missing destination is a per-channel "skip" unless that channel was
  // the only one requested.
  const ReminderSchema = z.object({
    contactId: z.string().uuid().optional(),
    channel: z.enum(['EMAIL', 'SMS', 'BOTH']).default('EMAIL'),
  });
  router.post(
    '/:id/send-verification-reminder',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      if (!deps.portalBaseUrl) {
        res.status(503).json({ error: 'mail_not_configured' });
        return;
      }
      const parsed = ReminderSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const wantEmail = parsed.data.channel === 'EMAIL' || parsed.data.channel === 'BOTH';
      const wantSms = parsed.data.channel === 'SMS' || parsed.data.channel === 'BOTH';
      const s = req.staffSession!;
      const [pm] = await deps.db
        .select({
          id: paymentMethod.id,
          clientId: paymentMethod.clientId,
          displayLabel: paymentMethod.displayLabel,
          verificationStatus: paymentMethod.verificationStatus,
          status: paymentMethod.status,
        })
        .from(paymentMethod)
        .where(and(eq(paymentMethod.id, req.params['id']!), eq(paymentMethod.firmId, s.firmId)))
        .limit(1);
      if (!pm || !pm.clientId) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (pm.status !== 'ACTIVE' || pm.verificationStatus !== 'PENDING_MICRODEPOSIT') {
        res.status(409).json({ error: 'not_pending_verification' });
        return;
      }
      if (await clientBlocked(deps, req, pm.clientId)) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }

      // Destination: an explicitly chosen contact (must belong to this
      // client and be active), else the billing/primary contact.
      let dest: {
        fullName: string;
        email: string | null;
        phone: string | null;
        smsPhone: string | null;
      } | null = null;
      if (parsed.data.contactId) {
        const [c] = await deps.db
          .select({
            fullName: persons.fullName,
            email: persons.email,
            phone: persons.phone,
            mobile: persons.mobile,
            smsOptOut: persons.smsOptOut,
            status: clientContacts.status,
          })
          .from(clientContacts)
          .innerJoin(persons, eq(persons.id, clientContacts.personId))
          .where(
            and(
              eq(clientContacts.id, parsed.data.contactId),
              eq(clientContacts.clientId, pm.clientId),
            ),
          )
          .limit(1);
        if (!c || c.status !== 'ACTIVE') {
          res.status(404).json({ error: 'contact_not_found' });
          return;
        }
        // SMS prefers the mobile number when the person has both; 0224 — an
        // SMS opt-out leaves no text destination.
        dest = {
          fullName: c.fullName,
          email: c.email,
          phone: c.mobile || c.phone,
          smsPhone: c.smsOptOut ? null : c.mobile || c.phone,
        };
      } else {
        dest = await getBillingContact(deps.db, pm.clientId);
      }

      // Hard error only when the SOLE requested channel is undeliverable.
      if (parsed.data.channel === 'EMAIL' && (!deps.sendStaffMail || !dest?.email)) {
        res.status(400).json({ error: 'no_email_destination' });
        return;
      }
      if (parsed.data.channel === 'SMS' && (!deps.sendSms || !dest?.smsPhone)) {
        res.status(400).json({ error: 'no_sms_destination' });
        return;
      }
      const emailDeliverable = wantEmail && !!deps.sendStaffMail && !!dest?.email;
      const smsDeliverable = wantSms && !!deps.sendSms && !!dest?.smsPhone;
      if (!emailDeliverable && !smsDeliverable) {
        res.status(400).json({ error: 'no_destination' });
        return;
      }

      const [firm] = await deps.db
        .select({ name: firms.name })
        .from(firms)
        .where(eq(firms.id, s.firmId))
        .limit(1);
      const firmName = firm?.name ?? 'your accounting firm';

      const link = await createAchVerifyLink(deps.db, {
        firmId: s.firmId,
        paymentMethodId: pm.id,
        createdByAppUserId: s.appUserId,
      });
      const url = `${deps.portalBaseUrl.replace(/\/$/, '')}/verify-bank/${link.token}`;
      const expires = link.expiresAt.toISOString().slice(0, 10);

      const results: { email: string; sms: string } = { email: 'skipped', sms: 'skipped' };

      if (emailDeliverable) {
        try {
          await deps.sendStaffMail!({
            to: dest!.email!,
            subject: `Action needed — confirm your bank account with ${firmName}`,
            body: [
              `Hi ${dest!.fullName},`,
              '',
              `${firmName} saved your bank account (${pm.displayLabel}) for ACH payments.`,
              'To activate it, please confirm the small "micro-deposits" our payment',
              'processor sent to that account. They appear on your bank statement within',
              '1-2 business days as either two deposits under $1.00, or one deposit with',
              'a 6-digit code starting with SM in its description.',
              '',
              'Confirm them here (no login needed):',
              url,
              '',
              `This link expires on ${expires}. If the deposits haven't appeared yet,`,
              'check again tomorrow.',
              '',
              `If you did not authorize this, please contact ${firmName}.`,
            ].join('\n'),
          });
          results.email = 'sent';
        } catch (err) {
          logger.error({ err }, 'ach verification reminder email failed');
          results.email = 'failed';
        }
      } else if (wantEmail) {
        results.email = 'no_destination';
      }

      if (smsDeliverable) {
        try {
          await deps.sendSms!({
            to: dest!.smsPhone!,
            body:
              `${firmName}: please confirm the small test deposit(s) sent to your bank ` +
              `${pm.displayLabel} so we can process your ACH payment. No login needed: ${url}`,
          });
          results.sms = 'sent';
        } catch (err) {
          logger.error({ err }, 'ach verification reminder sms failed');
          results.sms = 'failed';
        }
      } else if (wantSms) {
        results.sms = 'no_destination';
      }

      if (results.email !== 'sent' && results.sms !== 'sent') {
        res.status(502).json({ error: 'send_failed', results });
        return;
      }

      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'payment_method',
        entityId: pm.id,
        actorAppUserId: s.appUserId,
        after: {
          kind: 'ach_verification_reminder_sent',
          linkId: link.id,
          channel: parsed.data.channel,
          results,
        },
      }).catch(() => undefined);
      res.json({
        ok: true,
        results,
        sentToEmail: results.email === 'sent' ? dest!.email : null,
        sentToPhone: results.sms === 'sent' ? dest!.smsPhone : null,
        expiresAt: link.expiresAt,
      });
    },
  );

  // List a client's active saved methods.
  router.get('/', requirePermission(deps, 'payment:read'), async (req: Request, res: Response) => {
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const clientId = typeof req.query['clientId'] === 'string' ? req.query['clientId'] : '';
    if (!/^[0-9a-f-]{36}$/i.test(clientId)) {
      res.status(400).json({ error: 'invalid_client_id' });
      return;
    }
    if (await clientBlocked(deps, req, clientId)) {
      res.json({ items: [] });
      return;
    }
    const items = await listClientMethods(deps.db, req.staffSession!.firmId, clientId);
    res.json({ items });
  });

  // Revoke (soft) a saved method.
  router.delete(
    '/:id',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const firmId = req.staffSession!.firmId;
      const [row] = await deps.db
        .update(paymentMethod)
        .set({ status: 'REVOKED', updatedAt: new Date() })
        .where(and(eq(paymentMethod.id, req.params['id']!), eq(paymentMethod.firmId, firmId)))
        .returning({ id: paymentMethod.id });
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'payment_method',
        entityId: row.id,
        actorAppUserId: req.staffSession!.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  return router;
}
