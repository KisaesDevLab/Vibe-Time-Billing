// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P08 — Stripe Connect Standard OAuth client.
//
// Three operations against connect.stripe.com:
//   buildAuthorizeUrl  — pure URL builder. The state token is supplied
//                        by the caller (Redis-backed so we can verify
//                        on callback without sticky sessions).
//   exchangeCode       — POST /oauth/token with code + secret →
//                        returns { stripe_user_id, livemode, … }
//   deauthorize        — POST /oauth/deauthorize to sever the link
//                        without touching the connected account's data
//
// All three accept an injected fetch so tests can mock the network
// edge without monkey-patching globals.

const CONNECT_BASE = 'https://connect.stripe.com';

export interface BuildAuthorizeUrlInput {
  clientId: string;
  state: string;
  redirectUri?: string;
  // Stripe accepts read_only or read_write. Standard accounts default
  // to read_write so the platform can issue refunds, dispute responses,
  // etc. — same shape T&B will need for invoice management.
  scope?: 'read_only' | 'read_write';
}

export function buildAuthorizeUrl(input: BuildAuthorizeUrlInput): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    scope: input.scope ?? 'read_write',
    state: input.state,
    'stripe_user[business_type]': 'company',
  });
  if (input.redirectUri) {
    params.set('redirect_uri', input.redirectUri);
  }
  return `${CONNECT_BASE}/oauth/authorize?${params.toString()}`;
}

export interface ExchangeCodeInput {
  secretKey: string;
  code: string;
  fetchImpl?: typeof fetch;
}

export interface ExchangeCodeResult {
  stripeUserId: string;
  stripePublishableKey: string;
  scope: string;
  livemode: boolean;
  raw: Record<string, unknown>;
}

export async function exchangeCode(input: ExchangeCodeInput): Promise<ExchangeCodeResult> {
  const fetchImpl: typeof fetch = input.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
  });
  const res = await fetchImpl(`${CONNECT_BASE}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const msg =
      (json['error_description'] as string | undefined) ??
      (json['error'] as string | undefined) ??
      `stripe ${res.status}`;
    throw new Error(`stripe_oauth_token_failed: ${msg}`);
  }
  const stripeUserId = json['stripe_user_id'];
  const stripePublishableKey = json['stripe_publishable_key'];
  if (typeof stripeUserId !== 'string' || typeof stripePublishableKey !== 'string') {
    throw new Error('stripe_oauth_token_missing_fields');
  }
  return {
    stripeUserId,
    stripePublishableKey,
    scope: typeof json['scope'] === 'string' ? json['scope'] : 'read_write',
    livemode: Boolean(json['livemode']),
    raw: json,
  };
}

export interface DeauthorizeInput {
  secretKey: string;
  clientId: string;
  stripeUserId: string;
  fetchImpl?: typeof fetch;
}

export async function deauthorize(input: DeauthorizeInput): Promise<void> {
  const fetchImpl: typeof fetch = input.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const body = new URLSearchParams({
    client_id: input.clientId,
    stripe_user_id: input.stripeUserId,
  });
  const res = await fetchImpl(`${CONNECT_BASE}/oauth/deauthorize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const msg =
      (json['error_description'] as string | undefined) ??
      (json['error'] as string | undefined) ??
      `stripe ${res.status}`;
    throw new Error(`stripe_oauth_deauthorize_failed: ${msg}`);
  }
}

export interface FetchAccountInput {
  secretKey: string;
  stripeAccountId: string;
  fetchImpl?: typeof fetch;
}

export interface AccountSummary {
  id: string;
  email: string | null;
  businessProfileName: string | null;
  capabilities: Record<string, string>;
  defaultCurrency: string;
  payoutsEnabled: boolean;
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
}

export async function fetchAccount(input: FetchAccountInput): Promise<AccountSummary> {
  const fetchImpl: typeof fetch = input.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const res = await fetchImpl(`https://api.stripe.com/v1/accounts/${input.stripeAccountId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${input.secretKey}`,
      // Stripe-Account header is what tells Standard to act on the
      // connected account rather than the platform itself.
      'Stripe-Account': input.stripeAccountId,
    },
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const msg =
      ((json['error'] as { message?: string } | undefined)?.message ?? `stripe ${res.status}`) + '';
    throw new Error(`stripe_account_fetch_failed: ${msg}`);
  }
  const profile = json['business_profile'] as { name?: string | null } | undefined;
  return {
    id: String(json['id']),
    email: typeof json['email'] === 'string' ? json['email'] : null,
    businessProfileName: profile?.name ?? null,
    capabilities: (json['capabilities'] as Record<string, string> | undefined) ?? {},
    defaultCurrency:
      typeof json['default_currency'] === 'string' ? json['default_currency'] : 'usd',
    payoutsEnabled: Boolean(json['payouts_enabled']),
    chargesEnabled: Boolean(json['charges_enabled']),
    detailsSubmitted: Boolean(json['details_submitted']),
  };
}
