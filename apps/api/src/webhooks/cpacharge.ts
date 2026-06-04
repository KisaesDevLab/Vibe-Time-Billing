// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CPACharge webhook handler (Phase 14 #19). Stub — verifies the HMAC
// signature, looks up the matching payment row, and updates status.
// Real wire-up lands when a firm supplies CPACharge credentials.

import express, { type Request, type Response, type Router } from 'express';

import type { Database } from '@vibe/db';
import { type PaymentProvider } from '@vibe/core/payments';

import { logger } from '../logger';

export interface CpaChargeWebhookDeps {
  db: Database | null;
  provider: PaymentProvider | null;
  webhookSecret: string | null;
}

export function createCpaChargeWebhookRouter(deps: CpaChargeWebhookDeps): Router {
  const router = express.Router();
  // Raw body required for HMAC verification.
  router.use(express.raw({ type: 'application/json' }));

  router.post('/', async (req: Request, res: Response) => {
    if (!deps.provider || !deps.webhookSecret) {
      res.status(503).json({ error: 'cpacharge_not_configured' });
      return;
    }
    const signature = req.header('x-cpacharge-signature') ?? '';
    const payload = req.body instanceof Buffer ? req.body.toString('utf8') : '';
    const ok = deps.provider.verifyWebhookSignature({
      payload,
      signature,
      secret: deps.webhookSecret,
    });
    if (!ok) {
      // Never log the signature value itself (it's a credential). Log only
      // that a mismatch occurred — matches the other webhook verifiers.
      logger.warn({ result: 'mismatch' }, 'cpacharge webhook signature mismatch');
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }
    let event: { type?: string; data?: { charge_id?: string; status?: string } };
    try {
      event = JSON.parse(payload);
    } catch {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    logger.info({ type: event.type, chargeId: event.data?.charge_id }, 'cpacharge webhook');
    // Real handler would lookup payments by provider_charge_id and
    // update status. Stubbed; ack so CPACharge doesn't retry.
    res.json({ ok: true, received: event.type ?? null });
  });

  return router;
}
