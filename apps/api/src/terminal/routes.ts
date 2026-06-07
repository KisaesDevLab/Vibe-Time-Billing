// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Phases 15–17 — staff Terminal endpoints (server-driven). Provision a
// Location + Reader on the firm's connected account, then collect in person:
// create a card_present PaymentIntent (manual capture, no app fee), push it to
// the reader, and capture/cancel. Reader results arrive via webhooks.

import express, { type Router } from 'express';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import {
  firmSettingsProposals,
  invoices,
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
const CollectSchema = z.object({
  readerId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  customerId: z.string().optional(),
  saveCard: z.boolean().optional(),
});
const PiSchema = z.object({ paymentIntentId: z.string().min(1).max(120) });

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
