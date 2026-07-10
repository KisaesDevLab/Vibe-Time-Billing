// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Phases 15–17 — staff Terminal endpoints (server-driven). Provision a
// Location + Reader on the firm's connected account, then collect in person:
// create a card_present PaymentIntent (manual capture, no app fee), push it to
// the reader, and capture/cancel. Reader results arrive via webhooks.

import express, { type Router } from 'express';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import {
  clients,
  firmSettingsProposals,
  invoices,
  paymentReceipts,
  payments,
  terminalLocations,
  terminalReaders,
} from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import {
  cancelPaymentIntent,
  cancelReaderAction,
  capturePaymentIntent,
  createCardPresentIntent,
  createTerminalLocation,
  processPaymentIntent,
  registerTerminalReader,
} from '../stripe-connect/terminal';

export interface TerminalRoutesDeps extends RbacDeps {
  db: Database | null;
  secretKey: string | null;
}

const LocationSchema = z.object({
  displayName: z.string().min(1).max(200),
  line1: z.string().min(1).max(200),
  city: z.string().min(1).max(120),
  state: z.string().min(1).max(40),
  postalCode: z.string().min(1).max(20),
  country: z.string().length(2).optional(),
  cellularEnabled: z.boolean().optional(),
});
const ReaderSchema = z.object({
  registrationCode: z.string().min(1).max(120),
  locationId: z.string().uuid(),
  label: z.string().min(1).max(120),
});
// Stripe rejects charges above $999,999.99; cap here too so a bogus
// amount can't overflow JS number precision in downstream math.
const MAX_AMOUNT_CENTS = 99_999_999;
const CollectSchema = z.object({
  readerId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  amountCents: z.number().int().positive().max(MAX_AMOUNT_CENTS),
  customerId: z.string().optional(),
  saveCard: z.boolean().optional(),
});
const PiSchema = z.object({ paymentIntentId: z.string().min(1).max(120) });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CollectReceiptSchema = z.object({
  readerId: z.string().uuid(),
  payerClientId: z.string().uuid(),
  paymentDate: z.string().regex(DATE_RE),
  reference: z.string().max(200).nullable().optional(),
  allocations: z
    .array(
      z.object({
        invoiceId: z.string().uuid(),
        amountCents: z.number().int().positive().max(MAX_AMOUNT_CENTS),
      }),
    )
    .min(1)
    .max(100),
});

export function createTerminalRouter(deps: TerminalRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  async function conn(
    firmId: string,
  ): Promise<{ secretKey: string; stripeAccountId: string } | null> {
    if (!deps.db || !deps.secretKey) return null;
    const [row] = await deps.db
      .select({ acct: firmSettingsProposals.stripeAccountId })
      .from(firmSettingsProposals)
      .where(eq(firmSettingsProposals.firmId, firmId))
      .limit(1);
    if (!row?.acct) return null;
    return { secretKey: deps.secretKey, stripeAccountId: row.acct };
  }

  // ----- provisioning -------------------------------------------------

  router.post('/locations', requirePermission(deps, 'payment:write'), async (req, res) => {
    const session = req.staffSession!;
    const parsed = LocationSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'invalid_payload' });
    const c = await conn(session.firmId);
    if (!c) return void res.status(409).json({ error: 'stripe_not_connected' });
    const loc = await createTerminalLocation(c, parsed.data);
    const [row] = await deps
      .db!.insert(terminalLocations)
      .values({
        firmId: session.firmId,
        stripeLocationId: loc.id,
        displayName: parsed.data.displayName,
        addressLine1: parsed.data.line1,
        addressCity: parsed.data.city,
        addressState: parsed.data.state,
        addressPostal: parsed.data.postalCode,
        addressCountry: parsed.data.country ?? 'US',
        cellularEnabled: parsed.data.cellularEnabled ?? false,
      })
      .returning({ id: terminalLocations.id });
    res.status(201).json({ id: row!.id, stripeLocationId: loc.id });
  });

  router.post('/readers', requirePermission(deps, 'payment:write'), async (req, res) => {
    const session = req.staffSession!;
    const parsed = ReaderSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'invalid_payload' });
    const c = await conn(session.firmId);
    if (!c) return void res.status(409).json({ error: 'stripe_not_connected' });
    const [loc] = await deps
      .db!.select({ stripeId: terminalLocations.stripeLocationId })
      .from(terminalLocations)
      .where(
        and(
          eq(terminalLocations.id, parsed.data.locationId),
          eq(terminalLocations.firmId, session.firmId),
        ),
      )
      .limit(1);
    if (!loc) return void res.status(404).json({ error: 'location_not_found' });
    const reader = await registerTerminalReader(c, {
      registrationCode: parsed.data.registrationCode,
      locationId: loc.stripeId,
      label: parsed.data.label,
    });
    const [row] = await deps
      .db!.insert(terminalReaders)
      .values({
        firmId: session.firmId,
        locationId: parsed.data.locationId,
        stripeReaderId: reader.id,
        label: parsed.data.label,
        deviceType: reader.deviceType,
        serialNumber: reader.serialNumber,
        status: reader.status,
        lastSeenAt: new Date(),
      })
      .returning({ id: terminalReaders.id });
    res.status(201).json({ id: row!.id, stripeReaderId: reader.id, deviceType: reader.deviceType });
  });

  router.get('/readers', requirePermission(deps, 'payment:read'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) return void res.json({ readers: [], locations: [] });
    const [readers, locations] = await Promise.all([
      deps.db
        .select()
        .from(terminalReaders)
        .where(eq(terminalReaders.firmId, session.firmId))
        .orderBy(asc(terminalReaders.label)),
      deps.db
        .select()
        .from(terminalLocations)
        .where(eq(terminalLocations.firmId, session.firmId))
        .orderBy(asc(terminalLocations.displayName)),
    ]);
    res.json({ readers, locations });
  });

  // 0186 — bind a reader to a printer + per-reader auto-print toggle.
  const ReaderPrintConfigSchema = z.object({
    printerId: z.number().int().positive().nullable(),
    autoPrintReceipt: z.boolean(),
  });
  router.patch(
    '/readers/:id/print-config',
    requirePermission(deps, 'payment:write'),
    async (req, res) => {
      const session = req.staffSession!;
      if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
      const parsed = ReaderPrintConfigSchema.safeParse(req.body);
      if (!parsed.success) return void res.status(400).json({ error: 'invalid_payload' });
      await deps.db
        .update(terminalReaders)
        .set({ printerId: parsed.data.printerId, autoPrintReceipt: parsed.data.autoPrintReceipt })
        .where(
          and(
            eq(terminalReaders.id, req.params['id']!),
            eq(terminalReaders.firmId, session.firmId),
          ),
        );
      res.json({ ok: true });
    },
  );

  // ----- collection (in person) --------------------------------------

  router.post('/collect', requirePermission(deps, 'payment:write'), async (req, res) => {
    const session = req.staffSession!;
    const parsed = CollectSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'invalid_payload' });
    const c = await conn(session.firmId);
    if (!c) return void res.status(409).json({ error: 'stripe_not_connected' });

    const [reader] = await deps
      .db!.select({ stripeReaderId: terminalReaders.stripeReaderId })
      .from(terminalReaders)
      .where(
        and(
          eq(terminalReaders.id, parsed.data.readerId),
          eq(terminalReaders.firmId, session.firmId),
        ),
      )
      .limit(1);
    if (!reader) return void res.status(404).json({ error: 'reader_not_found' });
    const [inv] = await deps
      .db!.select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.id, parsed.data.invoiceId), eq(invoices.firmId, session.firmId)))
      .limit(1);
    if (!inv) return void res.status(404).json({ error: 'invoice_not_found' });

    const pi = await createCardPresentIntent(c, {
      amountCents: parsed.data.amountCents,
      customerId: parsed.data.customerId,
      saveForFutureUse: parsed.data.saveCard,
      metadata: { invoice_id: parsed.data.invoiceId, firm_id: session.firmId },
      idempotencyKey: `cp-${parsed.data.invoiceId}-${parsed.data.amountCents}`,
    });
    // Track as a PENDING payment; the webhook (payment_intent.succeeded after
    // capture) marks it succeeded + advances the invoice.
    await deps.db!.insert(payments).values({
      invoiceId: parsed.data.invoiceId,
      amountCents: parsed.data.amountCents,
      feeCents: 0,
      provider: 'STRIPE',
      channel: 'TERMINAL',
      providerChargeId: pi.id,
      status: 'PENDING',
      receivedAt: new Date(),
    });
    let actionStatus = 'in_progress';
    try {
      const r = await processPaymentIntent(c, {
        readerId: reader.stripeReaderId,
        paymentIntentId: pi.id,
      });
      actionStatus = r.actionStatus;
    } catch (err) {
      logger.error({ err, pi: pi.id }, 'terminal process_payment_intent failed');
      return void res.status(502).json({ error: 'reader_process_failed', paymentIntentId: pi.id });
    }
    await emitAudit(deps.db!, {
      action: 'PAYMENT',
      entityType: 'invoice',
      entityId: parsed.data.invoiceId,
      actorAppUserId: session.appUserId,
      after: { channel: 'terminal', paymentIntentId: pi.id, amountCents: parsed.data.amountCents },
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    // 200 = acknowledgement only; the UI confirms via reader webhooks.
    res.json({ paymentIntentId: pi.id, actionStatus });
  });

  // Collect a multi-invoice payment in person, producing the SAME grouped
  // payment_receipt the manual/card flows create (so print/email receipt
  // work). Auto-capture on tap; the existing payment_intent.succeeded
  // webhook materializes the receipt. The UI polls /payments/receive/:id.
  router.post('/collect-receipt', requirePermission(deps, 'payment:write'), async (req, res) => {
    const session = req.staffSession!;
    const parsed = CollectReceiptSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'invalid_payload' });
    const c = await conn(session.firmId);
    if (!c) return void res.status(409).json({ error: 'stripe_not_connected' });
    const db = deps.db!;

    const [reader] = await db
      .select({ stripeReaderId: terminalReaders.stripeReaderId })
      .from(terminalReaders)
      .where(
        and(
          eq(terminalReaders.id, parsed.data.readerId),
          eq(terminalReaders.firmId, session.firmId),
        ),
      )
      .limit(1);
    if (!reader) return void res.status(404).json({ error: 'reader_not_found' });

    const [payer] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.id, parsed.data.payerClientId), eq(clients.firmId, session.firmId)))
      .limit(1);
    if (!payer) return void res.status(404).json({ error: 'client_not_found' });

    // Every targeted invoice must belong to the firm.
    const invoiceIds = [...new Set(parsed.data.allocations.map((a) => a.invoiceId))];
    const found = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(inArray(invoices.id, invoiceIds), eq(invoices.firmId, session.firmId)));
    if (found.length !== invoiceIds.length) {
      return void res.status(404).json({ error: 'invoice_not_found' });
    }
    const totalCents = parsed.data.allocations.reduce((s, a) => s + a.amountCents, 0);
    if (totalCents > MAX_AMOUNT_CENTS) {
      return void res.status(400).json({ error: 'amount_too_large' });
    }

    // PENDING receipt holding the allocations; materialized by the webhook.
    const [receipt] = await db
      .insert(paymentReceipts)
      .values({
        firmId: session.firmId,
        payerClientId: parsed.data.payerClientId,
        paymentDate: parsed.data.paymentDate,
        reference: parsed.data.reference ?? null,
        paymentMethod: 'CARD_PRESENT',
        mode: 'CHARGE',
        totalCents,
        provider: 'STRIPE',
        status: 'PENDING',
        allocationsPending: parsed.data.allocations,
        createdById: session.appUserId,
        // 0186 — record the reader so the completion webhook can auto-print
        // the receipt to this terminal's configured printer.
        terminalReaderId: parsed.data.readerId,
      })
      .returning({ id: paymentReceipts.id });
    if (!receipt) return void res.status(500).json({ error: 'receipt_insert_failed' });

    const pi = await createCardPresentIntent(c, {
      amountCents: totalCents,
      captureMethod: 'automatic',
      metadata: { receipt_id: receipt.id, firm_id: session.firmId },
      idempotencyKey: `cpr-${receipt.id}`,
    });
    await db
      .update(paymentReceipts)
      .set({ providerChargeId: pi.id, updatedAt: new Date() })
      .where(eq(paymentReceipts.id, receipt.id));

    let actionStatus = 'in_progress';
    try {
      const r = await processPaymentIntent(c, {
        readerId: reader.stripeReaderId,
        paymentIntentId: pi.id,
      });
      actionStatus = r.actionStatus;
    } catch (err) {
      logger.error({ err, pi: pi.id }, 'terminal collect-receipt process failed');
      // Abandon the receipt so it isn't left dangling.
      await db
        .update(paymentReceipts)
        .set({ status: 'VOIDED', updatedAt: new Date() })
        .where(eq(paymentReceipts.id, receipt.id))
        .catch(() => undefined);
      return void res.status(502).json({ error: 'reader_process_failed', paymentIntentId: pi.id });
    }
    await emitAudit(db, {
      action: 'PAYMENT',
      entityType: 'payment_receipt',
      entityId: receipt.id,
      actorAppUserId: session.appUserId,
      after: { channel: 'terminal', paymentIntentId: pi.id, totalCents },
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.json({ receiptId: receipt.id, paymentIntentId: pi.id, actionStatus });
  });

  router.post('/capture', requirePermission(deps, 'payment:write'), async (req, res) => {
    const session = req.staffSession!;
    const parsed = PiSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'invalid_payload' });
    const c = await conn(session.firmId);
    if (!c) return void res.status(409).json({ error: 'stripe_not_connected' });
    const r = await capturePaymentIntent(c, { paymentIntentId: parsed.data.paymentIntentId });
    res.json(r);
  });

  router.post('/cancel', requirePermission(deps, 'payment:write'), async (req, res) => {
    const session = req.staffSession!;
    const parsed = PiSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'invalid_payload' });
    const c = await conn(session.firmId);
    if (!c) return void res.status(409).json({ error: 'stripe_not_connected' });
    const r = await cancelPaymentIntent(c, { paymentIntentId: parsed.data.paymentIntentId });
    res.json(r);
  });

  // Reset a stuck reader so it can take a new payment.
  router.post(
    '/readers/:id/cancel-action',
    requirePermission(deps, 'payment:write'),
    async (req, res) => {
      const session = req.staffSession!;
      const c = await conn(session.firmId);
      if (!c) return void res.status(409).json({ error: 'stripe_not_connected' });
      const [reader] = await deps
        .db!.select({ stripeReaderId: terminalReaders.stripeReaderId })
        .from(terminalReaders)
        .where(
          and(
            eq(terminalReaders.id, req.params['id']!),
            eq(terminalReaders.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!reader) return void res.status(404).json({ error: 'reader_not_found' });
      const r = await cancelReaderAction(c, { readerId: reader.stripeReaderId });
      res.json(r);
    },
  );

  return router;
}
