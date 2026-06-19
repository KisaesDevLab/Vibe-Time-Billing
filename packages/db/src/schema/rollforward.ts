// SPDX-License-Identifier: Elastic-2.0
//
// Tax-season rollforward (migration 0177). A batch generates next-year
// engagements (spine) + drop-off dates + dependent appointments from a
// prior-year window, reviewed as candidate rows, committed together.

import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  appointmentLocationOptions,
  appointments,
  appUsers,
  clients,
  engagements,
  engagementTypes,
  firms,
} from './core';

export const rollforwardBatches = pgTable(
  'rollforward_batch',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    sourceStart: date('source_start').notNull(),
    sourceEnd: date('source_end').notNull(),
    targetYear: integer('target_year').notNull(),
    mappingMode: text('mapping_mode').notNull().default('DEADLINE'), // DEADLINE | ISO_WEEK
    status: text('status').notNull().default('DRAFT'), // DRAFT | COMMITTED | CANCELLED
    idempotencyKey: text('idempotency_key'),
    createdByAppUserId: uuid('created_by_app_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmIdx: index('rollforward_batch_firm_idx').on(t.firmId, t.createdAt),
    idempotencyUk: uniqueIndex('rollforward_batch_idempotency_uk').on(t.idempotencyKey),
  }),
);

export const rollforwardEngagementCandidates = pgTable(
  'rollforward_engagement_candidate',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => rollforwardBatches.id, { onDelete: 'cascade' }),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    sourceEngagementId: uuid('source_engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    clientName: text('client_name').notNull(),
    returnType: text('return_type'),
    engagementTypeId: uuid('engagement_type_id').references(() => engagementTypes.id, {
      onDelete: 'set null',
    }),
    sourceDueDate: date('source_due_date'),
    suggestedDueDate: date('suggested_due_date'),
    sourceDropoffDate: date('source_dropoff_date'),
    suggestedDropoffDate: date('suggested_dropoff_date'),
    sourceFeeCents: bigint('source_fee_cents', { mode: 'number' }),
    suggestedFeeCents: bigint('suggested_fee_cents', { mode: 'number' }),
    status: text('status').notNull().default('PENDING'), // PENDING | APPROVED | SKIPPED | COMMITTED
    targetEngagementId: uuid('target_engagement_id').references(() => engagements.id, {
      onDelete: 'set null',
    }),
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    batchIdx: index('rollforward_eng_cand_batch_idx').on(t.batchId, t.status),
    sourceIdx: index('rollforward_eng_cand_source_idx').on(t.sourceEngagementId),
  }),
);

export const rollforwardAppointmentCandidates = pgTable(
  'rollforward_appointment_candidate',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => rollforwardBatches.id, { onDelete: 'cascade' }),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    engagementCandidateId: uuid('engagement_candidate_id')
      .notNull()
      .references(() => rollforwardEngagementCandidates.id, { onDelete: 'cascade' }),
    sourceAppointmentId: uuid('source_appointment_id').references(() => appointments.id, {
      onDelete: 'set null',
    }),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    staffIds: jsonb('staff_ids').notNull().default([]),
    sourceStartsAt: timestamp('source_starts_at', { withTimezone: true }),
    suggestedStartsAt: timestamp('suggested_starts_at', { withTimezone: true }),
    durationMinutes: integer('duration_minutes').notNull(),
    location: text('location'),
    locationOptionId: uuid('location_option_id').references(() => appointmentLocationOptions.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('PENDING'), // PENDING | APPROVED | SKIPPED | COMMITTED
    conflict: boolean('conflict').notNull().default(false),
    targetAppointmentId: uuid('target_appointment_id').references(() => appointments.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    batchIdx: index('rollforward_appt_cand_batch_idx').on(t.batchId, t.status),
    engIdx: index('rollforward_appt_cand_eng_idx').on(t.engagementCandidateId),
  }),
);
