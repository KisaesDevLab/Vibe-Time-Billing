// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Drizzle schema for the Vibe T&B Retainer Addendum (Stage R0).
//
// Parallel to core.ts and portal.ts — lives in its own module so the
// retainer surface can be reviewed without scrolling through 3,000 lines
// of core.ts. Re-exported from the schema barrel.
//
// Companion migration: packages/db/migrations/0065_retainer_addendum.sql.
// The Drizzle definitions here mirror that migration. Both files must be
// edited together when the schema changes.
//
// Naming: the addendum doc says "service code"; this codebase uses
// `work_code`. Every "service" reference here maps to work_code_id.
//
// Coexistence with the unrelated pre-existing `engagement.retainer_locked_at`
// and `billing_batch.kind = 'RETAINER'` is intentional — those are NOT
// part of this feature. See migration header for the full coexistence
// table.

import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appUsers, clients, engagements, firms, invoices, timeEntries, workCodes } from './core';

// =====================================================================
// ENUMS
// =====================================================================

export const retainerTier = pgEnum('retainer_tier', ['TIER_1', 'TIER_2']);

export const retainerStatus = pgEnum('retainer_status', [
  'active',
  'exhausted',
  'expired',
  'void',
  // R7 — firm can self-disable an active retainer without voiding it.
  // Time entries route to WIP while paused. Resume flips back to active.
  'paused',
]);

export const returnType = pgEnum('return_type', ['1040', '1065', '1120', '1120S', '1041', '990']);

export const retainerOfferStatus = pgEnum('retainer_offer_status', [
  'pending',
  'pending_payment',
  'purchased',
  'declined',
  'expired',
]);

export const retainerLedgerKind = pgEnum('retainer_ledger_kind', [
  'ACTIVATION',
  'CONSUME',
  'REVERSE',
]);

// =====================================================================
// retainer_tier_config — per (firm, return_type, tier)
// =====================================================================

export const retainerTierConfigs = pgTable(
  'retainer_tier_config',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    returnType: returnType('return_type').notNull(),
    tier: retainerTier('tier').notNull(),
    name: text('name').notNull(),
    hours: numeric('hours', { precision: 8, scale: 2 }).notNull(),
    baseFeeCents: bigint('base_fee_cents', { mode: 'number' }).notNull().default(0),
    // Stored as basis points (0..10000 → 0%..100%). Mirrors the codebase
    // convention (engagement.rate_multiplier_bps). Core math primitive
    // consumes this directly without scale conversion.
    pctOfPrepFeeBps: integer('pct_of_prep_fee_bps').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmReturnTierUk: uniqueIndex('retainer_tier_config_firm_return_tier_uk').on(
      t.firmId,
      t.returnType,
      t.tier,
    ),
    hoursPositive: check('retainer_tier_config_hours_positive', sql`${t.hours} > 0`),
    baseFeeNonneg: check('retainer_tier_config_base_fee_nonneg', sql`${t.baseFeeCents} >= 0`),
    pctRange: check(
      'retainer_tier_config_pct_range',
      sql`${t.pctOfPrepFeeBps} BETWEEN 0 AND 10000`,
    ),
  }),
);

// =====================================================================
// retainer_tier_eligible_service — work-codes covered by a tier
// =====================================================================

export const retainerTierEligibleServices = pgTable(
  'retainer_tier_eligible_service',
  {
    tierConfigId: uuid('tier_config_id')
      .notNull()
      .references(() => retainerTierConfigs.id, { onDelete: 'cascade' }),
    workCodeId: uuid('work_code_id')
      .notNull()
      .references(() => workCodes.id, { onDelete: 'restrict' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tierConfigId, t.workCodeId] }),
  }),
);

// =====================================================================
// firm_retainer_settings — per-firm feature flag + cadence
// =====================================================================

export const firmRetainerSettings = pgTable(
  'firm_retainer_settings',
  {
    firmId: uuid('firm_id')
      .primaryKey()
      .references(() => firms.id, { onDelete: 'cascade' }),
    // Phase 14 #1 — master kill switch, defaults OFF until operator flips.
    featureEnabled: boolean('feature_enabled').notNull().default(false),
    // D13 — biller toggle default ON when the offer condition matches.
    defaultBillerToggleOn: boolean('default_biller_toggle_on').notNull().default(true),
    // D12 / D20 — portal window in days from invoice_date.
    offerWindowDays: integer('offer_window_days').notNull().default(60),
    // D11 — work codes that count toward prep-fee basis.
    prepFeeWorkCodeIds: jsonb('prep_fee_work_code_ids').$type<string[]>().notNull().default([]),
    // D17 — togglable reminder cadence (fixed days for v1: 0/30/55).
    notifyOnBill: boolean('notify_on_bill').notNull().default(true),
    notifyDay30: boolean('notify_day_30').notNull().default(true),
    notifyDay55: boolean('notify_day_55').notNull().default(true),
    // R6 — GL account mapping. NULL until configured.
    revenueGlAccount: text('revenue_gl_account'),
    offsetGlAccount: text('offset_gl_account'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    windowPositive: check('firm_retainer_settings_window_positive', sql`${t.offerWindowDays} > 0`),
  }),
);

// =====================================================================
// retainer_offer — created on tax-prep invoice (R2)
// =====================================================================

export const retainerOffers = pgTable(
  'retainer_offer',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'restrict' }),
    // Source tax-prep invoice that triggered this offer.
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    returnType: returnType('return_type').notNull(),
    taxYear: integer('tax_year').notNull(),
    prepFeeBasisCents: bigint('prep_fee_basis_cents', { mode: 'number' }).notNull(),
    tier1TierConfigId: uuid('tier_1_tier_config_id')
      .notNull()
      .references(() => retainerTierConfigs.id, { onDelete: 'restrict' }),
    tier2TierConfigId: uuid('tier_2_tier_config_id')
      .notNull()
      .references(() => retainerTierConfigs.id, { onDelete: 'restrict' }),
    tier1PriceCents: bigint('tier_1_price_cents', { mode: 'number' }).notNull(),
    tier2PriceCents: bigint('tier_2_price_cents', { mode: 'number' }).notNull(),
    // { "tier1": [workCodeId, ...], "tier2": [...] } when overridden.
    // Promoted to retainer_eligible_service at activation (D18).
    eligibilityOverridesJson: jsonb('eligibility_overrides_json').$type<{
      tier1?: string[];
      tier2?: string[];
    } | null>(),
    offerExpiresAt: timestamp('offer_expires_at', { withTimezone: true }).notNull(),
    status: retainerOfferStatus('status').notNull().default('pending'),
    purchasedTier: retainerTier('purchased_tier'),
    purchasedInvoiceId: uuid('purchased_invoice_id').references(() => invoices.id, {
      onDelete: 'restrict',
    }),
    purchasedAt: timestamp('purchased_at', { withTimezone: true }),
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    // BullMQ delayed-job ids (R4) — activation handler cancels them.
    reminderJobIds: jsonb('reminder_job_ids').$type<string[] | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sweepIdx: index('retainer_offer_sweep_idx').on(t.status, t.offerExpiresAt),
    invoiceIdx: index('retainer_offer_invoice_idx').on(t.invoiceId),
    engagementIdx: index('retainer_offer_engagement_idx').on(t.engagementId),
    pricesNonneg: check(
      'retainer_offer_prices_nonneg',
      sql`${t.tier1PriceCents} >= 0 AND ${t.tier2PriceCents} >= 0`,
    ),
    basisNonneg: check('retainer_offer_basis_nonneg', sql`${t.prepFeeBasisCents} >= 0`),
  }),
);

// =====================================================================
// retainer — activated retainer (R3 activation handler)
// =====================================================================

export const retainers = pgTable(
  'retainer',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'restrict' }),
    // R7 — both nullable so a firm can manually create a retainer
    // without going through the offer / portal-purchase chain. When
    // present, these point back to the offer + AR invoice that funded
    // the retainer; NULL means the firm activated it directly.
    offerId: uuid('offer_id').references(() => retainerOffers.id, { onDelete: 'restrict' }),
    purchaseInvoiceId: uuid('purchase_invoice_id').references(() => invoices.id, {
      onDelete: 'restrict',
    }),
    tier: retainerTier('tier').notNull(),
    returnType: returnType('return_type').notNull(),
    taxYear: integer('tax_year').notNull(),
    tierConfigId: uuid('tier_config_id')
      .notNull()
      .references(() => retainerTierConfigs.id, { onDelete: 'restrict' }),
    // Snapshot of tier_config.name at activation — keeps historical
    // display stable even if the firm renames the tier config later.
    name: text('name').notNull(),
    hoursPurchased: numeric('hours_purchased', { precision: 8, scale: 2 }).notNull(),
    hoursConsumed: numeric('hours_consumed', { precision: 8, scale: 2 }).notNull().default('0'),
    priceCents: bigint('price_cents', { mode: 'number' }).notNull(),
    // D5 — purchase_date = activating payment date.
    purchaseDate: date('purchase_date').notNull(),
    // D3 — COALESCE(extended_due_date, original_due_date) + 3 years,
    // frozen at activation per D23.
    expiryDate: date('expiry_date').notNull(),
    status: retainerStatus('status').notNull().default('active'),
    notes: text('notes'),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedById: uuid('voided_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
    voidedReason: text('voided_reason'),
    // R7 — pause bookkeeping. status='paused' means consumption is
    // disabled but the retainer hasn't been voided. Resume flips back.
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    pausedReason: text('paused_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // D2 — one retainer per engagement.
    engagementUk: uniqueIndex('retainer_engagement_uk').on(t.engagementId),
    sweepIdx: index('retainer_sweep_idx').on(t.status, t.expiryDate),
    clientStatusIdx: index('retainer_client_status_idx').on(t.clientId, t.status),
    // Phase 8 consumption must never write outside this range.
    hoursConsumedBounds: check(
      'retainer_hours_consumed_bounds',
      sql`${t.hoursConsumed} >= 0 AND ${t.hoursConsumed} <= ${t.hoursPurchased}`,
    ),
    hoursPurchasedPositive: check(
      'retainer_hours_purchased_positive',
      sql`${t.hoursPurchased} > 0`,
    ),
    priceNonneg: check('retainer_price_nonneg', sql`${t.priceCents} >= 0`),
  }),
);

// =====================================================================
// retainer_eligible_service — immutable snapshot at activation (D6)
// =====================================================================

export const retainerEligibleServices = pgTable(
  'retainer_eligible_service',
  {
    retainerId: uuid('retainer_id')
      .notNull()
      .references(() => retainers.id, { onDelete: 'cascade' }),
    workCodeId: uuid('work_code_id')
      .notNull()
      .references(() => workCodes.id, { onDelete: 'restrict' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.retainerId, t.workCodeId] }),
  }),
);

// =====================================================================
// retainer_ledger — append-only consumption log
// =====================================================================
// Never UPDATE or DELETE. Reversals insert a new row with kind='REVERSE'
// and negative hours_delta. hours_balance_after is the denormalized
// remaining-hours figure for ledger view rendering.

export const retainerLedger = pgTable(
  'retainer_ledger',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    retainerId: uuid('retainer_id')
      .notNull()
      .references(() => retainers.id, { onDelete: 'restrict' }),
    // Time entry that produced this row. NULL for ACTIVATION (seed)
    // and some REVERSE rows where the originating entry was deleted.
    timeEntryId: uuid('time_entry_id').references(() => timeEntries.id, {
      onDelete: 'restrict',
    }),
    kind: retainerLedgerKind('kind').notNull(),
    // Positive for CONSUME, negative for REVERSE, 0 for ACTIVATION seed.
    hoursDelta: numeric('hours_delta', { precision: 8, scale: 2 }).notNull(),
    // Snapshot of hours_purchased - hours_consumed AFTER this row.
    hoursBalanceAfter: numeric('hours_balance_after', { precision: 8, scale: 2 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdById: uuid('created_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
  },
  (t) => ({
    retainerCreatedIdx: index('retainer_ledger_retainer_created_idx').on(t.retainerId, t.createdAt),
  }),
);

// =====================================================================
// NOTE: engagement.{retainer_id, return_type, tax_year, original_due_date,
//                   extended_due_date} and
//       time_entry.{retainer_id, retainer_hours, billable_hours} are
// added by the 0065 migration but live on the existing tables in
// core.ts. Drizzle column declarations for those additions are folded
// into core.ts in this same R0 commit so the type surface stays correct.
// =====================================================================
