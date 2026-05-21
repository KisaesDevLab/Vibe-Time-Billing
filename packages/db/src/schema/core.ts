// =====================================================================
// packages/db/src/schema/core.ts
//
// Core Drizzle schema for Vibe Time & Billing.
//
// Covers everything except the portal (see portal.ts for portal_identity,
// client_portal_access, portal_session, portal_invitation,
// portal_auth_challenge, and payment_method).
//
// This file is the authoritative reference for Phase 2. It implements
// all locked decisions from QUESTIONS.md:
//   - Single-firm per appliance (firm_id columns, no tenant resolver)
//   - USD only (no currency columns; amounts in integer cents)
//   - Soft delete (status enum with ARCHIVED on key tables)
//   - Standard rate snapshot at time entry (NOT NULL)
//   - Per-timekeeper adjustment_allocation grain with sum constraint
//   - Audit log append-only (enforced by Postgres role permissions, not by schema)
//
// In production, split into multiple files by domain
// (core/, taxonomy/, client-engagement/, billing/, audit/) and re-export
// from index.ts. Kept as one file here for skimmability.
// =====================================================================

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  jsonb,
  date,
  numeric,
  index,
  uniqueIndex,
  check,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// =====================================================================
// ENUMS
// =====================================================================

export const entityStatus = pgEnum('entity_status', [
  'PROSPECT',
  'ACTIVE',
  'INACTIVE',
  'ARCHIVED',
]);

export const userStatus = pgEnum('user_status', ['ACTIVE', 'INACTIVE', 'ARCHIVED']);

export const officeRole = pgEnum('office_role', ['PARTNER', 'MANAGER', 'SENIOR', 'STAFF', 'ADMIN']);

export const serviceLineCategory = pgEnum('service_line_category', [
  'tax',
  'audit',
  'advisory',
  'bookkeeping',
  'payroll',
]);

export const reasonCodeCategory = pgEnum('reason_code_category', [
  'WRITE_DOWN',
  'WRITE_UP',
  'TRANSFER',
]);

export const feeStructure = pgEnum('fee_structure', [
  'HOURLY',
  'HOURLY_NTE',
  'FIXED_FEE',
  'FIXED_FEE_WITH_MILESTONES',
  'RECURRING_SUBSCRIPTION',
]);

export const engagementStatus = pgEnum('engagement_status', [
  'PROPOSED',
  'ACTIVE',
  'PAUSED',
  'CLOSED',
  'ARCHIVED',
]);

export const recurringFrequency = pgEnum('recurring_frequency', [
  'WEEKLY',
  'BIWEEKLY',
  'MONTHLY',
  'QUARTERLY',
  'SEMIANNUAL',
  'ANNUAL',
]);

export const recurringPlanStatus = pgEnum('recurring_plan_status', [
  'ACTIVE',
  'PAUSED',
  'CANCELLED',
]);

export const milestoneTriggerType = pgEnum('milestone_trigger_type', [
  'DATE',
  'EVENT',
  'MANUAL',
]);

export const milestoneStatus = pgEnum('milestone_status', [
  'PENDING',
  'TRIGGERED',
  'INVOICED',
  'CANCELLED',
]);

export const hourBankTransactionType = pgEnum('hour_bank_transaction_type', [
  'PURCHASE',
  'DEBIT',
  'EXPIRE',
  'FORFEIT',
  'REFUND',
]);

export const timeEntryStatus = pgEnum('time_entry_status', [
  'DRAFT',
  'SUBMITTED',
  'LOCKED',
  'BILLED',
  'WRITTEN_OFF',
  'ARCHIVED',
]);

export const billingBatchStatus = pgEnum('billing_batch_status', [
  'DRAFT',
  'IN_REVIEW',
  'APPROVED',
  'INVOICED',
  'CANCELLED',
]);

export const billingBatchEntryAction = pgEnum('billing_batch_entry_action', [
  'INCLUDE',
  'DEFER',
  'WRITE_OFF',
  'WRITE_OFF_HELD',
]);

export const adjustmentMethod = pgEnum('adjustment_method', ['RATE', 'TIME', 'FEE']);

export const adjustmentAllocationMethod = pgEnum('adjustment_allocation_method', [
  'SPECIFIC_ENTRIES',
  'PRO_RATA_BY_VALUE',
  'PRO_RATA_BY_HOURS',
  'PARTNER_ABSORBS',
  'HIERARCHICAL_CASCADE',
  'CUSTOM_WEIGHTED',
]);

export const adjustmentStatus = pgEnum('adjustment_status', [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'APPLIED',
  'REVERSED',
]);

export const invoiceStatus = pgEnum('invoice_status', [
  'DRAFT',
  'SENT',
  'PARTIALLY_PAID',
  'PAID',
  'OVERDUE',
  'VOIDED',
]);

export const invoiceLineItemKind = pgEnum('invoice_line_item_kind', [
  'TIME_AGGREGATE',
  'FIXED_FEE',
  'MILESTONE',
  'RECURRING_FEE',
  'EXPENSE',
  'PROCESSING_FEE',
  'CUSTOM',
]);

export const consolidationPreference = pgEnum('consolidation_preference', [
  'CONSOLIDATED',
  'SEPARATE',
]);

export const paymentStatus = pgEnum('payment_status', [
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
]);

export const approvalEntityType = pgEnum('approval_entity_type', [
  'ADJUSTMENT',
  'PRE_BILL',
  'INVOICE',
  'ENGAGEMENT_LETTER',
  'RATE_CHANGE',
]);

export const approvalStatus = pgEnum('approval_status', [
  'PENDING',
  'APPROVED',
  'APPROVED_WITH_EDITS',
  'REJECTED',
  'CANCELLED',
  'AUTO_ESCALATED',
]);

export const auditAction = pgEnum('audit_action', [
  'CREATE',
  'UPDATE',
  'ARCHIVE',
  'RESTORE',
  'LOGIN',
  'LOGOUT',
  'STEP_UP',
  'EXPORT',
  'IMPERSONATE',
  'PAYMENT',
  'WEBHOOK_DELIVERY',
  'MCP_CALL',
  'AI_REQUEST',
  'BACKUP',
  'RESTORE_DATABASE',
]);

export const webhookDeliveryStatus = pgEnum('webhook_delivery_status', [
  'PENDING',
  'DELIVERED',
  'FAILED',
  'GAVE_UP',
]);

export const aiProvider = pgEnum('ai_provider', ['LOCAL_OLLAMA', 'LOCAL_LLAMACPP', 'ANTHROPIC', 'OPENAI_COMPATIBLE']);

// =====================================================================
// TABLE: firm
//
// Single-firm appliance: one row in production. Schema keeps firm_id
// columns everywhere for cleanliness and future multi-firm.
// =====================================================================

export const firms = pgTable('firm', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  fiscalYearStartMonth: integer('fiscal_year_start_month').notNull().default(1),
  defaultAllocationMethod: adjustmentAllocationMethod('default_allocation_method')
    .notNull()
    .default('PRO_RATA_BY_VALUE'),
  defaultTermsDays: integer('default_terms_days').notNull().default(30),

  // Settings JSON: branding (logo, colors), email templates, etc.
  settings: jsonb('settings').notNull().default({}),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// =====================================================================
// TABLE: firm_settings
//
// Discrete, queryable settings split out from firm.settings JSONB.
// Kept as a separate table because some are referenced in hot paths.
// =====================================================================

export const firmSettings = pgTable('firm_settings', {
  firmId: uuid('firm_id')
    .notNull()
    .references(() => firms.id, { onDelete: 'cascade' })
    .primaryKey(),

  // Adjustment approval — Q27
  adjustmentApprovalThresholdCents: bigint('adjustment_approval_threshold_cents', {
    mode: 'number',
  })
    .notNull()
    .default(100000),

  // AI cost cap — Q14
  aiMonthlyBudgetCents: bigint('ai_monthly_budget_cents', { mode: 'number' })
    .notNull()
    .default(10000),
  aiWarnThresholdPct: integer('ai_warn_threshold_pct').notNull().default(80),

  // Time entry rounding — Q19
  timeEntryRoundingHours: numeric('time_entry_rounding_hours', { precision: 4, scale: 2 })
    .notNull()
    .default('0.25'),

  // Step-up TOTP timeout — Q4
  stepUpTimeoutMinutes: integer('step_up_timeout_minutes').notNull().default(30),

  // Late entry alert threshold (days)
  lateEntryAlertDays: integer('late_entry_alert_days').notNull().default(3),
  lateEntryLockoutDays: integer('late_entry_lockout_days').notNull().default(14),

  // Default invoice numbering format
  invoiceNumberingPrefix: text('invoice_numbering_prefix').notNull().default('INV'),

  // Portal config — Q10
  portalEnabled: boolean('portal_enabled').notNull().default(true),
  portalSubdomain: text('portal_subdomain'),

  // Branding (Phase 4 #13)
  brandDisplayName: text('brand_display_name'),
  brandLogoUrl: text('brand_logo_url'),
  brandAccentColor: text('brand_accent_color'),
  brandSupportEmail: text('brand_support_email'),
  brandSupportPhone: text('brand_support_phone'),
  brandFooterHtml: text('brand_footer_html'),

  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// =====================================================================
// TABLE: office
// =====================================================================

export const offices = pgTable(
  'office',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    address: text('address'),
    timezone: text('timezone').notNull().default('America/Chicago'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmIdx: index('office_firm_idx').on(t.firmId),
  }),
);

// =====================================================================
// TABLE: office_settings — per-office overrides (Phase 4 #7)
// =====================================================================

// =====================================================================
// TABLE: notification_template (Phase 20 #12) — per-firm overrides for
// email/SMS notification copy. Variable insertion only, per Q28.
// =====================================================================

export const notificationTemplates = pgTable(
  'notification_template',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    channel: text('channel', { enum: ['EMAIL', 'SMS'] }).notNull(),
    subject: text('subject'),
    body: text('body').notNull(),
    variablesJson: jsonb('variables_json'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmKindIdx: index('notification_template_firm_kind_idx').on(t.firmId, t.kind),
    uniqueTriplet: uniqueIndex('notification_template_uk').on(t.firmId, t.kind, t.channel),
  }),
);

export const officeSettings = pgTable('office_settings', {
  officeId: uuid('office_id')
    .notNull()
    .references(() => offices.id, { onDelete: 'cascade' })
    .primaryKey(),
  // NULL = inherit from firm_settings
  adjustmentApprovalThresholdCents: bigint('adjustment_approval_threshold_cents', {
    mode: 'number',
  }),
  timeEntryRoundingHours: numeric('time_entry_rounding_hours', { precision: 4, scale: 2 }),
  lateEntryAlertDays: integer('late_entry_alert_days'),
  lateEntryLockoutDays: integer('late_entry_lockout_days'),
  invoiceNumberingPrefix: text('invoice_numbering_prefix'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// =====================================================================
// TABLE: app_user (STAFF — distinct from portal_identity)
// =====================================================================

export const appUsers = pgTable(
  'app_user',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    defaultOfficeId: uuid('default_office_id').references(() => offices.id),
    status: userStatus('status').notNull().default('ACTIVE'),

    // TOTP — Q5: required for all staff
    totpSecretEncrypted: text('totp_secret_encrypted'),
    totpEnrolledAt: timestamp('totp_enrolled_at', { withTimezone: true }),
    recoveryCodesEncrypted: text('recovery_codes_encrypted'),

    // Standard hours per week for utilization denominator
    standardHoursPerWeek: numeric('standard_hours_per_week', { precision: 5, scale: 2 })
      .notNull()
      .default('40.00'),

    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmEmailUnique: uniqueIndex('app_user_firm_email_uk').on(t.firmId, t.email),
    firmIdx: index('app_user_firm_idx').on(t.firmId),
    statusIdx: index('app_user_status_idx').on(t.status),
  }),
);

// =====================================================================
// TABLE: role + permissions + user_role
// =====================================================================

export const roles = pgTable(
  'role',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    systemFlag: boolean('system_flag').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmNameUnique: uniqueIndex('role_firm_name_uk').on(t.firmId, t.name),
  }),
);

export const rolePermissions = pgTable(
  'role_permission',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionKey: text('permission_key').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.roleId, t.permissionKey] }),
  }),
);

export const userRoles = pgTable(
  'user_role',
  {
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.appUserId, t.roleId] }),
  }),
);

// =====================================================================
// TAXONOMY: service_line, work_code, engagement_type, reason_code
// =====================================================================

export const serviceLines = pgTable(
  'service_line',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    category: serviceLineCategory('category').notNull(),
    color: text('color'),
    icon: text('icon'),
    status: entityStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmIdx: index('service_line_firm_idx').on(t.firmId),
  }),
);

export const workCodes = pgTable(
  'work_code',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    serviceLineId: uuid('service_line_id').references(() => serviceLines.id),
    key: text('key').notNull(), // e.g. "tax_prep", "audit_review"
    name: text('name').notNull(),
    billableDefault: boolean('billable_default').notNull().default(true),
    descriptionTemplate: text('description_template'),
    status: entityStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmKeyUnique: uniqueIndex('work_code_firm_key_uk').on(t.firmId, t.key),
    serviceLineIdx: index('work_code_service_line_idx').on(t.serviceLineId),
  }),
);

export const engagementTypes = pgTable(
  'engagement_type',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    serviceLineId: uuid('service_line_id').references(() => serviceLines.id),
    key: text('key').notNull(), // e.g. "individual_1040"
    name: text('name').notNull(),
    defaultFeeStructure: feeStructure('default_fee_structure'),
    defaultBudgetHours: numeric('default_budget_hours', { precision: 8, scale: 2 }),
    autoRolloverDefault: boolean('auto_rollover_default').notNull().default(false),
    templateData: jsonb('template_data').notNull().default({}),
    status: entityStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmKeyUnique: uniqueIndex('engagement_type_firm_key_uk').on(t.firmId, t.key),
  }),
);

export const reasonCodes = pgTable(
  'reason_code',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    category: reasonCodeCategory('category').notNull(),
    label: text('label').notNull(),
    status: entityStatus('status').notNull().default('ACTIVE'),
  },
  (t) => ({
    firmCatLabelUnique: uniqueIndex('reason_code_firm_cat_label_uk').on(t.firmId, t.category, t.label),
  }),
);

// =====================================================================
// TABLE: client
// =====================================================================

export const clients = pgTable(
  'client',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: entityStatus('status').notNull().default('ACTIVE'),
    partnerInChargeId: uuid('partner_in_charge_id')
      .notNull()
      .references(() => appUsers.id),

    billingContactName: text('billing_contact_name'),
    billingContactEmail: text('billing_contact_email'),
    billingContactPhone: text('billing_contact_phone'),
    billingAddress: text('billing_address'),

    termsDays: integer('terms_days').notNull().default(30),

    // Q26
    invoiceConsolidationPreference: consolidationPreference('invoice_consolidation_preference')
      .notNull()
      .default('SEPARATE'),

    customFields: jsonb('custom_fields').notNull().default({}),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    notes: text('notes'),

    // Legal hold (Phase 19 #12) — when true, the retention worker
    // skips this client's records and archive is blocked.
    legalHoldFlag: boolean('legal_hold_flag').notNull().default(false),
    legalHoldReason: text('legal_hold_reason'),
    legalHoldSetAt: timestamp('legal_hold_set_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmIdx: index('client_firm_idx').on(t.firmId),
    statusIdx: index('client_status_idx').on(t.status),
    partnerIdx: index('client_partner_idx').on(t.partnerInChargeId),
    nameSearchIdx: index('client_name_search_idx').on(t.firmId, t.name),
  }),
);

// =====================================================================
// TABLE: engagement
// =====================================================================

export const engagements = pgTable(
  'engagement',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    engagementTypeId: uuid('engagement_type_id').references(() => engagementTypes.id),
    name: text('name').notNull(),

    feeStructure: feeStructure('fee_structure').notNull(),
    feeAmountCents: bigint('fee_amount_cents', { mode: 'number' }),
    budgetHours: numeric('budget_hours', { precision: 8, scale: 2 }),
    budgetAmountCents: bigint('budget_amount_cents', { mode: 'number' }),

    // Mixed-mode flag — Q20: in_scope flag set per-entry at write time
    mixedModeEnabled: boolean('mixed_mode_enabled').notNull().default(false),
    // Array of work_code IDs considered in-scope for this engagement
    inScopeWorkCodeIds: jsonb('in_scope_work_code_ids').$type<string[]>().notNull().default([]),

    // Hourly NTE
    nteCapCents: bigint('nte_cap_cents', { mode: 'number' }),
    nteCapScope: text('nte_cap_scope'), // 'PERIOD' | 'LIFETIME'

    // Q9 — fee passthrough
    feePassthroughEnabled: boolean('fee_passthrough_enabled').notNull().default(false),

    partnerId: uuid('partner_id').references(() => appUsers.id),
    managerId: uuid('manager_id').references(() => appUsers.id),

    scopeDefinition: text('scope_definition'),

    status: engagementStatus('status').notNull().default('PROPOSED'),
    startDate: date('start_date'),
    endDate: date('end_date'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedReason: text('closed_reason'),

    autoRolloverEnabled: boolean('auto_rollover_enabled').notNull().default(false),
    autoRolloverPriceIncreasePct: numeric('auto_rollover_price_increase_pct', {
      precision: 5,
      scale: 2,
    }),

    customFields: jsonb('custom_fields').notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    clientIdx: index('engagement_client_idx').on(t.clientId),
    statusIdx: index('engagement_status_idx').on(t.status),
    partnerIdx: index('engagement_partner_idx').on(t.partnerId),
    feeStructureIdx: index('engagement_fee_structure_idx').on(t.feeStructure),
  }),
);

// =====================================================================
// RATE MANAGEMENT
//
// Resolution order (highest to lowest precedence):
//   engagement_rate_override → client_rate_override → service_line_rate
//     → timekeeper_rate → firm default
// =====================================================================

export const timekeeperRates = pgTable(
  'timekeeper_rate',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    billRateCents: bigint('bill_rate_cents', { mode: 'number' }).notNull(),
    costRateCents: bigint('cost_rate_cents', { mode: 'number' }),
    effectiveStart: date('effective_start').notNull(),
    effectiveEnd: date('effective_end'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userEffectiveIdx: index('timekeeper_rate_user_effective_idx').on(
      t.appUserId,
      t.effectiveStart,
    ),
  }),
);

export const clientRateOverrides = pgTable(
  'client_rate_override',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUsers.id),
    billRateCents: bigint('bill_rate_cents', { mode: 'number' }).notNull(),
    effectiveStart: date('effective_start').notNull(),
    effectiveEnd: date('effective_end'),
  },
  (t) => ({
    clientUserIdx: index('client_rate_override_client_user_idx').on(t.clientId, t.appUserId),
  }),
);

export const engagementRateOverrides = pgTable(
  'engagement_rate_override',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUsers.id),
    billRateCents: bigint('bill_rate_cents', { mode: 'number' }).notNull(),
    effectiveStart: date('effective_start').notNull(),
  },
  (t) => ({
    engUserIdx: index('engagement_rate_override_eng_user_idx').on(t.engagementId, t.appUserId),
  }),
);

export const serviceLineRates = pgTable(
  'service_line_rate',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    serviceLineId: uuid('service_line_id')
      .notNull()
      .references(() => serviceLines.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    billRateCents: bigint('bill_rate_cents', { mode: 'number' }).notNull(),
    effectiveStart: date('effective_start').notNull(),
    effectiveEnd: date('effective_end'),
  },
);

// =====================================================================
// TIME ENTRY
//
// Standard rate snapshot is NOT NULL — captured at write time. Historical
// reports never shift when rates change.
// =====================================================================

export const timeEntries = pgTable(
  'time_entry',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUsers.id),
    workCodeId: uuid('work_code_id').references(() => workCodes.id),
    entryDate: date('entry_date').notNull(),
    hours: numeric('hours', { precision: 6, scale: 2 }).notNull(),

    billableFlag: boolean('billable_flag').notNull().default(true),
    // Q20 — set at write time via in_scope_work_code_ids on engagement
    inScopeFlag: boolean('in_scope_flag').notNull().default(true),

    description: text('description').notNull().default(''),

    // SNAPSHOTS — captured at write time, never recomputed
    standardRateSnapshotCents: bigint('standard_rate_snapshot_cents', { mode: 'number' }).notNull(),
    standardAmountCents: bigint('standard_amount_cents', { mode: 'number' }).notNull(),

    status: timeEntryStatus('status').notNull().default('SUBMITTED'),

    billingBatchId: uuid('billing_batch_id'), // forward reference, see below
    lockedAt: timestamp('locked_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    engagementIdx: index('time_entry_engagement_idx').on(t.engagementId),
    userDateIdx: index('time_entry_user_date_idx').on(t.appUserId, t.entryDate),
    dateIdx: index('time_entry_date_idx').on(t.entryDate),
    statusIdx: index('time_entry_status_idx').on(t.status),
    batchIdx: index('time_entry_batch_idx').on(t.billingBatchId),
    // CRITICAL: snapshot must be present
    rateSnapshotPositive: check(
      'time_entry_rate_snapshot_positive',
      sql`${t.standardRateSnapshotCents} >= 0`,
    ),
    hoursPositive: check('time_entry_hours_positive', sql`${t.hours} > 0`),
  }),
);

export const timeEntryVersions = pgTable(
  'time_entry_version',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    timeEntryId: uuid('time_entry_id')
      .notNull()
      .references(() => timeEntries.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    fields: jsonb('fields').notNull(),
    editedById: uuid('edited_by_id').references(() => appUsers.id),
    editedAt: timestamp('edited_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entryVersionUnique: uniqueIndex('time_entry_version_entry_version_uk').on(t.timeEntryId, t.version),
  }),
);

// =====================================================================
// RECURRING BILLING
// =====================================================================

export const recurringBillingPlans = pgTable(
  'recurring_billing_plan',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    frequency: recurringFrequency('frequency').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    billingDayOfMonth: integer('billing_day_of_month'),
    nextRunDate: date('next_run_date').notNull(),
    autoPayFlag: boolean('auto_pay_flag').notNull().default(false),
    autoPayPaymentMethodId: uuid('auto_pay_payment_method_id'), // FK to payment_method in portal.ts
    prorationRule: text('proration_rule').notNull().default('DAILY'),
    status: recurringPlanStatus('status').notNull().default('ACTIVE'),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    pausedReason: text('paused_reason'),
    // Auto-pause after N consecutive autopay failures (Phase 10 #30)
    consecutiveFailureCount: integer('consecutive_failure_count').notNull().default(0),
    autopayPauseThreshold: integer('autopay_pause_threshold').notNull().default(3),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    engagementIdx: index('recurring_plan_engagement_idx').on(t.engagementId),
    nextRunIdx: index('recurring_plan_next_run_idx').on(t.nextRunDate, t.status),
  }),
);

export const recurringBillingPlanServices = pgTable('recurring_billing_plan_service', {
  planId: uuid('plan_id')
    .notNull()
    .references(() => recurringBillingPlans.id, { onDelete: 'cascade' }),
  serviceLineId: uuid('service_line_id')
    .notNull()
    .references(() => serviceLines.id),
  includedHours: numeric('included_hours', { precision: 8, scale: 2 }),
}, (t) => ({
  pk: primaryKey({ columns: [t.planId, t.serviceLineId] }),
}));

export const milestonePlans = pgTable('milestone_plan', {
  id: uuid('id').defaultRandom().primaryKey(),
  engagementId: uuid('engagement_id')
    .notNull()
    .references(() => engagements.id, { onDelete: 'cascade' })
    .unique(),
  totalFeeCents: bigint('total_fee_cents', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const milestones = pgTable(
  'milestone',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => milestonePlans.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    sequence: integer('sequence').notNull(),
    triggerType: milestoneTriggerType('trigger_type').notNull(),
    triggerDate: date('trigger_date'),
    triggerEventKey: text('trigger_event_key'),
    invoiceId: uuid('invoice_id'),
    status: milestoneStatus('status').notNull().default('PENDING'),
    triggeredAt: timestamp('triggered_at', { withTimezone: true }),
  },
  (t) => ({
    planSequenceIdx: index('milestone_plan_sequence_idx').on(t.planId, t.sequence),
    statusIdx: index('milestone_status_idx').on(t.status),
  }),
);

// =====================================================================
// HOUR BANK — ledger model. Residual is FORFEIT on close (Q22).
// =====================================================================

export const hourBanks = pgTable('hour_bank', {
  id: uuid('id').defaultRandom().primaryKey(),
  engagementId: uuid('engagement_id')
    .notNull()
    .references(() => engagements.id, { onDelete: 'cascade' })
    .unique(),
  openingHours: numeric('opening_hours', { precision: 8, scale: 2 }).notNull(),
  openingAmountCents: bigint('opening_amount_cents', { mode: 'number' }).notNull(),
  rolloverCapHours: numeric('rollover_cap_hours', { precision: 8, scale: 2 }),
  expirationDate: date('expiration_date'),
  forfeitedAt: timestamp('forfeited_at', { withTimezone: true }),
  forfeitedAmountCents: bigint('forfeited_amount_cents', { mode: 'number' }),
  // Phase 10 #15 — auto-replenish. When enabled and balance drops below
  // threshold, the bank-monitor worker tops the bank up to target.
  autoReplenishEnabled: boolean('auto_replenish_enabled').notNull().default(false),
  autoReplenishThresholdHours: numeric('auto_replenish_threshold_hours', {
    precision: 8,
    scale: 2,
  }),
  autoReplenishTargetHours: numeric('auto_replenish_target_hours', { precision: 8, scale: 2 }),
  autoReplenishLastRunAt: timestamp('auto_replenish_last_run_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const hourBankTransactions = pgTable(
  'hour_bank_transaction',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    hourBankId: uuid('hour_bank_id')
      .notNull()
      .references(() => hourBanks.id, { onDelete: 'cascade' }),
    type: hourBankTransactionType('type').notNull(),
    hours: numeric('hours', { precision: 8, scale: 2 }).notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    sourceRefType: text('source_ref_type'), // 'time_entry' | 'invoice' | etc.
    sourceRefId: uuid('source_ref_id'),
    runningBalanceHours: numeric('running_balance_hours', { precision: 10, scale: 2 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bankOccurredIdx: index('hour_bank_tx_bank_occurred_idx').on(t.hourBankId, t.occurredAt),
  }),
);

// =====================================================================
// BILLING BATCH (PRE-BILL)
// =====================================================================

export const billingBatches = pgTable(
  'billing_batch',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    status: billingBatchStatus('status').notNull().default('DRAFT'),
    createdById: uuid('created_by_id').references(() => appUsers.id),
    approvedById: uuid('approved_by_id').references(() => appUsers.id),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    engagementPeriodIdx: index('billing_batch_engagement_period_idx').on(
      t.engagementId,
      t.periodStart,
    ),
    statusIdx: index('billing_batch_status_idx').on(t.status),
  }),
);

export const billingBatchEntries = pgTable(
  'billing_batch_entry',
  {
    billingBatchId: uuid('billing_batch_id')
      .notNull()
      .references(() => billingBatches.id, { onDelete: 'cascade' }),
    timeEntryId: uuid('time_entry_id')
      .notNull()
      .references(() => timeEntries.id),
    action: billingBatchEntryAction('action').notNull().default('INCLUDE'),
    comment: text('comment'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.billingBatchId, t.timeEntryId] }),
    timeEntryIdx: index('billing_batch_entry_time_entry_idx').on(t.timeEntryId),
  }),
);

// =====================================================================
// ADJUSTMENT — the wedge.
//
// adjustment_allocation is at the per-timekeeper grain:
//   (adjustment_id, time_entry_id, app_user_id) → adjustment_amount_cents
//
// Constraint: SUM(adjustment_amount_cents) = adjustment.total_amount_cents
// Enforced by application logic + a check via deferred trigger (not in this
// file; see migrations/0002_adjustment_sum_trigger.sql).
// =====================================================================

export const adjustments = pgTable(
  'adjustment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    billingBatchId: uuid('billing_batch_id')
      .notNull()
      .references(() => billingBatches.id),
    method: adjustmentMethod('method').notNull(),
    allocationMethod: adjustmentAllocationMethod('allocation_method').notNull(),
    // Signed — negative for write-down, positive for write-up
    totalAmountCents: bigint('total_amount_cents', { mode: 'number' }).notNull(),
    reasonCodeId: uuid('reason_code_id')
      .notNull()
      .references(() => reasonCodes.id),
    notes: text('notes'),
    status: adjustmentStatus('status').notNull().default('DRAFT'),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => appUsers.id),
    approverId: uuid('approver_id').references(() => appUsers.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    reversedById: uuid('reversed_by_id').references(() => appUsers.id),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    customWeightedInputType: text('custom_weighted_input_type'), // 'PERCENT' | 'DOLLAR' for Q21
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    batchIdx: index('adjustment_batch_idx').on(t.billingBatchId),
    statusIdx: index('adjustment_status_idx').on(t.status),
    reasonIdx: index('adjustment_reason_idx').on(t.reasonCodeId),
  }),
);

export const adjustmentAllocations = pgTable(
  'adjustment_allocation',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    adjustmentId: uuid('adjustment_id')
      .notNull()
      .references(() => adjustments.id, { onDelete: 'cascade' }),
    timeEntryId: uuid('time_entry_id')
      .notNull()
      .references(() => timeEntries.id),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUsers.id),
    originalValueCents: bigint('original_value_cents', { mode: 'number' }).notNull(),
    adjustedValueCents: bigint('adjusted_value_cents', { mode: 'number' }).notNull(),
    // Signed: negative = write-down impact, positive = write-up
    adjustmentAmountCents: bigint('adjustment_amount_cents', { mode: 'number' }).notNull(),
  },
  (t) => ({
    adjustmentIdx: index('adjustment_allocation_adjustment_idx').on(t.adjustmentId),
    timeEntryIdx: index('adjustment_allocation_time_entry_idx').on(t.timeEntryId),
    userIdx: index('adjustment_allocation_user_idx').on(t.appUserId),
    // (adjustment, time_entry, user) is the natural key
    naturalKey: uniqueIndex('adjustment_allocation_natural_uk').on(
      t.adjustmentId,
      t.timeEntryId,
      t.appUserId,
    ),
  }),
);

// =====================================================================
// INVOICE & PAYMENT
// =====================================================================

export const invoices = pgTable(
  'invoice',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    // Multi-engagement consolidated invoice has billing_batch_ids in line_items;
    // single-engagement invoices use this convenience pointer
    primaryEngagementId: uuid('primary_engagement_id').references(() => engagements.id),

    invoiceNumber: text('invoice_number').notNull(),
    issueDate: date('issue_date').notNull(),
    dueDate: date('due_date').notNull(),
    subtotalCents: bigint('subtotal_cents', { mode: 'number' }).notNull(),
    feeCents: bigint('fee_cents', { mode: 'number' }).notNull().default(0),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull(),

    status: invoiceStatus('status').notNull().default('DRAFT'),
    sentAt: timestamp('sent_at', { withTimezone: true }),

    // Q30 — portal-view receipt
    firstViewedAt: timestamp('first_viewed_at', { withTimezone: true }),

    paidCents: bigint('paid_cents', { mode: 'number' }).notNull().default(0),
    paidAt: timestamp('paid_at', { withTimezone: true }),

    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedReason: text('voided_reason'),

    notes: text('notes'),
    payToUnlockAttachments: boolean('pay_to_unlock_attachments').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmNumberUnique: uniqueIndex('invoice_firm_number_uk').on(t.firmId, t.invoiceNumber),
    clientIdx: index('invoice_client_idx').on(t.clientId),
    statusIdx: index('invoice_status_idx').on(t.status),
    dueDateIdx: index('invoice_due_date_idx').on(t.dueDate),
  }),
);

export const invoiceLineItems = pgTable(
  'invoice_line_item',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    kind: invoiceLineItemKind('kind').notNull(),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 10, scale: 2 }),
    rateCents: bigint('rate_cents', { mode: 'number' }),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    engagementId: uuid('engagement_id').references(() => engagements.id),
    sourceRefType: text('source_ref_type'), // 'billing_batch' | 'milestone' | 'recurring_plan' | 'expense' | 'manual'
    sourceRefId: uuid('source_ref_id'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => ({
    invoiceIdx: index('invoice_line_item_invoice_idx').on(t.invoiceId),
  }),
);

export const payments = pgTable(
  'payment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    feeCents: bigint('fee_cents', { mode: 'number' }).notNull().default(0),
    paymentMethodId: uuid('payment_method_id'), // FK to payment_method in portal.ts
    provider: text('provider').notNull(), // 'STRIPE' | 'CPACHARGE' | 'MANUAL'
    providerChargeId: text('provider_charge_id'),
    status: paymentStatus('status').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    refundedAmountCents: bigint('refunded_amount_cents', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    invoiceIdx: index('payment_invoice_idx').on(t.invoiceId),
    providerChargeIdx: index('payment_provider_charge_idx').on(t.providerChargeId),
  }),
);

// =====================================================================
// TABLE: client_note + engagement_note + approval_comment
// Note threads — immutable rows; edits supersede via new inserts.
// =====================================================================

export const clientNotes = pgTable(
  'client_note',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => appUsers.id),
    body: text('body').notNull(),
    pinned: boolean('pinned').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    clientIdx: index('client_note_client_idx').on(t.clientId, t.createdAt),
  }),
);

export const engagementNotes = pgTable(
  'engagement_note',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => appUsers.id),
    body: text('body').notNull(),
    pinned: boolean('pinned').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    engagementIdx: index('engagement_note_eng_idx').on(t.engagementId, t.createdAt),
  }),
);

// =====================================================================
// TABLE: engagement_letter — versioned engagement letters with HTML body
// and optional storage_path to the rendered PDF.
// =====================================================================

export const engagementLetters = pgTable(
  'engagement_letter',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: text('status').notNull().default('DRAFT'),
    bodyHtml: text('body_html').notNull(),
    storagePath: text('storage_path'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    sentToEmail: text('sent_to_email'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedIp: text('accepted_ip'),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedReason: text('voided_reason'),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    engIdx: index('engagement_letter_eng_idx').on(t.engagementId),
    statusIdx: index('engagement_letter_status_idx').on(t.status),
    engVersionUnique: uniqueIndex('engagement_letter_eng_version_uk').on(t.engagementId, t.version),
  }),
);

// =====================================================================
// TABLE: attachment — generic uploaded-file metadata
// =====================================================================

export const attachments = pgTable(
  'attachment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    ownerType: text('owner_type').notNull(),
    ownerId: uuid('owner_id').notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    storagePath: text('storage_path').notNull(),
    uploadedById: uuid('uploaded_by_id')
      .notNull()
      .references(() => appUsers.id),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdx: index('attachment_owner_idx').on(t.ownerType, t.ownerId),
    firmIdx: index('attachment_firm_idx').on(t.firmId),
  }),
);

export const requiredFieldRules = pgTable(
  'required_field_rule',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    conditionsJson: jsonb('conditions_json').notNull(),
    requiredFields: jsonb('required_fields').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmIdx: index('required_field_rule_firm_idx').on(t.firmId, t.status),
  }),
);

// =====================================================================
// TABLE: saved_report (Phase 18 #21)
// Persisted report filter state owned by a staff user; shared_flag lets
// a partner publish a definition firm-wide.
// =====================================================================

export const savedReports = pgTable(
  'saved_report',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => appUsers.id),
    name: text('name').notNull(),
    reportKind: text('report_kind').notNull(),
    paramsJson: jsonb('params_json').notNull().default({}),
    sharedFlag: boolean('shared_flag').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmIdx: index('saved_report_firm_idx').on(t.firmId),
    ownerIdx: index('saved_report_owner_idx').on(t.ownerId),
    ownerNameUk: uniqueIndex('saved_report_owner_name_uk').on(t.ownerId, t.name),
  }),
);

// =====================================================================
// TABLE: holiday_calendar
// Firm holidays + per-user PTO. app_user_id NULL means firm-wide.
// =====================================================================

export const holidayCalendar = pgTable(
  'holiday_calendar',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    appUserId: uuid('app_user_id').references(() => appUsers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    kind: text('kind').notNull().default('HOLIDAY'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmRangeIdx: index('holiday_calendar_firm_range_idx').on(t.firmId, t.startDate, t.endDate),
    userRangeIdx: index('holiday_calendar_user_range_idx').on(t.appUserId, t.startDate, t.endDate),
  }),
);

// =====================================================================
// TABLE: dunning_history
// Per-invoice ledger of dunning steps already dispatched. The sweep job
// consults this to skip already-sent kinds and writes on each dispatch.
// =====================================================================

export const dunningHistory = pgTable(
  'dunning_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    stepKind: text('step_kind').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    channel: text('channel'),
    recipient: text('recipient'),
    outcome: text('outcome').notNull().default('SENT'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    invoiceIdx: index('dunning_history_invoice_idx').on(t.invoiceId),
    sentAtIdx: index('dunning_history_sent_at_idx').on(t.sentAt),
    invoiceStepUnique: uniqueIndex('dunning_history_invoice_step_uk').on(t.invoiceId, t.stepKind),
  }),
);

// =====================================================================
// APPROVAL WORKFLOW
// =====================================================================

export const approvalRules = pgTable(
  'approval_rule',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    entityType: approvalEntityType('entity_type').notNull(),
    name: text('name').notNull(),
    conditionsJson: jsonb('conditions_json').notNull(), // expression language for the rule
    approverResolutionJson: jsonb('approver_resolution_json').notNull(), // role | user | by-engagement-partner | etc.
    slaHours: integer('sla_hours'),
    autoEscalateHours: integer('auto_escalate_hours'),
    priority: integer('priority').notNull().default(100),
    status: entityStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmEntityIdx: index('approval_rule_firm_entity_idx').on(t.firmId, t.entityType),
  }),
);

export const approvalRequests = pgTable(
  'approval_request',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ruleId: uuid('rule_id').references(() => approvalRules.id),
    entityType: approvalEntityType('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    requesterId: uuid('requester_id')
      .notNull()
      .references(() => appUsers.id),
    approverId: uuid('approver_id').references(() => appUsers.id),
    status: approvalStatus('status').notNull().default('PENDING'),
    comments: text('comments'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    // Phase 18 #5 — multi-step routing
    currentStep: integer('current_step').notNull().default(1),
    totalSteps: integer('total_steps').notNull().default(1),
    stepsJson: jsonb('steps_json'),
  },
  (t) => ({
    entityIdx: index('approval_request_entity_idx').on(t.entityType, t.entityId),
    approverStatusIdx: index('approval_request_approver_status_idx').on(t.approverId, t.status),
  }),
);

export const approvalComments = pgTable(
  'approval_comment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => approvalRequests.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => appUsers.id),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    requestIdx: index('approval_comment_request_idx').on(t.requestId, t.createdAt),
  }),
);

// =====================================================================
// AUDIT LOG
//
// CRITICAL: app role must have REVOKE UPDATE, DELETE on this table.
// Enforced by migration `0001_audit_log_immutability.sql`.
// =====================================================================

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),

    // Actor: exactly one of these must be set
    actorAppUserId: uuid('actor_app_user_id').references(() => appUsers.id),
    actorPortalIdentityId: uuid('actor_portal_identity_id'), // FK to portal_identity in portal.ts
    actorMcpTokenId: uuid('actor_mcp_token_id'), // FK to mcp_token below

    // For portal actors, capture the current entity context
    activeClientId: uuid('active_client_id').references(() => clients.id),

    action: auditAction('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),

    beforeJson: jsonb('before_json'),
    afterJson: jsonb('after_json'),

    ip: text('ip'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
  },
  (t) => ({
    occurredAtIdx: index('audit_log_occurred_at_idx').on(t.occurredAt),
    entityIdx: index('audit_log_entity_idx').on(t.entityType, t.entityId),
    actorAppUserIdx: index('audit_log_actor_app_user_idx').on(t.actorAppUserId),
    actorPortalIdx: index('audit_log_actor_portal_idx').on(t.actorPortalIdentityId),
    // Exactly one of three actor columns must be set
    actorMutexCheck: check(
      'audit_log_actor_mutex',
      sql`(
        (CASE WHEN ${t.actorAppUserId} IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN ${t.actorPortalIdentityId} IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN ${t.actorMcpTokenId} IS NOT NULL THEN 1 ELSE 0 END)
      ) = 1`,
    ),
  }),
);

// =====================================================================
// WEBHOOKS, MCP TOKENS, AI REQUEST LOG
// =====================================================================

export const webhookEndpoints = pgTable(
  'webhook_endpoint',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    secretHash: text('secret_hash').notNull(),
    events: jsonb('events').$type<string[]>().notNull(),
    status: entityStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

export const webhookDeliveries = pgTable(
  'webhook_delivery',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    webhookEndpointId: uuid('webhook_endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    status: webhookDeliveryStatus('status').notNull().default('PENDING'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index('webhook_delivery_status_idx').on(t.status, t.nextAttemptAt),
  }),
);

export const mcpTokens = pgTable(
  'mcp_token',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    allowedTools: jsonb('allowed_tools').$type<string[]>().notNull(),
    createdById: uuid('created_by_id').references(() => appUsers.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

export const aiRequestLog = pgTable(
  'ai_request_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    provider: aiProvider('provider').notNull(),
    model: text('model').notNull(),
    feature: text('feature').notNull(), // e.g. 'description_suggestion', 'plain_english_query'
    requestTokens: integer('request_tokens'),
    responseTokens: integer('response_tokens'),
    costCents: integer('cost_cents'),
    latencyMs: integer('latency_ms'),
    success: boolean('success').notNull(),
    errorMessage: text('error_message'),
    appUserId: uuid('app_user_id').references(() => appUsers.id),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmMonthIdx: index('ai_request_log_firm_month_idx').on(t.firmId, t.occurredAt),
  }),
);

// =====================================================================
// RELATIONS (selected — extend as needed for query helpers)
// =====================================================================

export const firmRelations = relations(firms, ({ many, one }) => ({
  offices: many(offices),
  appUsers: many(appUsers),
  clients: many(clients),
  serviceLines: many(serviceLines),
  settings: one(firmSettings),
}));

export const clientRelations = relations(clients, ({ one, many }) => ({
  firm: one(firms, { fields: [clients.firmId], references: [firms.id] }),
  partnerInCharge: one(appUsers, {
    fields: [clients.partnerInChargeId],
    references: [appUsers.id],
  }),
  engagements: many(engagements),
  invoices: many(invoices),
}));

export const engagementRelations = relations(engagements, ({ one, many }) => ({
  client: one(clients, { fields: [engagements.clientId], references: [clients.id] }),
  type: one(engagementTypes, {
    fields: [engagements.engagementTypeId],
    references: [engagementTypes.id],
  }),
  partner: one(appUsers, { fields: [engagements.partnerId], references: [appUsers.id] }),
  manager: one(appUsers, { fields: [engagements.managerId], references: [appUsers.id] }),
  timeEntries: many(timeEntries),
  billingBatches: many(billingBatches),
  recurringPlans: many(recurringBillingPlans),
}));

export const timeEntryRelations = relations(timeEntries, ({ one, many }) => ({
  engagement: one(engagements, {
    fields: [timeEntries.engagementId],
    references: [engagements.id],
  }),
  appUser: one(appUsers, { fields: [timeEntries.appUserId], references: [appUsers.id] }),
  workCode: one(workCodes, { fields: [timeEntries.workCodeId], references: [workCodes.id] }),
  versions: many(timeEntryVersions),
}));

export const adjustmentRelations = relations(adjustments, ({ one, many }) => ({
  billingBatch: one(billingBatches, {
    fields: [adjustments.billingBatchId],
    references: [billingBatches.id],
  }),
  reasonCode: one(reasonCodes, {
    fields: [adjustments.reasonCodeId],
    references: [reasonCodes.id],
  }),
  approver: one(appUsers, { fields: [adjustments.approverId], references: [appUsers.id] }),
  createdBy: one(appUsers, { fields: [adjustments.createdById], references: [appUsers.id] }),
  allocations: many(adjustmentAllocations),
}));

export const adjustmentAllocationRelations = relations(adjustmentAllocations, ({ one }) => ({
  adjustment: one(adjustments, {
    fields: [adjustmentAllocations.adjustmentId],
    references: [adjustments.id],
  }),
  timeEntry: one(timeEntries, {
    fields: [adjustmentAllocations.timeEntryId],
    references: [timeEntries.id],
  }),
  appUser: one(appUsers, {
    fields: [adjustmentAllocations.appUserId],
    references: [appUsers.id],
  }),
}));

export const invoiceRelations = relations(invoices, ({ one, many }) => ({
  firm: one(firms, { fields: [invoices.firmId], references: [firms.id] }),
  client: one(clients, { fields: [invoices.clientId], references: [clients.id] }),
  primaryEngagement: one(engagements, {
    fields: [invoices.primaryEngagementId],
    references: [engagements.id],
  }),
  lineItems: many(invoiceLineItems),
  payments: many(payments),
}));

// =====================================================================
// INFERRED TYPES
// =====================================================================

export type Firm = typeof firms.$inferSelect;
export type NewFirm = typeof firms.$inferInsert;
export type FirmSettings = typeof firmSettings.$inferSelect;

export type Office = typeof offices.$inferSelect;
export type AppUser = typeof appUsers.$inferSelect;
export type NewAppUser = typeof appUsers.$inferInsert;

export type Role = typeof roles.$inferSelect;
export type ServiceLine = typeof serviceLines.$inferSelect;
export type WorkCode = typeof workCodes.$inferSelect;
export type EngagementType = typeof engagementTypes.$inferSelect;
export type ReasonCode = typeof reasonCodes.$inferSelect;

export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
export type Engagement = typeof engagements.$inferSelect;
export type NewEngagement = typeof engagements.$inferInsert;

export type TimekeeperRate = typeof timekeeperRates.$inferSelect;
export type TimeEntry = typeof timeEntries.$inferSelect;
export type NewTimeEntry = typeof timeEntries.$inferInsert;

export type RecurringBillingPlan = typeof recurringBillingPlans.$inferSelect;
export type Milestone = typeof milestones.$inferSelect;
export type HourBank = typeof hourBanks.$inferSelect;
export type HourBankTransaction = typeof hourBankTransactions.$inferSelect;

export type BillingBatch = typeof billingBatches.$inferSelect;
export type Adjustment = typeof adjustments.$inferSelect;
export type NewAdjustment = typeof adjustments.$inferInsert;
export type AdjustmentAllocation = typeof adjustmentAllocations.$inferSelect;
export type NewAdjustmentAllocation = typeof adjustmentAllocations.$inferInsert;

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;
export type Payment = typeof payments.$inferSelect;

export type ApprovalRule = typeof approvalRules.$inferSelect;
export type ApprovalRequest = typeof approvalRequests.$inferSelect;

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;

export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type McpToken = typeof mcpTokens.$inferSelect;
export type AiRequestLogRow = typeof aiRequestLog.$inferSelect;

// =====================================================================
// MIGRATION ORDER NOTES
//
// Apply migrations in this order to satisfy FK dependencies:
//
//   1. firm
//   2. office
//   3. app_user, role, role_permission, user_role
//   4. firm_settings
//   5. service_line, work_code, engagement_type, reason_code
//   6. client
//   7. engagement
//   8. timekeeper_rate, client_rate_override, engagement_rate_override, service_line_rate
//   9. time_entry, time_entry_version
//   10. recurring_billing_plan, recurring_billing_plan_service
//   11. milestone_plan, milestone
//   12. hour_bank, hour_bank_transaction
//   13. billing_batch, billing_batch_entry
//   14. adjustment, adjustment_allocation (+ deferred-trigger sum constraint)
//   15. invoice, invoice_line_item
//   16. payment (FK to payment_method from portal.ts — apply portal.ts before this)
//   17. approval_rule, approval_request
//   18. audit_log (+ REVOKE UPDATE, DELETE on app role)
//   19. webhook_endpoint, webhook_delivery
//   20. mcp_token
//   21. ai_request_log
//
// Materialized views (realization_view, utilization_view, profitability_view,
// ar_aging_snapshot) are created in a separate migration after all base tables exist.
//
// Audit log immutability is enforced in migrations/0001_audit_log_immutability.sql:
//
//   REVOKE UPDATE, DELETE ON audit_log FROM app_role;
//   GRANT INSERT, SELECT ON audit_log TO app_role;
//
// adjustment_allocation sum constraint enforced in 0002_adjustment_sum_trigger.sql
// as a DEFERRABLE INITIALLY DEFERRED constraint trigger so multi-row inserts
// in a transaction are validated at commit, not row-by-row.
// =====================================================================
