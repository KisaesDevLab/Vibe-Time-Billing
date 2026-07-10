// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Admin → Webhook keys. Lets the firm set the inbound webhook signing secrets
// for the notification providers (Postmark / Resend / Twilio / TextLink),
// stored encrypted under KMS_KEY. Receivers prefer these over the env vars.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { firmSettings } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { emitAudit } from '../auth/audit';
import {
  loadFirmWebhookKeys,
  encryptWebhookKeys,
  maskWebhookKeys,
  WEBHOOK_PROVIDERS,
  type WebhookKeys,
} from '../webhooks/webhook-keys';

export interface WebhookKeysRoutesDeps extends RbacDeps {
  db: Database | null;
}

const SaveSchema = z.object({
  postmark: z.string().trim().max(255).optional(),
  resend: z.string().trim().max(255).optional(),
  twilio: z.string().trim().max(255).optional(),
  textlink: z.string().trim().max(255).optional(),
});

export function createWebhookKeysRouter(deps: WebhookKeysRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ keys: maskWebhookKeys(null), kmsReady: Boolean(process.env['KMS_KEY']) });
        return;
      }
      const keys = await loadFirmWebhookKeys(deps.db, firmId);
      res.json({ keys: maskWebhookKeys(keys), kmsReady: Boolean(process.env['KMS_KEY']) });
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
      // Blank field keeps the stored value; empty string clears it.
      const next: WebhookKeys = { ...((await loadFirmWebhookKeys(deps.db, firmId)) ?? {}) };
      for (const p of WEBHOOK_PROVIDERS) {
        const v = parsed.data[p];
        if (v === undefined) continue;
        if (v === '') delete next[p];
        else next[p] = v;
      }
      await deps.db
        .update(firmSettings)
        .set({ webhookKeysEncrypted: encryptWebhookKeys(next), updatedAt: new Date() })
        .where(eq(firmSettings.firmId, firmId));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'webhook_keys',
        entityId: firmId,
        actorAppUserId: req.staffSession!.appUserId,
        after: maskWebhookKeys(next), // booleans only — never the secrets
      }).catch(() => undefined);
      res.json({ ok: true, keys: maskWebhookKeys(next) });
    },
  );

  return router;
}
