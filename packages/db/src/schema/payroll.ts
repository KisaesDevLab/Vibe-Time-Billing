// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Payroll timekeeping (migration 0226). Accrual policies + assignments,
// the append-only time_off_ledger (credits only — usage is derived live
// from time entries whose work code carries a payroll bank category, so
// entry edits/archives self-correct balances), materialized pay periods
// with per-employee approval, and the time-off request workflow.

import {
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { appUsers, firms, timeEntries } from './core';

export type TimeOffBank = 'PTO' | 'SICK' | 'COMP';
export type AccrualMethod = 'FIXED_PER_PERIOD' | 'PER_HOURS_WORKED' | 'ANNUAL_GRANT';
export type AnnualGrantTiming = 'CALENDAR_YEAR' | 'ANNIVERSARY';
export type TimeOffLedgerReason =
  | 'ACCRUAL'
  | 'GRANT'
  | 'COMP_EARNED'
  | 'CARRYOVER_FORFEIT'
  | 'ADJUSTMENT';
export type PayPeriodStatus = 'OPEN' | 'LOCKED';
export type TimeOffRequestStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'CANCELLED';
export type TimeOffRequestKind = 'PTO' | 'SICK' | 'COMP' | 'UNPAID';

// One policy per bank; assigned per employee. method decides which rate
// columns apply: FIXED_PER_PERIOD → hoursPerPeriod; PER_HOURS_WORKED →
// earnHours per perWorkedHours (e.g. 1 per 30); ANNUAL_GRANT →
// annualGrantHours at annualGrantTiming. Tenure tiers override the
// method's primary rate at ≥ minYearsService.
export const accrualPolicies = pgTable(
  'accrual_policy',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    bank: text('bank').$type<TimeOffBank>().notNull(),
    name: text('name').notNull(),
    method: text('method').$type<AccrualMethod>().notNull(),
    hoursPerPeriod: numeric('hours_per_period', { precision: 6, scale: 2 }),
    earnHours: numeric('earn_hours', { precision: 6, scale: 2 }),
    perWorkedHours: numeric('per_worked_hours', { precision: 6, scale: 2 }),
    annualGrantHours: numeric('annual_grant_hours', { precision: 6, scale: 2 }),
    annualGrantTiming: text('annual_grant_timing').$type<AnnualGrantTiming | null>(),
    // Days after hired_date before accrual starts / usage is allowed.
    accrualWaitingDays: integer('accrual_waiting_days').notNull().default(0),
    usageWaitingDays: integer('usage_waiting_days').notNull().default(0),
    // NULL = no ceiling. Accrual clamps so balance never exceeds this.
    maxBalanceHours: numeric('max_balance_hours', { precision: 7, scale: 2 }),
    // NULL = unlimited carryover. Jan-1 job forfeits the excess.
    carryoverCapHours: numeric('carryover_cap_hours', { precision: 7, scale: 2 }),
    status: text('status').$type<'ACTIVE' | 'ARCHIVED'>().notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmIdx: index('accrual_policy_firm_idx').on(t.firmId, t.bank),
  }),
);

export const accrualPolicyTiers = pgTable(
  'accrual_policy_tier',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    policyId: uuid('policy_id')
      .notNull()
      .references(() => accrualPolicies.id, { onDelete: 'cascade' }),
    minYearsService: integer('min_years_service').notNull(),
    rateHours: numeric('rate_hours', { precision: 6, scale: 2 }).notNull(),
  },
  (t) => ({
    policyTierUnique: uniqueIndex('accrual_policy_tier_policy_id_min_years_service_key').on(
      t.policyId,
      t.minYearsService,
    ),
  }),
);

// bank is denormalized from the policy so the one-active-assignment rule
// can be a plain partial unique index.
export const accrualPolicyAssignments = pgTable(
  'accrual_policy_assignment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    policyId: uuid('policy_id')
      .notNull()
      .references(() => accrualPolicies.id, { onDelete: 'cascade' }),
    bank: text('bank').$type<TimeOffBank>().notNull(),
    effectiveDate: date('effective_date').notNull().defaultNow(),
    endDate: date('end_date'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    policyIdx: index('accrual_assignment_policy_idx').on(t.policyId),
  }),
);

// Append-only credit ledger. delta_hours signed: ACCRUAL/GRANT/COMP_EARNED
// positive, CARRYOVER_FORFEIT negative, ADJUSTMENT either. period_key
// makes job writes idempotent ('PP:<pay_period_id>', 'ANNUAL:2026',
// 'ANNIV:2026', 'CY:2026'); manual rows leave it NULL. created_by NULL =
// system job. UPDATE/DELETE blocked by trigger (0226).
export const timeOffLedger = pgTable(
  'time_off_ledger',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    bank: text('bank').$type<TimeOffBank>().notNull(),
    entryDate: date('entry_date').notNull().defaultNow(),
    deltaHours: numeric('delta_hours', { precision: 7, scale: 2 }).notNull(),
    reason: text('reason').$type<TimeOffLedgerReason>().notNull(),
    policyId: uuid('policy_id').references(() => accrualPolicies.id, { onDelete: 'set null' }),
    payPeriodId: uuid('pay_period_id'),
    periodKey: text('period_key'),
    note: text('note').notNull().default(''),
    createdByAppUserId: uuid('created_by_app_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userBankIdx: index('time_off_ledger_user_bank_idx').on(t.appUserId, t.bank, t.entryDate),
    firmIdx: index('time_off_ledger_firm_idx').on(t.firmId, t.createdAt),
  }),
);

// Materialized periods (generated on demand + nightly, next 3 kept ahead).
// LOCKED freezes every time entry dated inside the range for all users —
// enforced in createTimeEntryCore / PATCH / DELETE, distinct from the
// billing locked_at/billing_batch_id concepts.
export const payPeriods = pgTable(
  'pay_period',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    status: text('status').$type<PayPeriodStatus>().notNull().default('OPEN'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedByAppUserId: uuid('locked_by_app_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmStartUnique: uniqueIndex('pay_period_firm_id_start_date_key').on(t.firmId, t.startDate),
    firmStatusIdx: index('pay_period_firm_status_idx').on(t.firmId, t.status, t.endDate),
  }),
);

// Per-employee sign-off within a period, plus OT→comp conversion hours
// (reduces reported OT without mutating entries).
export const payPeriodEmployees = pgTable(
  'pay_period_employee',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    payPeriodId: uuid('pay_period_id')
      .notNull()
      .references(() => payPeriods.id, { onDelete: 'cascade' }),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedByAppUserId: uuid('approved_by_app_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    compConvertedHours: numeric('comp_converted_hours', { precision: 6, scale: 2 })
      .notNull()
      .default('0'),
    // 0227 — per-employee totals frozen at period lock; LOCKED periods
    // serve review/exports from this instead of recomputing live.
    totalsSnapshot: jsonb('totals_snapshot').$type<Record<string, unknown> | null>(),
    note: text('note').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    periodUserUnique: uniqueIndex('pay_period_employee_pay_period_id_app_user_id_key').on(
      t.payPeriodId,
      t.appUserId,
    ),
    userIdx: index('pay_period_employee_user_idx').on(t.appUserId),
  }),
);

export const timeOffRequests = pgTable(
  'time_off_request',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<TimeOffRequestKind>().notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    totalHours: numeric('total_hours', { precision: 6, scale: 2 }).notNull(),
    status: text('status').$type<TimeOffRequestStatus>().notNull().default('PENDING'),
    note: text('note').notNull().default(''),
    approverAppUserId: uuid('approver_app_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmStatusIdx: index('time_off_request_firm_status_idx').on(t.firmId, t.status, t.startDate),
    userIdx: index('time_off_request_user_idx').on(t.appUserId, t.createdAt),
  }),
);

// Per-day hour rows; time_entry_id set on approval (one ordinary entry
// per day, created through createTimeEntryCore on the firm-admin
// engagement with the kind's seeded work code).
export const timeOffRequestDays = pgTable(
  'time_off_request_day',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => timeOffRequests.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    hours: numeric('hours', { precision: 5, scale: 2 }).notNull(),
    timeEntryId: uuid('time_entry_id').references(() => timeEntries.id, { onDelete: 'set null' }),
  },
  (t) => ({
    requestDayUnique: uniqueIndex('time_off_request_day_request_id_day_key').on(t.requestId, t.day),
  }),
);
