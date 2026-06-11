// SPDX-License-Identifier: Elastic-2.0
//
// CPACharge provider stub. CPACharge is the IOLTA-friendly processor
// many CPA firms already use. Their public API is REST + Basic-auth
// keyed on a per-firm merchant id. This stub conforms to the
// PaymentProvider interface so the rest of the system can wire it up;
// real implementation lands when a firm requests it (and supplies
// credentials).

import type {
  ChargeRequest,
  ChargeResult,
  PaymentProvider,
  RefundRequest,
  RefundResult,
} from './provider';

export interface CpaChargeConfig {
  apiKey: string;
  merchantId: string;
  /** Default https://api.cpacharge.com — overridable for sandbox. */
  baseUrl?: string;
}

export function createCpaChargeProvider(config: CpaChargeConfig): PaymentProvider {
  const baseUrl = config.baseUrl ?? 'https://api.cpacharge.com';
  return {
    id: 'cpacharge',
    async charge(_req: ChargeRequest): Promise<ChargeResult> {
      // Real implementation: POST {baseUrl}/charges with merchant_id +
      // tokenized payment method + amount. Returns charge id on success.
      void config.apiKey;
      void config.merchantId;
      void baseUrl;
      return {
        ok: false,
        providerChargeId: '',
        status: 'FAILED',
        errorCode: 'NOT_IMPLEMENTED',
        errorMessage:
          'CPACharge provider stub: real charge call wired when a firm supplies credentials.',
      };
    },
    async refund(_req: RefundRequest): Promise<RefundResult> {
      return { ok: false, providerRefundId: '', amountCents: 0 };
    },
    verifyWebhookSignature(args): boolean {
      // CPACharge signs webhooks with HMAC-SHA256 over the raw body
      // using the firm's webhook secret. Stubbed to false until wired.
      void args;
      return false;
    },
  };
}
