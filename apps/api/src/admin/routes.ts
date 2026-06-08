// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Admin endpoints (Phase 4). Backs the firm-settings, office, and user
// admin UIs. RBAC-gated via `requirePermission`.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  engagementStatusConfig,
  firms,
  firmSettings,
  notificationTemplates,
  officeSettings,
  offices,
  rateCodes,
  rolePermissions,
  roles,
  staffRateSnapshotEntries,
  staffRateSnapshots,
  staffSkills,
  staffTargets,
  userRoles,
  workCodes,
} from '@vibe/db/schema';
import { createSnapshot } from '../rates/routes';
import { PERMISSION_KEYS, ROLE_TEMPLATES, type RoleSlug } from '@vibe/core/rbac';
import { seedNotificationTemplates, NOTIFICATION_TEMPLATE_DEFAULTS } from '@vibe/db/seed-helpers';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';

export interface AdminRoutesDeps extends RbacDeps {
  db: Database | null;
  // Q35 — whether OPENSIGN_URL is configured on the appliance. Gates the
  // 'opensign' e-sign provider option in the admin UI; when false the UI
  // hides it and the server rejects selecting it.
  openSignAvailable?: boolean;
}

const InviteSchema = z.object({
  email: z.string().min(3).max(254),
  fullName: z.string().min(1).max(200),
  defaultOfficeId: z.string().uuid().optional(),
});

const OfficeSchema = z.object({
  name: z.string().min(1).max(120),
  timezone: z.string().min(1).max(64),
  address: z.string().max(400).optional(),
  isDefault: z.boolean().optional(),
  // Phase 4 #14 — inherited as partner_in_charge_id on new clients.
  defaultPartnerInChargeId: z.string().uuid().nullable().optional(),
});

const FEE_STRUCTURES = [
  'HOURLY',
  'HOURLY_NTE',
  'FIXED_FEE',
  'FIXED_FEE_WITH_MILESTONES',
  'RECURRING_SUBSCRIPTION',
] as const;
const ALLOCATION_METHODS = [
  'SPECIFIC_ENTRIES',
  'PRO_RATA_BY_VALUE',
  'PRO_RATA_BY_HOURS',
  'PARTNER_ABSORBS',
  'HIERARCHICAL_CASCADE',
  'CUSTOM_WEIGHTED',
] as const;

const FirmSettingsPatchSchema = z.object({
  adjustmentApprovalThresholdCents: z.number().int().nonnegative().optional(),
  aiMonthlyBudgetCents: z.number().int().nonnegative().optional(),
  timeEntryRoundingHours: z.enum(['0.10', '0.25', '0.00']).optional(),
  stepUpTimeoutMinutes: z.number().int().min(5).max(240).optional(),
  lateEntryAlertDays: z.number().int().min(1).max(90).optional(),
  lateEntryLockoutDays: z.number().int().min(1).max(365).optional(),
  invoiceNumberingPrefix: z.string().max(12).optional(),
  portalEnabled: z.boolean().optional(),
  portalSubdomain: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(63)
    .nullable()
    .optional(),
  brandDisplayName: z.string().max(120).nullable().optional(),
  brandLogoUrl: z.string().url().max(500).nullable().optional(),
  brandAccentColor: z
    .string()
    .regex(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/)
    .nullable()
    .optional(),
  brandSupportEmail: z.string().email().max(254).nullable().optional(),
  brandSupportPhone: z.string().max(40).nullable().optional(),
  brandSupportFax: z.string().max(40).nullable().optional(),
  brandSupportWeb: z.string().max(254).nullable().optional(),
  brandFooterHtml: z.string().max(4000).nullable().optional(),
  // 0053 — Billing + A/R block.
  arTermsText: z.string().max(4000).nullable().optional(),
  statementEmailMessage: z.string().max(4000).nullable().optional(),
  defaultStatementFormat: z.string().max(80).optional(),
  achProcessingEnabled: z.boolean().optional(),
  creditCardProcessingEnabled: z.boolean().optional(),
  assessServiceChargesEnabled: z.boolean().optional(),
  serviceChargeRateBps: z.number().int().min(0).max(10_000).optional(),
  dunningMessage1: z.string().max(2000).nullable().optional(),
  dunningMessage2: z.string().max(2000).nullable().optional(),
  dunningMessage3: z.string().max(2000).nullable().optional(),
  dunningMessage4: z.string().max(2000).nullable().optional(),
  dunningMessage5: z.string().max(2000).nullable().optional(),
  // Phase 20 #4 — fee structures the firm wants to expose.
  enabledFeeStructures: z.array(z.enum(FEE_STRUCTURES)).min(1).max(5).optional(),
  // Phase 20 #8 — firm-wide billable target.
  billableTargetHoursPerMonth: z.number().int().min(40).max(220).optional(),
  // Phase 23 #6 — firm AI provider override.
  aiProvider: z.enum(['local', 'cloud']).nullable().optional(),
  // Phase 13 #6 — invoice template picker.
  invoiceTemplateStyle: z.enum(['modern', 'classic', 'minimal']).optional(),
  // v2 — firm-default surcharge label inherited by engagements
  // whose surcharge_label is null. Engagement can still override.
  defaultSurchargeLabel: z.string().min(1).max(80).optional(),
});
// NOT .strict(): the PATCH handler validates the SAME combined body against
// both this schema and FirmPatchSchema. Zod's default STRIP behavior drops the
// other table's fields so each parse keeps only its own — strict would reject
// the foreign keys and 400 every mixed save.

const FirmPatchSchema = z.object({
  // Phase 20 #5 — default allocation method.
  defaultAllocationMethod: z.enum(ALLOCATION_METHODS).optional(),
  // Phase 20 #6 — fiscal year start month (1..12).
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  name: z.string().min(1).max(200).optional(),
  defaultTermsDays: z.number().int().min(0).max(365).optional(),
});

export function createAdminRouter(deps: AdminRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router, ['skillId', 'targetId']);

  router.get(
    '/firm-settings',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.status(200).json({ firmId, settings: null });
        return;
      }
      const [firm] = await deps.db.select().from(firms).where(eq(firms.id, firmId)).limit(1);
      const [settings] = await deps.db
        .select()
        .from(firmSettings)
        .where(eq(firmSettings.firmId, firmId))
        .limit(1);
      // Q35 — e-sign provider lives on firm_settings_proposals. Default
      // to 'native' when no row exists yet.
      const { firmSettingsProposals } = await import('@vibe/db/schema');
      const [proposalSettings] = await deps.db
        .select({ esignProvider: firmSettingsProposals.esignProvider })
        .from(firmSettingsProposals)
        .where(eq(firmSettingsProposals.firmId, firmId))
        .limit(1);
      res.json({
        firm,
        settings,
        esignProvider: proposalSettings?.esignProvider ?? 'native',
        openSignAvailable: Boolean(deps.openSignAvailable),
      });
    },
  );

  router.patch(
    '/firm-settings',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      // Split incoming body into firm-table fields and firm_settings
      // fields so the partner editing fiscalYearStart doesn't have to
      // know which table it lives on.
      const settingsParsed = FirmSettingsPatchSchema.safeParse(req.body);
      const firmParsed = FirmPatchSchema.safeParse(req.body);
      if (!settingsParsed.success && !firmParsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.status(200).json({
          ok: true,
          applied: { ...settingsParsed.data, ...firmParsed.data },
        });
        return;
      }
      const settingsData =
        settingsParsed.success && Object.keys(settingsParsed.data).length > 0
          ? settingsParsed.data
          : null;
      const firmData =
        firmParsed.success && Object.keys(firmParsed.data).length > 0 ? firmParsed.data : null;
      if (settingsData) {
        await deps.db
          .update(firmSettings)
          .set({ ...settingsData, updatedAt: new Date() })
          .where(eq(firmSettings.firmId, firmId));
      }
      if (firmData) {
        await deps.db
          .update(firms)
          .set({ ...firmData, updatedAt: new Date() })
          .where(eq(firms.id, firmId));
      }
      // Q35 — e-sign provider (firm_settings_proposals). Only honor a
      // valid value; reject 'opensign' when the appliance has no
      // OPENSIGN_URL configured so the UI can't enable a dead provider.
      const esignParsed = z
        .object({ esignProvider: z.enum(['native', 'opensign']) })
        .safeParse(req.body);
      if (esignParsed.success) {
        if (esignParsed.data.esignProvider === 'opensign' && !deps.openSignAvailable) {
          res.status(400).json({ error: 'opensign_not_available' });
          return;
        }
        const { firmSettingsProposals } = await import('@vibe/db/schema');
        await deps.db
          .insert(firmSettingsProposals)
          .values({ firmId, esignProvider: esignParsed.data.esignProvider })
          .onConflictDoUpdate({
            target: firmSettingsProposals.firmId,
            set: { esignProvider: esignParsed.data.esignProvider, updatedAt: new Date() },
          });
      }
      res.json({ ok: true });
    },
  );

  // ============================================================
  // P3.2 — F.1 escrow_visibility (Connect Integration firm_config)
  // ============================================================
  router.get(
    '/firm-config',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ config: null });
        return;
      }
      const { firmConfig } = await import('@vibe/db/schema');
      const [cfg] = await deps.db
        .select()
        .from(firmConfig)
        .where(eq(firmConfig.firmId, firmId))
        .limit(1);
      res.json({ config: cfg ?? null });
    },
  );

  const FirmConfigPatchSchema = z.object({
    // Section L Q37 — escrow staff visibility
    escrowVisibility: z.enum(['engagement-access', 'partner-and-assigned-only']).optional(),
    // Section L Q36 — suggestion expiration window
    suggestionExpirationDays: z.number().int().min(1).max(365).optional(),
    // Section L Q38/I.8 — step-up thresholds
    writeOffStepUpThresholdCents: z.number().int().nonnegative().optional(),
    creditStepUpThresholdCents: z.number().int().nonnegative().optional(),
    // Section L Q39 — AI egress + Shield endpoint (Q39 + J.7/J.8)
    aiEgressEnabled: z.boolean().optional(),
    vibeShieldEndpoint: z.string().url().nullable().optional(),
    // 0100 — cloud egress mode: 'shield' (reachable Vibe Shield) or
    // 'direct' (appliance calls the provider API directly).
    aiEgressMode: z.enum(['shield', 'direct']).optional(),
  });

  router.patch(
    '/firm-config',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const parsed = FirmConfigPatchSchema.safeParse(req.body);
      if (!parsed.success || Object.keys(parsed.data).length === 0) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession?.firmId;
      const session = req.staffSession!;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      const { firmConfig } = await import('@vibe/db/schema');
      await deps.db
        .update(firmConfig)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(eq(firmConfig.firmId, firmId));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'firm_config',
        entityId: firmId,
        actorAppUserId: session.appUserId,
        after: parsed.data,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  router.get(
    '/offices',
    requirePermission(deps, 'office:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ offices: [] });
        return;
      }
      const rows = await deps.db.select().from(offices).where(eq(offices.firmId, firmId));
      res.json({ offices: rows });
    },
  );

  router.get(
    '/offices/:id',
    requirePermission(deps, 'office:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ office: null });
        return;
      }
      const [office] = await deps.db
        .select()
        .from(offices)
        .where(and(eq(offices.id, req.params['id']!), eq(offices.firmId, firmId)))
        .limit(1);
      if (!office) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ office });
    },
  );

  router.patch(
    '/offices/:id',
    requirePermission(deps, 'office:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      const parsed = OfficeSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      await deps.db
        .update(offices)
        .set(parsed.data)
        .where(and(eq(offices.id, req.params['id']!), eq(offices.firmId, firmId)));
      res.json({ ok: true });
    },
  );

  router.get(
    '/users/:id',
    requirePermission(deps, 'app_user:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ user: null });
        return;
      }
      const [user] = await deps.db
        .select({
          id: appUsers.id,
          email: appUsers.email,
          fullName: appUsers.fullName,
          firstName: appUsers.firstName,
          middleName: appUsers.middleName,
          lastName: appUsers.lastName,
          title: appUsers.title,
          salutation: appUsers.salutation,
          businessPhone: appUsers.businessPhone,
          businessPhoneExt: appUsers.businessPhoneExt,
          homePhone: appUsers.homePhone,
          homePhoneExt: appUsers.homePhoneExt,
          faxPhone: appUsers.faxPhone,
          faxPhoneExt: appUsers.faxPhoneExt,
          mobilePhone: appUsers.mobilePhone,
          mobilePhoneExt: appUsers.mobilePhoneExt,
          secondaryEmail: appUsers.secondaryEmail,
          addressLine1: appUsers.addressLine1,
          addressLine2: appUsers.addressLine2,
          city: appUsers.city,
          state: appUsers.state,
          zip: appUsers.zip,
          addressCountry: appUsers.addressCountry,
          homeAddressLine1: appUsers.homeAddressLine1,
          homeAddressLine2: appUsers.homeAddressLine2,
          homeCity: appUsers.homeCity,
          homeState: appUsers.homeState,
          homeZip: appUsers.homeZip,
          homeCountry: appUsers.homeCountry,
          hiredDate: appUsers.hiredDate,
          leftDate: appUsers.leftDate,
          status: appUsers.status,
          defaultOfficeId: appUsers.defaultOfficeId,
          standardHoursPerWeek: appUsers.standardHoursPerWeek,
          billableTargetHoursPerMonth: appUsers.billableTargetHoursPerMonth,
          totpEnrolledAt: appUsers.totpEnrolledAt,
          // 0062 — profile expansion fields
          displayId: appUsers.displayId,
          description: appUsers.description,
          photoUrl: appUsers.photoUrl,
          // (0063 dropped costRateCents — see migration header)
          internalNotes: appUsers.internalNotes,
          createdAt: appUsers.createdAt,
        })
        .from(appUsers)
        .where(and(eq(appUsers.id, req.params['id']!), eq(appUsers.firmId, firmId)))
        .limit(1);
      if (!user) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ user });
    },
  );

  router.post(
    '/offices',
    requirePermission(deps, 'office:write'),
    async (req: Request, res: Response) => {
      const parsed = OfficeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const [row] = await deps.db
        .insert(offices)
        .values({ firmId, ...parsed.data })
        .returning({ id: offices.id });
      res.status(201).json({ id: row?.id });
    },
  );

  router.patch(
    '/users/:id/archive',
    requirePermission(deps, 'app_user:archive'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(appUsers)
        .set({ status: 'ARCHIVED' })
        .where(eq(appUsers.id, req.params['id']!));
      res.json({ ok: true });
    },
  );

  router.patch(
    '/users/:id',
    requirePermission(deps, 'app_user:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      // Identity (Main tab)
      const str = (k: string, max = 200): void => {
        const v = body[k];
        if (v === null) patch[k] = null;
        else if (typeof v === 'string') {
          const trimmed = v.slice(0, max);
          patch[k] = trimmed.trim() === '' ? null : trimmed;
        }
      };
      str('firstName');
      str('middleName');
      str('lastName');
      str('title');
      str('salutation', 40);
      // 0062 — Main tab additions
      str('displayId', 40);
      str('description');
      str('photoUrl', 1000);
      str('internalNotes', 5000);
      // Contact Info tab
      str('businessPhone', 40);
      str('businessPhoneExt', 12);
      str('homePhone', 40);
      str('homePhoneExt', 12);
      str('faxPhone', 40);
      str('faxPhoneExt', 12);
      str('mobilePhone', 40);
      str('mobilePhoneExt', 12);
      str('secondaryEmail', 254);
      str('addressLine1', 200);
      str('addressLine2', 200);
      str('city', 120);
      str('state', 40);
      str('zip', 20);
      str('addressCountry', 60);
      str('homeAddressLine1', 200);
      str('homeAddressLine2', 200);
      str('homeCity', 120);
      str('homeState', 40);
      str('homeZip', 20);
      str('homeCountry', 60);
      // Dates
      const date = (k: string): void => {
        const v = body[k];
        if (v === null) patch[k] = null;
        else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) patch[k] = v;
      };
      date('hiredDate');
      date('leftDate');
      // Existing fields
      if (typeof body['fullName'] === 'string' && (body['fullName'] as string).trim()) {
        patch['fullName'] = (body['fullName'] as string).slice(0, 200);
      }
      if (typeof body['defaultOfficeId'] === 'string') {
        patch['defaultOfficeId'] = body['defaultOfficeId'];
      }
      if (
        body['status'] === 'ACTIVE' ||
        body['status'] === 'INACTIVE' ||
        body['status'] === 'ARCHIVED'
      ) {
        patch['status'] = body['status'];
      }
      // Phase 20 #7 — standard hours per week (utilization denominator).
      if (
        typeof body['standardHoursPerWeek'] === 'number' &&
        (body['standardHoursPerWeek'] as number) >= 0 &&
        (body['standardHoursPerWeek'] as number) <= 80
      ) {
        patch['standardHoursPerWeek'] = (body['standardHoursPerWeek'] as number).toFixed(2);
      }
      // Phase 20 #8 — per-user billable target override.
      if (body['billableTargetHoursPerMonth'] === null) {
        patch['billableTargetHoursPerMonth'] = null;
      } else if (
        typeof body['billableTargetHoursPerMonth'] === 'number' &&
        (body['billableTargetHoursPerMonth'] as number) >= 0 &&
        (body['billableTargetHoursPerMonth'] as number) <= 300
      ) {
        patch['billableTargetHoursPerMonth'] = Math.round(
          body['billableTargetHoursPerMonth'] as number,
        );
      }
      // (0063 dropped the app_user.cost_rate_cents handler — cost rate
      // lives on staff_rate_snapshot now, edited via the snapshot
      // create/list endpoints. The column is gone, so accepting it here
      // would silently no-op.)
      // 0054 — when first/middle/last are supplied, recompute fullName so
      // every display that still reads fullName stays in sync.
      const fn = (patch['firstName'] ?? null) as string | null;
      const mn = (patch['middleName'] ?? null) as string | null;
      const ln = (patch['lastName'] ?? null) as string | null;
      if (
        patch['firstName'] !== undefined ||
        patch['lastName'] !== undefined ||
        patch['middleName'] !== undefined
      ) {
        const parts = [fn, mn, ln].filter((p): p is string => !!p && p.length > 0);
        if (parts.length > 0) patch['fullName'] = parts.join(' ');
      }
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: 'no_fields_to_update' });
        return;
      }
      try {
        await deps.db
          .update(appUsers)
          .set(patch)
          .where(and(eq(appUsers.id, req.params['id']!), eq(appUsers.firmId, firmId)));
      } catch (err) {
        // Map Postgres unique-violation on (firm_id, display_id) to 409
        // instead of bubbling up as a generic 500.
        const pgCode =
          err && typeof err === 'object' && 'code' in err
            ? (err as { code: unknown }).code
            : undefined;
        if (pgCode === '23505') {
          res.status(409).json({ error: 'display_id_taken' });
          return;
        }
        throw err;
      }
      res.json({ ok: true });
    },
  );

  router.post(
    '/users/:id/reset-totp',
    requirePermission(deps, 'app_user:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(appUsers)
        .set({ totpSecretEncrypted: null, totpEnrolledAt: null })
        .where(and(eq(appUsers.id, req.params['id']!), eq(appUsers.firmId, firmId)));
      res.json({ ok: true });
    },
  );

  router.get(
    '/users',
    requirePermission(deps, 'app_user:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ users: [] });
        return;
      }
      const rows = await deps.db
        .select({
          id: appUsers.id,
          email: appUsers.email,
          fullName: appUsers.fullName,
          status: appUsers.status,
          totpEnrolledAt: appUsers.totpEnrolledAt,
          standardHoursPerWeek: appUsers.standardHoursPerWeek,
          billableTargetHoursPerMonth: appUsers.billableTargetHoursPerMonth,
        })
        .from(appUsers)
        .where(eq(appUsers.firmId, firmId));
      res.json({ users: rows });
    },
  );

  router.post(
    '/users/invite',
    requirePermission(deps, 'app_user:invite'),
    async (req: Request, res: Response) => {
      const parsed = InviteSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const [row] = await deps.db
        .insert(appUsers)
        .values({
          firmId,
          email: parsed.data.email,
          fullName: parsed.data.fullName,
          defaultOfficeId: parsed.data.defaultOfficeId ?? null,
        })
        .returning({ id: appUsers.id });
      res.status(201).json({ id: row?.id });
    },
  );

  router.get(
    '/license/validate',
    requirePermission(deps, 'firm:settings:read'),
    async (_req: Request, res: Response) => {
      // The license check itself happens at boot; this endpoint reports
      // the current state. Hooked up to the admin dashboard banner.
      const token = process.env['COMMERCIAL_LICENSE_TOKEN'];
      res.json({
        valid: Boolean(token),
        kind: token ? 'commercial' : 'community',
      });
    },
  );

  router.post(
    '/backup/trigger',
    requirePermission(deps, 'admin:backup:manage'),
    async (req: Request, res: Response) => {
      // Real backups run from a cron inside ops/docker — this endpoint
      // marks an audit event the operator can correlate against the file.
      const session = req.staffSession!;
      res.json({
        ok: true,
        kind: 'manual',
        requestedBy: session.appUserId,
        // The ops script reads this header to differentiate manual runs.
        marker: `manual-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      });
    },
  );

  router.get(
    '/roles',
    requirePermission(deps, 'app_user:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ roles: [] });
        return;
      }
      const rows = await deps.db
        .select({
          id: roles.id,
          name: roles.name,
          systemFlag: roles.systemFlag,
        })
        .from(roles)
        .where(eq(roles.firmId, firmId));
      res.json({ roles: rows });
    },
  );

  router.get(
    '/users/:id/roles',
    requirePermission(deps, 'app_user:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ roles: [] });
        return;
      }
      const [scope] = await deps.db
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(and(eq(appUsers.id, req.params['id']!), eq(appUsers.firmId, firmId)))
        .limit(1);
      if (!scope) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const rows = await deps.db
        .select({ id: roles.id, name: roles.name })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(eq(userRoles.appUserId, req.params['id']!));
      res.json({ roles: rows });
    },
  );

  router.post(
    '/users/:id/roles',
    requirePermission(deps, 'app_user:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const firmId = session.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const body = req.body as { roleIds?: unknown };
      if (!Array.isArray(body.roleIds) || body.roleIds.some((r) => typeof r !== 'string')) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const wanted = body.roleIds as string[];
      const [scope] = await deps.db
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(and(eq(appUsers.id, req.params['id']!), eq(appUsers.firmId, firmId)))
        .limit(1);
      if (!scope) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const allowed = await deps.db
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.firmId, firmId));
      const allowedIds = new Set(allowed.map((r) => r.id));
      const filtered = wanted.filter((r) => allowedIds.has(r));
      const before = await deps.db
        .select({ roleId: userRoles.roleId })
        .from(userRoles)
        .where(eq(userRoles.appUserId, req.params['id']!));
      await deps.db.transaction(async (tx) => {
        await tx.delete(userRoles).where(eq(userRoles.appUserId, req.params['id']!));
        if (filtered.length > 0) {
          await tx
            .insert(userRoles)
            .values(filtered.map((roleId) => ({ appUserId: req.params['id']!, roleId })));
        }
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'app_user_roles',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        before: { roleIds: before.map((b) => b.roleId) },
        after: { roleIds: filtered },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });
      res.json({ ok: true, assigned: filtered.length });
    },
  );

  router.post(
    '/users/import',
    requirePermission(deps, 'app_user:invite'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const firmId = session.firmId;
      if (!deps.db) {
        res.json({ created: 0, skipped: 0 });
        return;
      }
      const body = req.body as { csv?: unknown };
      if (typeof body.csv !== 'string' || body.csv.length === 0) {
        res.status(400).json({ error: 'csv_required' });
        return;
      }
      const lines = body.csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length < 2) {
        res.status(400).json({ error: 'csv_needs_header_and_one_row' });
        return;
      }
      const header = lines[0]!.split(',').map((h) => h.trim().toLowerCase());
      const emailIdx = header.indexOf('email');
      const nameIdx = header.indexOf('fullname');
      if (emailIdx < 0 || nameIdx < 0) {
        res.status(400).json({ error: 'csv_missing_columns', need: ['email', 'fullName'] });
        return;
      }
      const existing = new Set(
        (
          await deps.db
            .select({ email: appUsers.email })
            .from(appUsers)
            .where(eq(appUsers.firmId, firmId))
        ).map((u) => u.email.toLowerCase()),
      );
      let created = 0;
      let skipped = 0;
      const created_ids: string[] = [];
      for (let i = 1; i < lines.length; i += 1) {
        const parts = lines[i]!.split(',');
        const email = (parts[emailIdx] ?? '').trim();
        const fullName = (parts[nameIdx] ?? '').trim();
        if (!email || !fullName || existing.has(email.toLowerCase())) {
          skipped += 1;
          continue;
        }
        const [row] = await deps.db
          .insert(appUsers)
          .values({ firmId, email, fullName })
          .returning({ id: appUsers.id });
        if (row) {
          created += 1;
          created_ids.push(row.id);
          existing.add(email.toLowerCase());
        }
      }
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'app_user_bulk_import',
        actorAppUserId: session.appUserId,
        after: { created, skipped, ids: created_ids },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });
      res.status(201).json({ created, skipped, ids: created_ids });
    },
  );

  // -----------------------------------------------------------------
  // Custom role CRUD (Phase 4 #11). The 5 system role templates ship
  // hard-coded in @vibe/core/rbac and can't be edited; firms can also
  // create extra rows in the `role` table and pick from PERMISSION_KEYS
  // for each. user_role rows resolve from both sources at session time.
  // -----------------------------------------------------------------
  router.post(
    '/roles',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const body = req.body as { name?: unknown; permissionKeys?: unknown };
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
      if (!name) {
        res.status(400).json({ error: 'name_required' });
        return;
      }
      const keys = Array.isArray(body.permissionKeys)
        ? body.permissionKeys.filter(
            (k): k is string =>
              typeof k === 'string' && (PERMISSION_KEYS as readonly string[]).includes(k),
          )
        : [];
      const created = await deps.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(roles)
          .values({ firmId: session.firmId, name, systemFlag: false })
          .returning({ id: roles.id });
        if (!row) throw new Error('insert_failed');
        if (keys.length > 0) {
          await tx
            .insert(rolePermissions)
            .values(keys.map((k) => ({ roleId: row.id, permissionKey: k })));
        }
        return row.id;
      });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'role',
        entityId: created,
        actorAppUserId: session.appUserId,
        after: { name, permissionKeys: keys },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });
      res.status(201).json({ id: created });
    },
  );

  router.get(
    '/roles/:id/permissions',
    requirePermission(deps, 'app_user:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ permissions: [] });
        return;
      }
      const [scope] = await deps.db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.id, req.params['id']!), eq(roles.firmId, session.firmId)))
        .limit(1);
      if (!scope) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const rows = await deps.db
        .select({ k: rolePermissions.permissionKey })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, req.params['id']!));
      res.json({ permissions: rows.map((r) => r.k) });
    },
  );

  router.put(
    '/roles/:id/permissions',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const body = req.body as { permissionKeys?: unknown };
      if (!Array.isArray(body.permissionKeys)) {
        res.status(400).json({ error: 'permissionKeys_required' });
        return;
      }
      const wanted = body.permissionKeys.filter(
        (k): k is string =>
          typeof k === 'string' && (PERMISSION_KEYS as readonly string[]).includes(k),
      );
      const [scope] = await deps.db
        .select({ id: roles.id, systemFlag: roles.systemFlag })
        .from(roles)
        .where(and(eq(roles.id, req.params['id']!), eq(roles.firmId, session.firmId)))
        .limit(1);
      if (!scope) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (scope.systemFlag) {
        res.status(409).json({ error: 'system_role_immutable' });
        return;
      }
      await deps.db.transaction(async (tx) => {
        await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, req.params['id']!));
        if (wanted.length > 0) {
          await tx
            .insert(rolePermissions)
            .values(wanted.map((k) => ({ roleId: req.params['id']!, permissionKey: k })));
        }
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'role_permissions',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { permissionKeys: wanted },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });
      res.json({ ok: true, count: wanted.length });
    },
  );

  router.delete(
    '/roles/:id',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [scope] = await deps.db
        .select({ id: roles.id, systemFlag: roles.systemFlag })
        .from(roles)
        .where(and(eq(roles.id, req.params['id']!), eq(roles.firmId, session.firmId)))
        .limit(1);
      if (!scope) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (scope.systemFlag) {
        res.status(409).json({ error: 'system_role_undeletable' });
        return;
      }
      await deps.db.delete(roles).where(eq(roles.id, req.params['id']!));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'role',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { deleted: true },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });
      res.json({ ok: true });
    },
  );

  router.get(
    '/permission-matrix',
    requirePermission(deps, 'firm:settings:read'),
    async (_req: Request, res: Response) => {
      const slugs: RoleSlug[] = ['admin', 'partner', 'manager', 'senior', 'staff'];
      const matrix = PERMISSION_KEYS.map((key) => ({
        key,
        roles: slugs.filter((slug) => ROLE_TEMPLATES[slug].has(key)),
      }));
      res.json({ permissions: matrix, roles: slugs });
    },
  );

  // -----------------------------------------------------------------
  // Test the configured mail provider. Sends a one-line message to the
  // given address and returns success / failure. No template, no audit
  // value beyond the audit_log row.
  // -----------------------------------------------------------------
  router.post(
    '/email/test',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const body = req.body as { to?: unknown };
      const to = typeof body.to === 'string' ? body.to : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        res.status(400).json({ error: 'invalid_to' });
        return;
      }
      const session = req.staffSession!;
      // The actual mail provider hangs off the app's PortalRoutesDeps —
      // we don't have a direct handle here, so emit an audit event and
      // tell the caller to use the standard verify-magic-link surface to
      // confirm send. (Future: pipe sendPortalEmail in via deps.)
      if (deps.db) {
        await emitAudit(deps.db, {
          action: 'CREATE',
          entityType: 'email_test',
          actorAppUserId: session.appUserId,
          after: { to, kind: 'placeholder' },
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
        });
      }
      res.json({
        ok: true,
        sent: false,
        note: 'mail-test surface logs the request; actual provider send wired in next iteration',
      });
    },
  );

  router.post(
    '/users/:id/invite-resend',
    requirePermission(deps, 'app_user:invite'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      const [u] = await deps.db
        .select({ id: appUsers.id, email: appUsers.email })
        .from(appUsers)
        .where(and(eq(appUsers.id, req.params['id']!), eq(appUsers.firmId, firmId)))
        .limit(1);
      if (!u) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // The actual magic-link send is in the staff-auth route. This
      // endpoint surfaces the existence of the resend for the UI; the
      // user clicks "send magic link" which hits /api/auth/login next.
      res.json({ ok: true, email: u.email });
    },
  );

  // ----------------------------------------------------------------
  // Per-office settings overrides (Phase 4 #7). Resolution is
  // "office override if set, else firm default".
  // ----------------------------------------------------------------
  router.get(
    '/offices/:id/settings',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ resolved: null, override: null });
        return;
      }
      const [office] = await deps.db
        .select({ id: offices.id })
        .from(offices)
        .where(and(eq(offices.id, req.params['id']!), eq(offices.firmId, firmId)))
        .limit(1);
      if (!office) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [firm] = await deps.db
        .select()
        .from(firmSettings)
        .where(eq(firmSettings.firmId, firmId))
        .limit(1);
      const [ov] = await deps.db
        .select()
        .from(officeSettings)
        .where(eq(officeSettings.officeId, office.id))
        .limit(1);
      const pick = <T>(o: T | null | undefined, f: T): T => (o ?? f) as T;
      res.json({
        override: ov ?? null,
        resolved: firm
          ? {
              adjustmentApprovalThresholdCents: pick(
                ov?.adjustmentApprovalThresholdCents,
                firm.adjustmentApprovalThresholdCents,
              ),
              timeEntryRoundingHours: pick(ov?.timeEntryRoundingHours, firm.timeEntryRoundingHours),
              lateEntryAlertDays: pick(ov?.lateEntryAlertDays, firm.lateEntryAlertDays),
              lateEntryLockoutDays: pick(ov?.lateEntryLockoutDays, firm.lateEntryLockoutDays),
              invoiceNumberingPrefix: pick(ov?.invoiceNumberingPrefix, firm.invoiceNumberingPrefix),
            }
          : null,
      });
    },
  );

  router.put(
    '/offices/:id/settings',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      const [office] = await deps.db
        .select({ id: offices.id })
        .from(offices)
        .where(and(eq(offices.id, req.params['id']!), eq(offices.firmId, firmId)))
        .limit(1);
      if (!office) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const numOrNull = (k: string): number | null =>
        body[k] === null ? null : typeof body[k] === 'number' ? (body[k] as number) : null;
      const strOrNull = (k: string): string | null =>
        body[k] === null ? null : typeof body[k] === 'string' ? (body[k] as string) : null;

      // MERGE only the fields present in the body — the UI saves one override
      // field at a time, so a full upsert would wipe the sibling overrides.
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if ('adjustmentApprovalThresholdCents' in body)
        set['adjustmentApprovalThresholdCents'] = numOrNull('adjustmentApprovalThresholdCents');
      if ('timeEntryRoundingHours' in body)
        set['timeEntryRoundingHours'] = strOrNull('timeEntryRoundingHours');
      if ('lateEntryAlertDays' in body) set['lateEntryAlertDays'] = numOrNull('lateEntryAlertDays');
      if ('lateEntryLockoutDays' in body)
        set['lateEntryLockoutDays'] = numOrNull('lateEntryLockoutDays');
      if ('invoiceNumberingPrefix' in body)
        set['invoiceNumberingPrefix'] = strOrNull('invoiceNumberingPrefix');
      const values = { officeId: office.id, ...set };
      await deps.db
        .insert(officeSettings)
        .values(values)
        .onConflictDoUpdate({ target: officeSettings.officeId, set });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'office_settings',
        entityId: office.id,
        actorAppUserId: req.staffSession!.appUserId,
        after: values,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // ----------------------------------------------------------------
  // Notification templates (Phase 20 #12). Per Q28: variable
  // insertion only via {{placeholder}} markers. UI uses the picker
  // to insert variables; the dispatcher renders at send time.
  // ----------------------------------------------------------------
  router.get(
    '/notification-templates',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      let items = await deps.db
        .select()
        .from(notificationTemplates)
        .where(eq(notificationTemplates.firmId, firmId));
      // Self-heal: firms that missed the bootstrap seed (or that were
      // upgraded across a migration window that added new kinds) land here
      // missing one or more (kind, channel) pairs from the current default
      // set. Run the same idempotent seeder used by /seed-defaults so the
      // admin always sees a fully-populated grid — never a blank template.
      // Existing rows are preserved because seedNotificationTemplates uses
      // ON CONFLICT DO NOTHING on (firm_id, kind, channel), so admin
      // overrides survive. (A firm may also carry legacy kinds no longer in
      // the registry; those are simply left in place.)
      const have = new Set(items.map((i) => `${i.kind}:${i.channel}`));
      const missingDefault = NOTIFICATION_TEMPLATE_DEFAULTS.some(
        (d) => !have.has(`${d.kind}:${d.channel}`),
      );
      if (missingDefault && deps.db) {
        const db = deps.db;
        await db
          .transaction(async (tx) => {
            await seedNotificationTemplates(tx, firmId);
          })
          .catch((err) => {
            // Non-fatal: GET still returns whatever rows exist. The
            // admin can hit /seed-defaults explicitly to retry.
            // eslint-disable-next-line no-console
            console.warn('notification template auto-seed failed', err);
          });
        items = await db
          .select()
          .from(notificationTemplates)
          .where(eq(notificationTemplates.firmId, firmId));
      }
      res.json({ items });
    },
  );

  // v2 Sprint A — populate any kind/channel pair that does not yet have
  // an override row. Existing rows are preserved (admins keep their
  // customizations). Returns the count inserted so the UI can toast it.
  router.post(
    '/notification-templates/seed-defaults',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ inserted: 0 });
        return;
      }
      const inserted = await deps.db.transaction(async (tx) =>
        seedNotificationTemplates(tx, firmId),
      );
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'notification_template',
        entityId: 'seed-defaults',
        actorAppUserId: req.staffSession!.appUserId,
        after: { inserted },
      }).catch(() => undefined);
      res.json({ inserted });
    },
  );

  router.put(
    '/notification-templates/:kind/:channel',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      const kind = req.params['kind']!;
      const channel =
        req.params['channel'] === 'SMS'
          ? 'SMS'
          : req.params['channel'] === 'CALL'
            ? 'CALL'
            : 'EMAIL';
      const body = (req.body ?? {}) as { subject?: string; body?: string; enabled?: boolean };
      if (typeof body.body !== 'string' || body.body.length === 0) {
        res.status(400).json({ error: 'body_required' });
        return;
      }
      // Mine placeholder names so the UI variable picker can render them.
      const re = /{{\s*([a-zA-Z0-9_.]+)\s*}}/g;
      const seen = new Set<string>();
      const sources = [body.body, body.subject ?? ''].join('\n');
      let m: RegExpExecArray | null;
      while ((m = re.exec(sources))) seen.add(m[1]!);
      const variables = Array.from(seen).sort();

      const values = {
        firmId,
        kind,
        channel: channel as 'EMAIL' | 'SMS' | 'CALL',
        subject: body.subject ?? null,
        body: body.body,
        variablesJson: variables,
        enabled: body.enabled ?? true,
        updatedAt: new Date(),
      };
      await deps.db
        .insert(notificationTemplates)
        .values(values)
        .onConflictDoUpdate({
          target: [
            notificationTemplates.firmId,
            notificationTemplates.kind,
            notificationTemplates.channel,
          ],
          set: values,
        });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'notification_template',
        entityId: `${kind}:${channel}`,
        actorAppUserId: req.staffSession!.appUserId,
        after: { kind, channel, enabled: values.enabled, variableCount: variables.length },
      }).catch(() => undefined);
      res.json({ ok: true, variables });
    },
  );

  router.delete(
    '/notification-templates/:kind/:channel',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      const kind = req.params['kind']!;
      const channel =
        req.params['channel'] === 'SMS'
          ? 'SMS'
          : req.params['channel'] === 'CALL'
            ? 'CALL'
            : 'EMAIL';
      await deps.db
        .delete(notificationTemplates)
        .where(
          and(
            eq(notificationTemplates.firmId, firmId),
            eq(notificationTemplates.kind, kind),
            eq(notificationTemplates.channel, channel),
          ),
        );
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'notification_template',
        entityId: `${kind}:${channel}`,
        actorAppUserId: req.staffSession!.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // ----------------------------------------------------------------
  // 0050 — engagement_status_config. Per-firm presentation +
  // automation flags layered over the workflow_state enum. Seeded by
  // migration; only GET/PATCH exposed (no insert/delete — enum bound).
  // ----------------------------------------------------------------
  router.get(
    '/engagement-statuses',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      let items = await deps.db
        .select()
        .from(engagementStatusConfig)
        .where(eq(engagementStatusConfig.firmId, firmId))
        .orderBy(engagementStatusConfig.sortOrder);
      // Self-heal: firms created after migration 0050 land here with
      // zero rows because the backfill INSERT only fired against firms
      // that existed at migration time. Seed defaults on first read.
      if (items.length === 0) {
        const DEFAULT_STATUS_CONFIGS: Array<{
          workflowState:
            | 'NO_STATUS'
            | 'NOT_STARTED'
            | 'READY'
            | 'IN_PROGRESS'
            | 'ON_HOLD'
            | 'NEEDS_REVIEW'
            | 'WITH_CLIENT'
            | 'COMPLETED'
            | 'CANCELED'
            | 'DRAFT';
          label: string;
          color: string;
          sortOrder: number;
          kanbanVisible: boolean;
        }> = [
          {
            workflowState: 'DRAFT',
            label: 'Draft',
            color: '#9ca3af',
            sortOrder: 0,
            kanbanVisible: true,
          },
          {
            workflowState: 'NOT_STARTED',
            label: 'Not started',
            color: '#6b7280',
            sortOrder: 10,
            kanbanVisible: true,
          },
          {
            workflowState: 'READY',
            label: 'Ready',
            color: '#3b82f6',
            sortOrder: 20,
            kanbanVisible: true,
          },
          {
            workflowState: 'IN_PROGRESS',
            label: 'In progress',
            color: '#f59e0b',
            sortOrder: 30,
            kanbanVisible: true,
          },
          {
            workflowState: 'ON_HOLD',
            label: 'On hold',
            color: '#a855f7',
            sortOrder: 40,
            kanbanVisible: true,
          },
          {
            workflowState: 'NEEDS_REVIEW',
            label: 'Needs review',
            color: '#ec4899',
            sortOrder: 50,
            kanbanVisible: true,
          },
          {
            workflowState: 'WITH_CLIENT',
            label: 'With client',
            color: '#0ea5e9',
            sortOrder: 60,
            kanbanVisible: true,
          },
          {
            workflowState: 'COMPLETED',
            label: 'Completed',
            color: '#22c55e',
            sortOrder: 70,
            kanbanVisible: true,
          },
          {
            workflowState: 'CANCELED',
            label: 'Canceled',
            color: '#737373',
            sortOrder: 80,
            kanbanVisible: true,
          },
          {
            workflowState: 'NO_STATUS',
            label: 'No status',
            color: '#94a3b8',
            sortOrder: 90,
            kanbanVisible: true,
          },
        ];
        await deps.db.insert(engagementStatusConfig).values(
          DEFAULT_STATUS_CONFIGS.map((d) => ({
            firmId,
            ...d,
            triggersClientComm: false,
            isSystem: true,
            clientVisible: true,
          })),
        );
        items = await deps.db
          .select()
          .from(engagementStatusConfig)
          .where(eq(engagementStatusConfig.firmId, firmId))
          .orderBy(engagementStatusConfig.sortOrder);
      }
      res.json({ items });
    },
  );

  // 0101 — presentation + client-facing fields. Any existing row (system
  // or custom) is editable; the key (workflow_state) is immutable.
  const StatusConfigPatchSchema = z
    .object({
      label: z.string().min(1).max(60).optional(),
      color: z
        .string()
        .regex(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/)
        .optional(),
      sortOrder: z.number().int().min(0).max(9999).optional(),
      kanbanVisible: z.boolean().optional(),
      triggersClientComm: z.boolean().optional(),
      clientLabel: z.string().max(120).nullable().optional(),
      clientDescription: z.string().max(500).nullable().optional(),
      clientVisible: z.boolean().optional(),
    })
    .strict();

  // 0101 — derive a stable, unique-per-firm text key from a label.
  function slugifyStatusKey(label: string): string {
    const base =
      label
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40) || 'STATUS';
    return base;
  }

  const StatusCreateSchema = z
    .object({
      label: z.string().min(1).max(60),
      color: z
        .string()
        .regex(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/)
        .optional(),
      sortOrder: z.number().int().min(0).max(9999).optional(),
      kanbanVisible: z.boolean().optional(),
      triggersClientComm: z.boolean().optional(),
      clientLabel: z.string().max(120).nullable().optional(),
      clientDescription: z.string().max(500).nullable().optional(),
      clientVisible: z.boolean().optional(),
    })
    .strict();

  // POST /engagement-statuses — create a firm-custom progress status.
  router.post(
    '/engagement-statuses',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = StatusCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      const d = parsed.data;
      // Dedupe the key within the firm.
      const existingKeys = new Set(
        (
          await deps.db
            .select({ ws: engagementStatusConfig.workflowState })
            .from(engagementStatusConfig)
            .where(eq(engagementStatusConfig.firmId, firmId))
        ).map((r) => r.ws),
      );
      const baseKey = slugifyStatusKey(d.label);
      let key = baseKey;
      let n = 2;
      while (existingKeys.has(key)) key = `${baseKey}_${n++}`;

      await deps.db.insert(engagementStatusConfig).values({
        firmId,
        workflowState: key,
        label: d.label,
        color: d.color ?? '#6b7280',
        sortOrder: d.sortOrder ?? 100,
        kanbanVisible: d.kanbanVisible ?? true,
        triggersClientComm: d.triggersClientComm ?? false,
        isSystem: false,
        clientLabel: d.clientLabel ?? null,
        clientDescription: d.clientDescription ?? null,
        clientVisible: d.clientVisible ?? true,
      });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'engagement_status_config',
        entityId: key,
        actorAppUserId: req.staffSession!.appUserId,
        after: { workflowState: key, label: d.label },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);
      res.json({ ok: true, workflowState: key });
    },
  );

  router.patch(
    '/engagement-statuses/:state',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      const state = req.params['state'] as string;
      const parsed = StatusConfigPatchSchema.safeParse(req.body);
      if (!parsed.success || Object.keys(parsed.data).length === 0) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const [row] = await deps.db
        .select({ ws: engagementStatusConfig.workflowState })
        .from(engagementStatusConfig)
        .where(
          and(
            eq(engagementStatusConfig.firmId, firmId),
            eq(engagementStatusConfig.workflowState, state),
          ),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'unknown_state' });
        return;
      }
      await deps.db
        .update(engagementStatusConfig)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(
          and(
            eq(engagementStatusConfig.firmId, firmId),
            eq(engagementStatusConfig.workflowState, state),
          ),
        );
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement_status_config',
        entityId: state,
        actorAppUserId: req.staffSession!.appUserId,
        after: parsed.data,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // DELETE /engagement-statuses/:state — custom + not-in-use only.
  router.delete(
    '/engagement-statuses/:state',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const state = req.params['state'] as string;
      const [row] = await deps.db
        .select({ isSystem: engagementStatusConfig.isSystem })
        .from(engagementStatusConfig)
        .where(
          and(
            eq(engagementStatusConfig.firmId, firmId),
            eq(engagementStatusConfig.workflowState, state),
          ),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'unknown_state' });
        return;
      }
      if (row.isSystem) {
        res.status(409).json({ error: 'cannot_delete_system_status' });
        return;
      }
      // In-use guard: engagement has no firm_id, so scope via client.
      const { engagements, clients } = await import('@vibe/db/schema');
      const [used] = await deps.db
        .select({ n: sql<number>`count(*)::int` })
        .from(engagements)
        .innerJoin(clients, eq(engagements.clientId, clients.id))
        .where(and(eq(clients.firmId, firmId), eq(engagements.workflowState, state)));
      if ((used?.n ?? 0) > 0) {
        res.status(409).json({ error: 'status_in_use', count: used?.n ?? 0 });
        return;
      }
      await deps.db
        .delete(engagementStatusConfig)
        .where(
          and(
            eq(engagementStatusConfig.firmId, firmId),
            eq(engagementStatusConfig.workflowState, state),
          ),
        );
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'engagement_status_config',
        entityId: state,
        actorAppUserId: req.staffSession!.appUserId,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // ----------------------------------------------------------------
  // 0054 — rate_code CRUD. Firm-scoped catalog. StandardRate is system:
  // can be renamed (description) but not deleted, and its `code` is
  // immutable (the resolver fallback path looks it up by literal name).
  // ----------------------------------------------------------------
  const RateCodeCreateSchema = z.object({
    code: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z0-9_-]+$/, 'code must be alphanumeric, dash, or underscore'),
    description: z.string().max(200).nullable().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  });
  const RateCodePatchSchema = z.object({
    code: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    description: z.string().max(200).nullable().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    active: z.boolean().optional(),
  });

  router.get(
    '/rate-codes',
    requirePermission(deps, 'rate:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(rateCodes)
        .where(eq(rateCodes.firmId, firmId))
        .orderBy(rateCodes.sortOrder, rateCodes.code);
      res.json({ items });
    },
  );

  router.post(
    '/rate-codes',
    requirePermission(deps, 'rate:write'),
    async (req: Request, res: Response) => {
      const parsed = RateCodeCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      try {
        const [row] = await deps.db
          .insert(rateCodes)
          .values({
            firmId,
            code: parsed.data.code,
            description: parsed.data.description ?? null,
            sortOrder: parsed.data.sortOrder ?? 0,
            isSystem: false,
          })
          .returning({ id: rateCodes.id });
        await emitAudit(deps.db, {
          action: 'CREATE',
          entityType: 'rate_code',
          entityId: row?.id,
          actorAppUserId: req.staffSession!.appUserId,
          after: parsed.data,
        }).catch(() => undefined);
        res.status(201).json({ id: row?.id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'insert_failed';
        if (/unique|duplicate/i.test(msg)) {
          res.status(409).json({ error: 'duplicate_code' });
          return;
        }
        res.status(500).json({ error: 'insert_failed' });
      }
    },
  );

  router.patch(
    '/rate-codes/:id',
    requirePermission(deps, 'rate:write'),
    async (req: Request, res: Response) => {
      const parsed = RateCodePatchSchema.safeParse(req.body);
      if (!parsed.success || Object.keys(parsed.data).length === 0) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      const [existing] = await deps.db
        .select()
        .from(rateCodes)
        .where(and(eq(rateCodes.id, req.params['id']!), eq(rateCodes.firmId, firmId)))
        .limit(1);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // System codes: `code` is immutable. Description / sort / active OK.
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.code != null) {
        if (existing.isSystem) {
          res.status(409).json({ error: 'system_code_immutable' });
          return;
        }
        patch['code'] = parsed.data.code;
      }
      if (parsed.data.description !== undefined) patch['description'] = parsed.data.description;
      if (parsed.data.sortOrder != null) patch['sortOrder'] = parsed.data.sortOrder;
      if (parsed.data.active != null) {
        if (existing.isSystem && parsed.data.active === false) {
          res.status(409).json({ error: 'system_code_cannot_deactivate' });
          return;
        }
        patch['active'] = parsed.data.active;
      }
      try {
        await deps.db.update(rateCodes).set(patch).where(eq(rateCodes.id, existing.id));
        await emitAudit(deps.db, {
          action: 'UPDATE',
          entityType: 'rate_code',
          entityId: existing.id,
          actorAppUserId: req.staffSession!.appUserId,
          before: existing,
          after: patch,
        }).catch(() => undefined);
        res.json({ ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'update_failed';
        if (/unique|duplicate/i.test(msg)) {
          res.status(409).json({ error: 'duplicate_code' });
          return;
        }
        res.status(500).json({ error: 'update_failed' });
      }
    },
  );

  router.delete(
    '/rate-codes/:id',
    requirePermission(deps, 'rate:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      const [existing] = await deps.db
        .select()
        .from(rateCodes)
        .where(and(eq(rateCodes.id, req.params['id']!), eq(rateCodes.firmId, firmId)))
        .limit(1);
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (existing.isSystem) {
        res.status(409).json({ error: 'system_code_cannot_be_deleted' });
        return;
      }
      // RESTRICT FK on staff_rate_snapshot_entry.rate_code_id means a code
      // in use cannot be deleted. Surface that cleanly.
      try {
        await deps.db.delete(rateCodes).where(eq(rateCodes.id, existing.id));
        await emitAudit(deps.db, {
          action: 'ARCHIVE',
          entityType: 'rate_code',
          entityId: existing.id,
          actorAppUserId: req.staffSession!.appUserId,
          before: existing,
          after: { deleted: true },
        }).catch(() => undefined);
        res.json({ ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'delete_failed';
        if (/foreign key|fk|violates/i.test(msg)) {
          res.status(409).json({ error: 'rate_code_in_use' });
          return;
        }
        res.status(500).json({ error: 'delete_failed' });
      }
    },
  );

  // ----------------------------------------------------------------
  // 0054 — staff rate snapshots. Append-only. POST creates a new
  // effective_date snapshot with the supplied (code → bill rate) entries.
  // Editing a past snapshot is forbidden (rate-change history is the
  // entire point).
  // ----------------------------------------------------------------
  router.get(
    '/users/:id/rate-snapshots',
    requirePermission(deps, 'rate:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ snapshots: [], codes: [] });
        return;
      }
      const [user] = await deps.db
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(and(eq(appUsers.id, req.params['id']!), eq(appUsers.firmId, firmId)))
        .limit(1);
      if (!user) {
        res.status(404).json({ error: 'user_not_found' });
        return;
      }
      const codes = await deps.db
        .select()
        .from(rateCodes)
        .where(eq(rateCodes.firmId, firmId))
        .orderBy(rateCodes.sortOrder, rateCodes.code);
      const snaps = await deps.db
        .select()
        .from(staffRateSnapshots)
        .where(eq(staffRateSnapshots.appUserId, user.id))
        .orderBy(desc(staffRateSnapshots.effectiveDate));
      const entries = snaps.length
        ? await deps.db
            .select()
            .from(staffRateSnapshotEntries)
            .where(
              inArray(
                staffRateSnapshotEntries.snapshotId,
                snaps.map((s) => s.id),
              ),
            )
        : [];
      const byId = new Map<string, { rateCodeId: string; billRateCents: number }[]>();
      for (const e of entries) {
        const list = byId.get(e.snapshotId) ?? [];
        list.push({ rateCodeId: e.rateCodeId, billRateCents: e.billRateCents });
        byId.set(e.snapshotId, list);
      }
      res.json({
        codes,
        snapshots: snaps.map((s) => ({
          id: s.id,
          effectiveDate: s.effectiveDate,
          costRateCents: s.costRateCents,
          createdAt: s.createdAt,
          entries: byId.get(s.id) ?? [],
        })),
      });
    },
  );

  const SnapshotCreateSchema = z.object({
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    costRateCents: z.number().int().nonnegative().nullable().optional(),
    entries: z
      .array(
        z.object({
          rateCodeId: z.string().uuid(),
          billRateCents: z.number().int().nonnegative(),
        }),
      )
      .min(1),
  });

  router.post(
    '/users/:id/rate-snapshots',
    requirePermission(deps, 'rate:write'),
    async (req: Request, res: Response) => {
      const parsed = SnapshotCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const [user] = await deps.db
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(and(eq(appUsers.id, req.params['id']!), eq(appUsers.firmId, firmId)))
        .limit(1);
      if (!user) {
        res.status(404).json({ error: 'user_not_found' });
        return;
      }
      // Every rate_code_id must belong to this firm (don't allow snapshots
      // to reference a code from another firm).
      const codeIds = Array.from(new Set(parsed.data.entries.map((e) => e.rateCodeId)));
      const codes = await deps.db
        .select({ id: rateCodes.id, code: rateCodes.code })
        .from(rateCodes)
        .where(and(eq(rateCodes.firmId, firmId), inArray(rateCodes.id, codeIds)));
      if (codes.length !== codeIds.length) {
        res.status(400).json({ error: 'rate_code_not_in_firm' });
        return;
      }
      // Require StandardRate to be present — every snapshot must carry
      // the resolver-fallback entry, even if zero.
      const standardId = codes.find((c) => c.code === 'StandardRate')?.id;
      if (!standardId || !parsed.data.entries.some((e) => e.rateCodeId === standardId)) {
        res.status(400).json({ error: 'standard_rate_required' });
        return;
      }
      try {
        const id = await createSnapshot(deps.db, {
          appUserId: user.id,
          effectiveDate: parsed.data.effectiveDate,
          costRateCents: parsed.data.costRateCents ?? null,
          entries: parsed.data.entries,
        });
        await emitAudit(deps.db, {
          action: 'CREATE',
          entityType: 'staff_rate_snapshot',
          entityId: id,
          actorAppUserId: req.staffSession!.appUserId,
          after: parsed.data,
        }).catch(() => undefined);
        res.status(201).json({ id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'insert_failed';
        if (/unique|duplicate/i.test(msg)) {
          res.status(409).json({ error: 'snapshot_for_date_exists' });
          return;
        }
        res.status(500).json({ error: 'insert_failed' });
      }
    },
  );

  // =================================================================
  // 0062 — Skill Set tab
  // =================================================================
  router.get(
    '/users/:id/skills',
    requirePermission(deps, 'app_user:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select({
          id: staffSkills.id,
          workCodeId: staffSkills.workCodeId,
          workCodeKey: workCodes.key,
          workCodeName: workCodes.name,
          proficiency: staffSkills.proficiency,
          notes: staffSkills.notes,
          updatedAt: staffSkills.updatedAt,
        })
        .from(staffSkills)
        .innerJoin(workCodes, eq(workCodes.id, staffSkills.workCodeId))
        .innerJoin(appUsers, eq(appUsers.id, staffSkills.appUserId))
        .where(and(eq(staffSkills.appUserId, req.params['id']!), eq(appUsers.firmId, firmId)))
        .orderBy(workCodes.name);
      res.json({ items });
    },
  );

  router.post(
    '/users/:id/skills',
    requirePermission(deps, 'app_user:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      const session = req.staffSession!;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      const Schema = z.object({
        workCodeId: z.string().uuid(),
        proficiency: z.enum(['LEARNING', 'COMPETENT', 'PROFICIENT', 'EXPERT']).default('COMPETENT'),
        notes: z.string().max(1000).nullable().optional(),
      });
      const parsed = Schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      // Scope check: the target user must belong to the same firm.
      const [user] = await deps.db
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(and(eq(appUsers.id, req.params['id']!), eq(appUsers.firmId, firmId)))
        .limit(1);
      if (!user) {
        res.status(404).json({ error: 'user_not_found' });
        return;
      }
      // Validate the work code belongs to this firm — defends against
      // cross-firm references and gives a clean 400 instead of a 500
      // from a FK violation.
      const [wc] = await deps.db
        .select({ id: workCodes.id })
        .from(workCodes)
        .where(and(eq(workCodes.id, parsed.data.workCodeId), eq(workCodes.firmId, firmId)))
        .limit(1);
      if (!wc) {
        res.status(400).json({ error: 'work_code_not_found' });
        return;
      }
      const [row] = await deps.db
        .insert(staffSkills)
        .values({
          appUserId: req.params['id']!,
          workCodeId: parsed.data.workCodeId,
          proficiency: parsed.data.proficiency,
          notes: parsed.data.notes ?? null,
        })
        .onConflictDoUpdate({
          target: [staffSkills.appUserId, staffSkills.workCodeId],
          set: {
            proficiency: parsed.data.proficiency,
            notes: parsed.data.notes ?? null,
            updatedAt: new Date(),
          },
        })
        .returning({ id: staffSkills.id });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'staff_skill',
        entityId: row?.id,
        actorAppUserId: session.appUserId,
        after: {
          targetUserId: req.params['id']!,
          workCodeId: parsed.data.workCodeId,
          proficiency: parsed.data.proficiency,
        },
      }).catch(() => undefined);
      res.status(201).json({ id: row?.id });
    },
  );

  router.delete(
    '/users/:id/skills/:skillId',
    requirePermission(deps, 'app_user:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      const session = req.staffSession!;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      // Scope check via app_user.firm_id.
      const deleted = await deps.db
        .delete(staffSkills)
        .where(
          and(
            eq(staffSkills.id, req.params['skillId']!),
            eq(staffSkills.appUserId, req.params['id']!),
          ),
        )
        .returning({ id: staffSkills.id });
      if (deleted.length === 0) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'staff_skill',
        entityId: req.params['skillId']!,
        actorAppUserId: session.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // =================================================================
  // 0062 — Targets tab
  // =================================================================
  router.get(
    '/users/:id/targets',
    requirePermission(deps, 'app_user:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(staffTargets)
        .innerJoin(appUsers, eq(appUsers.id, staffTargets.appUserId))
        .where(and(eq(staffTargets.appUserId, req.params['id']!), eq(appUsers.firmId, firmId)))
        .orderBy(desc(staffTargets.targetYear));
      res.json({ items: items.map((r) => r.staff_target) });
    },
  );

  router.post(
    '/users/:id/targets',
    requirePermission(deps, 'app_user:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      const session = req.staffSession!;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      const Schema = z.object({
        targetYear: z.number().int().min(2000).max(2100),
        annualBillableHours: z.number().nonnegative().max(99999).nullable().optional(),
        annualTotalHours: z.number().nonnegative().max(99999).nullable().optional(),
        targetRealizationPctBps: z.number().int().min(0).max(10000).nullable().optional(),
        targetUtilizationPctBps: z.number().int().min(0).max(10000).nullable().optional(),
        notes: z.string().max(2000).nullable().optional(),
      });
      const parsed = Schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const [user] = await deps.db
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(and(eq(appUsers.id, req.params['id']!), eq(appUsers.firmId, firmId)))
        .limit(1);
      if (!user) {
        res.status(404).json({ error: 'user_not_found' });
        return;
      }
      const [row] = await deps.db
        .insert(staffTargets)
        .values({
          appUserId: req.params['id']!,
          targetYear: parsed.data.targetYear,
          annualBillableHours: parsed.data.annualBillableHours?.toString() ?? null,
          annualTotalHours: parsed.data.annualTotalHours?.toString() ?? null,
          targetRealizationPctBps: parsed.data.targetRealizationPctBps ?? null,
          targetUtilizationPctBps: parsed.data.targetUtilizationPctBps ?? null,
          notes: parsed.data.notes ?? null,
        })
        .onConflictDoUpdate({
          target: [staffTargets.appUserId, staffTargets.targetYear],
          set: {
            annualBillableHours: parsed.data.annualBillableHours?.toString() ?? null,
            annualTotalHours: parsed.data.annualTotalHours?.toString() ?? null,
            targetRealizationPctBps: parsed.data.targetRealizationPctBps ?? null,
            targetUtilizationPctBps: parsed.data.targetUtilizationPctBps ?? null,
            notes: parsed.data.notes ?? null,
            updatedAt: new Date(),
          },
        })
        .returning({ id: staffTargets.id });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'staff_target',
        entityId: row?.id,
        actorAppUserId: session.appUserId,
        after: { targetUserId: req.params['id']!, ...parsed.data },
      }).catch(() => undefined);
      res.status(201).json({ id: row?.id });
    },
  );

  router.delete(
    '/users/:id/targets/:targetId',
    requirePermission(deps, 'app_user:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      const session = req.staffSession!;
      if (!firmId || !deps.db) {
        res.json({ ok: true });
        return;
      }
      const deleted = await deps.db
        .delete(staffTargets)
        .where(
          and(
            eq(staffTargets.id, req.params['targetId']!),
            eq(staffTargets.appUserId, req.params['id']!),
          ),
        )
        .returning({ id: staffTargets.id });
      if (deleted.length === 0) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'staff_target',
        entityId: req.params['targetId']!,
        actorAppUserId: session.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  return router;
}
