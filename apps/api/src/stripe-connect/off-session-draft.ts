// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Phases 12/13 — off-session payment drafts against a saved method on the
// firm's connected account (MIT). Two variants:
//   - draftCardOffSession: card MIT. off_session=true + confirm=true; Stripe
//     auto-requests SCA exemptions and may return requires_action.
//   - draftAchOffSession: ACH. confirm=true + saved bank PM, NO off_session
//     flag and NO re-collected mandate (the setup-time mandate persists). This
//     is the single most common ACH integration mistake — keep it distinct.

import { stripePostForm } from './raw';

export interface OffSessionDraftInput {
  secretKey: string;
  stripeAccountId: string;
  customerId: string;
  paymentMethodId: string;
  amountCents: number;
  currency?: string;
  metadata?: Record<string, string>;
  fetchImpl?: typeof fetch;
  idempotencyKey?: string;
}

export interface DraftResult {
  id: string;
  status: string;
  /** True when Stripe needs on-session authentication (card MIT path). */
  requiresAction: boolean;
  clientSecret?: string;
}

function baseParams(input: OffSessionDraftInput): Record<string, string> {
  const params: Record<string, string> = {
    amount: String(input.amountCents),
    currency: input.currency ?? 'usd',
    customer: input.customerId,
    payment_method: input.paymentMethodId,
    confirm: 'true',
  };
  for (const [k, v] of Object.entries(input.metadata ?? {})) {
    params[`metadata[${k}]`] = v;
  }
  return params;
}

/** Card merchant-initiated draft. off_session=true lets Stripe seek SCA exemptions. */
export async function draftCardOffSession(input: OffSessionDraftInput): Promise<DraftResult> {
  const params = baseParams(input);
  params['off_session'] = 'true';
  params['payment_method_types[0]'] = 'card';
  return run(input, params);
}

/**
 * ACH off-session draft. CRITICAL: no `off_session` flag and no re-collected
 * mandate — the mandate captured at setup time persists. ACH is not subject to
 * SCA, so there's never a requires_action step.
 */
export async function draftAchOffSession(input: OffSessionDraftInput): Promise<DraftResult> {
  const params = baseParams(input);
  params['payment_method_types[0]'] = 'us_bank_account';
  return run(input, params);
}

async function run(
  input: OffSessionDraftInput,
  params: Record<string, string>,
): Promise<DraftResult> {
  try {
    const json = await stripePostForm({
      secretKey: input.secretKey,
      stripeAccountId: input.stripeAccountId,
      path: '/payment_intents',
      params,
      fetchImpl: input.fetchImpl,
      idempotencyKey: input.idempotencyKey,
    });
    const status = String(json['status']);
    return {
      id: String(json['id']),
      status,
      requiresAction: status === 'requires_action' || status === 'requires_payment_method',
      clientSecret: json['client_secret'] ? String(json['client_secret']) : undefined,
    };
  } catch (err) {
    // Card MIT: a confirmed-but-needs-auth intent throws with code
    // authentication_required; surface it as requiresAction so the caller can
    // send an on-session recovery link rather than treating it as a hard fail.
    const code = (err as Error & { stripeCode?: string }).stripeCode;
    if (code === 'authentication_required') {
      return { id: '', status: 'requires_action', requiresAction: true };
    }
    throw err;
  }
}
