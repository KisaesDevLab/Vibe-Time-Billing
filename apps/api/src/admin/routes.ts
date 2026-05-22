// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Admin endpoints (Phase 4). Backs the firm-settings, office, and user
// admin UIs. RBAC-gated via `requirePermission`.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  firms,
  firmSettings,
  notificationTemplates,
  officeSettings,
  offices,
  rolePermissions,
  roles,
  userRoles,
} from '@vibe/db/schema';
import { PERMISSION_KEYS, ROLE_TEMPLATES, type RoleSlug } from '@vibe/core/rbac';
import { seedNotificationTemplates } from '@vibe/db/seed-helpers';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface AdminRoutesDeps extends RbacDeps {
  db: Database | null;
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

const FirmSettingsPatchSchema = z
  .object({
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
    brandFooterHtml: z.string().max(4000).nullable().optional(),
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
  })
  .strict();

const FirmPatchSchema = z
  .object({
    // Phase 20 #5 — default allocation method.
    defaultAllocationMethod: z.enum(ALLOCATION_METHODS).optional(),
    // Phase 20 #6 — fiscal year start month (1..12).
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
    name: z.string().min(1).max(200).optional(),
    defaultTermsDays: z.number().int().min(0).max(365).optional(),
  })
  .strict();

export function createAdminRouter(deps: AdminRoutesDeps): Router {
  const router = express.Router();

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
      res.json({ firm, settings });
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
          status: appUsers.status,
          defaultOfficeId: appUsers.defaultOfficeId,
          totpEnrolledAt: appUsers.totpEnrolledAt,
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
      const body = req.body as {
        fullName?: unknown;
        defaultOfficeId?: unknown;
        status?: unknown;
        standardHoursPerWeek?: unknown;
        billableTargetHoursPerMonth?: unknown;
      };
      const patch: Record<string, unknown> = {};
      if (typeof body.fullName === 'string' && body.fullName.trim()) {
        patch['fullName'] = body.fullName.slice(0, 200);
      }
      if (typeof body.defaultOfficeId === 'string') {
        patch['defaultOfficeId'] = body.defaultOfficeId;
      }
      if (body.status === 'ACTIVE' || body.status === 'INACTIVE' || body.status === 'ARCHIVED') {
        patch['status'] = body.status;
      }
      // Phase 20 #7 — standard hours per week (utilization denominator).
      if (
        typeof body.standardHoursPerWeek === 'number' &&
        body.standardHoursPerWeek >= 0 &&
        body.standardHoursPerWeek <= 80
      ) {
        patch['standardHoursPerWeek'] = body.standardHoursPerWeek.toFixed(2);
      }
      // Phase 20 #8 — per-user billable target override.
      if (body.billableTargetHoursPerMonth === null) {
        patch['billableTargetHoursPerMonth'] = null;
      } else if (
        typeof body.billableTargetHoursPerMonth === 'number' &&
        body.billableTargetHoursPerMonth >= 0 &&
        body.billableTargetHoursPerMonth <= 300
      ) {
        patch['billableTargetHoursPerMonth'] = Math.round(body.billableTargetHoursPerMonth);
      }
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: 'no_fields_to_update' });
        return;
      }
      await deps.db
        .update(appUsers)
        .set(patch)
        .where(and(eq(appUsers.id, req.params['id']!), eq(appUsers.firmId, firmId)));
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

      const values = {
        officeId: office.id,
        adjustmentApprovalThresholdCents: numOrNull('adjustmentApprovalThresholdCents'),
        timeEntryRoundingHours: strOrNull('timeEntryRoundingHours'),
        lateEntryAlertDays: numOrNull('lateEntryAlertDays'),
        lateEntryLockoutDays: numOrNull('lateEntryLockoutDays'),
        invoiceNumberingPrefix: strOrNull('invoiceNumberingPrefix'),
        updatedAt: new Date(),
      };
      await deps.db
        .insert(officeSettings)
        .values(values)
        .onConflictDoUpdate({ target: officeSettings.officeId, set: values });
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
      const items = await deps.db
        .select()
        .from(notificationTemplates)
        .where(eq(notificationTemplates.firmId, firmId));
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
      const channel = req.params['channel'] === 'SMS' ? 'SMS' : 'EMAIL';
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
        channel: channel as 'EMAIL' | 'SMS',
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
      const channel = req.params['channel'] === 'SMS' ? 'SMS' : 'EMAIL';
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

  return router;
}
