// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R4-followup — delayed retainer offer reminder. Triggered by jobs the
// API enqueued at offer creation time (R2). Each job fires at the kind's
// scheduled offset (on-bill ~5 min, day-30, day-55) and sends a single
// reminder email to the client's billing contact.
//
// Defensive lookups: the offer may have been purchased, declined, or
// expired between enqueue and run. In those cases the handler silently
// skips. Same shape as `runDunningSweep` so the worker's mail dispatch
// can short-circuit when no provider is configured.

import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { clientContacts, clients, firmRetainerSettings, retainerOffers } from '@vibe/db/schema';

import type { MailDispatch } from '../dispatchers';

export interface OfferReminderJobPayload {
  offerId: string;
  kind: 'onbill' | 'day30' | 'day55';
}

export interface OfferReminderResult {
  sent: boolean;
  skipped?:
    | 'offer_missing'
    | 'offer_terminal'
    | 'feature_disabled'
    | 'no_contact'
    | 'no_mail_provider';
}

export async function runRetainerOfferReminder(
  db: Database,
  log: Logger,
  args: { sendEmail?: MailDispatch | undefined; portalBaseUrl?: string | undefined },
  payload: OfferReminderJobPayload,
): Promise<OfferReminderResult> {
  const [offer] = await db
    .select({
      id: retainerOffers.id,
      firmId: retainerOffers.firmId,
      clientId: retainerOffers.clientId,
      status: retainerOffers.status,
      returnType: retainerOffers.returnType,
      taxYear: retainerOffers.taxYear,
      tier1PriceCents: retainerOffers.tier1PriceCents,
      tier2PriceCents: retainerOffers.tier2PriceCents,
      offerExpiresAt: retainerOffers.offerExpiresAt,
    })
    .from(retainerOffers)
    .where(eq(retainerOffers.id, payload.offerId))
    .limit(1);
  if (!offer) {
    log.info({ offerId: payload.offerId, kind: payload.kind }, 'reminder: offer missing — skip');
    return { sent: false, skipped: 'offer_missing' };
  }
  if (offer.status !== 'pending' && offer.status !== 'pending_payment') {
    log.info(
      { offerId: payload.offerId, kind: payload.kind, status: offer.status },
      'reminder: offer in terminal state — skip',
    );
    return { sent: false, skipped: 'offer_terminal' };
  }
  const [settings] = await db
    .select({ featureEnabled: firmRetainerSettings.featureEnabled })
    .from(firmRetainerSettings)
    .where(eq(firmRetainerSettings.firmId, offer.firmId))
    .limit(1);
  if (!settings?.featureEnabled) {
    return { sent: false, skipped: 'feature_disabled' };
  }
  // Billing contact resolution mirrors apps/api/src/clients/billing-contact.ts
  // (isBilling first, isPrimary fallback) — inlined here so the worker
  // doesn't need to reach across into the API tree.
  const contactEmail = await resolveBillingEmail(db, offer.clientId);
  if (!contactEmail) {
    log.info({ offerId: payload.offerId }, 'reminder: no billing contact — skip');
    return { sent: false, skipped: 'no_contact' };
  }
  if (!args.sendEmail) {
    return { sent: false, skipped: 'no_mail_provider' };
  }
  const [client] = await db
    .select({ name: clients.name })
    .from(clients)
    .where(eq(clients.id, offer.clientId))
    .limit(1);
  const base = args.portalBaseUrl ?? process.env['PORTAL_BASE_URL'] ?? 'https://portal.firm.com';
  const link = `${base.replace(/\/$/, '')}/portal/retainer-offers/${offer.id}`;
  const subject = renderSubject(payload.kind, offer.returnType, offer.taxYear);
  const body = renderBody({
    kind: payload.kind,
    clientName: client?.name ?? 'Client',
    returnType: offer.returnType,
    taxYear: offer.taxYear,
    tier1PriceCents: Number(offer.tier1PriceCents),
    tier2PriceCents: Number(offer.tier2PriceCents),
    offerExpiresAt:
      offer.offerExpiresAt instanceof Date
        ? offer.offerExpiresAt.toISOString().slice(0, 10)
        : String(offer.offerExpiresAt).slice(0, 10),
    link,
  });
  await args.sendEmail({ to: contactEmail, subject, body });
  log.info({ offerId: payload.offerId, kind: payload.kind, to: contactEmail }, 'reminder: sent');
  return { sent: true };
}

async function resolveBillingEmail(db: Database, clientId: string): Promise<string | null> {
  const billing = await db
    .select({ email: clientContacts.email })
    .from(clientContacts)
    .where(and(eq(clientContacts.clientId, clientId), eq(clientContacts.isBilling, true)))
    .limit(1);
  if (billing[0]?.email) return billing[0].email;
  const primary = await db
    .select({ email: clientContacts.email })
    .from(clientContacts)
    .where(and(eq(clientContacts.clientId, clientId), eq(clientContacts.isPrimary, true)))
    .limit(1);
  return primary[0]?.email ?? null;
}

function renderSubject(
  kind: OfferReminderJobPayload['kind'],
  returnType: string,
  taxYear: number,
): string {
  if (kind === 'day55') {
    return `Final reminder — your TY${taxYear} ${returnType} retainer offer expires soon`;
  }
  if (kind === 'day30') {
    return `Halfway there — your TY${taxYear} ${returnType} retainer is still available`;
  }
  return `Protect your TY${taxYear} ${returnType} return with a retainer`;
}

function renderBody(args: {
  kind: OfferReminderJobPayload['kind'];
  clientName: string;
  returnType: string;
  taxYear: number;
  tier1PriceCents: number;
  tier2PriceCents: number;
  offerExpiresAt: string;
  link: string;
}): string {
  const dollars = (c: number): string => `$${(c / 100).toFixed(2)}`;
  const intro =
    args.kind === 'day55'
      ? `Your retainer offer for the TY${args.taxYear} ${args.returnType} return expires on ${args.offerExpiresAt}. This is the last reminder before the offer closes.`
      : `We are following up on the retainer offer for your TY${args.taxYear} ${args.returnType} return.`;
  const lines = [
    `Hello ${args.clientName},`,
    '',
    intro,
    '',
    'Two coverage tiers are available:',
    `  • Standard Coverage: ${dollars(args.tier1PriceCents)}`,
    `  • Premium Coverage:  ${dollars(args.tier2PriceCents)}`,
    '',
    'A retainer covers post-filing questions, amendments, and audit support for three years — without per-call billing surprises.',
    '',
    `Review and accept here: ${args.link}`,
    '',
    'No action is required if you prefer to pay for support as needed.',
  ];
  return lines.join('\n');
}
