// SPDX-License-Identifier: Elastic-2.0
//
// Admin endpoints for messaging provider configuration (v2 Sprint A,
// workstream 3.1).
//
//   GET    /admin/messaging                     · current masked config
//   PUT    /admin/messaging/email               · upsert email provider
//   PUT    /admin/messaging/sms                 · upsert sms provider
//   POST   /admin/messaging/email/test          · send test email
//   POST   /admin/messaging/sms/test            · send test SMS
//   DELETE /admin/messaging/email               · clear (fall back to env)
//   DELETE /admin/messaging/sms                 · clear (fall back to env)
//
// All endpoints are firm-scoped via the staff session. Credentials never
// leave the API as plaintext — read responses are masked. Test-send
// supports two modes: validate the *currently saved* config, or validate
// a *proposed* config supplied in the request body (so users can verify
// before persisting).

import express, { type Request, type Response, type Router } from 'express';
import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { firmSettings } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';
import {
  EmailConfig,
  SmsConfig,
  VoiceConfig,
  decryptEmailConfig,
  decryptSmsConfig,
  decryptVoiceConfig,
  encryptEmailConfig,
  encryptSmsConfig,
  encryptVoiceConfig,
  maskEmailConfig,
  maskSmsConfig,
  maskVoiceConfig,
} from './config';
import { buildMailProvider, buildSmsProvider } from './factory';
import { placeVoiceCall } from '../voice/place-call';

export interface MessagingRoutesDeps extends RbacDeps {
  db: Database | null;
}

async function loadCurrentEnvelopes(
  db: Database,
  firmId: string,
): Promise<{ mail: string | null; sms: string | null; voice: string | null }> {
  const [row] = await db
    .select({
      mail: firmSettings.mailConfigEncrypted,
      sms: firmSettings.smsConfigEncrypted,
      voice: firmSettings.voiceConfigEncrypted,
    })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, firmId))
    .limit(1);
  return { mail: row?.mail ?? null, sms: row?.sms ?? null, voice: row?.voice ?? null };
}

export function createMessagingRouter(deps: MessagingRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ email: null, sms: null });
        return;
      }
      const envelopes = await loadCurrentEnvelopes(deps.db, firmId);
      const email = envelopes.mail ? maskEmailConfig(decryptEmailConfig(envelopes.mail)) : null;
      const sms = envelopes.sms ? maskSmsConfig(decryptSmsConfig(envelopes.sms)) : null;
      const voice = envelopes.voice ? maskVoiceConfig(decryptVoiceConfig(envelopes.voice)) : null;
      res.json({ email, sms, voice });
    },
  );

  router.put(
    '/email',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const parsed = EmailConfig.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_email_config', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      const envelope = encryptEmailConfig(parsed.data);
      await deps.db
        .update(firmSettings)
        .set({
          mailConfigEncrypted: envelope,
          mailConfigUpdatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(firmSettings.firmId, firmId));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'messaging_config',
        entityId: `${firmId}:email`,
        actorAppUserId: req.staffSession!.appUserId,
        // audit records the provider id but never the credentials.
        after: { provider: parsed.data.provider, from: parsed.data.from },
      }).catch(() => undefined);
      res.json({ ok: true, masked: maskEmailConfig(parsed.data) });
    },
  );

  router.put(
    '/sms',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const parsed = SmsConfig.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_sms_config', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      const envelope = encryptSmsConfig(parsed.data);
      await deps.db
        .update(firmSettings)
        .set({
          smsConfigEncrypted: envelope,
          smsConfigUpdatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(firmSettings.firmId, firmId));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'messaging_config',
        entityId: `${firmId}:sms`,
        actorAppUserId: req.staffSession!.appUserId,
        after: { provider: parsed.data.provider },
      }).catch(() => undefined);
      res.json({ ok: true, masked: maskSmsConfig(parsed.data) });
    },
  );

  router.delete(
    '/email',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(firmSettings)
        .set({ mailConfigEncrypted: null, mailConfigUpdatedAt: new Date() })
        .where(eq(firmSettings.firmId, firmId));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'messaging_config',
        entityId: `${firmId}:email`,
        actorAppUserId: req.staffSession!.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  router.delete(
    '/sms',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(firmSettings)
        .set({ smsConfigEncrypted: null, smsConfigUpdatedAt: new Date() })
        .where(eq(firmSettings.firmId, firmId));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'messaging_config',
        entityId: `${firmId}:sms`,
        actorAppUserId: req.staffSession!.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // ----- Voice (0206) — separate Twilio account for automated calls -----

  router.put(
    '/voice',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const parsed = VoiceConfig.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_voice_config', issues: parsed.error.issues });
        return;
      }
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      const envelope = encryptVoiceConfig(parsed.data);
      await deps.db
        .update(firmSettings)
        .set({
          voiceConfigEncrypted: envelope,
          voiceConfigUpdatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(firmSettings.firmId, firmId));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'messaging_config',
        entityId: `${firmId}:voice`,
        actorAppUserId: req.staffSession!.appUserId,
        after: {
          provider: 'twilio',
          from: parsed.data.from,
          defaultVoice: parsed.data.defaultVoice,
          window: `${parsed.data.windowStart}-${parsed.data.windowEnd}`,
        },
      }).catch(() => undefined);
      res.json({ ok: true, masked: maskVoiceConfig(parsed.data) });
    },
  );

  router.delete(
    '/voice',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(firmSettings)
        .set({ voiceConfigEncrypted: null, voiceConfigUpdatedAt: new Date() })
        .where(eq(firmSettings.firmId, firmId));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'messaging_config',
        entityId: `${firmId}:voice`,
        actorAppUserId: req.staffSession!.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // Place a live test call so the admin can hear the configured voice.
  // Body: { to: string, config?: VoiceConfig } — when config is supplied
  // it is persisted-first semantics NOT used; we save nothing and pass
  // the proposed creds straight to the dialer. Test calls bypass the
  // window and do-not-call gates.
  router.post(
    '/voice/test',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
      if (!to) {
        res.status(400).json({ error: 'missing_to' });
        return;
      }
      if (!firmId || !deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      // Proposed (unsaved) config: stash it temporarily by encrypting to a
      // scratch object the dialer can use — placeVoiceCall reads the saved
      // config, so for proposed-config tests we save-then-test is avoided
      // by passing through a one-off resolution here.
      let proposed: VoiceConfig | null = null;
      if (req.body?.config != null) {
        const parsed = VoiceConfig.safeParse(req.body.config);
        if (!parsed.success) {
          res.status(400).json({ error: 'invalid_voice_config', issues: parsed.error.issues });
          return;
        }
        proposed = parsed.data;
      }
      const script = `Hello. This is a test call from your Vibe Time and Billing appliance. The configured voice is working.`;
      const result = await placeVoiceCall(deps.db, {
        firmId,
        kind: 'test',
        to,
        script,
        voice: proposed?.defaultVoice ?? null,
        bypassGates: true,
        publicBaseUrl: process.env['APP_BASE_URL'],
        configOverride: proposed ?? undefined,
      });
      if (!result.ok) {
        res.status(502).json({ error: result.code, detail: result.detail ?? null });
        return;
      }
      res.json({ ok: true, callSid: result.callSid });
    },
  );

  // Test-send. Body shape:
  //   { to: string, config?: <full email/sms config> }
  // When config is provided, the new credentials are tried without
  // persisting. When omitted, the currently-saved config is used.
  router.post(
    '/email/test',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as { to?: string; config?: unknown };
      if (!body.to || typeof body.to !== 'string') {
        res.status(400).json({ error: 'missing_to' });
        return;
      }
      let cfg: EmailConfig | null = null;
      if (body.config) {
        const parsed = EmailConfig.safeParse(body.config);
        if (!parsed.success) {
          res.status(400).json({ error: 'invalid_email_config', issues: parsed.error.issues });
          return;
        }
        cfg = parsed.data;
      } else if (req.staffSession?.firmId && deps.db) {
        const envelopes = await loadCurrentEnvelopes(deps.db, req.staffSession.firmId);
        if (!envelopes.mail) {
          res.status(400).json({ error: 'no_saved_email_config' });
          return;
        }
        cfg = decryptEmailConfig(envelopes.mail);
      } else {
        res.status(400).json({ error: 'no_saved_email_config' });
        return;
      }
      try {
        const provider = buildMailProvider(cfg, logger);
        const result = await provider.send({
          to: body.to,
          subject: 'Vibe Practice Management — test email',
          body: `This is a test message from your Vibe Practice Management appliance, confirming the ${cfg.provider} email provider is configured correctly.`,
        });
        if (deps.db && req.staffSession) {
          await emitAudit(deps.db, {
            action: 'UPDATE',
            entityType: 'messaging_config',
            entityId: `test:email`,
            actorAppUserId: req.staffSession.appUserId,
            after: { provider: cfg.provider, to: body.to, ok: result.ok },
          }).catch(() => undefined);
        }
        res.json(result);
      } catch (err) {
        res.status(500).json({
          ok: false,
          error: err instanceof Error ? err.message : 'test_failed',
        });
      }
    },
  );

  router.post(
    '/sms/test',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as { to?: string; config?: unknown };
      if (!body.to || typeof body.to !== 'string') {
        res.status(400).json({ error: 'missing_to' });
        return;
      }
      let cfg: SmsConfig | null = null;
      if (body.config) {
        const parsed = SmsConfig.safeParse(body.config);
        if (!parsed.success) {
          res.status(400).json({ error: 'invalid_sms_config', issues: parsed.error.issues });
          return;
        }
        cfg = parsed.data;
      } else if (req.staffSession?.firmId && deps.db) {
        const envelopes = await loadCurrentEnvelopes(deps.db, req.staffSession.firmId);
        if (!envelopes.sms) {
          res.status(400).json({ error: 'no_saved_sms_config' });
          return;
        }
        cfg = decryptSmsConfig(envelopes.sms);
      } else {
        res.status(400).json({ error: 'no_saved_sms_config' });
        return;
      }
      try {
        const provider = buildSmsProvider(cfg, logger);
        const result = await provider.send({
          to: body.to,
          body: 'Vibe Practice Management test SMS.',
        });
        if (deps.db && req.staffSession) {
          await emitAudit(deps.db, {
            action: 'UPDATE',
            entityType: 'messaging_config',
            entityId: `test:sms`,
            actorAppUserId: req.staffSession.appUserId,
            after: { provider: cfg.provider, to: body.to, ok: result.ok },
          }).catch(() => undefined);
        }
        res.json(result);
      } catch (err) {
        res.status(500).json({
          ok: false,
          error: err instanceof Error ? err.message : 'test_failed',
        });
      }
    },
  );

  return router;
}
