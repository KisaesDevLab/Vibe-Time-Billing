// =====================================================================
// packages/db/src/schema/core.ts
//
// Core Drizzle schema for Vibe Practice Management.
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
  smallint,
  jsonb,
  date,
  numeric,
  index,
  uniqueIndex,
  check,
  primaryKey,
  foreignKey,
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
// 0101 — relaxed from a pgEnum to a plain text key so firms can define
// UNLIMITED custom progress statuses. The valid keys per firm live in
// engagement_status_config; engagement.workflow_state carries a composite
// FK to it. The 10 original values remain as seeded `is_system` rows.

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

// 0084 — client request priority. Small fixed set so a pgEnum is fine
// (vs `client_request.status` which is text+CHECK to keep adding
// values lighter-weight).
export const requestPriority = pgEnum('request_priority', ['LOW', 'MEDIUM', 'HIGH', 'URGENT']);

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
  // 0082 — recurring engagement collision per Q23 (previous still
  // ACTIVE when the scheduled recurrence fires).
  'ENGAGEMENT_RENEWAL',
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

  // 0151 — revises locked decision #5: firms running fully internal can
  // switch off the staff second-factor requirement. When false, password
  // sign-in issues a session directly and step-up gates pass.
  staffSecondFactorRequired: boolean('staff_second_factor_required').notNull().default(true),

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
  // brandLogoUrl is the *effective* wide-logo URL used everywhere (portal
  // header, PDFs, shared pages). An uploaded logo sets it to the public
  // branding endpoint; firms can also paste an external URL here.
  brandLogoUrl: text('brand_logo_url'),
  brandAccentColor: text('brand_accent_color'),
  brandSupportEmail: text('brand_support_email'),
  brandSupportPhone: text('brand_support_phone'),
  brandFooterHtml: text('brand_footer_html'),
  // Logo-upload bookkeeping (firm logo upload). Storage keys present ⇒ an
  // asset was uploaded (vs. an external URL); the square icon source is
  // resized into the PWA/Apple icons on upload. Version bumps on any change
  // to bust caches on the public branding endpoints.
  brandLogoStorageKey: text('brand_logo_storage_key'),
  brandIconStorageKey: text('brand_icon_storage_key'),
  brandAssetsVersion: integer('brand_assets_version').notNull().default(0),
  // Cloudflare Turnstile CAPTCHA for the public intake form. Site key is
  // public; the secret is stored as a KMS-encrypted envelope. CAPTCHA is
  // active only when both are set.
  turnstileSiteKey: text('turnstile_site_key'),
  turnstileSecretEnc: text('turnstile_secret_enc'),

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
  // 0173 — firm-owned Stripe keys (secret/publishable/webhook), encrypted.
  stripeConfigEncrypted: text('stripe_config_encrypted'),
  // 0174 — inbound webhook signing secrets per notification provider, encrypted.
  webhookKeysEncrypted: text('webhook_keys_encrypted'),
  mailConfigUpdatedAt: timestamp('mail_config_updated_at', { withTimezone: true }),
  smsConfigUpdatedAt: timestamp('sms_config_updated_at', { withTimezone: true }),

  // 0178 — AI pricing-suggestion knobs. The engine picks the number
  // deterministically; these only tune inputs. Economic source defaults to
  // MANUAL (no network); "allow LLM to adjust the number" defaults OFF.
  pricingEconomicSource: text('pricing_economic_source').notNull().default('MANUAL'), // MANUAL|CPI|ECI
  pricingEconomicManualPct: numeric('pricing_economic_manual_pct', { precision: 5, scale: 2 })
    .notNull()
    .default('0.00'),
  pricingTargetMarginPct: numeric('pricing_target_margin_pct', { precision: 5, scale: 2 })
    .notNull()
    .default('40.00'),
  pricingExpectedHoursStat: text('pricing_expected_hours_stat').notNull().default('TRIMMED_MEAN'), // TRIMMED_MEAN|MEDIAN
  pricingCohortMin: integer('pricing_cohort_min').notNull().default(5),
  pricingBurdenedCostPerTier: jsonb('pricing_burdened_cost_per_tier')
    .$type<Record<string, number>>()
    .notNull()
    .default({}),
  pricingAllowLlmAdjust: boolean('pricing_allow_llm_adjust').notNull().default(false),

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
    // 0100 — cloud egress mode. 'shield' (default) requires a reachable
    // Vibe Shield; 'direct' lets the appliance call the provider API
    // directly (firm-owned key + budget cap + audit), no shield needed.
    aiEgressMode: text('ai_egress_mode').notNull().default('shield'),
    // 0103 — document intake feature toggle (license-gated, per firm).
    intakeEnabled: boolean('intake_enabled').notNull().default(false),
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
    channel: text('channel', { enum: ['EMAIL', 'SMS', 'CALL', 'PORTAL'] }).notNull(),
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

    // TOTP — was Q5 (mandatory) prior to 0087. Now one of three
    // optional second factors (TOTP / EMAIL / SMS); at least one must
    // be enrolled before the user can set a password.
    totpSecretEncrypted: text('totp_secret_encrypted'),
    totpEnrolledAt: timestamp('totp_enrolled_at', { withTimezone: true }),
    recoveryCodesEncrypted: text('recovery_codes_encrypted'),

    // 0087 — username + password sign-in (sibling to magic link).
    // password_hash is argon2id; NULL means this user has not set a
    // password and can only sign in via magic link.
    passwordHash: text('password_hash'),
    passwordSetAt: timestamp('password_set_at', { withTimezone: true }),
    // SMS OTP enrollment. phone is E.164 (verified at enrollment time
    // by a code round-trip).
    smsOtpPhoneE164: text('sms_otp_phone_e164'),
    smsOtpEnrolledAt: timestamp('sms_otp_enrolled_at', { withTimezone: true }),
    // Email OTP enrollment. No separate verification step — the user's
    // email is already trusted via magic-link onboarding.
    emailOtpEnrolledAt: timestamp('email_otp_enrolled_at', { withTimezone: true }),
    // 'TOTP' | 'EMAIL' | 'SMS'. NULL = auto-pick (TOTP > EMAIL > SMS).
    preferredSecondFactor: text('preferred_second_factor').$type<
      'TOTP' | 'EMAIL' | 'SMS' | null
    >(),

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

// 0147 — per-firm deltas over the code-level role templates, toggled
// from the admin permission matrix. granted=true adds a key the
// template lacks; granted=false revokes one it has. The admin role is
// never overridable (CHECK in migration); requirePermission merges
// these at request time.
export const rolePermissionOverrides = pgTable(
  'role_permission_override',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    roleSlug: text('role_slug', { enum: ['partner', 'manager', 'senior', 'staff'] }).notNull(),
    permissionKey: text('permission_key').notNull(),
    granted: boolean('granted').notNull(),
    updatedBy: uuid('updated_by').references(() => appUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uk: uniqueIndex('role_permission_override_uk').on(t.firmId, t.roleSlug, t.permissionKey),
    firmIdx: index('role_permission_override_firm_idx').on(t.firmId),
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
    // 0148 — was the service_line_category enum; firm-managed text now
    // (same relaxation 0101 applied to workflow states).
    category: text('category').notNull(),
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

// 0089 — firm-editable catalog of manually-recorded payment methods.
// Replaces the hard-coded RECORD_METHODS list on the Receive Payment
// form. CARD_STRIPE and CREDIT_APPLY remain synthetic (not seeded;
// the receive UI injects them based on context — Stripe wired / open
// credit memo).
export const paymentMethodTypes = pgTable(
  'payment_method_type',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    key: text('key').notNull(), // lower_snake; sent as `paymentMethod` to /receive
    label: text('label').notNull(),
    active: boolean('active').notNull().default(true),
    displayOrder: smallint('display_order').notNull().default(100),
    // System rows can be renamed/deactivated but not deleted.
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmKeyUnique: uniqueIndex('payment_method_type_firm_key_uk').on(t.firmId, t.key),
    firmActiveOrderIdx: index('payment_method_type_firm_active_order_idx').on(
      t.firmId,
      t.active,
      t.displayOrder,
    ),
  }),
);

// 0090 — Tax jurisdiction catalog. Firm-scoped enumeration that the
// New Tax Payment form drives its Jurisdiction dropdown from.
export const taxJurisdictions = pgTable(
  'tax_jurisdiction',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    displayOrder: smallint('display_order').notNull().default(100),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmNameUnique: uniqueIndex('tax_jurisdiction_firm_name_uk').on(t.firmId, t.name),
    firmActiveOrderIdx: index('tax_jurisdiction_firm_active_order_idx').on(
      t.firmId,
      t.active,
      t.displayOrder,
    ),
  }),
);

// 0090 — Tax payment-type catalog. Each row is scoped to ONE
// jurisdiction so the New Tax Payment form's Payment Type dropdown
// can filter by the picked Jurisdiction. payment_url is the link the
// client follows from the portal to pay online.
export const taxPaymentTypeCatalog = pgTable(
  'tax_payment_type',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    jurisdictionId: uuid('jurisdiction_id')
      .notNull()
      .references(() => taxJurisdictions.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    paymentUrl: text('payment_url'),
    active: boolean('active').notNull().default(true),
    displayOrder: smallint('display_order').notNull().default(100),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    jurisdictionNameUnique: uniqueIndex('tax_payment_type_juris_name_uk').on(
      t.jurisdictionId,
      t.name,
    ),
    firmActiveOrderIdx: index('tax_payment_type_firm_active_order_idx').on(
      t.firmId,
      t.active,
      t.displayOrder,
    ),
    jurisdictionIdx: index('tax_payment_type_jurisdiction_idx').on(t.jurisdictionId),
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
    // 0092 — every client belongs to one office. Multi-office firms
    // can filter / route / report by office.
    officeId: uuid('office_id')
      .notNull()
      .references(() => offices.id, { onDelete: 'restrict' }),

    // v2 0026 — CRM expansion
    clientType: clientType('client_type').notNull().default('BUSINESS'),
    clientFacingName: text('client_facing_name'),
    externalId: text('external_id'),
    // 0152 — second identifier for the Vibe Filer document mapper; some
    // export pipelines stamp filenames with this id instead of external_id.
    awsId: text('aws_id'),
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

    // Connect I.4 — server-peppered HMAC of the client's tax id, used
    // for the ssn-last-4 / ein portal step-up challenge factors.
    // tax_id_kind tags which factor applies. Never log raw values;
    // hashing happens in apps/api/src/portal/tax-id.ts with the
    // TAX_ID_HASH_PEPPER env value.
    taxIdKind: text('tax_id_kind'),
    taxIdHash: text('tax_id_hash'),

    // Legal hold (Phase 19 #12) — when true, the retention worker
    // skips this client's records and archive is blocked.
    legalHoldFlag: boolean('legal_hold_flag').notNull().default(false),
    legalHoldReason: text('legal_hold_reason'),
    legalHoldSetAt: timestamp('legal_hold_set_at', { withTimezone: true }),

    // 0165 — per-client visibility restriction. When true, only an admin,
    // the partner-in-charge, or a user with a client_access_grant row may
    // see the client's non-billing data; everyone else is limited to the
    // basic info + people + billing/A-R surfaces.
    restricted: boolean('restricted').notNull().default(false),

    // File-manager v2 (0043) — opaque identifiers from the firm's tax
    // software used for onboarding fuzzy-match against existing B2
    // folder names. See FILE_MANAGER_ADDENDUM.md §3.1.
    taxSoftwareId: text('tax_software_id'),
    taxSoftwareKind: text('tax_software_kind'),
    // 0142 — per-client folder-structure template (NULL → firm default).
    // Plain column (no Drizzle ref) to avoid a schema import cycle; the FK is
    // enforced in SQL (migration 0142).
    folderTemplateId: uuid('folder_template_id'),

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

// FMv2 §2.1 — folder_link_attempts records every (client, folder)
// link attempt for the admin reconciliation queue. Indexed on
// (firm, outcome) for the open-conflicts surface and on (client,
// attempted_at desc) for the per-client audit panel.
export const folderLinkAttempts = pgTable(
  'folder_link_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    storagePath: text('storage_path').notNull(),
    attemptedBy: uuid('attempted_by')
      .notNull()
      .references(() => appUsers.id),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
    matchConfidence: numeric('match_confidence', { precision: 4, scale: 3 }),
    matchReasonCode: text('match_reason_code'),
    outcome: text('outcome').notNull().default('pending'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => appUsers.id),
    resolutionReason: text('resolution_reason'),
    notes: text('notes'),
  },
  (t) => ({
    openIdx: index('idx_folder_link_attempts_open')
      .on(t.firmId, t.outcome)
      .where(sql`outcome IN ('pending', 'contested')`),
    clientIdx: index('idx_folder_link_attempts_client').on(t.clientId, t.attemptedAt),
    outcomeChk: check(
      'folder_link_attempts_outcome_chk',
      sql`${t.outcome} IN ('pending', 'linked', 'contested', 'denied', 'reassigned', 'aborted')`,
    ),
    confidenceRange: check(
      'folder_link_attempts_confidence_range',
      sql`${t.matchConfidence} IS NULL OR (${t.matchConfidence} >= 0 AND ${t.matchConfidence} <= 1)`,
    ),
  }),
);

// =====================================================================
// app_user_credential — Phase 3 item #8. One row per registered
// WebAuthn / passkey credential. Unique by credential_id.
// =====================================================================
export const appUserCredentials = pgTable(
  'app_user_credential',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    credentialId: text('credential_id').notNull(),
    publicKey: text('public_key').notNull(),
    signCount: bigint('sign_count', { mode: 'number' }).notNull().default(0),
    transports: text('transports').notNull().default(''),
    label: text('label'),
    aaguid: uuid('aaguid'),
    deviceType: text('device_type'),
    backedUp: boolean('backed_up').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => ({
    credentialUk: uniqueIndex('app_user_credential_credential_uk').on(t.credentialId),
    userIdx: index('app_user_credential_user_idx').on(t.appUserId),
  }),
);

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

// 0115 — firm-global directory person. Canonical source of name/email/
// phone for the firm; one row per human, referenced by many client_contact
// rows (per-client) and optionally a portal_identity (login). Email is the
// firm-unique identity key; phone/mobile are non-unique lookup hints
// (shared numbers are legitimate).
export const persons = pgTable(
  'person',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    email: text('email'),
    phone: text('phone'),
    mobile: text('mobile'),
    status: entityStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmIdx: index('person_firm_idx').on(t.firmId),
    // Real DB index is functional (lower(email)) — see 0115 migration; the
    // declaration here is approximate (hand-written SQL is authoritative).
    firmEmailUk: uniqueIndex('person_firm_email_uk')
      .on(t.firmId, t.email)
      .where(sql`email IS NOT NULL`),
    firmPhoneIdx: index('person_firm_phone_idx')
      .on(t.firmId, t.phone)
      .where(sql`phone IS NOT NULL`),
    firmMobileIdx: index('person_firm_mobile_idx')
      .on(t.firmId, t.mobile)
      .where(sql`mobile IS NOT NULL`),
  }),
);

export const clientContacts = pgTable(
  'client_contact',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    // 0115 — canonical identity link. name/email/phone now live on person;
    // the columns below are retained (deprecated) until 0116 drops them.
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    fullName: text('full_name'),
    roleId: uuid('role_id').references(() => contactRoles.id, { onDelete: 'set null' }),
    email: text('email'),
    phone: text('phone'),
    mobile: text('mobile'),
    isPrimary: boolean('is_primary').notNull().default(false),
    isBilling: boolean('is_billing').notNull().default(false),
    isPortalIdentity: boolean('is_portal_identity').notNull().default(false),
    // CAL-7 — appointment reminder opt-out (default on).
    receiveAppointmentReminders: boolean('receive_appointment_reminders').notNull().default(true),
    // 0166 — engagement status-notification opt-out (default on). Honored by
    // the staged status-notification recipient resolution.
    receiveStatusNotifications: boolean('receive_status_notifications').notNull().default(true),
    status: entityStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    clientIdx: index('client_contact_client_idx').on(t.clientId),
    personIdx: index('client_contact_person_idx').on(t.personId),
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
// Recurrence cadence for a task. NULL on the column means a one-off task; a
// value means "when this is completed, open the next one this far out". Mirrors
// the recurring-billing frequencies but adds SEMIMONTHLY (twice a month).
export const clientTaskRecurrence = pgEnum('client_task_recurrence', [
  'WEEKLY',
  'BIWEEKLY',
  'SEMIMONTHLY',
  'MONTHLY',
  'QUARTERLY',
  'SEMIANNUAL',
  'ANNUAL',
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
    // NULL = one-off; a cadence means completing this task opens the next one.
    recurrence: clientTaskRecurrence('recurrence'),
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
    channel: text('channel', { enum: ['EMAIL', 'SMS', 'CALL', 'MEETING', 'NOTE', 'PORTAL'] }).notNull(),
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
    clonedFromSlug: text('cloned_from_slug'),
    clonedFromPackVersion: text('cloned_from_pack_version'),
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
    // 0170 — defaults for the engagement create form's green toggles +
    // sub-config, so a template streamlines more of the New Engagement screen.
    defaultMixedModeEnabled: boolean('default_mixed_mode_enabled').notNull().default(false),
    defaultFeePassthroughEnabled: boolean('default_fee_passthrough_enabled')
      .notNull()
      .default(false),
    defaultTaxEnabled: boolean('default_tax_enabled').notNull().default(false),
    defaultTaxRateBps: integer('default_tax_rate_bps'),
    defaultTaxLabel: text('default_tax_label'),
    defaultSurchargeEnabled: boolean('default_surcharge_enabled').notNull().default(false),
    defaultSurchargeType: text('default_surcharge_type'),
    defaultSurchargeValueBps: integer('default_surcharge_value_bps'),
    defaultSurchargeAmountCents: bigint('default_surcharge_amount_cents', { mode: 'number' }),
    defaultSurchargeLabel: text('default_surcharge_label'),
    // 0170 — when set, "Make recurring" on the create form prefills this frequency.
    defaultRecurrenceFrequency: text('default_recurrence_frequency'),
    // 0171 — trigger mode that pairs with the frequency ('SCHEDULE' | 'ON_COMPLETION').
    defaultRecurrenceTriggerMode: text('default_recurrence_trigger_mode'),
    // 0172 — lifecycle status applied to a recurrence-spawned engagement.
    // NULL falls back to 'ACTIVE' at spawn time.
    defaultRecurrenceStatus: engagementStatus('default_recurrence_status'),
    // FK added in 0033 after the letter table exists; declared here as
    // a plain uuid column so Drizzle can reference it.
    defaultLetterTemplateId: uuid('default_letter_template_id'),
    customFieldsSchema: jsonb('custom_fields_schema').notNull().default({}),
    // 0083 — Mustache-style template resolved at engagement-creation
    // time. Supports {{client.name}}, {{period.year/month/label}},
    // {{today}}, {{engagement.*}}. NULL = use static `name` field
    // (backward-compatible).
    namePattern: text('name_pattern'),
    isSystem: boolean('is_system').notNull().default(false),
    clonedFromSlug: text('cloned_from_slug'),
    clonedFromPackVersion: text('cloned_from_pack_version'),
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
    clonedFromSlug: text('cloned_from_slug'),
    clonedFromPackVersion: text('cloned_from_pack_version'),
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
    // 0101 — text key into engagement_status_config (firm-scoped catalog).
    workflowState: text('workflow_state').notNull().default('NO_STATUS'),
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

    // 0074 — proposal addendum. from_proposal_id stamps the proposal
    // that birthed this engagement; renewed_from_engagement_id chains
    // a renewed engagement to its predecessor. Both are nullable —
    // engagements created directly (without a proposal) leave them
    // NULL. Migration enforces the FKs.
    fromProposalId: uuid('from_proposal_id'),
    renewedFromEngagementId: uuid('renewed_from_engagement_id'),

    // 0083 — optional period inputs that engagement-template name patterns
    // substitute into the resolved engagement name (e.g. "Bookkeeping
    // 4/2026"). Also used by the engagement_recurrence worker to derive
    // the next occurrence's period via advancePeriod().
    periodYear: integer('period_year'),
    periodMonth: smallint('period_month'),
    periodLabel: text('period_label'),

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

// 0086 — multi-engagement billing batches. One batch can span N
// engagements for the same client; the join table holds every picked
// engagement (including the one stored in billing_batch.engagement_id,
// which remains as a "primary" pointer for legacy readers).
export const billingBatchEngagements = pgTable(
  'billing_batch_engagement',
  {
    billingBatchId: uuid('billing_batch_id')
      .notNull()
      .references(() => billingBatches.id, { onDelete: 'cascade' }),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'restrict' }),
    ordinal: smallint('ordinal').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.billingBatchId, t.engagementId] }),
    engagementIdx: index('billing_batch_engagement_engagement_idx').on(t.engagementId),
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
    // 0091 — when this invoice is a firm-initiated retainer bill
    // (created via /retainers/manual with billClient=true), this points
    // directly at the retainer row in pending_payment. Paying this
    // invoice activates the retainer. Mutually exclusive with
    // retainer_offer_id in practice — the offer flow uses the FK above
    // and the firm-initiated flow uses this one.
    retainerId: uuid('retainer_id'),

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
    // 0130 — explicit collection channel when known (e.g. 'TERMINAL' for an
    // in-person card_present charge). NULL → derive from provider/method.
    channel: text('channel'),
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
    // 0131 — void of a manually-recorded payment (keeps the row for audit;
    // excluded from paid recompute + listing totals).
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedById: uuid('voided_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
    voidReason: text('void_reason'),
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
// TABLE: payment_import + payment_import_row (0158)
// Payments → Import tab: payroll-charges CSV ingests. One header per
// uploaded file; one row per CSV line with outcome breadcrumbs. Rows
// double as the duplicate-detection ledger on re-upload.
// =====================================================================
export const paymentImports = pgTable(
  'payment_import',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    engagementTypeId: uuid('engagement_type_id').references(() => engagementTypes.id, {
      onDelete: 'set null',
    }),
    paymentMethodKey: text('payment_method_key').notNull(),
    fileName: text('file_name'),
    createdByAppUserId: uuid('created_by_app_user_id').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmIdx: index('payment_import_firm_idx').on(t.firmId, t.createdAt),
  }),
);

export const paymentImportRows = pgTable(
  'payment_import_row',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    importId: uuid('import_id')
      .notNull()
      .references(() => paymentImports.id, { onDelete: 'cascade' }),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientCode: text('client_code').notNull(),
    clientName: text('client_name'),
    chargeDate: date('charge_date').notNull(),
    description: text('description'),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
    engagementId: uuid('engagement_id').references(() => engagements.id, {
      onDelete: 'set null',
    }),
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    paymentReceiptId: uuid('payment_receipt_id').references(() => paymentReceipts.id, {
      onDelete: 'set null',
    }),
    creditMemoId: uuid('credit_memo_id').references(() => creditMemos.id, {
      onDelete: 'set null',
    }),
    // INVOICED_PAID | PREPAYMENT | SKIPPED
    outcome: text('outcome').notNull(),
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    importIdx: index('payment_import_row_import_idx').on(t.importId),
    dedupeIdx: index('payment_import_row_dedupe_idx').on(
      t.firmId,
      t.clientCode,
      t.chargeDate,
      t.amountCents,
    ),
  }),
);

export type PaymentImport = typeof paymentImports.$inferSelect;
export type PaymentImportRow = typeof paymentImportRows.$inferSelect;

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

// 0159 — per-client credential vault. Each credential carries a per-record
// DEK (random key) wrapped by the firm MFK; the *_enc columns are encrypted
// with that DEK (mirrors intake/messaging/calendar). Only title/category/hint
// are plaintext (for list display without decrypting). Encryption-at-rest, not
// E2EE — the firm (appliance) holds the key. Reveal is gated by RBAC +
// step-up + audit; never store plaintext secrets here.
export const clientCredentials = pgTable(
  'client_credential',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    // irs | state | bank | payroll | software | other
    category: text('category').notNull().default('other'),
    hint: text('hint'), // plaintext preview, e.g. masked username — never the secret
    wrappedDek: bytea('wrapped_dek').notNull(),
    usernameEnc: bytea('username_enc'),
    passwordEnc: bytea('password_enc'),
    urlEnc: bytea('url_enc'),
    notesEnc: bytea('notes_enc'),
    status: text('status').notNull().default('ACTIVE'), // ACTIVE | ARCHIVED
    lastRevealedAt: timestamp('last_revealed_at', { withTimezone: true }),
    lastRevealedBy: uuid('last_revealed_by').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    createdBy: uuid('created_by').references(() => appUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmIdx: index('client_credential_firm_idx').on(t.firmId),
    clientIdx: index('client_credential_client_idx').on(t.clientId, t.status, t.createdAt),
    statusCk: check(
      'client_credential_status_ck',
      sql`${t.status} IN ('ACTIVE', 'ARCHIVED')`,
    ),
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
// TABLE: saved_kanban_view (0122)
// Per-user named "column views" for the engagements kanban board.
// visible_columns is an ordered array of workflow_state keys. Private to
// the owner (no shared flag, unlike saved_report).
// =====================================================================

export const savedKanbanViews = pgTable(
  'saved_kanban_view',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    boardType: text('board_type').notNull().default('engagement'),
    visibleColumns: jsonb('visible_columns').notNull().default([]).$type<string[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdx: index('saved_kanban_view_owner_idx').on(t.ownerId, t.boardType),
    ownerBoardNameUk: uniqueIndex('saved_kanban_view_owner_board_name_uk').on(
      t.ownerId,
      t.boardType,
      t.name,
    ),
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
// alert_dismissal — staff can dismiss a worker alert (an audit_log row of
// an alert kind) so it leaves the Alerts inbox and the dashboard callout.
// audit_log is append-only, so the dismissal lives here. Per-firm: one
// dismissal hides the alert for the whole firm.
// =====================================================================
export const alertDismissals = pgTable(
  'alert_dismissal',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    auditLogId: uuid('audit_log_id')
      .notNull()
      .references(() => auditLog.id, { onDelete: 'cascade' }),
    dismissedByAppUserId: uuid('dismissed_by_app_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uk: uniqueIndex('alert_dismissal_uk').on(t.firmId, t.auditLogId),
  }),
);

// =====================================================================
// notification_log — Connect H.8. One row per outbound mail/sms send
// attempt so firms can answer "did this dunning email actually go
// out?" without grepping pino logs. Captures success + failure.
// =====================================================================
export const notificationLog = pgTable(
  'notification_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id').references(() => firms.id, { onDelete: 'set null' }),
    channel: text('channel').notNull(),
    provider: text('provider').notNull(),
    templateKey: text('template_key'),
    recipient: text('recipient').notNull(),
    subject: text('subject'),
    status: text('status').notNull(),
    providerMessageId: text('provider_message_id'),
    errorMessage: text('error_message'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    deliveryUpdatedAt: timestamp('delivery_updated_at', { withTimezone: true }),
  },
  (t) => ({
    firmIdx: index('notification_log_firm_idx').on(t.firmId, t.occurredAt),
    statusIdx: index('notification_log_status_idx')
      .on(t.status, t.occurredAt)
      .where(sql`status = 'failed'`),
    recipientIdx: index('notification_log_recipient_idx').on(t.recipient, t.occurredAt),
    providerMessageIdx: index('notification_log_provider_message_idx')
      .on(t.providerMessageId)
      .where(sql`provider_message_id IS NOT NULL`),
    channelCheck: check('notification_log_channel_ck', sql`${t.channel} IN ('email', 'sms')`),
    statusCheck: check(
      'notification_log_status_ck',
      sql`${t.status} IN ('sent', 'failed', 'delivered', 'bounced', 'complained', 'opened')`,
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

// 0165 — client_access_grant. Designated users for a restricted client
// (client.restricted = true). Membership grants full access to the
// client's otherwise-hidden surfaces; admins + the partner-in-charge are
// always allowed and need no row here.
export const clientAccessGrants = pgTable(
  'client_access_grant',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    grantedById: uuid('granted_by_id').references(() => appUsers.id),
  },
  (t) => ({
    naturalKey: uniqueIndex('client_access_grant_uk').on(t.clientId, t.appUserId),
    clientIdx: index('client_access_grant_client_idx').on(t.clientId),
    userIdx: index('client_access_grant_user_idx').on(t.appUserId),
  }),
);

// =====================================================================
// 0083 — engagement_recurrence. Subscribes a (client × template) to a
// cadence. Worker spawns the next engagement either on schedule
// (next_run_date <= today) or when the previous engagement transitions
// to CLOSED. Collision case (previous still ACTIVE on a SCHEDULE fire)
// queues an ENGAGEMENT_RENEWAL approval per Q23.
// =====================================================================
export const engagementRecurrences = pgTable(
  'engagement_recurrence',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id')
      .notNull()
      .references(() => engagementTemplates.id, { onDelete: 'restrict' }),
    frequency: recurringFrequency('frequency').notNull(),
    triggerMode: text('trigger_mode').notNull(),
    nextRunDate: date('next_run_date'),
    seedPeriodYear: integer('seed_period_year'),
    seedPeriodMonth: smallint('seed_period_month'),
    seedPeriodLabel: text('seed_period_label'),
    lastEngagementId: uuid('last_engagement_id').references(() => engagements.id, {
      onDelete: 'set null',
    }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    status: text('status').notNull().default('ACTIVE'),
    // 0172 — per-recurrence override for the spawned engagement's lifecycle
    // status. NULL inherits the template default, then falls back to 'ACTIVE'.
    spawnStatus: engagementStatus('spawn_status'),
    notes: text('notes'),
    createdById: uuid('created_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmStatusIdx: index('engagement_recurrence_firm_status_idx').on(t.firmId, t.status),
    nextRunIdx: index('engagement_recurrence_next_run_idx')
      .on(t.nextRunDate)
      .where(sql`status = 'ACTIVE' AND trigger_mode = 'SCHEDULE'`),
    completionIdx: index('engagement_recurrence_completion_idx')
      .on(t.lastEngagementId)
      .where(sql`status = 'ACTIVE' AND trigger_mode = 'ON_COMPLETION'`),
    clientIdx: index('engagement_recurrence_client_idx').on(t.clientId),
    triggerModeCheck: check(
      'engagement_recurrence_trigger_mode_ck',
      sql`${t.triggerMode} IN ('SCHEDULE', 'ON_COMPLETION')`,
    ),
    statusCheck: check(
      'engagement_recurrence_status_ck',
      sql`${t.status} IN ('ACTIVE', 'PAUSED', 'CANCELLED')`,
    ),
    scheduleHasDateCheck: check(
      'engagement_recurrence_schedule_has_date_ck',
      sql`(${t.triggerMode} = 'SCHEDULE') = (${t.nextRunDate} IS NOT NULL)`,
    ),
    seedMonthRangeCheck: check(
      'engagement_recurrence_seed_month_range_ck',
      sql`${t.seedPeriodMonth} IS NULL OR (${t.seedPeriodMonth} BETWEEN 1 AND 12)`,
    ),
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
    // 0101 — arbitrary text key (was the engagement_workflow_state enum).
    workflowState: text('workflow_state').notNull(),
    label: text('label').notNull(),
    color: text('color').notNull().default('#6b7280'),
    sortOrder: integer('sort_order').notNull().default(0),
    kanbanVisible: boolean('kanban_visible').notNull().default(true),
    triggersClientComm: boolean('triggers_client_comm').notNull().default(false),
    // 0146 — notification config used when triggers_client_comm is set:
    // dispatch mode, channel fan-out, and recipient resolution rule.
    notifyMode: text('notify_mode', { enum: ['IMMEDIATE', 'STAGED'] })
      .notNull()
      .default('STAGED'),
    notifyChannels: text('notify_channels').array().notNull().default([]),
    notifyRecipients: text('notify_recipients', { enum: ['BILLING_CONTACT', 'ALL_CONTACTS'] })
      .notNull()
      .default('BILLING_CONTACT'),
    // 0101 — the 10 originals are is_system (un-deletable, key immutable);
    // firm-created rows are deletable. Client-facing text shown in the
    // portal in place of the internal label when set + client_visible.
    isSystem: boolean('is_system').notNull().default(false),
    clientLabel: text('client_label'),
    clientDescription: text('client_description'),
    clientVisible: boolean('client_visible').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.firmId, t.workflowState] }),
    firmSortIdx: index('engagement_status_config_firm_sort_idx').on(t.firmId, t.sortOrder),
  }),
);

// 0167 — engagement_status_service_line. Maps a firm's workflow statuses
// to the service lines they apply to. A status with zero rows here is
// unrestricted (offered for every engagement); rows restrict it to only
// the listed service lines. Mirrors the work_code → service_line scoping
// pattern. Filtering of status pickers is done client-side from the
// catalog response; this table is the source of truth.
export const engagementStatusServiceLine = pgTable(
  'engagement_status_service_line',
  {
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    workflowState: text('workflow_state').notNull(),
    serviceLineId: uuid('service_line_id')
      .notNull()
      .references(() => serviceLines.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.firmId, t.workflowState, t.serviceLineId] }),
    statusFk: foreignKey({
      columns: [t.firmId, t.workflowState],
      foreignColumns: [engagementStatusConfig.firmId, engagementStatusConfig.workflowState],
    }).onDelete('cascade'),
    serviceLineIdx: index('engagement_status_service_line_sl_idx').on(t.firmId, t.serviceLineId),
  }),
);

// 0146 — staged_notification. One row per notification trigger event
// (trigger_kind 'engagement_status' first). Recipients + rendered
// per-channel content are snapshotted at staging time; the worker only
// re-checks guards at fire time. IMMEDIATE mode rows go straight to
// SCHEDULED so all sends share one worker path. A partial unique index
// on supersede_key (active statuses only) enforces at most one unsent
// notification per engagement+trigger; newer changes supersede.
export const stagedNotifications = pgTable(
  'staged_notification',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    triggerKind: text('trigger_kind').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    // { workflowState, fromState, statusLabel }
    triggerContext: jsonb('trigger_context').notNull(),
    supersedeKey: text('supersede_key').notNull(),
    mode: text('mode', { enum: ['IMMEDIATE', 'STAGED'] }).notNull(),
    status: text('status', {
      enum: ['PENDING_APPROVAL', 'SCHEDULED', 'SENT', 'CANCELED', 'FAILED'],
    }).notNull(),
    channels: text('channels').array().notNull(),
    recipientMode: text('recipient_mode', {
      enum: ['BILLING_CONTACT', 'ALL_CONTACTS'],
    }).notNull(),
    // [{ personId, name, email, phone }]
    recipients: jsonb('recipients').notNull(),
    // { EMAIL: {subject, body}, SMS: {body}, PORTAL: {title, body} }
    rendered: jsonb('rendered').notNull(),
    templateKind: text('template_kind').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    decidedBy: uuid('decided_by').references(() => appUsers.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    canceledReason: text('canceled_reason', {
      enum: ['SUPERSEDED', 'MANUAL', 'STATE_CHANGED_AT_FIRE'],
    }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    // { EMAIL: {ok, sentTo[], error?}, ... }
    channelResults: jsonb('channel_results'),
    errorMessage: text('error_message'),
    createdBy: uuid('created_by').references(() => appUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmStatusIdx: index('staged_notification_firm_status_idx').on(t.firmId, t.status),
    clientIdx: index('staged_notification_client_idx').on(t.clientId),
    entityIdx: index('staged_notification_entity_idx').on(t.entityType, t.entityId),
    activeSupersedeUk: uniqueIndex('staged_notification_active_supersede_uk')
      .on(t.supersedeKey)
      .where(sql`status IN ('PENDING_APPROVAL', 'SCHEDULED')`),
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
    // 0088 — denormalized client pointer so a single WHERE returns
    // every thread for a client (both engagement-linked and
    // client-direct). Engagement-linked threads have this populated
    // from engagement.client_id at create time.
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'cascade' }),
    tDekWrapped: bytea('t_dek_wrapped').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    title: text('title'),
    // 0105 — 'client' (the original client/engagement-scoped threads) vs
    // 'internal' (staff-to-staff direct + group chat; client_id is null).
    kind: text('kind').notNull().default('client'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => ({
    firmIdx: index('thread_firm_id_idx').on(t.firmId),
    clientIdx: index('thread_client_id_idx').on(t.clientId),
    statusIdx: index('thread_status_idx').on(t.status),
    statusCk: check('thread_status_ck', sql`${t.status} IN ('ACTIVE', 'ARCHIVED')`),
    kindCk: check('thread_kind_ck', sql`${t.kind} IN ('client', 'internal')`),
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
    // 0105 — per-member read cursor (unread = messages after this) and the
    // last time we emailed/texted this member about the thread (debounce).
    lastReadAt: timestamp('last_read_at', { withTimezone: true }),
    lastNotifiedAt: timestamp('last_notified_at', { withTimezone: true }),
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

// 0106 — message attachments (images/files). Bytes are stored at objectKey
// encrypted under the thread T-DEK (same key as message bodies); the
// original filename is encrypted too. messageId is null while an upload is
// pending and set when the composing message is posted.
export const threadAttachments = pgTable(
  'thread_attachment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    objectKey: text('object_key').notNull(),
    originalFilenameEnc: bytea('original_filename_enc'),
    mimeType: text('mime_type'),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    createdByAppUserId: uuid('created_by_app_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    threadIdx: index('thread_attachment_thread_idx').on(t.threadId),
    messageIdx: index('thread_attachment_message_idx').on(t.messageId),
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
    // 0135 — 'GENERAL' | 'DROP_OFF'. Drop-offs are dated client info
    // hand-offs with once-only email+SMS reminders; see request-reminder.
    kind: text('kind').notNull().default('GENERAL'),
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
    // 0084 — request expansion.
    priority: requestPriority('priority').notNull().default('MEDIUM'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    // FK declared via raw SQL in the migration (request_template
    // doesn't exist yet at this column's declaration time). Drizzle
    // treats it as a bare uuid pointer.
    templateId: uuid('template_id'),
    reminderDaysBefore: integer('reminder_days_before'),
    lastReminderSentAt: timestamp('last_reminder_sent_at', { withTimezone: true }),
    clientReplyText: text('client_reply_text'),
  },
  (t) => ({
    firmStatusIdx: index('client_request_firm_status_idx').on(t.firmId, t.status),
    engIdx: index('client_request_engagement_idx').on(t.engagementId, t.status),
    priorityIdx: index('client_request_priority_idx').on(t.firmId, t.priority, t.status),
    statusCk: check(
      'client_request_status_ck',
      sql`${t.status} IN ('OPEN', 'FULFILLED', 'DISMISSED', 'EXPIRED', 'NEEDS_INFO')`,
    ),
    reminderDaysCk: check(
      'client_request_reminder_days_ck',
      sql`${t.reminderDaysBefore} IS NULL OR ${t.reminderDaysBefore} BETWEEN 0 AND 365`,
    ),
    // 0135 — kind discriminator; mirrors the migration's CHECK.
    kindCk: check('client_request_kind_ck', sql`${t.kind} IN ('GENERAL', 'DROP_OFF')`),
  }),
);

// 0084 — request templates with Mustache title/body patterns.
export const requestTemplates = pgTable(
  'request_template',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    titlePattern: text('title_pattern').notNull(),
    bodyPattern: text('body_pattern').notNull().default(''),
    defaultPriority: requestPriority('default_priority').notNull().default('MEDIUM'),
    defaultDueOffsetDays: integer('default_due_offset_days'),
    defaultReminderDaysBefore: integer('default_reminder_days_before'),
    defaultAssignedAppUserId: uuid('default_assigned_app_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    isSystem: boolean('is_system').notNull().default(false),
    clonedFromSlug: text('cloned_from_slug'),
    clonedFromPackVersion: text('cloned_from_pack_version'),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdById: uuid('created_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
  },
  (t) => ({
    firmKeyUk: uniqueIndex('request_template_firm_key_uk').on(t.firmId, t.key),
    firmStatusIdx: index('request_template_firm_status_idx').on(t.firmId, t.status),
    statusCk: check('request_template_status_ck', sql`${t.status} IN ('ACTIVE', 'ARCHIVED')`),
  }),
);

export const requestTemplateItems = pgTable(
  'request_template_item',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => requestTemplates.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    label: text('label').notNull(),
    body: text('body').notNull().default(''),
    itemKind: text('item_kind').notNull().default('QUESTION'),
    required: boolean('required').notNull().default(true),
    defaultDueOffsetDays: integer('default_due_offset_days'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ordinalUk: uniqueIndex('request_template_item_ordinal_uk').on(t.templateId, t.ordinal),
    kindCk: check(
      'request_template_item_kind_ck',
      sql`${t.itemKind} IN ('QUESTION', 'DOCUMENT', 'SIGNATURE')`,
    ),
  }),
);

export const clientRequestItems = pgTable(
  'client_request_item',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    clientRequestId: uuid('client_request_id')
      .notNull()
      .references(() => clientRequests.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    label: text('label').notNull(),
    body: text('body').notNull().default(''),
    itemKind: text('item_kind').notNull().default('QUESTION'),
    required: boolean('required').notNull().default(true),
    status: text('status').notNull().default('OPEN'),
    dueDate: date('due_date'),
    fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
    fulfilledByAppUserId: uuid('fulfilled_by_app_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    fulfilledByPortalIdentityId: uuid('fulfilled_by_portal_identity_id'),
    fulfilledByFileId: uuid('fulfilled_by_file_id'),
    fulfilledText: text('fulfilled_text'),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    dismissedReason: text('dismissed_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ordinalUk: uniqueIndex('client_request_item_ordinal_uk').on(t.clientRequestId, t.ordinal),
    requestStatusIdx: index('client_request_item_request_status_idx').on(
      t.clientRequestId,
      t.status,
    ),
    statusCk: check(
      'client_request_item_status_ck',
      sql`${t.status} IN ('OPEN', 'FULFILLED', 'DISMISSED', 'NEEDS_INFO')`,
    ),
    kindCk: check(
      'client_request_item_kind_ck',
      sql`${t.itemKind} IN ('QUESTION', 'DOCUMENT', 'SIGNATURE')`,
    ),
  }),
);

export const clientRequestAttachments = pgTable(
  'client_request_attachment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    clientRequestId: uuid('client_request_id')
      .notNull()
      .references(() => clientRequests.id, { onDelete: 'cascade' }),
    clientRequestItemId: uuid('client_request_item_id').references(() => clientRequestItems.id, {
      onDelete: 'cascade',
    }),
    fileId: uuid('file_id').notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    uploadedByAppUserId: uuid('uploaded_by_app_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    uploadedByPortalIdentityId: uuid('uploaded_by_portal_identity_id'),
  },
  (t) => ({
    requestIdx: index('client_request_attachment_request_idx').on(t.clientRequestId, t.uploadedAt),
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
export type ClientAccessGrant = typeof clientAccessGrants.$inferSelect;
export type NewClientAccessGrant = typeof clientAccessGrants.$inferInsert;
export type EngagementStatusConfig = typeof engagementStatusConfig.$inferSelect;
export type NewEngagementStatusConfig = typeof engagementStatusConfig.$inferInsert;
export type EngagementStatusServiceLine = typeof engagementStatusServiceLine.$inferSelect;
export type NewEngagementStatusServiceLine = typeof engagementStatusServiceLine.$inferInsert;
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
    // 0154 — NULL for a bundle (multi-file) share; the files live in
    // file_share_item. Single-file shares keep this set.
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'cascade' }),
    // FK to portal_identity in portal.ts — kept loose to avoid circular
    // imports. Enforced by the migration. Exactly one of this /
    // created_by_app_user_id is set (client vs staff initiator).
    createdByPortalIdentityId: uuid('created_by_portal_identity_id'),
    // 0102 — staff initiator (loose FK to app_user).
    createdByAppUserId: uuid('created_by_app_user_id'),
    tokenHash: text('token_hash').notNull().unique(),
    accessLevel: text('access_level').notNull().default('view'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    accessCount: integer('access_count').notNull().default(0),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
    // 0102 — rich third-party share fields (parity with tax_return_shares).
    recipientName: text('recipient_name'),
    recipientEmail: text('recipient_email'),
    recipientPhone: text('recipient_phone'),
    organization: text('organization'),
    role: text('role'),
    personalMessage: text('personal_message'),
    require2fa: boolean('require_2fa').notNull().default(false),
    verifyChannel: text('verify_channel').notNull().default('NONE'),
    watermark: boolean('watermark').notNull().default(false),
    status: text('status').notNull().default('SENT'),
    firstViewedAt: timestamp('first_viewed_at', { withTimezone: true }),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    // 0150 — gated shares open the access-code landing page instead of
    // direct-downloading. Pre-0150 rows are false (legacy links honored
    // until expiry); all new shares are gated.
    gated: boolean('gated').notNull().default(true),
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
      sql`${t.outcome} IN ('allowed', 'denied_revoked', 'denied_expired', 'denied_file_gone', 'otp_sent', 'otp_failed', 'otp_verified', 'otp_locked', 'denied_gated', 'denied_not_verified', 'revoked_lockout')`,
    ),
  }),
);

// 0150 — one row per "send access code" on a gated share. The 6-digit
// code and the post-verify browser grant are both sha256-hashed at
// rest. Cooldown (60s) and the 24h send quota are computed by counting
// rows; 5 wrong attempts lock a challenge, 3 exhausted challenges
// revoke the share.
export const fileShareOtps = pgTable(
  'file_share_otp',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    fileShareId: uuid('file_share_id')
      .notNull()
      .references(() => fileShares.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: ['EMAIL', 'SMS'] }).notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    grantTokenHash: text('grant_token_hash'),
    grantExpiresAt: timestamp('grant_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shareIdx: index('file_share_otp_share_idx').on(t.fileShareId, t.createdAt),
    attemptsNonneg: check('file_share_otp_attempts_nonneg', sql`${t.attempts} >= 0`),
  }),
);

// 0154 — files in a bundle (multi-file) share. One row per included
// file; the parent file_share.file_id is NULL for bundles.
export const fileShareItems = pgTable(
  'file_share_item',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    fileShareId: uuid('file_share_id')
      .notNull()
      .references(() => fileShares.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shareIdx: index('file_share_item_share_idx').on(t.fileShareId),
    uk: uniqueIndex('file_share_item_uk').on(t.fileShareId, t.fileId),
  }),
);

export type FileShare = typeof fileShares.$inferSelect;
export type FileShareEvent = typeof fileShareEvents.$inferSelect;
export type FileShareOtp = typeof fileShareOtps.$inferSelect;
export type FileShareItem = typeof fileShareItems.$inferSelect;

// 0155 — Route Sheet prints. One parent per print (staff/when/note);
// one item per engagement on the sheet (workflow-state before/after +
// a JSON snapshot of the rendered payload for faithful reprint).
export const routeSheetPrints = pgTable(
  'route_sheet_print',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    createdByAppUserId: uuid('created_by_app_user_id').references(() => appUsers.id),
    note: text('note'),
    printedAt: timestamp('printed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmClientIdx: index('route_sheet_print_firm_client_idx').on(
      t.firmId,
      t.clientId,
      t.printedAt,
    ),
  }),
);

export interface RouteSheetItemSnapshot {
  engagementId: string;
  engagementName: string;
  workflowStateLabel: string;
  periodLabel: string | null;
  dueDate: string | null;
  partnerName: string | null;
  managerName: string | null;
  assignees: string[];
  client: {
    name: string;
    address: string | null;
    contacts: Array<{ name: string; email: string | null; home: string | null; mobile: string | null }>;
  };
  note: string;
}

export const routeSheetPrintItems = pgTable(
  'route_sheet_print_item',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    routeSheetPrintId: uuid('route_sheet_print_id')
      .notNull()
      .references(() => routeSheetPrints.id, { onDelete: 'cascade' }),
    // Nullable: a "blank" route sheet (no engagement selected/available) stores
    // one item row with a client-only snapshot and no engagement.
    engagementId: uuid('engagement_id').references(() => engagements.id, {
      onDelete: 'cascade',
    }),
    workflowStateBefore: text('workflow_state_before'),
    workflowStateAfter: text('workflow_state_after'),
    snapshotJson: jsonb('snapshot_json').$type<RouteSheetItemSnapshot>(),
  },
  (t) => ({
    printIdx: index('route_sheet_print_item_print_idx').on(t.routeSheetPrintId),
  }),
);

export type RouteSheetPrint = typeof routeSheetPrints.$inferSelect;
export type RouteSheetPrintItem = typeof routeSheetPrintItems.$inferSelect;

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

// BK-1 — booking enums (declared before `appointments` so the
// cancelled_by_actor column can use the enum type eagerly).
export const providerWriteStatus = pgEnum('provider_write_status', [
  'pending',
  'written',
  'failed',
  // 0157 — a successful reschedule write-back (distinguishes from the
  // original create and clears a previously failed row). Appended last
  // to match ALTER TYPE ... ADD VALUE ordering in the database.
  'updated',
]);
export const appointmentCancelledBy = pgEnum('appointment_cancelled_by', ['staff', 'client']);
export const rescheduleRequestStatus = pgEnum('reschedule_request_status', [
  'pending',
  'accepted',
  'declined',
]);
export const appointmentRsvpStatus = pgEnum('appointment_rsvp_status', [
  'pending',
  'confirmed',
  'declined',
]);

export const appointments = pgTable(
  'appointment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    // BK-1 — nullable: booking allows client-less internal meetings.
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'restrict' }),
    engagementId: uuid('engagement_id').references(() => engagements.id, {
      onDelete: 'restrict',
    }),
    title: text('title').notNull(),
    description: text('description'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    location: appointmentLocation('location').notNull().default('VIDEO'),
    locationDetail: text('location_detail'),
    // 0144 — optional link to a firm-managed location preset. The canonical
    // location/locationDetail above are still populated (from the preset at
    // booking time) so all readers keep working; this just records provenance.
    locationOptionId: uuid('location_option_id').references(() => appointmentLocationOptions.id, {
      onDelete: 'set null',
    }),
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
    // BK-1 — booking additions. type/duration/internal notes; signed
    // tokens for client-side cancel/reschedule; whether staff or client
    // cancelled; when last rescheduled. Multi-staff lives in
    // appointment_staff (booking.ts); the single lead_app_user_id above
    // is retained for back-compat.
    appointmentTypeId: uuid('appointment_type_id').references(() => appointmentTypes.id, {
      onDelete: 'set null',
    }),
    durationMinutes: integer('duration_minutes'),
    internalNotes: text('internal_notes'),
    cancelToken: uuid('cancel_token'),
    rescheduleToken: uuid('reschedule_token'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    cancelledByActor: appointmentCancelledBy('cancelled_by_actor'),
    lastRescheduledAt: timestamp('last_rescheduled_at', { withTimezone: true }),
    // 0121 — per-booking reminder schedule override (null = inherit type/firm).
    reminderSchedule: jsonb('reminder_schedule').$type<ReminderStep[]>(),
  },
  (t) => ({
    firmStartsIdx: index('appointment_firm_starts_idx').on(t.firmId, t.startsAt),
    clientStartsIdx: index('appointment_client_starts_idx').on(t.clientId, t.startsAt),
    leadStartsIdx: index('appointment_lead_starts_idx')
      .on(t.leadAppUserId, t.startsAt)
      .where(sql`lead_app_user_id IS NOT NULL`),
    timeOrderCk: check('appointment_time_order', sql`${t.endsAt} > ${t.startsAt}`),
    cancelTokenUk: uniqueIndex('appointment_cancel_token_uk')
      .on(t.cancelToken)
      .where(sql`cancel_token IS NOT NULL`),
    rescheduleTokenUk: uniqueIndex('appointment_reschedule_token_uk')
      .on(t.rescheduleToken)
      .where(sql`reschedule_token IS NOT NULL`),
    clientStatusIdx: index('appointment_client_status_idx')
      .on(t.clientId, t.status)
      .where(sql`client_id IS NOT NULL`),
  }),
);

export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;

// BK-1 — the firm-managed appointment type library (enums above).
/** 0121 — one reminder step in a schedule: how long before start, on which
 *  channel. Stored as a jsonb array on appointment_type (default) and
 *  appointment (per-booking override). */
export type ReminderStep = { offsetMinutes: number; channel: 'EMAIL' | 'SMS' | 'CALL' };

export const appointmentTypes = pgTable(
  'appointment_type',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    defaultDurationMinutes: integer('default_duration_minutes').notNull().default(30),
    defaultLocationType: appointmentLocation('default_location_type').notNull().default('VIDEO'),
    description: text('description'),
    color: text('color'),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    // 0121 — default reminder schedule for bookings of this type (null = firm default).
    reminderSchedule: jsonb('reminder_schedule').$type<ReminderStep[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmSortIdx: index('appointment_type_firm_sort_idx').on(t.firmId, t.sortOrder),
  }),
);

export type AppointmentType = typeof appointmentTypes.$inferSelect;
export type NewAppointmentType = typeof appointmentTypes.$inferInsert;

// 0144 — firm-managed list of reusable appointment locations. Each preset
// carries a meeting type + a free-text detail (address / video link / phone),
// selectable at booking time in addition to typing a one-off location, and
// attachable to a staff availability window (staff_availability.location_option_id).
export const appointmentLocationOptions = pgTable(
  'appointment_location_option',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    locationType: appointmentLocation('location_type').notNull().default('IN_PERSON'),
    // Address (IN_PERSON), meeting link (VIDEO), or phone number (PHONE).
    detail: text('detail'),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmSortIdx: index('appointment_location_option_firm_sort_idx').on(t.firmId, t.sortOrder),
  }),
);

export type AppointmentLocationOption = typeof appointmentLocationOptions.$inferSelect;

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
    // 0134 — optional link to the tax return this payment was generated
    // from (estimated vouchers / balance due). Loose column; the FK to
    // tax_returns is added by migration 0134 to avoid a core↔tax-returns
    // import cycle (same pattern as tax_returns.amends_return_id).
    taxReturnId: uuid('tax_return_id'),
    // 0090 — denormalized "pay online" link snapshotted from the
    // tax_payment_type catalog at create time so the portal CTA is
    // stable even if the catalog row is later edited or removed.
    paymentUrl: text('payment_url'),
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

// =====================================================================
// 0085 — CLOUDFLARE TUNNEL CONFIG
// =====================================================================
//
// Stores firm-owned Cloudflare credentials + the per-tunnel run-token.
// One row per firm. Both secrets are MFK-wrapped (bytea); plaintext
// never leaves the API process. `api_token_hint` is the last 4 chars
// of the API token so the admin UI can render "ends in ...abcd" with
// no decrypt. See apps/api/src/admin/cloudflare-tunnel/routes.ts.

export const cloudflareTunnelStatus = pgEnum('cloudflare_tunnel_status', [
  'INACTIVE',
  'PROVISIONING',
  'ACTIVE',
  'ERROR',
]);

// 0095 — realm a tunnel hostname routes to. STAFF → app SPA, PORTAL →
// client portal SPA. Drives the origin Host-header rewrite so Caddy's
// existing `portal.*` matcher lands the request in the right realm
// regardless of the public hostname label.
// 0099 — ESIGN → the OpenSign signing UI on the isolated sidecar
// (opensign-caddy:4001); routes WITHOUT a Host-header rewrite.
// 0104 — INTAKE → the public document-intake SPA; routes to the appliance
// Caddy with a Host rewrite to intake.<zone>, where Caddy exposes ONLY
// /api/public/intake/* + the static intake SPA.
export const cloudflareTunnelRealm = pgEnum('cloudflare_tunnel_realm', [
  'STAFF',
  'PORTAL',
  'ESIGN',
  'INTAKE',
]);

export const cloudflareTunnelConfigs = pgTable(
  'cloudflare_tunnel_config',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    accountId: text('account_id'),
    zoneId: text('zone_id'),
    zoneName: text('zone_name'),
    staffHostname: text('staff_hostname'),
    portalHostname: text('portal_hostname'),
    tunnelId: text('tunnel_id'),
    tunnelName: text('tunnel_name'),
    apiTokenEncrypted: bytea('api_token_encrypted'),
    apiTokenHint: text('api_token_hint'),
    tunnelTokenEncrypted: bytea('tunnel_token_encrypted'),
    status: cloudflareTunnelStatus('status').notNull().default('INACTIVE'),
    lastError: text('last_error'),
    lastProvisionedAt: timestamp('last_provisioned_at', { withTimezone: true }),
    lastStatusCheckAt: timestamp('last_status_check_at', { withTimezone: true }),
    metricsSnapshot: jsonb('metrics_snapshot').$type<{
      ready: boolean;
      connectorCount: number;
      region: string | null;
      checkedAt: string;
    } | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmUk: uniqueIndex('cf_tunnel_one_per_firm').on(t.firmId),
    statusIdx: index('cloudflare_tunnel_status_idx').on(t.status),
  }),
);

// 0095 — source of truth for tunnel hostnames. Supports an arbitrary
// add/remove list (replacing the fixed staff/portal pair); the legacy
// staff_hostname/portal_hostname columns above are kept populated with
// the first hostname of each realm for back-compat.
export const cloudflareTunnelHostnames = pgTable(
  'cloudflare_tunnel_hostname',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    hostname: text('hostname').notNull(),
    realm: cloudflareTunnelRealm('realm').notNull(),
    // Cloudflare DNS record id for this hostname — stored so edit/remove
    // can reconcile (delete) the exact record without a lookup.
    dnsRecordId: text('dns_record_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmHostUk: uniqueIndex('cf_tunnel_hostname_firm_host_uk').on(t.firmId, t.hostname),
    firmIdx: index('cf_tunnel_hostname_firm_idx').on(t.firmId),
  }),
);

// 0100 — concrete AI provider kind for UI-entered credentials. Distinct
// from the coarse `ai_provider` enum (which logs LOCAL_OLLAMA vs cloud in
// ai_request_log) — this names the exact client to build.
export const aiProviderKind = pgEnum('ai_provider_kind', [
  'anthropic',
  'openai_compatible',
  'ollama',
]);

// 0100 — per-firm AI provider credentials entered via Admin → AI settings.
// API keys are MFK-wrapped (bytea) exactly like the Cloudflare tunnel token;
// plaintext never lives in the DB and is returned to the UI only as a
// last-4 `api_key_hint`. One row per provider kind per firm. The boot/env
// providers remain the fallback when a firm has no row.
export const aiProviderCredential = pgTable(
  'ai_provider_credential',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    providerId: aiProviderKind('provider_id').notNull(),
    // Null for ollama (no key) and for updates that leave the key unchanged.
    apiKeyEncrypted: bytea('api_key_encrypted'),
    apiKeyHint: text('api_key_hint'),
    // baseUrl: required for openai_compatible; optional override for ollama.
    baseUrl: text('base_url'),
    model: text('model'),
    // Optional cost overrides, cents per 1M tokens (Stripe-style integers).
    inputCentsPerMtok: integer('input_cents_per_mtok'),
    outputCentsPerMtok: integer('output_cents_per_mtok'),
    enabled: boolean('enabled').notNull().default(true),
    status: text('status').notNull().default('UNTESTED'),
    lastError: text('last_error'),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmProviderUk: uniqueIndex('ai_provider_credential_firm_provider_uk').on(
      t.firmId,
      t.providerId,
    ),
    firmIdx: index('ai_provider_credential_firm_idx').on(t.firmId),
  }),
);

// 0094 — UI-configurable file storage. The boot path merges this row
// (sealed credentials decrypted by FirmKeyManager) with env-var
// fallbacks. Provider selects which credential block applies.
export const storageSettings = pgTable('storage_settings', {
  firmId: uuid('firm_id')
    .primaryKey()
    .references(() => firms.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull().default('mock'),

  b2Endpoint: text('b2_endpoint'),
  b2Region: text('b2_region'),
  b2Bucket: text('b2_bucket'),
  b2KeyIdEncrypted: bytea('b2_key_id_encrypted'),
  b2ApplicationKeyEncrypted: bytea('b2_application_key_encrypted'),
  b2KeyIdHint: text('b2_key_id_hint'),

  minioEndpoint: text('minio_endpoint'),
  minioRegion: text('minio_region'),
  minioBucket: text('minio_bucket'),
  minioAccessKeyEncrypted: bytea('minio_access_key_encrypted'),
  minioSecretKeyEncrypted: bytea('minio_secret_key_encrypted'),
  minioAccessKeyHint: text('minio_access_key_hint'),

  lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
  lastTestedProvider: text('last_tested_provider'),
  lastTestError: text('last_test_error'),

  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedById: uuid('updated_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
});

// =====================================================================
// 0096 — Support knowledge base. Firm-scoped so a firm's edits stay
// local; product articles are seeded with is_system=true (editable but
// flagged). The AI support chat retrieves PUBLISHED articles to ground
// its answers.
// =====================================================================

export const kbArticleStatus = pgEnum('kb_article_status', ['DRAFT', 'PUBLISHED', 'ARCHIVED']);

// 0113 — which realm an article is visible to. Default 'staff' keeps
// content internal unless an admin exposes it to the client portal.
export const kbAudience = pgEnum('kb_audience', ['staff', 'client', 'both']);

export const kbCategories = pgTable(
  'kb_category',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmSlugUk: uniqueIndex('kb_category_firm_slug_uk').on(t.firmId, t.slug),
  }),
);

export const kbArticles = pgTable(
  'kb_article',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').references(() => kbCategories.id, { onDelete: 'set null' }),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    summary: text('summary'),
    bodyMarkdown: text('body_markdown').notNull(),
    tags: text('tags').array(),
    status: kbArticleStatus('status').notNull().default('PUBLISHED'),
    // 0113 — realm visibility; default 'staff' so nothing leaks to clients.
    audience: kbAudience('audience').notNull().default('staff'),
    isSystem: boolean('is_system').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    updatedById: uuid('updated_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmSlugUk: uniqueIndex('kb_article_firm_slug_uk').on(t.firmId, t.slug),
    firmCategoryIdx: index('kb_article_firm_category_idx').on(t.firmId, t.categoryId),
    firmStatusIdx: index('kb_article_firm_status_idx').on(t.firmId, t.status),
    firmAudienceIdx: index('kb_article_firm_audience_idx').on(t.firmId, t.audience),
  }),
);

// =====================================================================
// 0103 — Document Intake (INTAKE_ADDENDUM). Anonymous-friendly public
// document intake routed into existing clients/engagements/folders.
// PII + content columns are MFK-wrapped: each record carries a per-record
// DEK (wrapped_dek) that encrypts its *_enc columns. See
// apps/api/src/intake/crypto.ts.
// =====================================================================

// One row per staff member who can appear on the public intake grid.
export const intakeStaffCards = pgTable(
  'intake_staff_cards',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    isVisible: boolean('is_visible').notNull().default(false), // admin-controlled
    displayOrder: integer('display_order').notNull().default(0), // admin-controlled
    acceptingUploads: boolean('accepting_uploads').notNull().default(true), // staff
    displayTitle: text('display_title'), // staff
    headshotObjectKey: text('headshot_object_key'), // staff
    notifyEmail: boolean('notify_email').notNull().default(true),
    notifySms: boolean('notify_sms').notNull().default(false),
    notifyInApp: boolean('notify_in_app').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmUserUk: uniqueIndex('intake_staff_cards_firm_user_uk').on(t.firmId, t.userId),
    firmVisibleIdx: index('intake_staff_cards_firm_visible_idx').on(t.firmId, t.isVisible),
  }),
);

// Tokenized "send-a-link" records (reuses the argon2 token + deliverShare
// pattern from sharing/file-share-helper.ts).
export const intakeLinks = pgTable(
  'intake_links',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    targetStaffId: uuid('target_staff_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    wrappedDek: bytea('wrapped_dek'),
    recipientEmailEnc: bytea('recipient_email_enc'),
    recipientPhoneEnc: bytea('recipient_phone_enc'),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmIdx: index('intake_links_firm_idx').on(t.firmId),
  }),
);

// One row per client intake event.
export const intakeSessions = pgTable(
  'intake_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    targetStaffId: uuid('target_staff_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    wrappedDek: bytea('wrapped_dek').notNull(),
    clientNameEnc: bytea('client_name_enc'),
    clientEmailEnc: bytea('client_email_enc'),
    clientPhoneEnc: bytea('client_phone_enc'),
    messageEnc: bytea('message_enc'),
    // Plaintext flag (no PII): lets the anonymous "complete" step accept a
    // message-only submission (no files) without decrypting message_enc.
    hasMessage: boolean('has_message').notNull().default(false),
    source: text('source').notNull().default('public'),
    linkTokenId: uuid('link_token_id').references(() => intakeLinks.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('pending_scan'),
    matchedClientId: uuid('matched_client_id').references(() => clients.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmStatusIdx: index('intake_sessions_firm_status_idx').on(t.firmId, t.status),
    targetStaffIdx: index('intake_sessions_target_staff_idx').on(t.targetStaffId),
    sourceCk: check('intake_sessions_source_ck', sql`${t.source} IN ('public', 'tokenized_link')`),
    statusCk: check(
      'intake_sessions_status_ck',
      sql`${t.status} IN ('pending_scan', 'processing', 'received', 'disposed', 'rejected')`,
    ),
  }),
);

// Uploaded files within a session (stored under the quarantine key prefix
// until the scan worker clears them).
export const intakeFiles = pgTable(
  'intake_files',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => intakeSessions.id, { onDelete: 'cascade' }),
    originalFilenameEnc: bytea('original_filename_enc'),
    objectKey: text('object_key').notNull(),
    mimeType: text('mime_type'),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    kind: text('kind').notNull().default('upload'),
    scanStatus: text('scan_status').notNull().default('pending'),
    assembledPdfObjectKey: text('assembled_pdf_object_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionIdx: index('intake_files_session_idx').on(t.sessionId),
    kindCk: check('intake_files_kind_ck', sql`${t.kind} IN ('upload', 'scan')`),
    scanStatusCk: check(
      'intake_files_scan_status_ck',
      sql`${t.scanStatus} IN ('pending', 'clean', 'infected')`,
    ),
  }),
);

// Disposition / action trail.
export const intakeActions = pgTable(
  'intake_actions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => intakeSessions.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    targetClientId: uuid('target_client_id').references(() => clients.id, { onDelete: 'set null' }),
    targetEngagementId: uuid('target_engagement_id').references(() => engagements.id, {
      onDelete: 'set null',
    }),
    targetFolderId: uuid('target_folder_id').references(() => clientFolders.id, {
      onDelete: 'set null',
    }),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionIdx: index('intake_actions_session_idx').on(t.sessionId),
    actionCk: check(
      'intake_actions_action_ck',
      sql`${t.action} IN ('move', 'assign', 'review', 'archive', 'reject', 'leave')`,
    ),
  }),
);

// =====================================================================
// ach_returns (Phase 22) — ACH return / late-failure dispute ledger.
// One row per ACH return Stripe reports; drives mandate invalidation,
// payment-method blocking, and dunning halt decisions.
// =====================================================================

export const achReturns = pgTable(
  'ach_returns',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'set null' }),
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    stripePaymentIntentId: text('stripe_payment_intent_id'),
    stripeChargeId: text('stripe_charge_id'),
    stripePaymentMethodId: text('stripe_payment_method_id'),
    returnCode: text('return_code').notNull(),
    category: text('category').notNull(), // INSUFFICIENT_FUNDS | NO_AUTHORIZATION | ACCOUNT_ERROR | OTHER
    retriable: boolean('retriable').notNull().default(false),
    invalidatedMandate: boolean('invalidated_mandate').notNull().default(false),
    blockedPaymentMethod: boolean('blocked_payment_method').notNull().default(false),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull().default(0),
    feeCents: bigint('fee_cents', { mode: 'number' }).notNull().default(0),
    // 'failure' (return during processing) | 'dispute' (late failure).
    source: text('source').notNull().default('failure'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmIdx: index('ach_returns_firm_idx').on(t.firmId, t.createdAt),
    piIdx: index('ach_returns_pi_idx').on(t.stripePaymentIntentId),
  }),
);

// =====================================================================
// Stripe Terminal (Phase 15) — in-person card readers per firm. Location
// + Reader live on the firm's connected account; we store the pointers.
// =====================================================================

export const terminalLocations = pgTable(
  'terminal_locations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    stripeLocationId: text('stripe_location_id').notNull(),
    displayName: text('display_name').notNull(),
    addressLine1: text('address_line1'),
    addressCity: text('address_city'),
    addressState: text('address_state'),
    addressPostal: text('address_postal'),
    addressCountry: text('address_country').notNull().default('US'),
    cellularEnabled: boolean('cellular_enabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmIdx: index('terminal_locations_firm_idx').on(t.firmId),
  }),
);

export const terminalReaders = pgTable(
  'terminal_readers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => terminalLocations.id, { onDelete: 'cascade' }),
    stripeReaderId: text('stripe_reader_id').notNull(),
    label: text('label').notNull(),
    deviceType: text('device_type'),
    serialNumber: text('serial_number'),
    status: text('status').notNull().default('offline'), // online | offline
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmIdx: index('terminal_readers_firm_idx').on(t.firmId),
    stripeIdx: index('terminal_readers_stripe_idx').on(t.stripeReaderId),
  }),
);

// 0175 — background-job admin. Appliance-global (jobs aren't firm-scoped).
// job_schedule toggles a job on/off (+ optional cron override); job_run is the
// per-execution history the worker writes.
export const jobSchedule = pgTable('job_schedule', {
  jobName: text('job_name').primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
  cronOverride: text('cron_override'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const jobRun = pgTable(
  'job_run',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jobName: text('job_name').notNull(),
    // running | completed | failed | skipped
    status: text('status').notNull(),
    itemCount: integer('item_count'),
    error: text('error'),
    triggeredBy: text('triggered_by'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    jobIdx: index('job_run_job_idx').on(t.jobName, t.startedAt),
  }),
);
