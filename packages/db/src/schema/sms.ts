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
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { appUsers, firms } from './core';

// ----- Shared value types --------------------------------------------

export type SmsA2pStatus = 'unknown' | 'unregistered' | 'pending' | 'registered' | 'not_applicable';
export type SmsLineStatus = 'ACTIVE' | 'ARCHIVED';

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
