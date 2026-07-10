// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Drizzle schema for the Vibe Filer module (document inbox & routing).
// Mirrors packages/db/migrations/0137_filer.sql — edit both together.

import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appUsers, clients, firms } from './core';

// Workqueue cache — upserted on each inbox scan; rows removed once routed.
export const inboxItems = pgTable(
  'inbox_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    objectKey: text('object_key').notNull(),
    originalName: text('original_name').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    etag: text('etag'),
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
    parsedName: text('parsed_name'),
    parsedId: text('parsed_id'),
    parsedYear: integer('parsed_year'),
    matchStatus: text('match_status').notNull().default('unparseable'),
    matchedClient: uuid('matched_client').references(() => clients.id, { onDelete: 'set null' }),
    suggestedRule: uuid('suggested_rule'),
    suggestedPath: text('suggested_path'),
    reviewAction: text('review_action'),
    overrideFolder: text('override_folder'),
    overrideYear: integer('override_year'),
    flagFormCode: text('flag_form_code'),
    flagTaxYear: integer('flag_tax_year'),
    included: boolean('included').notNull().default(true),
    reviewedBy: uuid('reviewed_by').references(() => appUsers.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    objectKeyUk: uniqueIndex('inbox_items_object_key_uk').on(t.firmId, t.objectKey),
    firmIdx: index('inbox_items_firm_idx').on(t.firmId, t.matchStatus),
    matchStatusCk: check(
      'inbox_items_match_status_ck',
      sql`${t.matchStatus} IN ('matched','fuzzy','inactive','name_mismatch','year_needed','folder_unbound','unparseable')`,
    ),
    reviewActionCk: check(
      'inbox_items_review_action_ck',
      sql`${t.reviewAction} IS NULL OR ${t.reviewAction} IN ('file','flag_tax','skip','file_flag_tax')`,
    ),
  }),
);

export const inboxRoutingProfiles = pgTable(
  'inbox_routing_profiles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmIdx: index('inbox_routing_profiles_firm_idx').on(t.firmId),
  }),
);

export const inboxRoutingRules = pgTable(
  'inbox_routing_rules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => inboxRoutingProfiles.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
    name: text('name').notNull(),
    identifier: text('identifier').notNull().default(''),
    matchMode: text('match_mode').notNull().default('contains'),
    caseSensitive: boolean('case_sensitive').notNull().default(false),
    targetPath: text('target_path').notNull().default(''),
    yearBehavior: text('year_behavior').notNull().default('none'),
    isTaxReturn: boolean('is_tax_return').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    notes: text('notes'),
  },
  (t) => ({
    profileIdx: index('inbox_routing_rules_profile_idx').on(t.profileId, t.sortOrder),
    matchModeCk: check(
      'inbox_routing_rules_match_mode_ck',
      sql`${t.matchMode} IN ('contains','starts_with','regex')`,
    ),
    yearBehaviorCk: check(
      'inbox_routing_rules_year_behavior_ck',
      sql`${t.yearBehavior} IN ('none','current_only','current_and_next','previous')`,
    ),
  }),
);

// Immutable history / undo source. Append-only except the flip to
// 'reversed' on undo.
export const inboxRoutingLog = pgTable(
  'inbox_routing_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    batchId: uuid('batch_id').notNull(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    objectKeyFrom: text('object_key_from').notNull(),
    objectKeyTo: text('object_key_to'),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
    folderPath: text('folder_path'),
    action: text('action').notNull(),
    ruleId: uuid('rule_id'),
    routedFileId: uuid('routed_file_id'),
    taxJobId: uuid('tax_job_id'),
    taxReturnId: uuid('tax_return_id'),
    userId: uuid('user_id').references(() => appUsers.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('success'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    batchIdx: index('inbox_routing_log_batch_idx').on(t.batchId),
    firmAtIdx: index('inbox_routing_log_firm_at_idx').on(t.firmId, t.createdAt),
    fromIdx: index('inbox_routing_log_from_idx').on(t.firmId, t.objectKeyFrom),
    actionCk: check(
      'inbox_routing_log_action_ck',
      sql`${t.action} IN ('filed','tax_flagged','skipped','failed')`,
    ),
    statusCk: check(
      'inbox_routing_log_status_ck',
      sql`${t.status} IN ('success','reversed','error')`,
    ),
  }),
);

// =====================================================================
// 0153 — zip imports: upload a client document export (.zip), match
// the client from the zip name, pick a destination folder, extract in
// the worker. Per-entry outcomes (imported / skipped / error) live in
// `results` JSONB. Mirrors 0153_zip_imports.sql — edit both together.
// =====================================================================

export interface ZipImportResultEntry {
  path: string;
  status: 'imported' | 'skipped' | 'error';
  detail?: string;
}

export const zipImports = pgTable(
  'zip_imports',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    zipName: text('zip_name').notNull(),
    zipKey: text('zip_key').notNull(),
    zipSizeBytes: bigint('zip_size_bytes', { mode: 'number' }).notNull().default(0),
    matchedClient: uuid('matched_client').references(() => clients.id, { onDelete: 'set null' }),
    destFolder: text('dest_folder'),
    // draft -> queued -> running -> done | error
    status: text('status').notNull().default('draft'),
    totalEntries: integer('total_entries'),
    importedCount: integer('imported_count'),
    skippedCount: integer('skipped_count'),
    errorCount: integer('error_count'),
    results: jsonb('results').$type<ZipImportResultEntry[]>(),
    error: text('error'),
    createdBy: uuid('created_by').references(() => appUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmCreatedIdx: index('zip_imports_firm_created_idx').on(t.firmId, t.createdAt),
  }),
);
