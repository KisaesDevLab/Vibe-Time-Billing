// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Stripe implementation of @vibe/core/payments.PaymentProvider.
//
// Q7: the firm owns the Stripe account (BYO API keys via admin settings),
// so this client takes the secret key per-call rather than holding a
// global singleton. Webhook signature verification follows Stripe's
// documented `t=…,v1=…` scheme — same shape our @vibe/core/webhooks
// signer already uses for outbound, so for inbound we delegate to a
// thin shim.

import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  ChargeRequest,
  ChargeResult,
  CreateIntentRequest,
  CreateIntentResult,
  PaymentProvider,
  RefundRequest,
  RefundResult,
} from './provider';

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

export interface StripeProviderOptions {
  secretKey: string;
  fetchImpl?: typeof fetch;
}

export function createStripeProvider(opts: StripeProviderOptions): PaymentProvider {
  const fetchImpl: typeof fetch =
    opts.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined) ?? notWired;

  async function postForm(path: string, params: Record<string, string>): Promise<unknown> {
    const body = new URLSearchParams(params).toString();
    const res = await fetchImpl(`${STRIPE_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new StripeError(
        (json['error'] as { message?: string } | undefined)?.message ?? `stripe ${res.status}`,
        res.status,
      );
    }
    return json;
  }

  return {
    id: 'stripe',

    async charge(req: ChargeRequest): Promise<ChargeResult> {
      const params: Record<string, string> = {
        amount: String(req.amountCents),
        currency: req.currency.toLowerCase(),
        confirm: 'true',
        payment_method: req.paymentMethod.providerMethodId,
        description: req.description,
      };
      for (const [k, v] of Object.entries(req.metadata)) {
        params[`metadata[${k}]`] = v;
      }
      try {
        const json = (await postForm('/payment_intents', params)) as {
          id: string;
          status: string;
        };
        return {
          ok: json.status === 'succeeded' || json.status === 'processing',
          providerChargeId: json.id,
          status:
            json.status === 'succeeded'
              ? 'SUCCEEDED'
              : json.status === 'requires_action'
                ? 'PENDING'
                : 'PENDING',
        };
      } catch (err) {
        if (err instanceof StripeError) {
          return {
            ok: false,
            providerChargeId: '',
            status: 'FAILED',
            errorCode: String(err.statusCode),
            errorMessage: err.message,
          };
        }
        throw err;
      }
    },

    async refund(req: RefundRequest): Promise<RefundResult> {
      const params: Record<string, string> = { payment_intent: req.providerChargeId };
      if (req.amountCents != null) params['amount'] = String(req.amountCents);
      if (req.reason) params['reason'] = req.reason.slice(0, 64);
      const json = (await postForm('/refunds', params)) as { id: string; amount: number };
      return { ok: true, providerRefundId: json.id, amountCents: json.amount };
    },

    verifyWebhookSignature({ payload, signature, secret }) {
      const match = /t=(\d+),v1=([0-9a-f]+)/.exec(signature);
      if (!match) return false;
      const expected = createHmac('sha256', secret).update(`${match[1]}.${payload}`).digest('hex');
      const a = Buffer.from(expected, 'hex');
      const b = Buffer.from(match[2]!, 'hex');
      return a.length === b.length && timingSafeEqual(a, b);
    },

    async createIntent(req: CreateIntentRequest): Promise<CreateIntentResult> {
      const params: Record<string, string> = {
        amount: String(req.amountCents),
        currency: req.currency.toLowerCase(),
        description: req.description,
      };
      req.paymentMethodTypes.forEach((t, i) => {
        params[`payment_method_types[${i}]`] = t;
      });
      for (const [k, v] of Object.entries(req.metadata)) {
        params[`metadata[${k}]`] = v;
      }
      try {
        const json = (await postForm('/payment_intents', params)) as {
          id: string;
          client_secret: string;
        };
        return {
          ok: true,
          providerChargeId: json.id,
          clientSecret: json.client_secret,
        };
      } catch (err) {
        if (err instanceof StripeError) {
          return {
            ok: false,
            providerChargeId: '',
            clientSecret: '',
            errorCode: String(err.statusCode),
            errorMessage: err.message,
          };
        }
        throw err;
      }
    },
  };
}

class StripeError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

function notWired(): never {
  throw new Error('No fetch implementation provided to StripeProvider');
}
