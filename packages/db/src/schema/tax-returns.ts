// SPDX-License-Identifier: Elastic-2.0
//
// Drizzle schema for the Vibe T&B Tax-Return Module (Phase TR-1).
//
// Mirrors `packages/db/migrations/0075_tax_return_module.sql`. Both
// files must be edited together when the schema changes.

import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appUsers, clients, engagements, files, firms } from './core';

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return 'bytea';
  },
});

// =====================================================================
// ENUMS
// =====================================================================

export const taxReturnStatus = pgEnum('tax_return_status', [
  'DRAFT',
  'PARSED',
  'REVIEW',
  'APPROVED',
  'RELEASED',
  'SUPERSEDED',
]);

export const taxReleaseKind = pgEnum('tax_release_kind', ['ORIGINAL', 'AMENDED', 'SUPERSEDED']);

export const taxSectionKind = pgEnum('tax_section_kind', [
  'COVER',
  'MAIN_FORM',
  'SCHEDULE',
  'K1',
  'STATE',
  'WORKSHEET',
  'ATTACHMENT',
  'UNKNOWN',
]);

export const taxReleaseScope = pgEnum('tax_release_scope', ['FULL', 'SELECTED']);

export const taxShareStatus = pgEnum('tax_share_status', ['SENT', 'VIEWED', 'EXPIRED', 'REVOKED']);

export const taxShareVerifyChannel = pgEnum('tax_share_verify_channel', ['SMS', 'EMAIL', 'NONE']);

export const taxAccessActorKind = pgEnum('tax_access_actor_kind', [
  'CLIENT',
  'STAFF',
  'RECIPIENT',
  'SYSTEM',
]);

export const taxAccessEvent = pgEnum('tax_access_event', [
  'PARSED',
  'RELEASED',
  'REVOKED',
  'VIEW',
  'DOWNLOAD',
  'PAGE_RENDER',
  '2FA_SENT',
  '2FA_PASSED',
  '2FA_FAILED',
  'EXPIRED',
  'SUPERSEDED',
  'SECTION_EDITED',
  // 0136 — client-initiated 3rd-party share (distinct from staff RELEASED).
  'SHARED',
]);

// =====================================================================
// tax_returns
// =====================================================================

export const taxReturns = pgTable(
  'tax_returns',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    engagementId: uuid('engagement_id').references(() => engagements.id, {
      onDelete: 'set null',
    }),
    taxYear: integer('tax_year').notNull(),
    formCode: text('form_code').notNull(),
    jurisdiction: text('jurisdiction').notNull().default('federal'),
    title: text('title').notNull(),
    status: taxReturnStatus('status').notNull().default('DRAFT'),
    releaseKind: taxReleaseKind('release_kind').notNull().default('ORIGINAL'),
    // Self-reference enforced by migration ALTER; we keep the column
    // loose here to avoid the recursive type binding.
    amendsReturnId: uuid('amends_return_id'),
    filedAt: timestamp('filed_at', { withTimezone: true }),
    refundOrOwedCents: bigint('refund_or_owed_cents', { mode: 'number' }),
    sourceFileId: uuid('source_file_id').references(() => files.id, {
      onDelete: 'restrict',
    }),
    sourceFileSha256: text('source_file_sha256'),
    totalPages: integer('total_pages'),
    parsedAt: timestamp('parsed_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedByUserId: uuid('released_by_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    wrappedDek: bytea('wrapped_dek'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmStatusIdx: index('tax_returns_firm_status_idx').on(t.firmId, t.status),
    clientYearIdx: index('tax_returns_client_year_idx').on(t.clientId, t.taxYear),
    yearRange: check('tax_returns_tax_year_range', sql`${t.taxYear} BETWEEN 1900 AND 2999`),
    totalPagesPos: check(
      'tax_returns_total_pages_pos',
      sql`${t.totalPages} IS NULL OR ${t.totalPages} > 0`,
    ),
  }),
);

// =====================================================================
// tax_return_sections
// =====================================================================

export const taxReturnSections = pgTable(
  'tax_return_sections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    returnId: uuid('return_id')
      .notNull()
      .references(() => taxReturns.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    parentSectionId: uuid('parent_section_id'),
    depth: smallint('depth').notNull().default(0),
    rawTitle: text('raw_title').notNull(),
    normalizedTitle: text('normalized_title').notNull(),
    kind: taxSectionKind('kind').notNull().default('UNKNOWN'),
    formCode: text('form_code'),
    recipientName: text('recipient_name'),
    recipientTinLast4: text('recipient_tin_last4'),
    startPage: integer('start_page').notNull(),
    endPage: integer('end_page').notNull(),
    releasable: boolean('releasable').notNull().default(true),
    pageSha256: text('page_sha256'),
    parseConfidence: smallint('parse_confidence').notNull().default(100),
    isManualOverride: boolean('is_manual_override').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    returnOrdinalUk: uniqueIndex('tax_return_sections_return_ordinal_uk').on(t.returnId, t.ordinal),
    returnIdx: index('tax_return_sections_return_idx').on(t.returnId, t.startPage),
    kindIdx: index('tax_return_sections_kind_idx').on(t.returnId, t.kind),
    pageRange: check(
      'tax_return_sections_page_range',
      sql`${t.startPage} > 0 AND ${t.endPage} >= ${t.startPage}`,
    ),
  }),
);

// =====================================================================
// tax_return_releases
// =====================================================================

export const taxReturnReleases = pgTable(
  'tax_return_releases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    returnId: uuid('return_id')
      .notNull()
      .references(() => taxReturns.id, { onDelete: 'cascade' }),
    releasedToClientId: uuid('released_to_client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    scope: taxReleaseScope('scope').notNull().default('FULL'),
    sectionIds: uuid('section_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    clientCanDownload: boolean('client_can_download').notNull().default(true),
    coverNote: text('cover_note'),
    releasedByUserId: uuid('released_by_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'restrict' }),
    releasedAt: timestamp('released_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: uuid('revoked_by_user_id'),
  },
  (t) => ({
    returnIdx: index('tax_return_releases_return_idx').on(t.returnId),
    clientIdx: index('tax_return_releases_client_idx').on(t.releasedToClientId),
  }),
);

// =====================================================================
// tax_return_shares
// =====================================================================

export const taxReturnShares = pgTable(
  'tax_return_shares',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    returnId: uuid('return_id')
      .notNull()
      .references(() => taxReturns.id, { onDelete: 'cascade' }),
    releaseId: uuid('release_id')
      .notNull()
      .references(() => taxReturnReleases.id, { onDelete: 'cascade' }),
    // 0102 — exactly one initiator: a portal client access OR a staff user.
    sharedByAccessId: uuid('shared_by_access_id'),
    sharedByAppUserId: uuid('shared_by_app_user_id'),
    recipientName: text('recipient_name').notNull(),
    recipientEmail: text('recipient_email').notNull(),
    recipientPhone: text('recipient_phone'),
    organization: text('organization').notNull().default(''),
    role: text('role').notNull(),
    accessLevel: text('access_level').notNull().default('view_only'),
    scope: taxReleaseScope('scope').notNull().default('SELECTED'),
    sectionIds: uuid('section_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    require2fa: boolean('require_2fa').notNull().default(true),
    verifyChannel: taxShareVerifyChannel('verify_channel').notNull().default('EMAIL'),
    watermark: boolean('watermark').notNull().default(true),
    tokenHash: text('token_hash').notNull(),
    wrappedDek: bytea('wrapped_dek'),
    personalMessage: text('personal_message').notNull().default(''),
    status: taxShareStatus('status').notNull().default('SENT'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    firstViewedAt: timestamp('first_viewed_at', { withTimezone: true }),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    viewCount: integer('view_count').notNull().default(0),
    failed2faCount: integer('failed_2fa_count').notNull().default(0),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByAccessId: uuid('revoked_by_access_id'),
  },
  (t) => ({
    tokenHashUk: uniqueIndex('tax_return_shares_token_hash_uk').on(t.tokenHash),
    returnIdx: index('tax_return_shares_return_idx').on(t.returnId, t.status),
    releaseIdx: index('tax_return_shares_release_idx').on(t.releaseId),
  }),
);

// =====================================================================
// tax_return_access_log
// =====================================================================

export const taxReturnAccessLog = pgTable(
  'tax_return_access_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    returnId: uuid('return_id')
      .notNull()
      .references(() => taxReturns.id, { onDelete: 'cascade' }),
    shareId: uuid('share_id').references(() => taxReturnShares.id, {
      onDelete: 'set null',
    }),
    actorKind: taxAccessActorKind('actor_kind').notNull(),
    actorRef: text('actor_ref'),
    actorIp: text('actor_ip'),
    actorUserAgent: text('actor_user_agent'),
    event: taxAccessEvent('event').notNull(),
    pageNumber: integer('page_number'),
    sectionId: uuid('section_id').references(() => taxReturnSections.id, {
      onDelete: 'set null',
    }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    returnAtIdx: index('tax_return_access_log_return_at_idx').on(t.returnId, t.at),
    shareIdx: index('tax_return_access_log_share_idx').on(t.shareId, t.at),
    eventIdx: index('tax_return_access_log_event_idx').on(t.event, t.at),
  }),
);
