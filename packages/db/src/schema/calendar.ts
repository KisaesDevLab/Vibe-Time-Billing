// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// 0109 — Calendar Integration (CAL-1…CAL-9). Per-staff OAuth into Microsoft
// 365 / Google Calendar, poll-only read ingest of appointments, two-tier
// client matching, reminders + RSVP, and time-entry suggestions.
//
// Secrets at rest (provider client secrets, OAuth access/refresh tokens) use
// the firm-MFK per-record-DEK envelope (XChaCha20-Poly1305) — each row holds
// a `t_dek_wrapped` (the row DEK wrapped by the firm master key) and the
// `*_enc` columns are ciphertext under that DEK. Mirrors intake/messaging.
// (The addendum says "AES-256-GCM"; we use the appliance's real envelope
// crypto, which is the MFK pattern it points at.)

import {
  boolean,
  check,
  customType,
  doublePrecision,
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

import { appUsers, clientContacts, clients, firms } from './core';

// PG bytea for encrypted columns + wrapped DEKs.
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return 'bytea';
  },
});

// CAL-3 — firm-level sync tunables (one row per firm).
export const calendarSettings = pgTable(
  'calendar_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    syncIntervalMinutes: integer('sync_interval_minutes').notNull().default(15),
    lookbackDays: integer('lookback_days').notNull().default(7),
    lookaheadDays: integer('lookahead_days').notNull().default(90),
    // CAL-7 — reminder offsets in minutes before start (default 1d + 2h).
    reminderOffsetsMinutes: jsonb('reminder_offsets_minutes').notNull().default([1440, 120]),
    // 0121 — quiet hours for SMS/voice reminders (HH:MM wall-clock, firm/office tz).
    reminderQuietStart: text('reminder_quiet_start').notNull().default('08:00'),
    reminderQuietEnd: text('reminder_quiet_end').notNull().default('20:00'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmUk: uniqueIndex('calendar_settings_firm_uk').on(t.firmId),
  }),
);

// CAL-7 — ledger of reminders already dispatched (idempotency per
// event × contact × offset).
export const calendarRemindersSent = pgTable(
  'calendar_reminders_sent',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => calendarEvents.id, { onDelete: 'cascade' }),
    clientContactId: uuid('client_contact_id').references(() => clientContacts.id, {
      onDelete: 'cascade',
    }),
    reminderOffsetMinutes: integer('reminder_offset_minutes').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    deliveryStatus: text('delivery_status').notNull().default('sent'),
    rsvpTokenId: uuid('rsvp_token_id'),
  },
  (t) => ({
    uniq: uniqueIndex('calendar_reminders_sent_uk').on(
      t.eventId,
      t.clientContactId,
      t.reminderOffsetMinutes,
    ),
  }),
);

// CAL-1 — firm-level OAuth app registration per provider (admin-entered).
export const calendarProviderConfig = pgTable(
  'calendar_provider_config',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    tDekWrapped: bytea('t_dek_wrapped').notNull(),
    clientIdEnc: bytea('client_id_enc').notNull(),
    clientSecretEnc: bytea('client_secret_enc').notNull(),
    tenantIdEnc: bytea('tenant_id_enc'), // M365 only
    enabled: boolean('enabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmProviderUk: uniqueIndex('calendar_provider_config_firm_provider_uk').on(
      t.firmId,
      t.provider,
    ),
    providerCk: check(
      'calendar_provider_config_provider_ck',
      sql`${t.provider} IN ('microsoft','google')`,
    ),
  }),
);

// CAL-2 — a staff member's OAuth connection to one provider account.
export const staffCalendarConnections = pgTable(
  'staff_calendar_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    tDekWrapped: bytea('t_dek_wrapped').notNull(),
    accessTokenEnc: bytea('access_token_enc').notNull(),
    refreshTokenEnc: bytea('refresh_token_enc'),
    tokenExpiry: timestamp('token_expiry', { withTimezone: true }),
    scope: text('scope'),
    providerUserId: text('provider_user_id'),
    providerEmail: text('provider_email'),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    syncError: text('sync_error'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    staffProviderUk: uniqueIndex('staff_calendar_connections_staff_provider_uk').on(
      t.staffId,
      t.provider,
    ),
    firmIdx: index('staff_calendar_connections_firm_idx').on(t.firmId),
    providerCk: check(
      'staff_calendar_connections_provider_ck',
      sql`${t.provider} IN ('microsoft','google')`,
    ),
  }),
);

// CAL-2 — which of a connection's calendars to sync.
export const staffCalendarSelections = pgTable(
  'staff_calendar_selections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => staffCalendarConnections.id, { onDelete: 'cascade' }),
    calendarId: text('calendar_id').notNull(),
    calendarName: text('calendar_name').notNull(),
    color: text('color'),
    isPrimary: boolean('is_primary').notNull().default(false),
    syncEnabled: boolean('sync_enabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    connCalUk: uniqueIndex('staff_calendar_selections_conn_cal_uk').on(
      t.connectionId,
      t.calendarId,
    ),
  }),
);

// CAL-3 — ingested appointments (read-only pull in v1).
export const calendarEvents = pgTable(
  'calendar_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    staffId: uuid('staff_id').references(() => appUsers.id, { onDelete: 'set null' }),
    connectionId: uuid('connection_id').references(() => staffCalendarConnections.id, {
      onDelete: 'set null',
    }),
    providerEventId: text('provider_event_id').notNull(),
    calendarId: text('calendar_id'),
    subject: text('subject'),
    bodyPreview: text('body_preview'),
    startAt: timestamp('start_at', { withTimezone: true }),
    endAt: timestamp('end_at', { withTimezone: true }),
    location: text('location'),
    isAllDay: boolean('is_all_day').notNull().default(false),
    organizerEmail: text('organizer_email'),
    organizerName: text('organizer_name'),
    // [{ email, name, response_status }]
    attendees: jsonb('attendees'),
    icalUid: text('ical_uid'),
    webLink: text('web_link'),
    rawEtag: text('raw_etag'),
    // CAL-9 write-back stub: marks TB-originated events (vs ingested).
    tbOrigin: boolean('tb_origin').notNull().default(false),
    softDeletedAt: timestamp('soft_deleted_at', { withTimezone: true }),
    syncAt: timestamp('sync_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    connEventUk: uniqueIndex('calendar_events_conn_event_uk').on(t.connectionId, t.providerEventId),
    staffStartIdx: index('calendar_events_staff_start_idx').on(t.staffId, t.startAt),
    firmStartIdx: index('calendar_events_firm_start_idx').on(t.firmId, t.startAt),
  }),
);

// CAL-4 — client match per event (tiered). Usually one row; a multi-client
// exact-email collision may produce several pending rows.
export const calendarEventMatches = pgTable(
  'calendar_event_matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => calendarEvents.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
    matchTier: text('match_tier').notNull(),
    matchScore: doublePrecision('match_score'),
    matchStatus: text('match_status').notNull().default('pending'),
    matchedBy: uuid('matched_by').references(() => appUsers.id, { onDelete: 'set null' }),
    matchedAt: timestamp('matched_at', { withTimezone: true }),
    dismissedReason: text('dismissed_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    eventIdx: index('calendar_event_matches_event_idx').on(t.eventId),
    clientStatusIdx: index('calendar_event_matches_client_status_idx').on(
      t.clientId,
      t.matchStatus,
    ),
    tierCk: check(
      'calendar_event_matches_tier_ck',
      sql`${t.matchTier} IN ('exact_email','fuzzy_name','llm','manual','unmatched')`,
    ),
    statusCk: check(
      'calendar_event_matches_status_ck',
      sql`${t.matchStatus} IN ('confirmed','dismissed','pending')`,
    ),
  }),
);

// CAL-8 — post-appointment time-entry suggestion log (one per event).
export const staffTimeSuggestionLog = pgTable(
  'staff_time_suggestion_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => calendarEvents.id, { onDelete: 'cascade' }),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    suggestedAt: timestamp('suggested_at', { withTimezone: true }).notNull().defaultNow(),
    action: text('action').notNull().default('pending'),
    timeEntryId: uuid('time_entry_id'),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    snoozeCount: integer('snooze_count').notNull().default(0),
  },
  (t) => ({
    eventUk: uniqueIndex('staff_time_suggestion_log_event_uk').on(t.eventId),
    staffActionIdx: index('staff_time_suggestion_log_staff_action_idx').on(t.staffId, t.action),
    actionCk: check(
      'staff_time_suggestion_log_action_ck',
      sql`${t.action} IN ('pending','logged','dismissed','snoozed')`,
    ),
  }),
);

// CAL-6/CAL-7 — one-click RSVP token per (event, contact).
export const calendarRsvpTokens = pgTable(
  'calendar_rsvp_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => calendarEvents.id, { onDelete: 'cascade' }),
    clientContactId: uuid('client_contact_id').references(() => clientContacts.id, {
      onDelete: 'cascade',
    }),
    token: uuid('token').notNull().defaultRandom(),
    response: text('response'),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    // FK added in CAL-7 once calendar_reminders_sent exists.
    reminderId: uuid('reminder_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenUk: uniqueIndex('calendar_rsvp_tokens_token_uk').on(t.token),
    eventContactUk: uniqueIndex('calendar_rsvp_tokens_event_contact_uk').on(
      t.eventId,
      t.clientContactId,
    ),
    responseCk: check(
      'calendar_rsvp_tokens_response_ck',
      sql`${t.response} IS NULL OR ${t.response} IN ('confirmed','declined')`,
    ),
  }),
);
