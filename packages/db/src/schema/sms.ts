// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Two-way SMS inbox (Twilio). Mirrors migrations 0233 (lines + firm
// settings) and 0234 (conversations, messages, media, templates). Both
// this file and the SQL must be edited together when the schema changes.
//
// Twilio credentials are NOT here — they stay in the existing
// firm_settings.sms_config_encrypted envelope (see
// apps/api/src/messaging/config.ts, TwilioConfig).

import { sql } from 'drizzle-orm';
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

import { bookingRequests } from './booking';
import {
  appUsers,
  appointments,
  clientContacts,
  clientRequests,
  clients,
  engagements,
  firms,
  intakeFiles,
  intakeSessions,
  persons,
} from './core';

// ----- Shared value types --------------------------------------------

export type SmsA2pStatus = 'unknown' | 'unregistered' | 'pending' | 'registered' | 'not_applicable';
export type SmsLineStatus = 'ACTIVE' | 'ARCHIVED';
export type SmsConversationStatus = 'open' | 'closed' | 'spam';
export type SmsLinkSource = 'none' | 'reply_context' | 'phone' | 'manual';
export type SmsDirection = 'inbound' | 'outbound';
export type SmsProviderStatus =
  | 'queued'
  | 'accepted'
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'undelivered'
  | 'failed'
  | 'received'
  | 'receiving'
  | 'canceled'
  | 'dead_letter';
export type SmsContextKind =
  | 'manual'
  | 'appointment_reminder'
  | 'booking'
  | 'client_request'
  | 'notification'
  | 'voice_fallback'
  | 'auto_reply'
  | 'inbound';
export type SmsIngestSource = 'webhook' | 'poll' | 'api';
export type SmsParsedIntent = 'confirm' | 'reschedule';
export type SmsMediaStatus = 'pending' | 'stored' | 'intake' | 'failed';
export type SmsTemplateScope = 'firm' | 'user';
export type SmsConsentSource = 'inbound' | 'booking' | 'portal' | 'verbal' | 'staff' | 'legacy';
export type SmsOptOutSource = 'inbound_stop' | 'provider_21610' | 'staff' | 'portal';
/** PII pattern flags set on message bodies (Phase 11). */
export type SmsRedactionFlag = 'ssn' | 'ein' | 'routing' | 'account' | 'card' | 'dob';

/** Operational health snapshot kept on firm_settings.sms_health. Sections
 *  are merge-written by whichever component observed them (webhook
 *  router, poll tick, send service) — never clobber a sibling section. */
export interface SmsHealth {
  webhook?: {
    lastInboundAt?: string | null;
    lastStatusAt?: string | null;
    gapDetectedAt?: string | null;
    missedSincePoll?: number;
    invalidSignature24h?: number;
    matchedBase?: string | null;
  };
  poll?: {
    lastAt?: string | null;
    lastOk?: boolean;
    lastError?: string | null;
    linesPolled?: number;
  };
  send?: {
    lastAt?: string | null;
    failures24h?: number;
    lastError?: string | null;
    deadLettered?: number;
  };
  media?: { pending?: number; failed24h?: number };
  a2p?: { status?: SmsA2pStatus; checkedAt?: string | null };
  lines?: { autoDiscovered?: string[] };
}

// ----- 0233 — sms_line -----------------------------------------------
//
// One row per phone number in the firm's Twilio Messaging Service.
// `ingest` controls whether inbound texts to that number land in the
// inbox; `is_default` picks the line used for outbound-initiated sends
// when the caller doesn't specify one (D2a).

export const smsLines = pgTable(
  'sms_line',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    phoneNumberE164: text('phone_number_e164').notNull(),
    twilioSid: text('twilio_sid'),
    label: text('label'),
    defaultAssigneeUserId: uuid('default_assignee_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    ingest: boolean('ingest').notNull().default(true),
    isDefault: boolean('is_default').notNull().default(false),
    status: text('status').$type<SmsLineStatus>().notNull().default('ACTIVE'),
    pollCursorAt: timestamp('poll_cursor_at', { withTimezone: true }),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmNumberUk: uniqueIndex('sms_line_firm_number_uk').on(t.firmId, t.phoneNumberE164),
    defaultUk: uniqueIndex('sms_line_default_uk')
      .on(t.firmId)
      .where(sql`is_default = true`),
    firmIdx: index('sms_line_firm_idx').on(t.firmId, t.status),
    statusCk: check('sms_line_status_check', sql`${t.status} IN ('ACTIVE', 'ARCHIVED')`),
  }),
);

export type SmsLine = typeof smsLines.$inferSelect;
export type NewSmsLine = typeof smsLines.$inferInsert;

// ----- 0234 — sms_conversation ------------------------------------------
//
// One thread per (line, external number). Client/engagement links come
// from the association engine (link_source phone|reply_context) or staff
// (manual — never overridden by re-matching). unread_count is maintained
// by ingest/read endpoints; conversation unread == any inbound with
// read_at IS NULL (D5).

export const smsConversations = pgTable(
  'sms_conversation',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    lineId: uuid('line_id')
      .notNull()
      .references(() => smsLines.id, { onDelete: 'restrict' }),
    externalNumberE164: text('external_number_e164').notNull(),
    personId: uuid('person_id').references(() => persons.id, { onDelete: 'set null' }),
    clientContactId: uuid('client_contact_id').references(() => clientContacts.id, {
      onDelete: 'set null',
    }),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
    engagementId: uuid('engagement_id').references(() => engagements.id, {
      onDelete: 'set null',
    }),
    engagementSuggested: boolean('engagement_suggested').notNull().default(false),
    linkSource: text('link_source').$type<SmsLinkSource>().notNull().default('none'),
    needsTriage: boolean('needs_triage').notNull().default(false),
    candidatePersonIds: jsonb('candidate_person_ids').$type<string[]>().notNull().default([]),
    assignedUserId: uuid('assigned_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    status: text('status').$type<SmsConversationStatus>().notNull().default('open'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    lastOutboundAt: timestamp('last_outbound_at', { withTimezone: true }),
    unreadCount: integer('unread_count').notNull().default(0),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    lineNumberUk: uniqueIndex('sms_conversation_line_number_uk').on(t.lineId, t.externalNumberE164),
    firmLastIdx: index('sms_conversation_firm_last_idx').on(t.firmId, t.lastMessageAt),
    clientIdx: index('sms_conversation_client_idx')
      .on(t.clientId)
      .where(sql`client_id IS NOT NULL`),
    personIdx: index('sms_conversation_person_idx')
      .on(t.personId)
      .where(sql`person_id IS NOT NULL`),
    engagementIdx: index('sms_conversation_engagement_idx')
      .on(t.engagementId)
      .where(sql`engagement_id IS NOT NULL`),
    unreadIdx: index('sms_conversation_unread_idx')
      .on(t.firmId, t.assignedUserId)
      .where(sql`unread_count > 0`),
    numberIdx: index('sms_conversation_number_idx').on(t.firmId, t.externalNumberE164),
    statusCk: check(
      'sms_conversation_status_check',
      sql`${t.status} IN ('open', 'closed', 'spam')`,
    ),
    linkSourceCk: check(
      'sms_conversation_link_source_check',
      sql`${t.linkSource} IN ('none', 'reply_context', 'phone', 'manual')`,
    ),
  }),
);

export type SmsConversation = typeof smsConversations.$inferSelect;
export type NewSmsConversation = typeof smsConversations.$inferInsert;

// ----- 0234 — sms_message -----------------------------------------------

export const smsMessages = pgTable(
  'sms_message',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => smsConversations.id, { onDelete: 'cascade' }),
    direction: text('direction').$type<SmsDirection>().notNull(),
    fromE164: text('from_e164').notNull(),
    toE164: text('to_e164').notNull(),
    body: text('body').notNull().default(''),
    providerMessageId: text('provider_message_id'),
    providerStatus: text('provider_status').$type<SmsProviderStatus>().notNull().default('queued'),
    providerErrorCode: integer('provider_error_code'),
    providerErrorMessage: text('provider_error_message'),
    numSegments: integer('num_segments'),
    numMedia: integer('num_media').notNull().default(0),
    contextKind: text('context_kind').$type<SmsContextKind>().notNull().default('manual'),
    engagementId: uuid('engagement_id').references(() => engagements.id, {
      onDelete: 'set null',
    }),
    sentByUserId: uuid('sent_by_user_id').references(() => appUsers.id, { onDelete: 'set null' }),
    appointmentId: uuid('appointment_id').references(() => appointments.id, {
      onDelete: 'set null',
    }),
    bookingRequestId: uuid('booking_request_id').references(() => bookingRequests.id, {
      onDelete: 'set null',
    }),
    clientRequestId: uuid('client_request_id').references(() => clientRequests.id, {
      onDelete: 'set null',
    }),
    optOutType: text('opt_out_type'),
    parsedIntent: text('parsed_intent').$type<SmsParsedIntent>(),
    readAt: timestamp('read_at', { withTimezone: true }),
    readByUserId: uuid('read_by_user_id').references(() => appUsers.id, { onDelete: 'set null' }),
    redactionFlags: jsonb('redaction_flags').$type<SmsRedactionFlag[]>().notNull().default([]),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    deadLetteredAt: timestamp('dead_lettered_at', { withTimezone: true }),
    providerTimestamp: timestamp('provider_timestamp', { withTimezone: true }),
    ingestSource: text('ingest_source').$type<SmsIngestSource>().notNull().default('api'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    providerIdUk: uniqueIndex('sms_message_provider_id_uk')
      .on(t.providerMessageId)
      .where(sql`provider_message_id IS NOT NULL`),
    conversationIdx: index('sms_message_conversation_idx').on(t.conversationId, t.createdAt),
    replyCtxIdx: index('sms_message_reply_ctx_idx')
      .on(t.firmId, t.toE164, t.createdAt)
      .where(sql`direction = 'outbound'`),
    stuckIdx: index('sms_message_stuck_idx')
      .on(t.createdAt)
      .where(
        sql`direction = 'outbound' AND provider_status IN ('queued', 'accepted', 'sending', 'sent')`,
      ),
    unreadIdx: index('sms_message_unread_idx')
      .on(t.conversationId)
      .where(sql`direction = 'inbound' AND read_at IS NULL`),
    appointmentIdx: index('sms_message_appointment_idx')
      .on(t.appointmentId)
      .where(sql`appointment_id IS NOT NULL`),
    directionCk: check(
      'sms_message_direction_check',
      sql`${t.direction} IN ('inbound', 'outbound')`,
    ),
  }),
);

export type SmsMessage = typeof smsMessages.$inferSelect;
export type NewSmsMessage = typeof smsMessages.$inferInsert;

// ----- 0234 — sms_media -------------------------------------------------
//
// Inbound MMS attachments. Fetched from Twilio, stored under
// system/sms-media/… in the firm's object storage, handed to Document
// Intake (AI naming applies), then deleted from Twilio (D7).

export const smsMedia = pgTable(
  'sms_media',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => smsMessages.id, { onDelete: 'cascade' }),
    providerMediaSid: text('provider_media_sid'),
    providerMediaUrl: text('provider_media_url'),
    storageKey: text('storage_key'),
    contentType: text('content_type'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    sha256: text('sha256'),
    intakeSessionId: uuid('intake_session_id').references(() => intakeSessions.id, {
      onDelete: 'set null',
    }),
    intakeFileId: uuid('intake_file_id').references(() => intakeFiles.id, {
      onDelete: 'set null',
    }),
    status: text('status').$type<SmsMediaStatus>().notNull().default('pending'),
    remoteDeleted: boolean('remote_deleted').notNull().default(false),
    error: text('error'),
    attemptCount: integer('attempt_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    messageSidUk: uniqueIndex('sms_media_message_sid_uk').on(t.messageId, t.providerMediaSid),
    messageIdx: index('sms_media_message_idx').on(t.messageId),
    statusIdx: index('sms_media_status_idx').on(t.firmId, t.status),
  }),
);

export type SmsMedia = typeof smsMedia.$inferSelect;
export type NewSmsMedia = typeof smsMedia.$inferInsert;

// ----- 0234 — sms_template ----------------------------------------------
//
// Quick-reply library for the composer. Distinct from notification_template
// (event-driven, kind × channel): these are free-form snippets with
// {client_first} {engagement_name} {staff_first} {firm} placeholders.

export const smsTemplates = pgTable(
  'sms_template',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    scope: text('scope').$type<SmsTemplateScope>().notNull(),
    ownerUserId: uuid('owner_user_id').references(() => appUsers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    body: text('body').notNull(),
    variables: jsonb('variables').$type<string[]>().notNull().default([]),
    status: text('status').$type<'ACTIVE' | 'ARCHIVED'>().notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmIdx: index('sms_template_firm_idx').on(t.firmId, t.scope, t.ownerUserId),
    scopeCk: check('sms_template_scope_check', sql`${t.scope} IN ('firm', 'user')`),
  }),
);

export type SmsTemplate = typeof smsTemplates.$inferSelect;
export type NewSmsTemplate = typeof smsTemplates.$inferInsert;
