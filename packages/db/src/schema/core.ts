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
  customType,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// Drizzle has no built-in bytea type. Define it once and reuse.
// 0058 — Master Firm Key envelope + sentinel ciphertext both need
// binary columns; future messaging/file encryption will too.
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (v) => Buffer.from(v),
  fromDriver: (v) => new Uint8Array(v),
});

// =====================================================================
// ENUMS
// =====================================================================

export const entityStatus = pgEnum('entity_status', [
  'PROSPECT',
  'ACTIVE',
  'INACTIVE',
  'ARCHIVED',
]);

// v2 0026 — CRM-class client model expansion.
export const clientType = pgEnum('client_type', ['INDIVIDUAL', 'BUSINESS']);
export const filingStatus = pgEnum('filing_status', [
  'SINGLE',
  'MFJ',
  'MFS',
  'HOH',
  'QW',
]);
export const pipelineStage = pgEnum('pipeline_stage', ['PROSPECT', 'CLIENT', 'OTHER']);

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

// v2 Part 2 — operational workflow state, distinct from billing
// lifecycle status. Drives the /engagements list view (Canopy-style).
export const engagementWorkflowState = pgEnum('engagement_workflow_state', [
  'NO_STATUS',
  'NOT_STARTED',
  'READY',
  'IN_PROGRESS',
  'ON_HOLD',
  'NEEDS_REVIEW',
  'WITH_CLIENT',
  'COMPLETED',
  'CANCELED',
  'DRAFT',
]);

export const engagementPriority = pgEnum('engagement_priority', [
  'LOW',
  'MEDIUM',
  'HIGH',
  'URGENT',
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
  // v2 — sales tax + per-engagement surcharge lines on the invoice.
  'SALES_TAX',
  'SURCHARGE',
  // 0066 — retainer-purchase AR invoice carries a single RETAINER
  // line. The payment webhook keys off invoice.metadata.retainerOfferId
  // (R3) to activate the retainer.
  'RETAINER',
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

// 0050 — retainer billing batch kind.
export const billingBatchKind = pgEnum('billing_batch_kind', ['STANDARD', 'RETAINER']);

// 0050 — engagement assignment role (multi-staff join table).
export const engagementAssignmentRole = pgEnum('engagement_assignment_role', [
  'PARTNER',
  'MANAGER',
  'REVIEWER',
  'PREPARER',
  'STAFF',
]);

// 0050 — invoice reminder log kind (auto dunning vs staff-triggered).
export const invoiceReminderKind = pgEnum('invoice_reminder_kind', ['AUTO', 'MANUAL']);

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

  // Phase 20 #4 — which fee structures are exposed in engagement-create.
  enabledFeeStructures: jsonb('enabled_fee_structures')
    .$type<string[]>()
    .notNull()
    .default(['HOURLY', 'HOURLY_NTE', 'FIXED_FEE', 'FIXED_FEE_WITH_MILESTONES', 'RECURRING_SUBSCRIPTION']),

  // Phase 23 #6 — firm-wide AI provider override. NULL = local-first (Q15).
  aiProvider: text('ai_provider'),

  // Phase 20 #8 — firm-wide billable-target default. Per-user override
  // lives on app_user.billable_target_hours_per_month.
  billableTargetHoursPerMonth: integer('billable_target_hours_per_month').notNull().default(130),

  // Phase 13 #6 — invoice template picker. One of 'modern', 'classic',
  // 'minimal'. CHECK constraint enforces the value space.
  invoiceTemplateStyle: text('invoice_template_style').notNull().default('modern'),

  // Branding (Phase 4 #13)
  brandDisplayName: text('brand_display_name'),
  brandLogoUrl: text('brand_logo_url'),
  brandAccentColor: text('brand_accent_color'),
  brandSupportEmail: text('brand_support_email'),
  brandSupportPhone: text('brand_support_phone'),
  brandFooterHtml: text('brand_footer_html'),

  // 0053 — Billing + A/R block (legacy "Firm — Billing and A/R" tab).
  brandSupportFax: text('brand_support_fax'),
  brandSupportWeb: text('brand_support_web'),
  arTermsText: text('ar_terms_text'),
  statementEmailMessage: text('statement_email_message'),
  defaultStatementFormat: text('default_statement_format')
    .notNull()
    .default('detailed_open_amounts'),
  achProcessingEnabled: boolean('ach_processing_enabled').notNull().default(false),
  creditCardProcessingEnabled: boolean('credit_card_processing_enabled')
    .notNull()
    .default(false),
  assessServiceChargesEnabled: boolean('assess_service_charges_enabled').notNull().default(false),
  serviceChargeRateBps: integer('service_charge_rate_bps').notNull().default(0),
  dunningMessage1: text('dunning_message_1'),
  dunningMessage2: text('dunning_message_2'),
  dunningMessage3: text('dunning_message_3'),
  dunningMessage4: text('dunning_message_4'),
  dunningMessage5: text('dunning_message_5'),

  // v2 — default surcharge label inherited by engagements whose
  // surcharge_label is NULL. Lets a firm say "Technology fee" once.
  defaultSurchargeLabel: text('default_surcharge_label').notNull().default('Surcharge'),

  // v2 Sprint A 0035 — DB-backed messaging provider config, encrypted
  // at rest with AES-256-GCM. NULL = inherit from env vars.
  mailConfigEncrypted: text('mail_config_encrypted'),
  smsConfigEncrypted: text('sms_config_encrypted'),
  mailConfigUpdatedAt: timestamp('mail_config_updated_at', { withTimezone: true }),
  smsConfigUpdatedAt: timestamp('sms_config_updated_at', { withTimezone: true }),

  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 0058 — firm_config: per-firm tunables for the absorbed Connect-style
// feature set. One row per firm; seeded on firm creation. Defaults
// match the addendum's locked decisions (Q1/Q3/Q4/I.8). Distinct from
// firm_settings, which holds the billing/email/branding knobs.
export const firmConfig = pgTable(
  'firm_config',
  {
    firmId: uuid('firm_id')
      .primaryKey()
      .references(() => firms.id, { onDelete: 'cascade' }),
    unlockMode: text('unlock_mode').notNull().default('sealed-on-disk'),
    suggestionExpirationDays: integer('suggestion_expiration_days').notNull().default(7),
    escrowVisibility: text('escrow_visibility').notNull().default('engagement-access'),
    writeOffStepUpThresholdCents: bigint('write_off_step_up_threshold_cents', { mode: 'number' })
      .notNull()
      .default(50000),
    creditStepUpThresholdCents: bigint('credit_step_up_threshold_cents', { mode: 'number' })
      .notNull()
      .default(50000),
    aiEgressEnabled: boolean('ai_egress_enabled').notNull().default(false),
    vibeShieldEndpoint: text('vibe_shield_endpoint'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    unlockModeCk: check(
      'firm_config_unlock_mode_ck',
      sql`${t.unlockMode} IN ('sealed-on-disk', 'admin-passphrase')`,
    ),
    escrowVisibilityCk: check(
      'firm_config_escrow_visibility_ck',
      sql`${t.escrowVisibility} IN ('engagement-access', 'partner-and-assigned-only')`,
    ),
  }),
);

// 0058 — firm_key_envelope: persists the MFK wrapped by the KEK, plus
// metadata about KEK derivation and a sentinel ciphertext used to
// verify the MFK at startup. Empty until FirmKeyManager.bootstrap()
// writes a row on first API boot.
export const firmKeyEnvelope = pgTable('firm_key_envelope', {
  firmId: uuid('firm_id')
    .primaryKey()
    .references(() => firms.id, { onDelete: 'cascade' }),
  wrappedMfk: bytea('wrapped_mfk').notNull(),
  kekMetadata: jsonb('kek_metadata').notNull(),
  sentinelCiphertext: bytea('sentinel_ciphertext').notNull(),
  rotationVersion: integer('rotation_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
    // Phase 4 #14 — when set, new clients created in this office inherit
    // this user as partner-in-charge (still overridable per client).
    defaultPartnerInChargeId: uuid('default_partner_in_charge_id'),
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

    // Phase 20 #8 — per-user billable target override. NULL = inherit
    // firm_settings.billable_target_hours_per_month.
    billableTargetHoursPerMonth: integer('billable_target_hours_per_month'),

    // 0054 — structured profile (Main + Contact Info tabs). full_name
    // stays as the canonical display field and is recomputed from parts
    // when first/last are present.
    firstName: text('first_name'),
    middleName: text('middle_name'),
    lastName: text('last_name'),
    title: text('title'),
    salutation: text('salutation'),
    businessPhone: text('business_phone'),
    homePhone: text('home_phone'),
    faxPhone: text('fax_phone'),
    mobilePhone: text('mobile_phone'),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    state: text('state'),
    zip: text('zip'),
    hiredDate: date('hired_date'),
    leftDate: date('left_date'),

    // 0062 — staff profile expansion (CCH-style 9-tab profile).
    // display_id is a short login-style identifier ("ADMIN", "SCHEN")
    // unique per firm; description is the free-text label shown next
    // to it on the Main tab.
    displayId: text('display_id'),
    description: text('description'),
    photoUrl: text('photo_url'),
    // (0063 dropped app_user.cost_rate_cents — was write-only with no
    //  reader. Cost rate lives on staff_rate_snapshot + is snapshotted
    //  onto time_entry.cost_rate_snapshot_cents at write time.)
    internalNotes: text('internal_notes'),
    // Phone extensions paired with each phone slot.
    businessPhoneExt: text('business_phone_ext'),
    homePhoneExt: text('home_phone_ext'),
    faxPhoneExt: text('fax_phone_ext'),
    mobilePhoneExt: text('mobile_phone_ext'),
    secondaryEmail: text('secondary_email'),
    addressCountry: text('address_country').default('US'),
    homeAddressLine1: text('home_address_line1'),
    homeAddressLine2: text('home_address_line2'),
    homeCity: text('home_city'),
    homeState: text('home_state'),
    homeZip: text('home_zip'),
    homeCountry: text('home_country'),

    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmEmailUnique: uniqueIndex('app_user_firm_email_uk').on(t.firmId, t.email),
    firmIdx: index('app_user_firm_idx').on(t.firmId),
    statusIdx: index('app_user_status_idx').on(t.status),
    firmDisplayIdUk: uniqueIndex('app_user_firm_display_id_uk')
      .on(t.firmId, t.displayId)
      .where(sql`display_id IS NOT NULL`),
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
// v2 0034 — client_source + contact_role taxonomies. Drive the
// Source dropdown in the Create Client wizard and the Role dropdown in
// the Contacts step. Seeded with sensible defaults at firm init.
// =====================================================================

export const clientSources = pgTable(
  'client_source',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    status: entityStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmKeyUnique: uniqueIndex('client_source_firm_key_uk').on(t.firmId, t.key),
  }),
);

export const contactRoles = pgTable(
  'contact_role',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    status: entityStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmKeyUnique: uniqueIndex('contact_role_firm_key_uk').on(t.firmId, t.key),
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

    // v2 0026 — CRM expansion
    clientType: clientType('client_type').notNull().default('BUSINESS'),
    clientFacingName: text('client_facing_name'),
    externalId: text('external_id'),
    filingStatus: filingStatus('filing_status'),
    sourceId: uuid('source_id').references(() => clientSources.id, { onDelete: 'set null' }),
    pipelineStage: pipelineStage('pipeline_stage').notNull().default('CLIENT'),
    active: boolean('active').notNull().default(true),

    // billingContactName/Email/Phone migrated to client_contact in 0027.
    billingAddress: text('billing_address'),

    // 0050 — structured mailing address. Separate from billingAddress
    // (single text) so PDFs/exports can render components.
    mailingStreet1: text('mailing_street1'),
    mailingStreet2: text('mailing_street2'),
    mailingCity: text('mailing_city'),
    mailingState: text('mailing_state'),
    mailingPostal: text('mailing_postal'),
    mailingCountry: text('mailing_country'),

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

    // File-manager v2 (0043) — opaque identifiers from the firm's tax
    // software used for onboarding fuzzy-match against existing B2
    // folder names. See FILE_MANAGER_ADDENDUM.md §3.1.
    taxSoftwareId: text('tax_software_id'),
    taxSoftwareKind: text('tax_software_kind'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmIdx: index('client_firm_idx').on(t.firmId),
    statusIdx: index('client_status_idx').on(t.status),
    partnerIdx: index('client_partner_idx').on(t.partnerInChargeId),
    nameSearchIdx: index('client_name_search_idx').on(t.firmId, t.name),
    pipelineIdx: index('client_pipeline_stage_idx').on(t.firmId, t.pipelineStage),
    externalIdUk: uniqueIndex('client_firm_external_id_uk')
      .on(t.firmId, t.externalId)
      .where(sql`external_id IS NOT NULL`),
    taxSoftwareIdx: index('idx_client_tax_software_id')
      .on(t.firmId, t.taxSoftwareId)
      .where(sql`tax_software_id IS NOT NULL`),
    // 0050 — GIN index on custom_fields is created by migration
    // (drizzle-orm IndexBuilder in use lacks .using('gin', ...) here).
  }),
);

// =====================================================================
// File-manager v2 (0044) — client_folders. One row per client; binds
// the client to its top-level B2 folder via the storage_path string +
// the in-folder sentinel file (_Vibe/client.json). Identity lives in
// the sentinel, not the path, so File-Explorer renames re-bind via the
// sync worker. See FILE_MANAGER_ADDENDUM.md §3.2.
// =====================================================================

export const clientFolders = pgTable(
  'client_folders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    storagePath: text('storage_path').notNull(),
    sentinelEtag: text('sentinel_etag'),
    // status vocabulary: active | renaming | missing | conflict | orphan
    // Soft enum (TEXT + CHECK in SQL) so new states don't require a
    // schema migration.
    status: text('status').notNull().default('active'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmPathUk: uniqueIndex('client_folders_firm_path_uk').on(t.firmId, t.storagePath),
    clientUk: uniqueIndex('client_folders_client_uk').on(t.clientId),
    statusIdx: index('idx_client_folders_status')
      .on(t.firmId, t.status)
      .where(sql`status <> 'active'`),
  }),
);

// =====================================================================
// File-manager v2 (0045) — folder_sync_events. Append-only audit log
// of every state transition the sync worker observes. Admin drains
// unresolved rows from the Storage Conflicts panel (Phase 4/9).
// See FILE_MANAGER_ADDENDUM.md §3.3.
//
// event_type vocabulary:
//   discovered | renamed | missing | sentinel_changed | sentinel_lost
//   | conflict | orphan | restored
// =====================================================================

export const folderSyncEvents = pgTable(
  'folder_sync_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id),
    // ON DELETE SET NULL (migration 0049) — preserves the audit row
    // while allowing the parent client_folders row to be deleted
    // (e.g. via admin Unbind).
    clientFolderId: uuid('client_folder_id').references(() => clientFolders.id, {
      onDelete: 'set null',
    }),
    eventType: text('event_type').notNull(),
    pathBefore: text('path_before'),
    pathAfter: text('path_after'),
    sentinelPayload: jsonb('sentinel_payload'),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => appUsers.id),
    resolution: text('resolution'),
    notes: text('notes'),
  },
  (t) => ({
    openEventsIdx: index('idx_folder_sync_events_open')
      .on(t.firmId, t.detectedAt)
      .where(sql`resolved_at IS NULL`),
  }),
);

// =====================================================================
// File-manager v2 (0046) — files. One row per object in storage,
// scoped to the client folder it lives inside. subfolder_path stores
// the relative path within the folder ('', 'Invoices/', '2024/Returns/').
// Identity is (firm_id, storage_key) — UNIQUE so a stray duplicate
// observation can't double-insert. See FILE_MANAGER_ADDENDUM.md §3.4.
//
// pending_upload is the Phase-8 reservation flag: the API INSERTs the
// row with pending_upload=true when it hands out a presigned PUT URL,
// preventing a concurrent sync tick from soft-deleting it before the
// client actually writes the object.
// =====================================================================

// =====================================================================
// File-manager v2 (0047) — visibility model.
//
//   firm_folder_visibility_rules — per-firm default-visibility policy.
//   file_visibility_events       — append-only history of changes.
//
// See FILE_MANAGER_ADDENDUM.md §3.5 + §3.6.
// =====================================================================

export const firmFolderVisibilityRules = pgTable(
  'firm_folder_visibility_rules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    subfolderPattern: text('subfolder_pattern').notNull(),
    defaultVisibility: text('default_visibility').notNull(),
    priority: integer('priority').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    lookupIdx: index('idx_firm_visibility_rules_lookup').on(t.firmId, t.enabled, t.priority),
  }),
);

export const fileVisibilityEvents = pgTable(
  'file_visibility_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    fileId: uuid('file_id').notNull(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id),
    oldValue: text('old_value').notNull(),
    newValue: text('new_value').notNull(),
    changedBy: uuid('changed_by').references(() => appUsers.id),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
    reason: text('reason'),
  },
  (t) => ({
    fileIdx: index('idx_file_visibility_events_file').on(t.fileId, t.changedAt),
  }),
);

// =====================================================================
// File-manager v2 (0048) — file_access_log. Append-only log of portal
// file accesses. Each row records who looked at what + outcome (allow
// or which denial reason). Powers the "First viewed in portal" staff
// view + compliance exports. See FILE_MANAGER_ADDENDUM.md §4 Phase 11.
// =====================================================================

export const fileAccessLog = pgTable(
  'file_access_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id),
    fileId: uuid('file_id'),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    portalIdentityId: uuid('portal_identity_id'),
    requestedStorageKey: text('requested_storage_key'),
    outcome: text('outcome').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    fileIdx: index('idx_file_access_log_file').on(t.fileId, t.occurredAt),
    clientIdx: index('idx_file_access_log_client').on(t.clientId, t.occurredAt),
  }),
);

export const files = pgTable(
  'files',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    clientFolderId: uuid('client_folder_id')
      .notNull()
      .references(() => clientFolders.id, { onDelete: 'cascade' }),
    subfolderPath: text('subfolder_path').notNull().default(''),
    originalFilename: text('original_filename').notNull(),
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256'),
    etag: text('etag'),
    category: text('category'),
    source: text('source').notNull().default('explorer'),
    visibility: text('visibility').notNull().default('private'),
    uploadedBy: uuid('uploaded_by').references(() => appUsers.id),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    modifiedAt: timestamp('modified_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    pendingUpload: boolean('pending_upload').notNull().default(false),
    // 0060 — pay-to-unlock escrow zone. invoice_id is the gating
    // invoice; promoted_at is set when the file flips from 'escrow' →
    // 'client_visible' via payment.
    invoiceId: uuid('invoice_id'),
    promotedAt: timestamp('promoted_at', { withTimezone: true }),
  },
  (t) => ({
    firmKeyUk: uniqueIndex('files_firm_storage_key_uk').on(t.firmId, t.storageKey),
    clientVisibilityIdx: index('idx_files_client_visibility')
      .on(t.clientId, t.visibility)
      .where(sql`deleted_at IS NULL`),
    folderSubfolderIdx: index('idx_files_folder_subfolder')
      .on(t.clientFolderId, t.subfolderPath)
      .where(sql`deleted_at IS NULL`),
    sha256PendingIdx: index('idx_files_sha256_pending')
      .on(t.firmId, t.sizeBytes)
      .where(sql`sha256 IS NULL AND deleted_at IS NULL AND pending_upload = false`),
    pendingUploadIdx: index('idx_files_pending_upload')
      .on(t.uploadedAt)
      .where(sql`pending_upload = true`),
  }),
);

// =====================================================================
// v2 0027 — client_contact (one-to-many). Replaces the legacy single-
// row billing_contact_* columns; each client has at least one row.
// At most one isPrimary and at most one isBilling per client (partial
// unique indexes).
// =====================================================================

export const clientContacts = pgTable(
  'client_contact',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    roleId: uuid('role_id').references(() => contactRoles.id, { onDelete: 'set null' }),
    email: text('email'),
    phone: text('phone'),
    mobile: text('mobile'),
    isPrimary: boolean('is_primary').notNull().default(false),
    isBilling: boolean('is_billing').notNull().default(false),
    isPortalIdentity: boolean('is_portal_identity').notNull().default(false),
    status: entityStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    clientIdx: index('client_contact_client_idx').on(t.clientId),
    primaryUk: uniqueIndex('client_contact_primary_uk')
      .on(t.clientId)
      .where(sql`is_primary = true`),
    billingUk: uniqueIndex('client_contact_billing_uk')
      .on(t.clientId)
      .where(sql`is_billing = true`),
  }),
);

// =====================================================================
// v2 0028 — client_task. Per-client task list (Canopy-style Tasks tab).
// =====================================================================

export const clientTaskPriority = pgEnum('client_task_priority', [
  'LOW',
  'MEDIUM',
  'HIGH',
  'URGENT',
]);
export const clientTaskStatus = pgEnum('client_task_status', [
  'OPEN',
  'IN_PROGRESS',
  'BLOCKED',
  'DONE',
  'CANCELED',
]);

export const clientTasks = pgTable(
  'client_task',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    // engagement FK added after engagements table is declared (forward
    // reference would break Drizzle); see the FK constraint in migration
    // 0028 itself. Column type alone is sufficient here.
    engagementId: uuid('engagement_id'),
    assigneeUserId: uuid('assignee_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    description: text('description'),
    priority: clientTaskPriority('priority').notNull().default('MEDIUM'),
    status: clientTaskStatus('status').notNull().default('OPEN'),
    dueDate: date('due_date'),
    createdById: uuid('created_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    clientStatusIdx: index('client_task_client_status_idx').on(t.clientId, t.status),
    assigneeIdx: index('client_task_assignee_idx')
      .on(t.assigneeUserId, t.status, t.dueDate)
      .where(sql`status NOT IN ('DONE', 'CANCELED')`),
  }),
);

// =====================================================================
// File-manager v1 (client_file / client_folder / client_folder_template)
// was removed in Phase 0 of the rebuild (migration 0042). The v2
// design — B2-backed, sentinel-bound, with `files` and `client_folders`
// (plural, one row per client) — lands across phases 2/5/6 of the
// rebuild. See FILE_MANAGER_ADDENDUM.md.
// =====================================================================

// =====================================================================
// v2 0030 — client_communication. Outbound notifications auto-record;
// staff records inbound/internal manually.
// =====================================================================

export const clientCommunications = pgTable(
  'client_communication',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: ['EMAIL', 'SMS', 'CALL', 'MEETING', 'NOTE'] }).notNull(),
    direction: text('direction', { enum: ['INBOUND', 'OUTBOUND', 'INTERNAL'] }).notNull(),
    subject: text('subject'),
    body: text('body').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    recordedById: uuid('recorded_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
    relatedEntityType: text('related_entity_type'),
    relatedEntityId: uuid('related_entity_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    clientIdx: index('client_communication_client_idx').on(t.clientId, t.occurredAt),
    firmIdx: index('client_communication_firm_idx').on(t.firmId, t.occurredAt),
  }),
);

// =====================================================================
// v2 0031 — client_template. Wizard prefills keyed by clientType.
// =====================================================================

export const clientTemplates = pgTable(
  'client_template',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    clientType: clientType('client_type').notNull(),
    defaultsJson: jsonb('defaults_json').notNull().default({}),
    defaultEngagementTemplateIds: jsonb('default_engagement_template_ids')
      .$type<string[]>()
      .notNull()
      .default([]),
    isSystem: boolean('is_system').notNull().default(false),
    status: entityStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmKeyUnique: uniqueIndex('client_template_firm_key_uk').on(t.firmId, t.key),
  }),
);

// =====================================================================
// v2 0032 — engagement_template. Firm-editable replacement for the
// hardcoded JSON starter pack.
// =====================================================================

export const engagementTemplates = pgTable(
  'engagement_template',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    engagementTypeId: uuid('engagement_type_id').references(() => engagementTypes.id, {
      onDelete: 'set null',
    }),
    defaultFeeStructure: feeStructure('default_fee_structure').notNull(),
    defaultFeeAmountCents: bigint('default_fee_amount_cents', { mode: 'number' }),
    defaultBudgetHours: numeric('default_budget_hours', { precision: 8, scale: 2 }),
    inScopeWorkCodeIds: jsonb('in_scope_work_code_ids').$type<string[]>().notNull().default([]),
    // 0054 — NULL means resolver falls back to firm's StandardRate.
    defaultRateCodeId: uuid('default_rate_code_id'),
    // FK added in 0033 after the letter table exists; declared here as
    // a plain uuid column so Drizzle can reference it.
    defaultLetterTemplateId: uuid('default_letter_template_id'),
    customFieldsSchema: jsonb('custom_fields_schema').notNull().default({}),
    isSystem: boolean('is_system').notNull().default(false),
    status: entityStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmKeyUnique: uniqueIndex('engagement_template_firm_key_uk').on(t.firmId, t.key),
  }),
);

// =====================================================================
// v2 0033 — engagement_letter_template. Library for the
// "Generate letter" picker on engagement detail.
// =====================================================================

export const engagementLetterTemplates = pgTable(
  'engagement_letter_template',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    engagementTypeId: uuid('engagement_type_id').references(() => engagementTypes.id, {
      onDelete: 'set null',
    }),
    bodyHtml: text('body_html').notNull(),
    variablesJson: jsonb('variables_json'),
    isSystem: boolean('is_system').notNull().default(false),
    status: entityStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmKeyUnique: uniqueIndex('engagement_letter_template_firm_key_uk').on(t.firmId, t.key),
  }),
);

// =====================================================================
// v2 0036 — user_pinned_client. Per-timekeeper pinned clients shown
// at the top of the Time entry combobox and Clients list.
// =====================================================================

export const userPinnedClients = pgTable(
  'user_pinned_client',
  {
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    pinnedAt: timestamp('pinned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.appUserId, t.clientId] }),
    userIdx: index('user_pinned_client_user_idx').on(t.appUserId, t.pinnedAt),
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

    // v2 — sales tax (per-engagement; opt-in). Rate stored as basis
    // points (425 = 4.25%). Label is freeform so firms in HI/NM can
    // put "GET" / "GRT" instead of "Sales tax".
    taxEnabled: boolean('tax_enabled').notNull().default(false),
    taxRateBps: integer('tax_rate_bps').notNull().default(0),
    taxLabel: text('tax_label').notNull().default('Sales tax'),

    // v2 — per-engagement surcharge. Type is PERCENT (uses
    // surcharge_value_bps against subtotal) OR FLAT_AMOUNT (uses
    // surcharge_amount_cents). Label falls back to
    // firm_settings.default_surcharge_label when null at render time.
    surchargeEnabled: boolean('surcharge_enabled').notNull().default(false),
    surchargeType: text('surcharge_type').notNull().default('PERCENT'),
    surchargeValueBps: integer('surcharge_value_bps').notNull().default(0),
    surchargeAmountCents: bigint('surcharge_amount_cents', { mode: 'number' })
      .notNull()
      .default(0),
    surchargeLabel: text('surcharge_label'),

    partnerId: uuid('partner_id').references(() => appUsers.id),
    managerId: uuid('manager_id').references(() => appUsers.id),

    // CP9 — per-engagement autopay control (Build Plan §2.2).
    // autopayMethodId references payment_method.id from portal.ts but
    // we keep it loose (no .references()) here to avoid a circular
    // schema import. The FK is enforced by the migration.
    // autopayPausedUntil lets clients pause without losing config.
    autopayMethodId: uuid('autopay_method_id'),
    autopayPausedUntil: date('autopay_paused_until'),

    // 0050 — when set, time-entry create/update on this engagement is
    // rejected (409). Toggled via /engagements/:id/retainer/lock|unlock.
    // NOTE: unrelated to the 0065 retainer addendum; that feature uses
    // the `retainer_id` + `return_type` columns added below.
    retainerLockedAt: timestamp('retainer_locked_at', { withTimezone: true }),

    // 0065 — retainer addendum. Convenience pointer to the active
    // retainer for this engagement (the retainer.engagement_id UNIQUE
    // constraint enforces D2; this column mirrors it). Set by the
    // activation handler inside the same transaction.
    retainerId: uuid('retainer_id'),
    // 0065 — six tax return types (1040/1065/1120/1120S/1041/990).
    // NULL for non-tax-prep engagements. Set explicitly at engagement
    // creation when the engagement covers a tax return.
    returnType: text('return_type'),
    // 0065 — tax year + due-date pair used by retainer expiry math:
    // expiry = COALESCE(extended, original) + 3 years (D3).
    taxYear: integer('tax_year'),
    originalDueDate: date('original_due_date'),
    extendedDueDate: date('extended_due_date'),

    scopeDefinition: text('scope_definition'),

    status: engagementStatus('status').notNull().default('PROPOSED'),
    // v2 Part 2 — operational workflow + priority (distinct from
    // lifecycle status above).
    workflowState: engagementWorkflowState('workflow_state').notNull().default('NO_STATUS'),
    priority: engagementPriority('priority').notNull().default('MEDIUM'),
    startDate: date('start_date'),
    endDate: date('end_date'),
    // 0051 — external deadline (filing date, audit report date, etc).
    // Distinct from end_date (which is internal work-completion target).
    dueDate: date('due_date'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedReason: text('closed_reason'),

    autoRolloverEnabled: boolean('auto_rollover_enabled').notNull().default(false),
    autoRolloverPriceIncreasePct: numeric('auto_rollover_price_increase_pct', {
      precision: 5,
      scale: 2,
    }),

    // Phase 7 #13 — premium / discount multiplier in basis points.
    // 10000 = 1.0x (no adjustment); 11000 = 1.1x (10% premium);
    // 8500 = 0.85x (15% discount). Applied to the resolved rate before
    // snapshot capture on time entries.
    rateMultiplierBps: integer('rate_multiplier_bps').notNull().default(10000),

    // 0054 — drives staff_rate_snapshot lookup at time-entry create.
    // NULL = resolver falls back to firm's StandardRate code.
    defaultRateCodeId: uuid('default_rate_code_id'),

    customFields: jsonb('custom_fields').notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    clientIdx: index('engagement_client_idx').on(t.clientId),
    statusIdx: index('engagement_status_idx').on(t.status),
    partnerIdx: index('engagement_partner_idx').on(t.partnerId),
    feeStructureIdx: index('engagement_fee_structure_idx').on(t.feeStructure),
    defaultRateCodeIdx: index('engagement_default_rate_code_idx').on(t.defaultRateCodeId),
  }),
);

// =====================================================================
// RATE MANAGEMENT
//
// Resolution order (highest to lowest precedence):
//   engagement_rate_override → client_rate_override → service_line_rate
//     → staff_rate_snapshot row for engagement.default_rate_code_id
//     → staff_rate_snapshot row for firm's 'StandardRate' code
//     → firm default (0)
//
// 0054 — flat timekeeper_rate replaced with per-code snapshots. Each
// firm has a catalog of rate_codes (StandardRate seeded as system).
// Staff have effective-dated snapshots; each snapshot has one cost
// rate + one bill rate per code.
// =====================================================================

export const rateCodes = pgTable(
  'rate_code',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    description: text('description'),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmCodeUnique: uniqueIndex('rate_code_firm_code_uk').on(t.firmId, t.code),
    firmActiveIdx: index('rate_code_firm_active_idx').on(t.firmId, t.active),
  }),
);

export const staffRateSnapshots = pgTable(
  'staff_rate_snapshot',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    effectiveDate: date('effective_date').notNull(),
    costRateCents: bigint('cost_rate_cents', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userDateUnique: uniqueIndex('staff_rate_snapshot_user_date_uk').on(
      t.appUserId,
      t.effectiveDate,
    ),
    userIdx: index('staff_rate_snapshot_user_idx').on(t.appUserId, t.effectiveDate),
  }),
);

export const staffRateSnapshotEntries = pgTable(
  'staff_rate_snapshot_entry',
  {
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => staffRateSnapshots.id, { onDelete: 'cascade' }),
    rateCodeId: uuid('rate_code_id')
      .notNull()
      .references(() => rateCodes.id, { onDelete: 'restrict' }),
    billRateCents: bigint('bill_rate_cents', { mode: 'number' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.snapshotId, t.rateCodeId] }),
    codeIdx: index('staff_rate_snapshot_entry_code_idx').on(t.rateCodeId),
    billNonNeg: check('staff_rate_snapshot_entry_bill_nonneg', sql`${t.billRateCents} >= 0`),
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

    // User-settable at write time; defaults true. May be seeded from
    // workCode.billableDefault at create time by the API. Reporting
    // treats this as authoritative — it is not recomputed.
    billableFlag: boolean('billable_flag').notNull().default(true),
    // Q20 — set at write time via in_scope_work_code_ids on engagement.
    // Never user-editable; provenance preserved.
    inScopeFlag: boolean('in_scope_flag').notNull().default(true),
    // 0050 — user-controlled OOS veto on top of computed inScopeFlag.
    // Effective scope in reporting = inScopeFlag AND NOT outOfScopeOverride.
    outOfScopeOverride: boolean('out_of_scope_override').notNull().default(false),

    description: text('description').notNull().default(''),

    // SNAPSHOTS — captured at write time, never recomputed
    standardRateSnapshotCents: bigint('standard_rate_snapshot_cents', { mode: 'number' }).notNull(),
    standardAmountCents: bigint('standard_amount_cents', { mode: 'number' }).notNull(),
    // 0063 — cost rate snapshotted at write time, mirroring the bill
    // rate. Nullable because pre-0063 entries (or entries logged before
    // any staff_rate_snapshot existed for the user) may not have a
    // value. Downstream sums COALESCE to 0.
    costRateSnapshotCents: bigint('cost_rate_snapshot_cents', { mode: 'number' }),

    status: timeEntryStatus('status').notNull().default('SUBMITTED'),

    // Phase 9 #22 — per-entry approver (when engagement requires
    // explicit approval, the manager/partner who signs off lands here).
    // NULL = not yet approved (or no approval requirement).
    approverId: uuid('approver_id'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),

    billingBatchId: uuid('billing_batch_id'), // forward reference, see below
    lockedAt: timestamp('locked_at', { withTimezone: true }),

    // 0065 — retainer addendum. Phase 8 auto-split sets these at
    // time-entry create. hours = retainerHours + billableHours when the
    // entry was routed through an active retainer; both NULL when no
    // retainer was eligible (legacy entries, or no active retainer on
    // the engagement). Keep `hours` as the canonical total so existing
    // reports don't drift.
    retainerId: uuid('retainer_id'),
    retainerHours: numeric('retainer_hours', { precision: 8, scale: 2 }),
    billableHours: numeric('billable_hours', { precision: 8, scale: 2 }),

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
    // 0050 — retainer billing batches carry a target dollar amount;
    // allocations across selected entries must sum to it.
    kind: billingBatchKind('kind').notNull().default('STANDARD'),
    retainerTargetAmountCents: bigint('retainer_target_amount_cents', { mode: 'number' }),
    // 0052 — invoice composition saved on the batch, applied when the
    // batch is finalized + an invoice is generated.
    invoiceDescription: text('invoice_description'),
    invoiceLineItems: jsonb('invoice_line_items').$type<
      Array<{ description: string; amountCents: number }>
    >(),
    // Phase 10 #35 — explicit idempotency key. Set deterministically by
    // the recurring tick to 'recurring:<plan_id>:<period_start>' so
    // double-runs are dropped at the UNIQUE constraint. NULL for
    // manually-created batches.
    idempotencyKey: text('idempotency_key'),
    createdById: uuid('created_by_id').references(() => appUsers.id),
    approvedById: uuid('approved_by_id').references(() => appUsers.id),
    // Phase 11 #10 — assigned partner for pre-bill review. NULL = use
    // engagement.partnerId. Filtered to non-null when listing a partner's
    // pending pre-bills (partial index on (assigned_partner_id, status)).
    assignedPartnerId: uuid('assigned_partner_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    // Phase 11 #23 — reopen → new version. previousVersionId points to
    // the batch this one replaces; version increments per reopen.
    previousVersionId: uuid('previous_version_id'),
    version: integer('version').notNull().default(1),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    engagementPeriodIdx: index('billing_batch_engagement_period_idx').on(
      t.engagementId,
      t.periodStart,
    ),
    statusIdx: index('billing_batch_status_idx').on(t.status),
    kindIdx: index('billing_batch_kind_idx').on(t.kind),
    // 0050 — retainer batches must declare a target; standard must not.
    retainerTargetPresent: check(
      'billing_batch_retainer_target_present',
      sql`(${t.kind} = 'RETAINER' AND ${t.retainerTargetAmountCents} IS NOT NULL AND ${t.retainerTargetAmountCents} > 0) OR (${t.kind} = 'STANDARD' AND ${t.retainerTargetAmountCents} IS NULL)`,
    ),
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
    // v2 — tax + surcharge breakdown persisted so the PDF + reports
    // round-trip without re-deriving from line items.
    taxCents: bigint('tax_cents', { mode: 'number' }).notNull().default(0),
    surchargeCents: bigint('surcharge_cents', { mode: 'number' }).notNull().default(0),
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

    // 0067 — when this invoice is the retainer-purchase AR invoice for
    // a tier the client selected in the portal, this points back to
    // the offer. NULL for everything else. The Stripe webhook reads
    // this column to find the offer to activate when this invoice is
    // marked paid.
    retainerOfferId: uuid('retainer_offer_id'),

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

// 0055 — Receive-Payment feature. paymentReceipts is the parent row
// for the N payment rows that come from one "receive" operation. The
// receipt holds payer + method + reference + provider charge id; the
// N child payments hold the per-invoice allocation.
export const paymentReceipts = pgTable(
  'payment_receipt',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    payerClientId: uuid('payer_client_id')
      .notNull()
      .references(() => clients.id),
    paymentDate: date('payment_date').notNull(),
    reference: text('reference'),
    paymentMethod: text('payment_method').notNull(),
    mode: text('mode').notNull(), // 'RECORD' | 'CHARGE'
    totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
    provider: text('provider').notNull(), // 'STRIPE' | 'CPACHARGE' | 'MANUAL'
    providerChargeId: text('provider_charge_id'),
    status: text('status').notNull().default('PENDING'),
    // Allocations stashed only while status='PENDING'. Webhook reads this
    // to materialize payment rows on intent.succeeded.
    allocationsPending: jsonb('allocations_pending').$type<
      { invoiceId: string; amountCents: number }[]
    >(),
    createdById: uuid('created_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmDateIdx: index('payment_receipt_firm_date_idx').on(t.firmId, t.paymentDate),
    payerIdx: index('payment_receipt_payer_idx').on(t.payerClientId, t.paymentDate),
    providerChargeIdx: index('payment_receipt_provider_charge_idx').on(t.providerChargeId),
    statusIdx: index('payment_receipt_status_idx').on(t.status),
    modeCk: check('payment_receipt_mode_ck', sql`${t.mode} IN ('RECORD', 'CHARGE')`),
    statusCk: check(
      'payment_receipt_status_ck',
      sql`${t.status} IN ('PENDING', 'SUCCEEDED', 'FAILED', 'VOIDED')`,
    ),
    providerCk: check(
      'payment_receipt_provider_ck',
      sql`${t.provider} IN ('STRIPE', 'CPACHARGE', 'MANUAL', 'CREDIT')`,
    ),
    totalNonNeg: check('payment_receipt_total_nonneg', sql`${t.totalCents} >= 0`),
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
    // Phase 10 #28 — scheduled retry on failed autopay. retryCount tracks
    // how many attempts have happened; nextRetryAt is when the worker
    // should pick this row up. Cleared on SUCCEEDED transition.
    retryCount: integer('retry_count').notNull().default(0),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    // 0055 — links the N payments from a single receive operation.
    // NULL for legacy /auto-apply rows and any payment created before
    // the receipt parent table existed.
    receiptId: uuid('receipt_id').references(() => paymentReceipts.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    invoiceIdx: index('payment_invoice_idx').on(t.invoiceId),
    providerChargeIdx: index('payment_provider_charge_idx').on(t.providerChargeId),
    receiptIdx: index('payment_receipt_idx').on(t.receiptId),
    providerCk: check(
      'payment_provider_ck',
      sql`${t.provider} IN ('STRIPE', 'CPACHARGE', 'MANUAL', 'CREDIT')`,
    ),
  }),
);

// 0056 — credit memos. Open credits the client has on file. Three
// sources: MANUAL (staff entry), OVERPAYMENT (auto from /receive when
// amount_received > sum of allocations), REFUND_EXCESS (auto from
// Stripe webhook when a refund exceeds invoice recoverable). Cross-
// entity application allowed within firm (see /credits router).
export const creditMemos = pgTable(
  'credit_memo',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    issuedDate: date('issued_date').notNull(),
    originalAmountCents: bigint('original_amount_cents', { mode: 'number' }).notNull(),
    source: text('source').notNull(), // 'MANUAL' | 'OVERPAYMENT' | 'REFUND_EXCESS'
    reference: text('reference'),
    notes: text('notes'),
    status: text('status').notNull().default('OPEN'),
    sourceReceiptId: uuid('source_receipt_id').references(() => paymentReceipts.id, {
      onDelete: 'set null',
    }),
    sourcePaymentId: uuid('source_payment_id').references(() => payments.id, {
      onDelete: 'set null',
    }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedById: uuid('voided_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
    voidReason: text('void_reason'),
    createdById: uuid('created_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmClientStatusIdx: index('credit_memo_firm_client_status_idx').on(
      t.firmId,
      t.clientId,
      t.status,
    ),
    sourceReceiptIdx: index('credit_memo_source_receipt_idx').on(t.sourceReceiptId),
    sourcePaymentIdx: index('credit_memo_source_payment_idx').on(t.sourcePaymentId),
    amountPositive: check('credit_memo_amount_positive', sql`${t.originalAmountCents} > 0`),
    sourceCk: check(
      'credit_memo_source_ck',
      sql`${t.source} IN ('MANUAL', 'OVERPAYMENT', 'REFUND_EXCESS')`,
    ),
    statusCk: check(
      'credit_memo_status_ck',
      sql`${t.status} IN ('OPEN', 'PARTIALLY_APPLIED', 'FULLY_APPLIED', 'VOIDED')`,
    ),
  }),
);

// One row per (credit, invoice) application. payment_id is the sibling
// provider='CREDIT' payment row that handles the invoice-side ledger.
// Void path: flip voided_at, flip payment.status to REFUNDED, recompute
// invoice.paid_cents and credit_memo.status.
export const creditApplications = pgTable(
  'credit_application',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    creditMemoId: uuid('credit_memo_id')
      .notNull()
      .references(() => creditMemos.id, { onDelete: 'restrict' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
    appliedById: uuid('applied_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
    receiptId: uuid('receipt_id').references(() => paymentReceipts.id, { onDelete: 'set null' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedById: uuid('voided_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
  },
  (t) => ({
    creditMemoActiveIdx: index('credit_application_credit_memo_active_idx').on(t.creditMemoId),
    invoiceIdx: index('credit_application_invoice_idx').on(t.invoiceId),
    receiptIdx: index('credit_application_receipt_idx').on(t.receiptId),
    amountPositive: check('credit_application_amount_positive', sql`${t.amountCents} > 0`),
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
    // CP8 — signature capture (Build Plan §2.11). signatureSvg holds
    // the raw <svg> the client drew on the portal pad; signedFullName
    // is a typed legibility fallback. Both nullable for legacy rows.
    signatureSvg: text('signature_svg'),
    signedFullName: text('signed_full_name'),
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
// 0050 — TIER 1–3 SWEEP TABLES
// =====================================================================

// engagement_assignment — multi-staff per engagement. partnerId /
// managerId on engagement stay for backwards-compat; "My Work" filter
// widens to also match rows here.
export const engagementAssignments = pgTable(
  'engagement_assignment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    role: engagementAssignmentRole('role').notNull().default('STAFF'),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    assignedById: uuid('assigned_by_id').references(() => appUsers.id),
  },
  (t) => ({
    naturalKey: uniqueIndex('engagement_assignment_uk').on(t.engagementId, t.appUserId, t.role),
    engagementIdx: index('engagement_assignment_engagement_idx').on(t.engagementId),
    userIdx: index('engagement_assignment_user_idx').on(t.appUserId, t.engagementId),
  }),
);

// engagement_status_config — per-firm × workflow_state presentation +
// automation flags. Seeded by migration; no insert/delete from app.
export const engagementStatusConfig = pgTable(
  'engagement_status_config',
  {
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    workflowState: engagementWorkflowState('workflow_state').notNull(),
    label: text('label').notNull(),
    color: text('color').notNull().default('#6b7280'),
    sortOrder: integer('sort_order').notNull().default(0),
    kanbanVisible: boolean('kanban_visible').notNull().default(true),
    triggersClientComm: boolean('triggers_client_comm').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.firmId, t.workflowState] }),
    firmSortIdx: index('engagement_status_config_firm_sort_idx').on(t.firmId, t.sortOrder),
  }),
);

// invoice_reminder_log — manual reminders are rate-limited via a
// per-invoice cooldown read from this log; automated dunning runs are
// also recorded for audit / UI display.
export const invoiceReminderLog = pgTable(
  'invoice_reminder_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    actorAppUserId: uuid('actor_app_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    kind: invoiceReminderKind('kind').notNull(),
    template: text('template').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    invoiceSentIdx: index('invoice_reminder_log_invoice_sent_idx').on(t.invoiceId, t.sentAt),
  }),
);

// =====================================================================
// 0059 — engagement messaging
// =====================================================================
// Per-thread DEK is wrapped with the firm MFK (Stage 1B crypto). Message
// bodies are encrypted with the unwrapped DEK and stored as bytea.

export const threads = pgTable(
  'thread',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    tDekWrapped: bytea('t_dek_wrapped').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    title: text('title'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => ({
    firmIdx: index('thread_firm_id_idx').on(t.firmId),
    statusIdx: index('thread_status_idx').on(t.status),
    statusCk: check('thread_status_ck', sql`${t.status} IN ('ACTIVE', 'ARCHIVED')`),
  }),
);

export const engagementThreadLinks = pgTable('engagement_thread_link', {
  engagementId: uuid('engagement_id')
    .primaryKey()
    .references(() => engagements.id, { onDelete: 'cascade' }),
  threadId: uuid('thread_id')
    .notNull()
    .unique()
    .references(() => threads.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const threadMembers = pgTable(
  'thread_member',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    appUserId: uuid('app_user_id').references(() => appUsers.id, { onDelete: 'cascade' }),
    portalIdentityId: uuid('portal_identity_id'),
    memberRole: text('member_role').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (t) => ({
    threadIdx: index('thread_member_thread_id_idx').on(t.threadId),
    actorCk: check(
      'thread_member_actor_ck',
      sql`(${t.appUserId} IS NOT NULL AND ${t.portalIdentityId} IS NULL)
          OR (${t.appUserId} IS NULL AND ${t.portalIdentityId} IS NOT NULL)`,
    ),
    roleCk: check(
      'thread_member_role_ck',
      sql`${t.memberRole} IN ('partner', 'staff', 'client')`,
    ),
  }),
);

export const messages = pgTable(
  'message',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    senderAppUserId: uuid('sender_app_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    senderPortalIdentityId: uuid('sender_portal_identity_id'),
    bodyCiphertext: bytea('body_ciphertext').notNull(),
    excerptPlaintext: text('excerpt_plaintext'),
    editOfId: uuid('edit_of_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedReason: text('deleted_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    threadCreatedIdx: index('message_thread_id_created_idx').on(t.threadId, t.createdAt),
    senderCk: check(
      'message_sender_ck',
      sql`(${t.senderAppUserId} IS NOT NULL AND ${t.senderPortalIdentityId} IS NULL)
          OR (${t.senderAppUserId} IS NULL AND ${t.senderPortalIdentityId} IS NOT NULL)`,
    ),
  }),
);

export const messageAttachments = pgTable(
  'message_attachment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    attachedAt: timestamp('attached_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    messageIdx: index('message_attachment_message_id_idx').on(t.messageId),
    fileIdx: index('message_attachment_file_id_idx').on(t.fileId),
  }),
);

export const messageReadReceipts = pgTable(
  'message_read_receipt',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    readerAppUserId: uuid('reader_app_user_id').references(() => appUsers.id, {
      onDelete: 'cascade',
    }),
    readerPortalIdentityId: uuid('reader_portal_identity_id'),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    readerCk: check(
      'mrr_reader_ck',
      sql`(${t.readerAppUserId} IS NOT NULL AND ${t.readerPortalIdentityId} IS NULL)
          OR (${t.readerAppUserId} IS NULL AND ${t.readerPortalIdentityId} IS NOT NULL)`,
    ),
  }),
);

export const timeEntryMessageLinks = pgTable(
  'time_entry_message_link',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    timeEntryId: uuid('time_entry_id')
      .notNull()
      .references(() => timeEntries.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    unique: uniqueIndex('time_entry_message_link_unique').on(t.timeEntryId, t.messageId),
    teIdx: index('time_entry_message_link_te_idx').on(t.timeEntryId),
    msgIdx: index('time_entry_message_link_msg_idx').on(t.messageId),
  }),
);

// =====================================================================
// 0061 — client requests
// =====================================================================

export const clientRequests = pgTable(
  'client_request',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    assignedAppUserId: uuid('assigned_app_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    status: text('status').notNull().default('OPEN'),
    dueDate: date('due_date'),
    fulfilledByMessageId: uuid('fulfilled_by_message_id'),
    fulfilledByFileId: uuid('fulfilled_by_file_id'),
    fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
    fulfilledByAppUserId: uuid('fulfilled_by_app_user_id'),
    fulfilledByPortalIdentityId: uuid('fulfilled_by_portal_identity_id'),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    dismissedReason: text('dismissed_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdByAppUserId: uuid('created_by_app_user_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmStatusIdx: index('client_request_firm_status_idx').on(t.firmId, t.status),
    engIdx: index('client_request_engagement_idx').on(t.engagementId, t.status),
    statusCk: check(
      'client_request_status_ck',
      sql`${t.status} IN ('OPEN', 'FULFILLED', 'DISMISSED', 'EXPIRED')`,
    ),
  }),
);

export const clientRequestTimeEntryLinks = pgTable(
  'client_request_time_entry_link',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    clientRequestId: uuid('client_request_id')
      .notNull()
      .references(() => clientRequests.id, { onDelete: 'cascade' }),
    timeEntryId: uuid('time_entry_id').references(() => timeEntries.id, {
      onDelete: 'cascade',
    }),
    suggestedForAppUserId: uuid('suggested_for_app_user_id').references(() => appUsers.id, {
      onDelete: 'cascade',
    }),
    suggestedAt: timestamp('suggested_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    dismissedReason: text('dismissed_reason'),
  },
  (t) => ({
    suggestedForIdx: index('crtel_suggested_for_idx').on(t.suggestedForAppUserId),
    expiresIdx: index('crtel_expires_idx').on(t.expiresAt),
  }),
);

// =====================================================================
// 0062 — staff profile expansion (Skill Set + Targets tabs)
// =====================================================================

export const staffSkills = pgTable(
  'staff_skill',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    workCodeId: uuid('work_code_id')
      .notNull()
      .references(() => workCodes.id, { onDelete: 'cascade' }),
    proficiency: text('proficiency').notNull().default('COMPETENT'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    unique: uniqueIndex('staff_skill_unique').on(t.appUserId, t.workCodeId),
    userIdx: index('staff_skill_user_idx').on(t.appUserId),
    codeIdx: index('staff_skill_code_idx').on(t.workCodeId),
    proficiencyCk: check(
      'staff_skill_proficiency_ck',
      sql`${t.proficiency} IN ('LEARNING','COMPETENT','PROFICIENT','EXPERT')`,
    ),
  }),
);

export const staffTargets = pgTable(
  'staff_target',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    targetYear: integer('target_year').notNull(),
    annualBillableHours: numeric('annual_billable_hours', { precision: 8, scale: 2 }),
    annualTotalHours: numeric('annual_total_hours', { precision: 8, scale: 2 }),
    targetRealizationPctBps: integer('target_realization_pct_bps'),
    targetUtilizationPctBps: integer('target_utilization_pct_bps'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    unique: uniqueIndex('staff_target_unique').on(t.appUserId, t.targetYear),
    userYearIdx: index('staff_target_user_year_idx').on(t.appUserId, t.targetYear),
    yearCk: check('staff_target_year_ck', sql`${t.targetYear} BETWEEN 2000 AND 2100`),
  }),
);

// =====================================================================
// INFERRED TYPES
// =====================================================================

export type Firm = typeof firms.$inferSelect;
export type NewFirm = typeof firms.$inferInsert;
export type FirmSettings = typeof firmSettings.$inferSelect;
export type FirmConfig = typeof firmConfig.$inferSelect;
export type NewFirmConfig = typeof firmConfig.$inferInsert;
export type FirmKeyEnvelope = typeof firmKeyEnvelope.$inferSelect;
export type NewFirmKeyEnvelope = typeof firmKeyEnvelope.$inferInsert;

// 0059 — messaging
export type Thread = typeof threads.$inferSelect;
export type NewThread = typeof threads.$inferInsert;
export type EngagementThreadLink = typeof engagementThreadLinks.$inferSelect;
export type NewEngagementThreadLink = typeof engagementThreadLinks.$inferInsert;
export type ThreadMember = typeof threadMembers.$inferSelect;
export type NewThreadMember = typeof threadMembers.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type MessageAttachment = typeof messageAttachments.$inferSelect;
export type NewMessageAttachment = typeof messageAttachments.$inferInsert;
export type MessageReadReceipt = typeof messageReadReceipts.$inferSelect;
export type NewMessageReadReceipt = typeof messageReadReceipts.$inferInsert;
export type TimeEntryMessageLink = typeof timeEntryMessageLinks.$inferSelect;
export type NewTimeEntryMessageLink = typeof timeEntryMessageLinks.$inferInsert;

// 0061 — client requests
export type ClientRequest = typeof clientRequests.$inferSelect;
export type NewClientRequest = typeof clientRequests.$inferInsert;
export type ClientRequestTimeEntryLink = typeof clientRequestTimeEntryLinks.$inferSelect;
export type NewClientRequestTimeEntryLink = typeof clientRequestTimeEntryLinks.$inferInsert;

// 0062 — staff profile expansion
export type StaffSkill = typeof staffSkills.$inferSelect;
export type NewStaffSkill = typeof staffSkills.$inferInsert;
export type StaffTarget = typeof staffTargets.$inferSelect;
export type NewStaffTarget = typeof staffTargets.$inferInsert;

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

export type ClientFolder = typeof clientFolders.$inferSelect;
export type NewClientFolder = typeof clientFolders.$inferInsert;
export type FolderSyncEvent = typeof folderSyncEvents.$inferSelect;
export type NewFolderSyncEvent = typeof folderSyncEvents.$inferInsert;
export type FileRow = typeof files.$inferSelect;
export type NewFileRow = typeof files.$inferInsert;
export type FirmFolderVisibilityRule = typeof firmFolderVisibilityRules.$inferSelect;
export type NewFirmFolderVisibilityRule = typeof firmFolderVisibilityRules.$inferInsert;
export type FileVisibilityEvent = typeof fileVisibilityEvents.$inferSelect;
export type NewFileVisibilityEvent = typeof fileVisibilityEvents.$inferInsert;
export type FileAccessLogRow = typeof fileAccessLog.$inferSelect;
export type NewFileAccessLogRow = typeof fileAccessLog.$inferInsert;

export type RateCode = typeof rateCodes.$inferSelect;
export type NewRateCode = typeof rateCodes.$inferInsert;
export type StaffRateSnapshot = typeof staffRateSnapshots.$inferSelect;
export type NewStaffRateSnapshot = typeof staffRateSnapshots.$inferInsert;
export type StaffRateSnapshotEntry = typeof staffRateSnapshotEntries.$inferSelect;
export type NewStaffRateSnapshotEntry = typeof staffRateSnapshotEntries.$inferInsert;

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
export type NewPayment = typeof payments.$inferInsert;
export type PaymentReceipt = typeof paymentReceipts.$inferSelect;
export type NewPaymentReceipt = typeof paymentReceipts.$inferInsert;
export type CreditMemo = typeof creditMemos.$inferSelect;
export type NewCreditMemo = typeof creditMemos.$inferInsert;
export type CreditApplication = typeof creditApplications.$inferSelect;
export type NewCreditApplication = typeof creditApplications.$inferInsert;

export type ApprovalRule = typeof approvalRules.$inferSelect;
export type ApprovalRequest = typeof approvalRequests.$inferSelect;

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;

export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type McpToken = typeof mcpTokens.$inferSelect;
export type AiRequestLogRow = typeof aiRequestLog.$inferSelect;

// 0050 — tier 1-3 sweep
export type EngagementAssignment = typeof engagementAssignments.$inferSelect;
export type NewEngagementAssignment = typeof engagementAssignments.$inferInsert;
export type EngagementStatusConfig = typeof engagementStatusConfig.$inferSelect;
export type NewEngagementStatusConfig = typeof engagementStatusConfig.$inferInsert;
export type InvoiceReminderLogRow = typeof invoiceReminderLog.$inferSelect;
export type NewInvoiceReminderLogRow = typeof invoiceReminderLog.$inferInsert;

// =====================================================================
// 0072 — File share links (CP11)
//
// Per-file share-link generator. Token stored hashed at rest; the raw
// token is shown to the creator exactly once. Public /shared/:token
// endpoint resolves to a fresh presigned URL on every access and
// writes a file_share_event row.
// =====================================================================

export const fileShares = pgTable(
  'file_share',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    // FK to portal_identity in portal.ts — kept loose to avoid circular
    // imports. Enforced by the migration.
    createdByPortalIdentityId: uuid('created_by_portal_identity_id'),
    tokenHash: text('token_hash').notNull().unique(),
    accessLevel: text('access_level').notNull().default('view'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    accessCount: integer('access_count').notNull().default(0),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
  },
  (t) => ({
    fileIdx: index('file_share_file_idx').on(t.fileId),
    clientIdx: index('file_share_client_idx').on(t.clientId),
    expiresIdx: index('file_share_expires_idx')
      .on(t.expiresAt)
      .where(sql`expires_at IS NOT NULL`),
    accessLevelCk: check(
      'file_share_access_level_ck',
      sql`${t.accessLevel} IN ('view', 'download')`,
    ),
    accessCountNonneg: check(
      'file_share_access_count_nonneg',
      sql`${t.accessCount} >= 0`,
    ),
  }),
);

export const fileShareEvents = pgTable(
  'file_share_event',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    fileShareId: uuid('file_share_id')
      .notNull()
      .references(() => fileShares.id, { onDelete: 'cascade' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    outcome: text('outcome').notNull(),
  },
  (t) => ({
    shareIdx: index('file_share_event_share_idx').on(t.fileShareId, t.occurredAt),
    outcomeCk: check(
      'file_share_event_outcome_ck',
      sql`${t.outcome} IN ('allowed', 'denied_revoked', 'denied_expired', 'denied_file_gone')`,
    ),
  }),
);

export type FileShare = typeof fileShares.$inferSelect;
export type FileShareEvent = typeof fileShareEvents.$inferSelect;

// =====================================================================
// 0073 — Appointments (CP12)
//
// Client-visible scheduled meetings between firm staff and the
// active client. Read-only on the portal in v1; staff create/cancel
// via /admin/appointments or a future calendar webhook.
// =====================================================================

export const appointmentStatus = pgEnum('appointment_status', [
  'SCHEDULED',
  'COMPLETED',
  'CANCELLED',
]);

export const appointmentLocation = pgEnum('appointment_location', [
  'VIDEO',
  'PHONE',
  'IN_PERSON',
]);

export const appointments = pgTable(
  'appointment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    engagementId: uuid('engagement_id').references(() => engagements.id, {
      onDelete: 'restrict',
    }),
    title: text('title').notNull(),
    description: text('description'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    location: appointmentLocation('location').notNull().default('VIDEO'),
    locationDetail: text('location_detail'),
    leadAppUserId: uuid('lead_app_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    status: appointmentStatus('status').notNull().default('SCHEDULED'),
    cancelledReason: text('cancelled_reason'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledById: uuid('cancelled_by_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    externalRef: text('external_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdById: uuid('created_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
  },
  (t) => ({
    firmStartsIdx: index('appointment_firm_starts_idx').on(t.firmId, t.startsAt),
    clientStartsIdx: index('appointment_client_starts_idx').on(t.clientId, t.startsAt),
    leadStartsIdx: index('appointment_lead_starts_idx')
      .on(t.leadAppUserId, t.startsAt)
      .where(sql`lead_app_user_id IS NOT NULL`),
    timeOrderCk: check('appointment_time_order', sql`${t.endsAt} > ${t.startsAt}`),
  }),
);

export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;

// =====================================================================
// 0069 — Tax payments (CP1)
//
// Staff-entered scheduled tax obligations surfaced to clients in the
// portal. Source of truth is firm-entered for v1; external_ref is
// reserved for a future MyBooks connector without committing to that
// integration shape now. Soft-delete via status='VOIDED'.
// =====================================================================

export const taxPaymentStatus = pgEnum('tax_payment_status', ['SCHEDULED', 'PAID', 'VOIDED']);

export const taxPayments = pgTable(
  'tax_payment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    // Nullable — many tax payments aren't tied to a single engagement.
    engagementId: uuid('engagement_id').references(() => engagements.id, {
      onDelete: 'restrict',
    }),
    jurisdiction: text('jurisdiction').notNull(),
    paymentType: text('payment_type').notNull(),
    taxYear: integer('tax_year'),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    dueDate: date('due_date').notNull(),
    status: taxPaymentStatus('status').notNull().default('SCHEDULED'),
    paidDate: date('paid_date'),
    confirmationNumber: text('confirmation_number'),
    // Firm-internal — portal API must strip this column.
    notes: text('notes'),
    // Reserved for future connector import; staff-entered rows leave NULL.
    externalRef: text('external_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdById: uuid('created_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
  },
  (t) => ({
    firmStatusDueIdx: index('tax_payment_firm_status_due_idx').on(t.firmId, t.status, t.dueDate),
    clientStatusDueIdx: index('tax_payment_client_status_due_idx').on(
      t.clientId,
      t.status,
      t.dueDate,
    ),
    engagementIdx: index('tax_payment_engagement_idx')
      .on(t.engagementId)
      .where(sql`engagement_id IS NOT NULL`),
    amountNonneg: check('tax_payment_amount_nonneg', sql`${t.amountCents} >= 0`),
  }),
);

export type TaxPayment = typeof taxPayments.$inferSelect;
export type NewTaxPayment = typeof taxPayments.$inferInsert;

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
//   8. rate_code, staff_rate_snapshot, staff_rate_snapshot_entry,
//      client_rate_override, engagement_rate_override, service_line_rate
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
