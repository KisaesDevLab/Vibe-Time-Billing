// SPDX-License-Identifier: Elastic-2.0
//
// Phases 15–17 — Stripe Terminal (server-driven, no client SDK, no connection
// token). All objects live on the firm's connected account via Stripe-Account.
//
//   - createTerminalLocation / registerTerminalReader — provisioning
//   - createCardPresentIntent — a card_present PaymentIntent, manual capture
//     (firm reviews before capture). NO application_fee (firm owns the account).
//   - processPaymentIntent — push the PI to the reader; HTTP 200 is an
//     acknowledgement only — the real result arrives via terminal.reader.*
//     webhooks. Never poll-block.
//   - capturePaymentIntent / cancelPaymentIntent — settle or abandon.
//   - cancelReaderAction — reset a stuck reader.

import { stripePostForm } from './raw';

interface Conn {
  secretKey: string;
  stripeAccountId: string;
  fetchImpl?: typeof fetch;
}

export async function createTerminalLocation(
  conn: Conn,
  input: {
    displayName: string;
    line1: string;
    city: string;
    state: string;
    postalCode: string;
    country?: string;
  },
): Promise<{ id: string }> {
  const json = await stripePostForm({
    ...conn,
    path: '/terminal/locations',
    params: {
      display_name: input.displayName,
      'address[line1]': input.line1,
      'address[city]': input.city,
      'address[state]': input.state,
      'address[postal_code]': input.postalCode,
      'address[country]': input.country ?? 'US',
    },
  });
  return { id: String(json['id']) };
}

export async function registerTerminalReader(
  conn: Conn,
  input: { registrationCode: string; locationId: string; label?: string },
): Promise<{ id: string; deviceType: string | null; serialNumber: string | null; status: string }> {
  const params: Record<string, string> = {
    registration_code: input.registrationCode,
    location: input.locationId,
  };
  if (input.label) params['label'] = input.label;
  const json = await stripePostForm({ ...conn, path: '/terminal/readers', params });
  return {
    id: String(json['id']),
    deviceType: json['device_type'] ? String(json['device_type']) : null,
    serialNumber: json['serial_number'] ? String(json['serial_number']) : null,
    status: String(json['status'] ?? 'offline'),
  };
}

export async function createCardPresentIntent(
  conn: Conn,
  input: {
    amountCents: number;
    currency?: string;
    customerId?: string;
    /** Save the tapped card for later (recurring) use → generated_card. */
    saveForFutureUse?: boolean;
    /**
     * 'manual' (default) — firm reviews before capture (admin/terminal).
     * 'automatic' — capture on tap, no separate step (the /payments/new
     * "collect and done" flow that auto-polls to a recorded receipt).
     */
    captureMethod?: 'manual' | 'automatic';
    metadata?: Record<string, string>;
    idempotencyKey?: string;
  },
): Promise<{ id: string; status: string; clientSecret?: string }> {
  const params: Record<string, string> = {
    amount: String(input.amountCents),
    currency: input.currency ?? 'usd',
    'payment_method_types[0]': 'card_present',
    capture_method: input.captureMethod ?? 'manual',
  };
  if (input.customerId) params['customer'] = input.customerId;
  if (input.saveForFutureUse) {
    params['setup_future_usage'] = 'off_session';
    // allow_redisplay so the generated card can be surfaced for reuse.
    params['payment_method_options[card_present][request_extended_authorization]'] = 'if_available';
  }
  for (const [k, v] of Object.entries(input.metadata ?? {})) params[`metadata[${k}]`] = v;
  const json = await stripePostForm({
    ...conn,
    path: '/payment_intents',
    params,
    idempotencyKey: input.idempotencyKey,
  });
  return {
    id: String(json['id']),
    status: String(json['status']),
    clientSecret: json['client_secret'] ? String(json['client_secret']) : undefined,
  };
}

/** Push a PI to the reader. 200 = acknowledgement only; confirm via webhooks. */
export async function processPaymentIntent(
  conn: Conn,
  input: { readerId: string; paymentIntentId: string },
): Promise<{ readerId: string; actionStatus: string }> {
  const json = await stripePostForm({
    ...conn,
    path: `/terminal/readers/${input.readerId}/process_payment_intent`,
    params: { payment_intent: input.paymentIntentId },
  });
  const action = json['action'] as { status?: string } | undefined;
  return { readerId: String(json['id']), actionStatus: String(action?.status ?? 'in_progress') };
}

export async function capturePaymentIntent(
  conn: Conn,
  input: { paymentIntentId: string },
): Promise<{ id: string; status: string }> {
  const json = await stripePostForm({
    ...conn,
    path: `/payment_intents/${input.paymentIntentId}/capture`,
    params: {},
  });
  return { id: String(json['id']), status: String(json['status']) };
}

export async function cancelPaymentIntent(
  conn: Conn,
  input: { paymentIntentId: string },
): Promise<{ id: string; status: string }> {
  const json = await stripePostForm({
    ...conn,
    path: `/payment_intents/${input.paymentIntentId}/cancel`,
    params: {},
  });
  return { id: String(json['id']), status: String(json['status']) };
}

/** Reset a stuck reader (action stuck in_progress) so it can accept a new PI. */
export async function cancelReaderAction(
  conn: Conn,
  input: { readerId: string },
): Promise<{ id: string; actionStatus: string | null }> {
  const json = await stripePostForm({
    ...conn,
    path: `/terminal/readers/${input.readerId}/cancel_action`,
    params: {},
  });
  const action = json['action'] as { status?: string } | null | undefined;
  return { id: String(json['id']), actionStatus: action?.status ? String(action.status) : null };
}
