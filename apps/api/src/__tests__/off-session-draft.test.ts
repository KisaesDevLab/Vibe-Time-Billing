// SPDX-License-Identifier: Elastic-2.0
//
// Phases 12/13 — off-session draft param correctness. The #1 ACH mistake is
// adding `off_session` / re-collecting a mandate; assert we never do for ACH,
// and that card MIT does set off_session.

import { describe, expect, it } from 'vitest';

import { draftAchOffSession, draftCardOffSession } from '../stripe-connect/off-session-draft';

function captureFetch(responseBody: Record<string, unknown>): {
  fetchImpl: typeof fetch;
  lastBody: () => URLSearchParams;
} {
  let captured = '';
  const fetchImpl = (async (_url: string, init?: { body?: string }) => {
    captured = init?.body ?? '';
    return {
      ok: true,
      json: async () => responseBody,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, lastBody: () => new URLSearchParams(captured) };
}

const base = {
  secretKey: 'sk_test',
  stripeAccountId: 'acct_1',
  customerId: 'cus_1',
  paymentMethodId: 'pm_1',
  amountCents: 12345,
};

describe('draftAchOffSession', () => {
  it('confirms with us_bank_account and NO off_session flag', async () => {
    const cap = captureFetch({ id: 'pi_ach', status: 'processing', client_secret: 'cs' });
    const r = await draftAchOffSession({ ...base, fetchImpl: cap.fetchImpl });
    const body = cap.lastBody();
    expect(body.get('confirm')).toBe('true');
    expect(body.get('payment_method_types[0]')).toBe('us_bank_account');
    expect(body.get('off_session')).toBeNull(); // <-- the critical assertion
    expect(body.get('amount')).toBe('12345');
    expect(r.status).toBe('processing');
    expect(r.requiresAction).toBe(false);
  });
});

describe('draftCardOffSession', () => {
  it('sets off_session=true for card MIT', async () => {
    const cap = captureFetch({ id: 'pi_card', status: 'succeeded' });
    await draftCardOffSession({ ...base, fetchImpl: cap.fetchImpl });
    const body = cap.lastBody();
    expect(body.get('off_session')).toBe('true');
    expect(body.get('payment_method_types[0]')).toBe('card');
    expect(body.get('confirm')).toBe('true');
  });

  it('maps authentication_required into requiresAction', async () => {
    const failing = (async () =>
      ({
        ok: false,
        json: async () => ({ error: { code: 'authentication_required', message: 'auth' } }),
      }) as unknown as Response) as unknown as typeof fetch;
    const r = await draftCardOffSession({ ...base, fetchImpl: failing });
    expect(r.requiresAction).toBe(true);
    expect(r.status).toBe('requires_action');
  });
});
