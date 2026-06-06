// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CAL-1 — firm admin OAuth app registration (mounted at
// /api/staff/admin/calendar). Stores Microsoft 365 / Google client
// credentials encrypted under the firm MFK; never returns secrets. A
// provider must be enabled before staff can connect it (CAL-2).

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, isNull, lte } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  calendarEventMatches,
  calendarEvents,
  calendarProviderConfig,
  clients,
  staffCalendarConnections,
} from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { getApplianceLockState } from '../crypto/boot';
import { decField, encField, newCalendarRecordKey, unwrapCalendarRecordKey } from './crypto';
import { testProvider } from './provider-test';
import { hasWriteScope, type CalendarProvider } from './oauth';
import { getCalendarSettings, upsertCalendarSettings } from './settings';

export interface CalendarAdminDeps extends RbacDeps {
  db: Database | null;
  /** Injected in tests for the Test-Connection probe; defaults to global fetch. */
  testFetch?: typeof fetch;
}

const PROVIDERS = ['microsoft', 'google'] as const;
type Provider = (typeof PROVIDERS)[number];

function isProvider(v: string): v is Provider {
  return (PROVIDERS as readonly string[]).includes(v);
}

const UpsertSchema = z.object({
  clientId: z.string().trim().min(1).max(400),
  // Optional on update: omit to preserve the stored secret (masked input).
  clientSecret: z.string().trim().min(1).max(1000).optional(),
  tenantId: z.string().trim().max(200).optional(),
  enabled: z.boolean().optional(),
});

const TestSchema = z.object({
  clientId: z.string().trim().min(1).max(400).optional(),
  clientSecret: z.string().trim().min(1).max(1000).optional(),
  tenantId: z.string().trim().max(200).optional(),
});

const SettingsSchema = z.object({
  syncIntervalMinutes: z.number().int().min(5).max(60).optional(),
  lookbackDays: z.number().int().min(1).max(60).optional(),
  lookaheadDays: z.number().int().min(7).max(365).optional(),
  reminderOffsetsMinutes: z.array(z.number().int()).max(4).optional(),
});

export function createCalendarAdminRouter(deps: CalendarAdminDeps): Router {
  const router = express.Router();

  function requireUnlocked(firmId: string, res: Response): boolean {
    const lock = getApplianceLockState();
    if (lock.kind !== 'unlocked' || lock.firmId !== firmId) {
      res.status(503).json({ error: 'appliance_locked' });
      return false;
    }
    return true;
  }

  async function loadConfig(db: Database, firmId: string, provider: Provider) {
    const [row] = await db
      .select()
      .from(calendarProviderConfig)
      .where(
        and(
          eq(calendarProviderConfig.firmId, firmId),
          eq(calendarProviderConfig.provider, provider),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  // GET /providers — status of both providers (never the secrets).
  router.get(
    '/providers',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ providers: [] });
        return;
      }
      const rows = await deps.db
        .select({
          provider: calendarProviderConfig.provider,
          enabled: calendarProviderConfig.enabled,
          clientIdEnc: calendarProviderConfig.clientIdEnc,
          tenantIdEnc: calendarProviderConfig.tenantIdEnc,
          updatedAt: calendarProviderConfig.updatedAt,
        })
        .from(calendarProviderConfig)
        .where(eq(calendarProviderConfig.firmId, firmId));
      const byProvider = new Map(rows.map((r) => [r.provider, r]));
      res.json({
        providers: PROVIDERS.map((p) => {
          const r = byProvider.get(p);
          return {
            provider: p,
            configured: Boolean(r),
            enabled: r?.enabled ?? false,
            hasTenant: Boolean(r?.tenantIdEnc),
            updatedAt: r?.updatedAt ?? null,
          };
        }),
      });
    },
  );

  // PUT /providers/:provider — create/update the app registration.
  router.put(
    '/providers/:provider',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const actor = req.staffSession!.appUserId;
      const provider = req.params['provider']!;
      if (!isProvider(provider)) {
        res.status(400).json({ error: 'unknown_provider' });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      if (!requireUnlocked(firmId, res)) return;
      const parsed = UpsertSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
        return;
      }
      if (provider === 'microsoft' && !parsed.data.tenantId) {
        res.status(400).json({ error: 'tenant_id_required' });
        return;
      }

      const existing = await loadConfig(deps.db, firmId, provider);
      // Resolve the secret: use the submitted one, else preserve the stored
      // one (the UI masks it and may omit on edits).
      let secret = parsed.data.clientSecret;
      if (!secret) {
        if (!existing) {
          res.status(400).json({ error: 'client_secret_required' });
          return;
        }
        const dek = unwrapCalendarRecordKey(deps.db, firmId, existing.tDekWrapped);
        secret = decField(dek, existing.clientSecretEnc) ?? '';
      }

      const { dek, wrappedDek } = newCalendarRecordKey(deps.db, firmId);
      const values = {
        firmId,
        provider,
        tDekWrapped: Buffer.from(wrappedDek),
        clientIdEnc: encField(dek, parsed.data.clientId)!,
        clientSecretEnc: encField(dek, secret)!,
        tenantIdEnc: encField(dek, parsed.data.tenantId ?? null),
        enabled: parsed.data.enabled ?? existing?.enabled ?? false,
        updatedAt: new Date(),
      };
      await deps.db
        .insert(calendarProviderConfig)
        .values(values)
        .onConflictDoUpdate({
          target: [calendarProviderConfig.firmId, calendarProviderConfig.provider],
          set: {
            tDekWrapped: values.tDekWrapped,
            clientIdEnc: values.clientIdEnc,
            clientSecretEnc: values.clientSecretEnc,
            tenantIdEnc: values.tenantIdEnc,
            enabled: values.enabled,
            updatedAt: values.updatedAt,
          },
        });
      await emitAudit(deps.db, {
        action: existing ? 'UPDATE' : 'CREATE',
        entityType: 'calendar_provider_config',
        entityId: firmId,
        actorAppUserId: actor,
        after: {
          provider,
          enabled: values.enabled,
          secretRotated: Boolean(parsed.data.clientSecret),
        },
      });
      res.json({ ok: true });
    },
  );

  // POST /providers/:provider/test — verify credentials (submitted or stored).
  router.post(
    '/providers/:provider/test',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const provider = req.params['provider']!;
      if (!isProvider(provider)) {
        res.status(400).json({ error: 'unknown_provider' });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      if (!requireUnlocked(firmId, res)) return;
      const parsed = TestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_body' });
        return;
      }

      let { clientId, clientSecret, tenantId } = parsed.data;
      if (!clientId || !clientSecret) {
        const existing = await loadConfig(deps.db, firmId, provider);
        if (!existing) {
          res.status(400).json({ error: 'not_configured' });
          return;
        }
        const dek = unwrapCalendarRecordKey(deps.db, firmId, existing.tDekWrapped);
        clientId = clientId ?? decField(dek, existing.clientIdEnc) ?? '';
        clientSecret = clientSecret ?? decField(dek, existing.clientSecretEnc) ?? '';
        tenantId = tenantId ?? decField(dek, existing.tenantIdEnc) ?? undefined;
      }

      const result = await testProvider(
        provider,
        { clientId, clientSecret, tenantId },
        deps.testFetch ?? fetch,
      );
      res.json(result);
    },
  );

  // GET /settings — sync interval + lookback/lookahead (with defaults).
  router.get(
    '/settings',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ syncIntervalMinutes: 15, lookbackDays: 7, lookaheadDays: 90 });
        return;
      }
      res.json(await getCalendarSettings(deps.db, firmId));
    },
  );

  // PUT /settings — update sync tunables (clamped server-side).
  router.put(
    '/settings',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = SettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_body' });
        return;
      }
      const saved = await upsertCalendarSettings(deps.db, firmId, parsed.data);
      res.json(saved);
    },
  );

  // GET /overview — all-staff appointments (filterable). Admin/partner view.
  router.get(
    '/overview',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const conds = [eq(calendarEvents.firmId, firmId), isNull(calendarEvents.softDeletedAt)];
      const from = req.query['from'] ? new Date(String(req.query['from'])) : null;
      const to = req.query['to'] ? new Date(String(req.query['to'])) : null;
      if (from && !Number.isNaN(from.getTime())) conds.push(gte(calendarEvents.startAt, from));
      if (to && !Number.isNaN(to.getTime())) conds.push(lte(calendarEvents.startAt, to));
      if (req.query['staffId'])
        conds.push(eq(calendarEvents.staffId, String(req.query['staffId'])));

      const rows = await deps.db
        .select({
          id: calendarEvents.id,
          subject: calendarEvents.subject,
          startAt: calendarEvents.startAt,
          endAt: calendarEvents.endAt,
          staffId: calendarEvents.staffId,
          staffName: appUsers.fullName,
          clientName: clients.name,
          matchTier: calendarEventMatches.matchTier,
          matchStatus: calendarEventMatches.matchStatus,
        })
        .from(calendarEvents)
        .leftJoin(appUsers, eq(appUsers.id, calendarEvents.staffId))
        .leftJoin(calendarEventMatches, eq(calendarEventMatches.eventId, calendarEvents.id))
        .leftJoin(clients, eq(clients.id, calendarEventMatches.clientId))
        .where(and(...conds))
        .orderBy(desc(calendarEvents.startAt))
        .limit(1000);

      if (String(req.query['format'] ?? '') === 'csv') {
        const header = 'subject,staff,client,start,end,match_tier,match_status\n';
        const csv = rows
          .map((r) =>
            [
              r.subject ?? '',
              r.staffName ?? '',
              r.clientName ?? '',
              r.startAt?.toISOString() ?? '',
              r.endAt?.toISOString() ?? '',
              r.matchTier ?? '',
              r.matchStatus ?? '',
            ]
              .map((v) => `"${String(v).replace(/"/g, '""')}"`)
              .join(','),
          )
          .join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="calendar-overview.csv"');
        res.send(header + csv);
        return;
      }
      res.json({ items: rows });
    },
  );

  // GET /health — all staff connections' sync health.
  router.get(
    '/health',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ connections: [] });
        return;
      }
      const rows = await deps.db
        .select({
          id: staffCalendarConnections.id,
          staffName: appUsers.fullName,
          provider: staffCalendarConnections.provider,
          providerEmail: staffCalendarConnections.providerEmail,
          enabled: staffCalendarConnections.enabled,
          syncError: staffCalendarConnections.syncError,
          lastSyncedAt: staffCalendarConnections.lastSyncedAt,
          scope: staffCalendarConnections.scope,
        })
        .from(staffCalendarConnections)
        .leftJoin(appUsers, eq(appUsers.id, staffCalendarConnections.staffId))
        .where(eq(staffCalendarConnections.firmId, firmId));
      // BK-5 — surface which connections can receive appointment write-back.
      const connections = rows.map(({ scope, ...r }) => ({
        ...r,
        canWrite: hasWriteScope(r.provider as CalendarProvider, scope),
      }));
      res.json({ connections });
    },
  );

  return router;
}
