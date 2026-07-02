// SPDX-License-Identifier: Elastic-2.0
import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';

import { createStripeProvider } from './stripe';

describe('stripe provider', () => {
  it('posts a payment_intent with the right fields and reports success', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'pi_test_1', status: 'succeeded' }), { status: 200 }),
    );
    const provider = createStripeProvider({ secretKey: 'sk_test_x', fetchImpl });
    const result = await provider.charge({
      amountCents: 1000,
      currency: 'USD',
      description: 'Inv #1',
      metadata: { invoice_id: 'inv_1' },
      paymentMethod: {
        providerId: 'stripe',
        providerMethodId: 'pm_test_1',
        kind: 'CARD',
      },
    });
    expect(result.ok).toBe(true);
    expect(result.providerChargeId).toBe('pi_test_1');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = fetchImpl.mock.calls as unknown as any[][];
    const call = calls[0]!;
    expect(String(call[0])).toContain('/payment_intents');
    expect(call[1].body).toContain('amount=1000');
    expect(call[1].body).toContain('metadata%5Binvoice_id%5D=inv_1');
  });

  it('reports failure on a 402 response', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'card_declined' } }), { status: 402 }),
    );
    const provider = createStripeProvider({ secretKey: 'sk_test_x', fetchImpl });
    const result = await provider.charge({
      amountCents: 1000,
      currency: 'USD',
      description: 'Inv #1',
      metadata: {},
      paymentMethod: { providerId: 'stripe', providerMethodId: 'pm_test_2', kind: 'CARD' },
    });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toBe('card_declined');
  });

  it('verifies an HMAC-signed webhook header', () => {
    const provider = createStripeProvider({
      secretKey: 'sk_x',
      fetchImpl: async () => new Response(),
    });
    const payload = JSON.stringify({ id: 'evt_1' });
    const ts = 1700000000;
    const sig = createHmac('sha256', 'whsec_test').update(`${ts}.${payload}`).digest('hex');
    const header = `t=${ts},v1=${sig}`;
    expect(
      provider.verifyWebhookSignature({
        payload,
        signature: header,
        secret: 'whsec_test',
        nowMs: ts * 1000,
      }),
    ).toBe(true);
  });

  it('createIntent posts payment_intents with the right shape and returns the client secret', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'pi_test_99', client_secret: 'pi_test_99_secret_abc' }), {
          status: 200,
        }),
    );
    const provider = createStripeProvider({ secretKey: 'sk_test_x', fetchImpl });
    const result = await provider.createIntent!({
      amountCents: 250000,
      currency: 'USD',
      description: 'Receipt 11111111-1111-1111-1111-111111111111 (Card via Stripe)',
      paymentMethodTypes: ['card'],
      metadata: {
        receiptId: '11111111-1111-1111-1111-111111111111',
        firmId: 'firm_1',
      },
    });
    expect(result.ok).toBe(true);
    expect(result.providerChargeId).toBe('pi_test_99');
    expect(result.clientSecret).toBe('pi_test_99_secret_abc');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = fetchImpl.mock.calls as unknown as any[][];
    const call = calls[0]!;
    expect(String(call[0])).toContain('/payment_intents');
    expect(call[1].body).toContain('amount=250000');
    expect(call[1].body).toContain('payment_method_types%5B0%5D=card');
    expect(call[1].body).toContain('metadata%5BreceiptId%5D=');
    // The intent flow must NOT include confirm=true or a payment_method —
    // Stripe Elements confirms client-side with the returned client_secret.
    expect(call[1].body).not.toContain('confirm=true');
    expect(call[1].body).not.toContain('payment_method=');
  });

  it('createIntent surfaces Stripe errors without throwing', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'invalid_amount' } }), { status: 400 }),
    );
    const provider = createStripeProvider({ secretKey: 'sk_test_x', fetchImpl });
    const result = await provider.createIntent!({
      amountCents: 0,
      currency: 'USD',
      description: 'bad',
      paymentMethodTypes: ['card'],
      metadata: {},
    });
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toBe('invalid_amount');
    expect(result.clientSecret).toBe('');
  });

  it('rejects tampered webhook payloads', () => {
    const provider = createStripeProvider({
      secretKey: 'sk_x',
      fetchImpl: async () => new Response(),
    });
    const payload = JSON.stringify({ id: 'evt_1' });
    const ts = 1700000000;
    const sig = createHmac('sha256', 'whsec_test').update(`${ts}.${payload}`).digest('hex');
    const header = `t=${ts},v1=${sig}`;
    expect(
      provider.verifyWebhookSignature({
        payload: payload + 'X',
        signature: header,
        secret: 'whsec_test',
        nowMs: ts * 1000,
      }),
    ).toBe(false);
  });
});
