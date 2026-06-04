// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Error-handling coverage for the CPACharge webhook: signature mismatch
// fails closed (401) and never echoes the signature; unconfigured → 503;
// malformed JSON → 400; valid → ack.

import { describe, expect, it } from 'vitest';
import type express from 'express';

import type { PaymentProvider } from '@vibe/core/payments';

import { createCpaChargeWebhookRouter } from '../webhooks/cpacharge';

interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
}
function makeRes(): FakeRes {
  return {
    statusCode: 200,
    jsonBody: undefined,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.jsonBody = b;
      return this;
    },
  };
}

async function post(router: express.Router, req: Record<string, unknown>): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === '/' && r.methods['post'] === true;
  });
  if (!layer) throw new Error('route not registered');
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (rq: unknown, rs: unknown) => Promise<void>)(req, res);
  return res;
}

const SIGNATURE = 'sig_super_secret_value';

function makeReq(body: string): Record<string, unknown> {
  return {
    body: Buffer.from(body),
    header: (n: string) => (n === 'x-cpacharge-signature' ? SIGNATURE : undefined),
  };
}

function provider(verify: boolean): PaymentProvider {
  return { verifyWebhookSignature: () => verify } as unknown as PaymentProvider;
}

describe('cpacharge webhook error handling', () => {
  it('fails closed (401) on signature mismatch and never echoes the signature', async () => {
    const router = createCpaChargeWebhookRouter({
      db: null,
      provider: provider(false),
      webhookSecret: 'whsec',
    });
    const res = await post(router, makeReq('{"type":"charge.succeeded"}'));
    expect(res.statusCode).toBe(401);
    expect((res.jsonBody as { error: string }).error).toBe('invalid_signature');
    // The signature is a credential — it must not leak into the response.
    expect(JSON.stringify(res.jsonBody)).not.toContain(SIGNATURE);
  });

  it('returns 503 when the provider/secret is not configured', async () => {
    const router = createCpaChargeWebhookRouter({ db: null, provider: null, webhookSecret: null });
    const res = await post(router, makeReq('{}'));
    expect(res.statusCode).toBe(503);
  });

  it('returns 400 on malformed JSON after a valid signature', async () => {
    const router = createCpaChargeWebhookRouter({
      db: null,
      provider: provider(true),
      webhookSecret: 'whsec',
    });
    const res = await post(router, makeReq('{not json'));
    expect(res.statusCode).toBe(400);
    expect((res.jsonBody as { error: string }).error).toBe('invalid_json');
  });

  it('acks a valid signed event', async () => {
    const router = createCpaChargeWebhookRouter({
      db: null,
      provider: provider(true),
      webhookSecret: 'whsec',
    });
    const res = await post(
      router,
      makeReq('{"type":"charge.succeeded","data":{"charge_id":"ch_1"}}'),
    );
    expect(res.statusCode).toBe(200);
    expect((res.jsonBody as { ok: boolean }).ok).toBe(true);
  });
});
