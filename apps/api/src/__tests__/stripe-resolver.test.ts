// SPDX-License-Identifier: Elastic-2.0
//
// The masked Stripe config must never echo a full secret back to the UI.

import { describe, expect, it } from 'vitest';

import { maskStripeConfig } from '../payments/stripe-resolver';

describe('maskStripeConfig', () => {
  it('shows only the last 4 chars and never the full secret', () => {
    const m = maskStripeConfig({
      secretKey: 'sk_live_ABCDEFGH1234',
      publishableKey: 'pk_live_WXYZ',
      webhookSecret: 'whsec_secret',
    });
    expect(m.secretKeyMasked).toBe('••••1234');
    expect(m.secretKeyMasked).not.toContain('ABCDEFGH');
    expect(m.publishableKeyMasked).toBe('••••WXYZ');
    expect(m.webhookSecretSet).toBe(true);
  });

  it('reports nulls / false when nothing is set', () => {
    expect(maskStripeConfig(null)).toEqual({
      secretKeyMasked: null,
      publishableKeyMasked: null,
      webhookSecretSet: false,
    });
  });
});
