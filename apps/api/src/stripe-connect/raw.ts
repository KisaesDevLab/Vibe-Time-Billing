// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Shared raw Stripe HTTP helpers for connected-account (direct) calls. Every
// request carries the firm's `Stripe-Account` header and an optional
// idempotency key. Used by the off-session draft + Terminal modules.

const API_BASE = 'https://api.stripe.com/v1';

export interface StripeCallOptions {
  secretKey: string;
  stripeAccountId: string;
  path: string;
  params?: Record<string, string>;
  fetchImpl?: typeof fetch;
  idempotencyKey?: string;
}

export async function stripePostForm(opts: StripeCallOptions): Promise<Record<string, unknown>> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const body = new URLSearchParams(opts.params ?? {}).toString();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.secretKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  // Direct firm keys (secretKey already scopes to the firm's account) pass an
  // empty accountId → omit the header. Connect OAuth passes the connected id.
  if (opts.stripeAccountId) headers['Stripe-Account'] = opts.stripeAccountId;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const res = await fetchImpl(`${API_BASE}${opts.path}`, { method: 'POST', headers, body });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = json['error'] as { message?: string; code?: string } | undefined;
    const e = new Error(`stripe_call_failed:${opts.path}: ${err?.message ?? res.status}`);
    (e as Error & { stripeCode?: string }).stripeCode = err?.code;
    throw e;
  }
  return json;
}

export async function stripeGet(opts: StripeCallOptions): Promise<Record<string, unknown>> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const qs = opts.params ? `?${new URLSearchParams(opts.params).toString()}` : '';
  const getHeaders: Record<string, string> = { Authorization: `Bearer ${opts.secretKey}` };
  if (opts.stripeAccountId) getHeaders['Stripe-Account'] = opts.stripeAccountId;
  const res = await fetchImpl(`${API_BASE}${opts.path}${qs}`, {
    method: 'GET',
    headers: getHeaders,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = json['error'] as { message?: string } | undefined;
    throw new Error(`stripe_get_failed:${opts.path}: ${err?.message ?? res.status}`);
  }
  return json;
}
