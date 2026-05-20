// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Payment provider abstraction. Stripe + CPACharge implementations live
// in apps/api/src/payments/{stripe,cpacharge}; this interface keeps the
// rest of the system provider-agnostic.

import type { Cents } from '@vibe/types';

export type PaymentProviderId = 'stripe' | 'cpacharge';

export type PaymentMethodKind = 'CARD' | 'ACH';

export interface PaymentMethodRecord {
  providerId: PaymentProviderId;
  providerMethodId: string; // e.g. Stripe pm_xxx
  kind: PaymentMethodKind;
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
}

export interface ChargeRequest {
  amountCents: Cents;
  currency: 'USD';
  description: string;
  metadata: Record<string, string>;
  paymentMethod: PaymentMethodRecord;
}

export interface ChargeResult {
  ok: boolean;
  providerChargeId: string;
  status: 'SUCCEEDED' | 'PENDING' | 'FAILED';
  errorCode?: string;
  errorMessage?: string;
}

export interface RefundRequest {
  providerChargeId: string;
  amountCents?: Cents; // omit for full refund
  reason?: string;
}

export interface RefundResult {
  ok: boolean;
  providerRefundId: string;
  amountCents: Cents;
}

export interface PaymentProvider {
  id: PaymentProviderId;
  charge(req: ChargeRequest): Promise<ChargeResult>;
  refund(req: RefundRequest): Promise<RefundResult>;
  /** Verify the webhook signature for incoming events. */
  verifyWebhookSignature(args: { payload: string; signature: string; secret: string }): boolean;
}
