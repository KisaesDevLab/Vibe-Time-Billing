// SPDX-License-Identifier: Elastic-2.0
//
// Admin → Stripe API keys. Lets the firm paste its own Stripe credentials
// (Q7) instead of relying on env vars. Stored encrypted under KMS_KEY. A
// "test" call validates the secret key against Stripe immediately.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { firmSettings } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { emitAudit } from '../auth/audit';
import {
  loadFirmStripeConfig,
  encryptStripeConfig,
  maskStripeConfig,
  testStripeSecretKey,
  type StoredStripeConfig,
} from '../payments/stripe-resolver';

export interface StripeKeysRoutesDeps extends RbacDeps {
  db: Database | null;
}

// All optional: omitted fields preserve the stored value; empty string clears.
const SaveSchema = z.object({
  secretKey: z.string().trim().max(255).optional(),
  publishableKey: z.string().trim().max(255).optional(),
  webhookSecret: z.string().trim().max(255).optional(),
});

const TestSchema = z.object({ secretKey: z.string().trim().min(1).max(255).optional() });

export function createStripeKeysRouter(deps: StripeKeysRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ config: maskStripeConfig(null), kmsReady: Boolean(process.env['KMS_KEY']) });
        return;
      }
      const cfg = await loadFirmStripeConfig(deps.db, firmId);
      res.json({ config: maskStripeConfig(cfg), kmsReady: Boolean(process.env['KMS_KEY']) });
    },
  );

  router.put(
    '/',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const parsed = SaveSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      if (!process.env['KMS_KEY']) {
        res.status(503).json({ error: 'kms_unavailable' });
        return;
      }
      // Merge over the existing config so a blank field keeps the stored value;
      // an explicit empty string clears that key.
      const current = (await loadFirmStripeConfig(deps.db, firmId)) ?? {};
      const next: StoredStripeConfig = { ...current };
      for (const k of ['secretKey', 'publishableKey', 'webhookSecret'] as const) {
        const v = parsed.data[k];
        if (v === undefined) continue;
        if (v === '') delete next[k];
        else next[k] = v;
      }
      await deps.db
        .update(firmSettings)
        .set({ stripeConfigEncrypted: encryptStripeConfig(next), updatedAt: new Date() })
        .where(eq(firmSettings.firmId, firmId));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'stripe_config',
        entityId: firmId,
        actorAppUserId: req.staffSession!.appUserId,
        // Never log the credentials — only which fields are now set.
        after: {
          secretKeySet: Boolean(next.secretKey),
          publishableKeySet: Boolean(next.publishableKey),
          webhookSecretSet: Boolean(next.webhookSecret),
        },
      }).catch(() => undefined);
      res.json({ ok: true, config: maskStripeConfig(next) });
    },
  );

  router.post(
    '/test',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const parsed = TestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession?.firmId;
      // Test the key provided in the body, else the one already stored.
      let secretKey = parsed.data.secretKey;
      if (!secretKey && firmId && deps.db) {
        secretKey = (await loadFirmStripeConfig(deps.db, firmId))?.secretKey;
      }
      if (!secretKey) {
        res.status(400).json({ error: 'no_secret_key' });
        return;
      }
      const result = await testStripeSecretKey(secretKey);
      if (!result.ok) {
        res.status(422).json({ ok: false, error: result.error });
        return;
      }
      res.json({ ok: true });
    },
  );

  return router;
}
