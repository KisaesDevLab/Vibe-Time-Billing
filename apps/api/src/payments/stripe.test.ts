// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
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
      provider.verifyWebhookSignature({ payload, signature: header, secret: 'whsec_test' }),
    ).toBe(true);
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
      }),
    ).toBe(false);
  });
});
