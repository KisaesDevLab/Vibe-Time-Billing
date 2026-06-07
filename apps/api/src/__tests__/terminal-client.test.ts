// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Phase 16 — card_present PaymentIntent param correctness: manual capture,
// card_present type, no application fee (firm owns the account), and the
// reader process_payment_intent path. Server-driven (no connection token).

import { describe, expect, it } from 'vitest';

import { createCardPresentIntent, processPaymentIntent } from '../stripe-connect/terminal';

function capture(responseBody: Record<string, unknown>): {
  fetchImpl: typeof fetch;
  url: () => string;
  body: () => URLSearchParams;
} {
  let capturedUrl = '';
  let capturedBody = '';
  const fetchImpl = (async (url: string, init?: { body?: string }) => {
    capturedUrl = url;
    capturedBody = init?.body ?? '';
    return { ok: true, json: async () => responseBody } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    url: () => capturedUrl,
    body: () => new URLSearchParams(capturedBody),
  };
}

const conn = { secretKey: 'sk_test', stripeAccountId: 'acct_1' };

describe('createCardPresentIntent', () => {
  it('uses card_present + manual capture and no application_fee', async () => {
    const cap = capture({ id: 'pi_cp', status: 'requires_payment_method', client_secret: 'cs' });
    await createCardPresentIntent(
      { ...conn, fetchImpl: cap.fetchImpl },
      { amountCents: 5000, metadata: { invoice_id: 'inv1' } },
    );
    const b = cap.body();
    expect(b.get('payment_method_types[0]')).toBe('card_present');
    expect(b.get('capture_method')).toBe('manual');
    expect(b.get('amount')).toBe('5000');
    expect(b.get('application_fee_amount')).toBeNull(); // firm owns the account
    expect(b.get('metadata[invoice_id]')).toBe('inv1');
  });

  it('sets setup_future_usage when saving the in-person card', async () => {
    const cap = capture({ id: 'pi_cp', status: 'requires_payment_method' });
    await createCardPresentIntent(
      { ...conn, fetchImpl: cap.fetchImpl },
      { amountCents: 5000, customerId: 'cus_1', saveForFutureUse: true },
    );
    expect(cap.body().get('setup_future_usage')).toBe('off_session');
    expect(cap.body().get('customer')).toBe('cus_1');
  });
});

describe('processPaymentIntent', () => {
  it('targets the reader process_payment_intent endpoint', async () => {
    const cap = capture({ id: 'tmr_1', action: { status: 'in_progress' } });
    const r = await processPaymentIntent(
      { ...conn, fetchImpl: cap.fetchImpl },
      { readerId: 'tmr_1', paymentIntentId: 'pi_cp' },
    );
    expect(cap.url()).toContain('/terminal/readers/tmr_1/process_payment_intent');
    expect(cap.body().get('payment_intent')).toBe('pi_cp');
    expect(r.actionStatus).toBe('in_progress'); // ack only
  });
});
