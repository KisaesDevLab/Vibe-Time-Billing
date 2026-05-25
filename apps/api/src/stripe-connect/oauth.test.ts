// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0

import { describe, expect, it } from 'vitest';

import { buildAuthorizeUrl, deauthorize, exchangeCode, fetchAccount } from './oauth';

describe('buildAuthorizeUrl', () => {
  it('builds a connect.stripe.com URL with required params', () => {
    const url = buildAuthorizeUrl({
      clientId: 'ca_x',
      state: 'state-abc',
      redirectUri: 'https://app.example/callback',
    });
    expect(url).toContain('connect.stripe.com/oauth/authorize');
    expect(url).toContain('response_type=code');
    expect(url).toContain('client_id=ca_x');
    expect(url).toContain('scope=read_write');
    expect(url).toContain('state=state-abc');
    expect(url).toContain('redirect_uri=https%3A%2F%2Fapp.example%2Fcallback');
  });

  it('omits redirect_uri when not supplied', () => {
    const url = buildAuthorizeUrl({ clientId: 'ca_y', state: 's' });
    expect(url).not.toContain('redirect_uri=');
  });

  it('accepts read_only scope', () => {
    const url = buildAuthorizeUrl({ clientId: 'ca_z', state: 's', scope: 'read_only' });
    expect(url).toContain('scope=read_only');
  });
});

describe('exchangeCode', () => {
  it('returns parsed stripe_user_id on success', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          stripe_user_id: 'acct_123',
          stripe_publishable_key: 'pk_test_abc',
          scope: 'read_write',
          livemode: true,
        }),
        { status: 200 },
      );
    const r = await exchangeCode({
      secretKey: 'sk_test_x',
      code: 'authcode',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.stripeUserId).toBe('acct_123');
    expect(r.stripePublishableKey).toBe('pk_test_abc');
    expect(r.livemode).toBe(true);
  });

  it('throws on Stripe error response', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'bad code' }), {
        status: 400,
      });
    await expect(
      exchangeCode({
        secretKey: 'sk',
        code: 'bad',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/stripe_oauth_token_failed: bad code/);
  });

  it('throws when expected fields missing', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ livemode: true }), { status: 200 });
    await expect(
      exchangeCode({
        secretKey: 'sk',
        code: 'x',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/missing_fields/);
  });
});

describe('deauthorize', () => {
  it('POSTs to /oauth/deauthorize with client_id + stripe_user_id', async () => {
    let bodyCaptured = '';
    const fetchImpl = async (url: string, init?: RequestInit) => {
      bodyCaptured = String(init?.body ?? '');
      expect(url).toContain('connect.stripe.com/oauth/deauthorize');
      return new Response('{}', { status: 200 });
    };
    await deauthorize({
      secretKey: 'sk',
      clientId: 'ca_x',
      stripeUserId: 'acct_y',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(bodyCaptured).toContain('client_id=ca_x');
    expect(bodyCaptured).toContain('stripe_user_id=acct_y');
  });

  it('throws on non-2xx', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    await expect(
      deauthorize({
        secretKey: 'sk',
        clientId: 'ca_x',
        stripeUserId: 'acct_y',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/deauthorize_failed/);
  });
});

describe('fetchAccount', () => {
  it('parses account JSON into AccountSummary', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          id: 'acct_x',
          email: 'firm@example.com',
          business_profile: { name: 'Smith CPAs' },
          capabilities: { card_payments: 'active' },
          default_currency: 'usd',
          payouts_enabled: true,
          charges_enabled: true,
          details_submitted: true,
        }),
        { status: 200 },
      );
    const summary = await fetchAccount({
      secretKey: 'sk',
      stripeAccountId: 'acct_x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(summary.id).toBe('acct_x');
    expect(summary.email).toBe('firm@example.com');
    expect(summary.businessProfileName).toBe('Smith CPAs');
    expect(summary.capabilities.card_payments).toBe('active');
    expect(summary.chargesEnabled).toBe(true);
  });
});
