// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0233 — Settings → SMS inbox. Everything the two-way inbox needs that is
// NOT a credential: enable flag, public base URL + derived webhook URLs,
// polling / retention knobs, default work code, PII warnings, consent
// enforcement, A2P status, the firm's texting lines, and the health card.
// Credentials themselves are edited on /admin/messaging/sms (existing).
//
//   GET    /                  · settings + lines + health
//   PUT    /                  · partial update
//   POST   /test              · verify Twilio creds + Messaging Service
//   GET    /lines             · lines in the Messaging Service
//   POST   /lines/sync        · pull numbers from Twilio → upsert sms_line
//   PATCH  /lines/:id         · label / ingest / default assignee / default
//   DELETE /lines/:id         · archive
//   GET    /health            · SmsHealth snapshot
//   POST   /a2p/refresh       · re-check 10DLC status now

import express, { type Router } from 'express';
import { and, asc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import {
  appUsers,
  firmSettings,
  smsLines,
  type SmsA2pStatus,
  type SmsHealth,
} from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { loadConfig } from '../config';
import { logger } from '../logger';
import { SmsConfig, decryptSmsConfig } from '../messaging/config';
import { loadFirmTwilioInboxConfig, type FirmTwilioInboxConfig } from '../messaging/sms-resolver';
import { resolveSmsPublicBaseUrlFrom, smsWebhookUrls } from './public-url';
import { syncLines } from './lines';
import { createTwilioClient, type TwilioClient } from './twilio-client';

export interface SmsSettingsRoutesDeps extends RbacDeps {
  db: Database | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const UUID_RE = /^[0-9a-fA-F-]{36}$/;

const SettingsPatch = z
  .object({
    enabled: z.boolean().optional(),
    publicBaseUrl: z
      .string()
      .trim()
      .max(255)
      .refine((v) => v === '' || /^https?:\/\/[^\s/]+/.test(v), 'Must be an http(s) origin')
      .nullable()
      .optional(),
    pollIntervalMinutes: z.number().int().min(1).max(60).optional(),
    retentionUnassignedDays: z.number().int().min(1).max(3650).optional(),
    retentionSpamDays: z.number().int().min(1).max(3650).optional(),
    defaultWorkCodeId: z.string().regex(UUID_RE).nullable().optional(),
    piiWarningsEnabled: z.boolean().optional(),
    consentEnforced: z.boolean().optional(),
    a2pOverrideAllow: z.boolean().optional(),
  })
  .strict();

const LinePatch = z
  .object({
    label: z.string().trim().max(80).nullable().optional(),
    ingest: z.boolean().optional(),
    defaultAssigneeUserId: z.string().regex(UUID_RE).nullable().optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

type SettingsRow = typeof firmSettings.$inferSelect;

function settingsView(row: SettingsRow, cfg: FirmTwilioInboxConfig | null) {
  const config = loadConfig();
  const pub = resolveSmsPublicBaseUrlFrom(row.smsPublicBaseUrl, {
    PUBLIC_BASE_URL: config.PUBLIC_BASE_URL,
    APP_BASE_URL: config.APP_BASE_URL,
  });
  return {
    enabled: row.smsInboxEnabled,
    providerReady: Boolean(cfg),
    messagingServiceSid: cfg?.messagingServiceSid ?? null,
    publicBaseUrl: row.smsPublicBaseUrl,
    effectivePublicBaseUrl: pub.baseUrl,
    publicBaseUrlSource: pub.source,
    webhookUrls: smsWebhookUrls(pub.baseUrl),
    pollIntervalMinutes: row.smsPollIntervalMinutes,
    retentionUnassignedDays: row.smsUnassignedRetentionDays,
    retentionSpamDays: row.smsSpamRetentionDays,
    defaultWorkCodeId: row.smsDefaultWorkCodeId,
    piiWarningsEnabled: row.smsPiiWarningsEnabled,
    consentEnforced: row.smsConsentEnforced,
    a2p: {
      status: row.smsA2pStatus,
      checkedAt: row.smsA2pCheckedAt,
      overrideAllow: row.smsA2pOverrideAllow,
    },
  };
}

export function healthView(row: SettingsRow): SmsHealth & {
  configured: boolean;
  lastInboundWebhookAt: Date | null;
  lastStatusWebhookAt: Date | null;
  lastPollAt: Date | null;
  lastSendAt: Date | null;
  webhookGap: boolean;
} {
  const h = (row.smsHealth ?? {}) as SmsHealth;
  return {
    ...h,
    configured: row.smsInboxEnabled,
    lastInboundWebhookAt: row.smsLastInboundWebhookAt,
    lastStatusWebhookAt: row.smsLastStatusWebhookAt,
    lastPollAt: row.smsLastPollAt,
    lastSendAt: row.smsLastSendAt,
    webhookGap: Boolean(h.webhook?.gapDetectedAt),
    a2p: {
      // reason: CHECK constraint in 0233 restricts the column to SmsA2pStatus values
      status: row.smsA2pStatus as SmsA2pStatus,
      checkedAt: row.smsA2pCheckedAt?.toISOString() ?? null,
    },
  };
}

export function createSmsSettingsRouter(deps: SmsSettingsRoutesDeps): Router {
  const router = express.Router();
  const nowFn = deps.now ?? ((): Date => new Date());

  async function loadRow(db: Database, firmId: string): Promise<SettingsRow | null> {
    const [row] = await db
      .select()
      .from(firmSettings)
      .where(eq(firmSettings.firmId, firmId))
      .limit(1);
    return row ?? null;
  }

  async function loadLines(db: Database, firmId: string) {
    const rows = await db
      .select({
        id: smsLines.id,
        phoneNumberE164: smsLines.phoneNumberE164,
        twilioSid: smsLines.twilioSid,
        label: smsLines.label,
        defaultAssigneeUserId: smsLines.defaultAssigneeUserId,
        defaultAssigneeName: appUsers.fullName,
        ingest: smsLines.ingest,
        isDefault: smsLines.isDefault,
        status: smsLines.status,
        pollCursorAt: smsLines.pollCursorAt,
        lastPolledAt: smsLines.lastPolledAt,
      })
      .from(smsLines)
      .leftJoin(appUsers, eq(appUsers.id, smsLines.defaultAssigneeUserId))
      .where(and(eq(smsLines.firmId, firmId), eq(smsLines.status, 'ACTIVE')))
      .orderBy(asc(smsLines.createdAt), asc(smsLines.phoneNumberE164));
    return rows;
  }

  function clientFor(cfg: FirmTwilioInboxConfig): TwilioClient {
    return createTwilioClient({ ...cfg, fetchImpl: deps.fetchImpl }, logger);
  }

  // ----- settings ---------------------------------------------------

  router.get('/', requirePermission(deps, 'firm:settings:read'), async (req, res) => {
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const row = await loadRow(deps.db, firmId);
    if (!row) {
      res.status(404).json({ error: 'firm_settings_missing' });
      return;
    }
    const cfg = await loadFirmTwilioInboxConfig(deps.db, firmId, logger);
    res.json({
      settings: settingsView(row, cfg),
      lines: await loadLines(deps.db, firmId),
      health: healthView(row),
    });
  });

  router.put('/', requirePermission(deps, 'firm:settings:write'), async (req, res) => {
    const parsed = SettingsPatch.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_sms_settings', issues: parsed.error.issues });
      return;
    }
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const before = await loadRow(deps.db, firmId);
    if (!before) {
      res.status(404).json({ error: 'firm_settings_missing' });
      return;
    }
    const p = parsed.data;
    const set: Partial<typeof firmSettings.$inferInsert> = { updatedAt: nowFn() };
    if (p.enabled !== undefined) set.smsInboxEnabled = p.enabled;
    if (p.publicBaseUrl !== undefined) {
      set.smsPublicBaseUrl = p.publicBaseUrl ? p.publicBaseUrl.replace(/\/+$/, '') : null;
    }
    if (p.pollIntervalMinutes !== undefined) set.smsPollIntervalMinutes = p.pollIntervalMinutes;
    if (p.retentionUnassignedDays !== undefined) {
      set.smsUnassignedRetentionDays = p.retentionUnassignedDays;
    }
    if (p.retentionSpamDays !== undefined) set.smsSpamRetentionDays = p.retentionSpamDays;
    if (p.defaultWorkCodeId !== undefined) set.smsDefaultWorkCodeId = p.defaultWorkCodeId;
    if (p.piiWarningsEnabled !== undefined) set.smsPiiWarningsEnabled = p.piiWarningsEnabled;
    if (p.consentEnforced !== undefined) set.smsConsentEnforced = p.consentEnforced;
    if (p.a2pOverrideAllow !== undefined) set.smsA2pOverrideAllow = p.a2pOverrideAllow;
    await deps.db.update(firmSettings).set(set).where(eq(firmSettings.firmId, firmId));
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'sms_settings',
      entityId: firmId,
      actorAppUserId: req.staffSession!.appUserId,
      before: pickAudit(before),
      after: { ...pickAudit(before), ...p },
      ip: req.ip,
      userAgent: req.get('user-agent') ?? null,
    }).catch(() => undefined);
    const row = await loadRow(deps.db, firmId);
    const cfg = await loadFirmTwilioInboxConfig(deps.db, firmId, logger);
    res.json({ ok: true, settings: settingsView(row!, cfg) });
  });

  // Verify credentials + Messaging Service. Body: { config?: SmsConfig } —
  // a proposed (unsaved) twilio config, or omitted to test the saved one.
  router.post('/test', requirePermission(deps, 'firm:settings:write'), async (req, res) => {
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    let cfg: FirmTwilioInboxConfig | null = null;
    const body = (req.body ?? {}) as { config?: unknown };
    if (body.config) {
      const parsed = SmsConfig.safeParse(body.config);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_sms_config', issues: parsed.error.issues });
        return;
      }
      if (parsed.data.provider !== 'twilio') {
        res.status(400).json({ error: 'inbox_requires_twilio' });
        return;
      }
      const c = parsed.data;
      cfg = {
        accountSid: c.accountSid,
        authToken: c.authToken,
        messagingServiceSid: c.messagingServiceSid ?? '',
        from: c.from,
        apiKeySid: c.apiKeySid,
        apiKeySecret: c.apiKeySecret,
      };
    } else {
      const [row] = await deps.db
        .select({ enc: firmSettings.smsConfigEncrypted })
        .from(firmSettings)
        .where(eq(firmSettings.firmId, firmId))
        .limit(1);
      if (!row?.enc) {
        res.status(400).json({ error: 'no_saved_sms_config' });
        return;
      }
      const saved = decryptSmsConfig(row.enc);
      if (saved.provider !== 'twilio') {
        res.status(400).json({ error: 'inbox_requires_twilio', provider: saved.provider });
        return;
      }
      cfg = {
        accountSid: saved.accountSid,
        authToken: saved.authToken,
        messagingServiceSid: saved.messagingServiceSid ?? '',
        from: saved.from,
        apiKeySid: saved.apiKeySid,
        apiKeySecret: saved.apiKeySecret,
      };
    }
    const client = clientFor(cfg);
    const creds = await client.verifyCredentials();
    if (!creds.ok) {
      res.json({ ok: false, error: creds.error ?? 'credentials_rejected' });
      return;
    }
    let messagingService: { sid: string; friendlyName: string } | null = null;
    let lineCount = 0;
    let error: string | null = null;
    if (cfg.messagingServiceSid) {
      try {
        messagingService = await client.getMessagingService(cfg.messagingServiceSid);
        lineCount = (await client.listMessagingServicePhoneNumbers(cfg.messagingServiceSid)).length;
      } catch (err) {
        error = err instanceof Error ? err.message : 'messaging_service_lookup_failed';
      }
    }
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'sms_settings',
      entityId: `${firmId}:test`,
      actorAppUserId: req.staffSession!.appUserId,
      after: { ok: !error, accountName: creds.accountName ?? null, lineCount },
    }).catch(() => undefined);
    res.json({
      ok: !error,
      accountName: creds.accountName ?? null,
      messagingService,
      messagingServiceFound: Boolean(messagingService),
      lineCount,
      error,
    });
  });

  // ----- lines ------------------------------------------------------

  router.get('/lines', requirePermission(deps, 'firm:settings:read'), async (req, res) => {
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    res.json({ items: await loadLines(deps.db, firmId) });
  });

  router.post('/lines/sync', requirePermission(deps, 'firm:settings:write'), async (req, res) => {
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const db = deps.db;
    const cfg = await loadFirmTwilioInboxConfig(db, firmId, logger);
    if (!cfg) {
      res.status(400).json({ error: 'inbox_not_configured' });
      return;
    }
    let numbers: Array<{ sid: string; phoneNumber: string }>;
    try {
      numbers = await clientFor(cfg).listMessagingServicePhoneNumbers(cfg.messagingServiceSid);
    } catch (err) {
      res.status(502).json({
        error: 'twilio_error',
        detail: err instanceof Error ? err.message : 'lookup_failed',
      });
      return;
    }
    const result = await syncLines(db, firmId, numbers, nowFn());
    await emitAudit(db, {
      action: 'UPDATE',
      entityType: 'sms_line',
      entityId: firmId,
      actorAppUserId: req.staffSession!.appUserId,
      after: { synced: numbers.length, added: result.added, archived: result.archived },
    }).catch(() => undefined);
    res.json({ ok: true, ...result, items: await loadLines(db, firmId) });
  });

  router.patch('/lines/:id', requirePermission(deps, 'firm:settings:write'), async (req, res) => {
    const firmId = req.staffSession?.firmId;
    const id = req.params['id'] ?? '';
    if (!firmId || !deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const parsed = LinePatch.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_line', issues: parsed.error.issues });
      return;
    }
    const db = deps.db;
    const [before] = await db
      .select()
      .from(smsLines)
      .where(and(eq(smsLines.id, id), eq(smsLines.firmId, firmId)))
      .limit(1);
    if (!before) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const p = parsed.data;
    await db.transaction(async (tx) => {
      if (p.isDefault === true) {
        await tx
          .update(smsLines)
          .set({ isDefault: false, updatedAt: nowFn() })
          .where(and(eq(smsLines.firmId, firmId), ne(smsLines.id, id)));
      }
      const set: Partial<typeof smsLines.$inferInsert> = { updatedAt: nowFn() };
      if (p.label !== undefined) set.label = p.label || null;
      if (p.ingest !== undefined) set.ingest = p.ingest;
      if (p.defaultAssigneeUserId !== undefined)
        set.defaultAssigneeUserId = p.defaultAssigneeUserId;
      if (p.isDefault !== undefined) set.isDefault = p.isDefault;
      await tx.update(smsLines).set(set).where(eq(smsLines.id, id));
    });
    await emitAudit(db, {
      action: 'UPDATE',
      entityType: 'sms_line',
      entityId: id,
      actorAppUserId: req.staffSession!.appUserId,
      before: {
        label: before.label,
        ingest: before.ingest,
        defaultAssigneeUserId: before.defaultAssigneeUserId,
        isDefault: before.isDefault,
      },
      after: p,
    }).catch(() => undefined);
    res.json({ ok: true, items: await loadLines(db, firmId) });
  });

  router.delete('/lines/:id', requirePermission(deps, 'firm:settings:write'), async (req, res) => {
    const firmId = req.staffSession?.firmId;
    const id = req.params['id'] ?? '';
    if (!firmId || !deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const updated = await deps.db
      .update(smsLines)
      .set({ status: 'ARCHIVED', isDefault: false, ingest: false, updatedAt: nowFn() })
      .where(and(eq(smsLines.id, id), eq(smsLines.firmId, firmId)))
      .returning({ id: smsLines.id });
    if (updated.length === 0) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await emitAudit(deps.db, {
      action: 'ARCHIVE',
      entityType: 'sms_line',
      entityId: id,
      actorAppUserId: req.staffSession!.appUserId,
    }).catch(() => undefined);
    res.json({ ok: true });
  });

  // ----- health + a2p -----------------------------------------------

  router.get('/health', requirePermission(deps, 'firm:settings:read'), async (req, res) => {
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const row = await loadRow(deps.db, firmId);
    if (!row) {
      res.status(404).json({ error: 'firm_settings_missing' });
      return;
    }
    res.json(healthView(row));
  });

  router.post('/a2p/refresh', requirePermission(deps, 'firm:settings:write'), async (req, res) => {
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const cfg = await loadFirmTwilioInboxConfig(deps.db, firmId, logger);
    if (!cfg) {
      res.status(400).json({ error: 'inbox_not_configured' });
      return;
    }
    const status = await clientFor(cfg).getA2pStatus(cfg.messagingServiceSid);
    await deps.db
      .update(firmSettings)
      .set({ smsA2pStatus: status, smsA2pCheckedAt: nowFn(), updatedAt: nowFn() })
      .where(eq(firmSettings.firmId, firmId));
    res.json({ ok: true, status, checkedAt: nowFn() });
  });

  return router;
}

function pickAudit(row: SettingsRow): Record<string, unknown> {
  return {
    enabled: row.smsInboxEnabled,
    publicBaseUrl: row.smsPublicBaseUrl,
    pollIntervalMinutes: row.smsPollIntervalMinutes,
    retentionUnassignedDays: row.smsUnassignedRetentionDays,
    retentionSpamDays: row.smsSpamRetentionDays,
    defaultWorkCodeId: row.smsDefaultWorkCodeId,
    piiWarningsEnabled: row.smsPiiWarningsEnabled,
    consentEnforced: row.smsConsentEnforced,
    a2pOverrideAllow: row.smsA2pOverrideAllow,
  };
}
