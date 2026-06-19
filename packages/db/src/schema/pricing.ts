// SPDX-License-Identifier: Elastic-2.0
//
// AI pricing suggestion (migration 0178). Two tables:
//   - economic_index: cached CPI/ECI figures (live source + as-of date) so the
//     economic factor is auditable and survives a fetch outage.
//   - pricing_decision: per-engagement suggestion + the CPA's accept/edit/
//     override, with the full inputs snapshot (audit-only for v1).

import {
  bigint,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { appUsers, engagements, firms } from './core';

export const economicIndexes = pgTable(
  'economic_index',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    // 'CPI' | 'ECI'
    source: text('source').notNull(),
    // trailing-12-month percent change, e.g. 3.20
    valuePct: numeric('value_pct', { precision: 6, scale: 3 }).notNull(),
    // the index reference period the figure is "as of"
    asOfDate: date('as_of_date').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmSourceIdx: index('economic_index_firm_source_idx').on(t.firmId, t.source, t.fetchedAt),
  }),
);

export const pricingDecisions = pgTable(
  'pricing_decision',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),

    // Full engine inputs/outputs snapshot (cohort, tiers, rates, factor, range).
    inputsJson: jsonb('inputs_json').$type<Record<string, unknown>>().notNull().default({}),
    suggestedLowCents: bigint('suggested_low_cents', { mode: 'number' }).notNull(),
    suggestedHighCents: bigint('suggested_high_cents', { mode: 'number' }).notNull(),
    suggestedRationale: text('suggested_rationale'),
    rationaleSource: text('rationale_source'), // 'AI' | 'TEMPLATE'
    economicSource: text('economic_source'), // MANUAL|CPI|ECI
    economicAsOf: date('economic_as_of'),
    confidence: text('confidence'), // LOW|MEDIUM|HIGH

    // The CPA's decision.
    userAction: text('user_action').notNull().default('PENDING'), // PENDING|ACCEPTED|EDITED|OVERRIDDEN
    finalLowCents: bigint('final_low_cents', { mode: 'number' }),
    finalHighCents: bigint('final_high_cents', { mode: 'number' }),
    decidedByAppUserId: uuid('decided_by_app_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),

    createdByAppUserId: uuid('created_by_app_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    engagementIdx: index('pricing_decision_engagement_idx').on(t.engagementId, t.createdAt),
    firmIdx: index('pricing_decision_firm_idx').on(t.firmId, t.createdAt),
  }),
);
