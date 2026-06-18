// SPDX-License-Identifier: Elastic-2.0
//
// BK-1 — Appointment booking relational tables. The firm-managed
// `appointment_type` library, the booking enums, and the additive
// `appointment` columns live in core.ts (alongside the 0073 appointment
// table) to avoid a circular import; this file holds the tables that
// fan OUT from an appointment:
//   * appointment_staff       — one row per staff member (multi-staff)
//   * appointment_participant — invited client contacts (RSVP)
//   * appointment_reschedule_request — client-initiated reschedule asks
//   * appointment_engagement_note    — booking ↔ auto-note link
//   * staff_availability       — per-staff weekly hours
//   * staff_booking_settings   — per-staff buffers/notice/increment

import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import {
  appUsers,
  appointmentLocationOptions,
  appointmentRsvpStatus,
  appointmentTypes,
  appointments,
  clientContacts,
  engagementNotes,
  engagements,
  firms,
  persons,
  providerWriteStatus,
  rescheduleRequestStatus,
} from './core';
import { calendarEvents } from './calendar';

// One row per staff member per appointment. calendar_event_id is the TB
// calendar_events mirror row (drives update/delete via
// CalendarWriteService); provider_event_id/calendar_id are the
// provider's own handles, stored for reference.
export const appointmentStaff = pgTable(
  'appointment_staff',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointments.id, { onDelete: 'cascade' }),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    calendarEventId: uuid('calendar_event_id').references(() => calendarEvents.id, {
      onDelete: 'set null',
    }),
    providerEventId: text('provider_event_id'),
    providerCalendarId: text('provider_calendar_id'),
    providerWriteStatus: providerWriteStatus('provider_write_status').notNull().default('pending'),
    providerWriteError: text('provider_write_error'),
    writtenAt: timestamp('written_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    apptStaffUk: uniqueIndex('appointment_staff_appt_staff_uk').on(t.appointmentId, t.staffId),
    apptIdx: index('appointment_staff_appt_idx').on(t.appointmentId),
    staffApptIdx: index('appointment_staff_staff_appt_idx').on(t.staffId, t.appointmentId),
  }),
);

export const appointmentParticipants = pgTable(
  'appointment_participant',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointments.id, { onDelete: 'cascade' }),
    clientContactId: uuid('client_contact_id')
      .notNull()
      .references(() => clientContacts.id, { onDelete: 'cascade' }),
    rsvpStatus: appointmentRsvpStatus('rsvp_status').notNull().default('pending'),
    confirmationSentAt: timestamp('confirmation_sent_at', { withTimezone: true }),
    cancellationSentAt: timestamp('cancellation_sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    apptContactUk: uniqueIndex('appointment_participant_appt_contact_uk').on(
      t.appointmentId,
      t.clientContactId,
    ),
    apptIdx: index('appointment_participant_appt_idx').on(t.appointmentId),
  }),
);

export const appointmentRescheduleRequests = pgTable(
  'appointment_reschedule_request',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointments.id, { onDelete: 'cascade' }),
    requestedByContactId: uuid('requested_by_contact_id').references(() => clientContacts.id, {
      onDelete: 'set null',
    }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    message: text('message'),
    status: rescheduleRequestStatus('status').notNull().default('pending'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedByStaffId: uuid('resolved_by_staff_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
  },
  (t) => ({
    apptIdx: index('appointment_reschedule_request_appt_idx').on(t.appointmentId),
    statusIdx: index('appointment_reschedule_request_status_idx').on(t.status),
  }),
);

export const appointmentEngagementNotes = pgTable(
  'appointment_engagement_note',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointments.id, { onDelete: 'cascade' }),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    noteId: uuid('note_id')
      .notNull()
      .references(() => engagementNotes.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    apptIdx: index('appointment_engagement_note_appt_idx').on(t.appointmentId),
  }),
);

export const staffAvailability = pgTable(
  'staff_availability',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    dayOfWeek: integer('day_of_week').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    // 0120 — allowed meeting location types for this window (e.g.
    // ['IN_PERSON']). NULL/empty = all locations allowed.
    locationTypes: text('location_types').array(),
    // 0144 — optional location preset for this window. When a slot in this
    // window is booked, the appointment defaults to this location.
    locationOptionId: uuid('location_option_id').references(() => appointmentLocationOptions.id, {
      onDelete: 'set null',
    }),
    // 0156 — allowed appointment types for this window (appointment_type
    // ids). NULL/empty = all types allowed.
    appointmentTypeIds: uuid('appointment_type_ids').array(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    staffDowIdx: index('staff_availability_staff_dow_idx').on(t.staffId, t.dayOfWeek),
    dowCk: check('staff_availability_dow_ck', sql`${t.dayOfWeek} BETWEEN 0 AND 6`),
  }),
);

export const staffBookingSettings = pgTable(
  'staff_booking_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    bufferBeforeMinutes: integer('buffer_before_minutes').notNull().default(0),
    bufferAfterMinutes: integer('buffer_after_minutes').notNull().default(0),
    minNoticeHours: integer('min_notice_hours').notNull().default(1),
    slotIncrementMinutes: integer('slot_increment_minutes').notNull().default(30),
    bookingEnabled: boolean('booking_enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    staffUk: uniqueIndex('staff_booking_settings_staff_uk').on(t.staffId),
  }),
);

// BK-7 — in-app staff notification center (written from BK-4/BK-5).
export const staffNotifications = pgTable(
  'staff_notification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    recipientAppUserId: uuid('recipient_app_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    title: text('title').notNull(),
    body: text('body'),
    actionUrl: text('action_url'),
    status: text('status').notNull().default('UNREAD'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => ({
    recipientStatusIdx: index('staff_notification_recipient_status_idx').on(
      t.recipientAppUserId,
      t.status,
    ),
    entityIdx: index('staff_notification_entity_idx').on(t.entityType, t.entityId),
    createdIdx: index('staff_notification_created_idx').on(t.createdAt),
  }),
);

// Reminder idempotency ledger (one row per appointment × contact × offset).
export const appointmentRemindersSent = pgTable(
  'appointment_reminders_sent',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointments.id, { onDelete: 'cascade' }),
    clientContactId: uuid('client_contact_id').references(() => clientContacts.id, {
      onDelete: 'cascade',
    }),
    reminderOffsetMinutes: integer('reminder_offset_minutes').notNull(),
    // 0121 — EMAIL | SMS | CALL; part of the idempotency key.
    channel: text('channel').notNull().default('EMAIL'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    deliveryStatus: text('delivery_status').notNull().default('sent'),
  },
  (t) => ({
    uniq: uniqueIndex('appointment_reminders_sent_uk').on(
      t.appointmentId,
      t.clientContactId,
      t.reminderOffsetMinutes,
      t.channel,
    ),
    apptIdx: index('appointment_reminders_sent_appt_idx').on(t.appointmentId),
  }),
);

export type StaffNotification = typeof staffNotifications.$inferSelect;

// BK-8 — v2 client self-booking public links (stub; feature-gated).
export const staffPublicBookingLinks = pgTable(
  'staff_public_booking_link',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    allowedAppointmentTypeIds: jsonb('allowed_appointment_type_ids'),
    customMessage: text('custom_message'),
    // 0168 — request→confirm settings. Page-level booking rules (mirror
    // staff_booking_settings) + the slot-hold window + abuse controls.
    holdExpiryHours: integer('hold_expiry_hours').notNull().default(72),
    slotIncrementMinutes: integer('slot_increment_minutes').notNull().default(30),
    minNoticeHours: integer('min_notice_hours').notNull().default(1),
    bufferBeforeMinutes: integer('buffer_before_minutes').notNull().default(0),
    bufferAfterMinutes: integer('buffer_after_minutes').notNull().default(0),
    defaultDurationMinutes: integer('default_duration_minutes').notNull().default(30),
    requireCaptcha: boolean('require_captcha').notNull().default(true),
    dailyCap: integer('daily_cap'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugUk: uniqueIndex('staff_public_booking_link_slug_uk').on(t.slug),
    staffIdx: index('staff_public_booking_link_staff_idx').on(t.staffId),
  }),
);

// 0168 — the page's OWN weekly availability windows (mirrors
// staffAvailability but scoped to a booking link, not a staff member).
export const publicBookingAvailability = pgTable(
  'public_booking_availability',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingLinkId: uuid('booking_link_id')
      .notNull()
      .references(() => staffPublicBookingLinks.id, { onDelete: 'cascade' }),
    dayOfWeek: integer('day_of_week').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    // 0169 — allowed contact types for this window (VIDEO/PHONE/IN_PERSON).
    // NULL/empty = all allowed (mirrors staff_availability.location_types).
    locationTypes: text('location_types').array(),
    locationOptionId: uuid('location_option_id').references(() => appointmentLocationOptions.id, {
      onDelete: 'set null',
    }),
    appointmentTypeIds: uuid('appointment_type_ids').array(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    linkDowIdx: index('public_booking_availability_link_dow_idx').on(t.bookingLinkId, t.dayOfWeek),
    dowCk: check('public_booking_availability_dow_ck', sql`${t.dayOfWeek} BETWEEN 0 AND 6`),
  }),
);

// 0168 — staff who may approve a request for this page.
export const publicBookingLinkApprovers = pgTable(
  'public_booking_link_approver',
  {
    bookingLinkId: uuid('booking_link_id')
      .notNull()
      .references(() => staffPublicBookingLinks.id, { onDelete: 'cascade' }),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.bookingLinkId, t.appUserId] }),
  }),
);

// 0168 — staff to notify of a new request (separate from approvers).
export const publicBookingLinkNotify = pgTable(
  'public_booking_link_notify',
  {
    bookingLinkId: uuid('booking_link_id')
      .notNull()
      .references(() => staffPublicBookingLinks.id, { onDelete: 'cascade' }),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    channels: text('channels')
      .array()
      .notNull()
      .default(sql`'{EMAIL}'`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.bookingLinkId, t.appUserId] }),
  }),
);

// 0168 — the pending booking request. A PENDING, non-expired row is the
// slot HOLD (counted as busy by the availability engine). The appointment
// is only created when a staff approver confirms.
export const bookingRequests = pgTable(
  'booking_request',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    bookingLinkId: uuid('booking_link_id').references(() => staffPublicBookingLinks.id, {
      onDelete: 'set null',
    }),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    appointmentTypeId: uuid('appointment_type_id').references(() => appointmentTypes.id, {
      onDelete: 'set null',
    }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    visitorName: text('visitor_name').notNull(),
    visitorEmail: text('visitor_email').notNull(),
    visitorPhone: text('visitor_phone'),
    notes: text('notes'),
    // 0169 — the visitor's chosen meeting location (type + optional preset),
    // carried onto the appointment on approval.
    location: text('location'),
    locationOptionId: uuid('location_option_id').references(() => appointmentLocationOptions.id, {
      onDelete: 'set null',
    }),
    locationDetail: text('location_detail'),
    personId: uuid('person_id').references(() => persons.id, { onDelete: 'set null' }),
    clientContactId: uuid('client_contact_id').references(() => clientContacts.id, {
      onDelete: 'set null',
    }),
    status: text('status', {
      enum: ['PENDING', 'APPROVED', 'DECLINED', 'EXPIRED', 'CANCELLED'],
    })
      .notNull()
      .default('PENDING'),
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }).notNull(),
    decidedByAppUserId: uuid('decided_by_app_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    declineReason: text('decline_reason'),
    createdAppointmentId: uuid('created_appointment_id').references(() => appointments.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    staffStatusStartsIdx: index('booking_request_staff_status_starts_idx').on(
      t.staffId,
      t.status,
      t.startsAt,
    ),
    firmStatusIdx: index('booking_request_firm_status_idx').on(t.firmId, t.status),
    holdExpiryIdx: index('booking_request_hold_expiry_idx').on(t.status, t.holdExpiresAt),
  }),
);

export type AppointmentStaff = typeof appointmentStaff.$inferSelect;
export type NewAppointmentStaff = typeof appointmentStaff.$inferInsert;
export type AppointmentParticipant = typeof appointmentParticipants.$inferSelect;
export type AppointmentRescheduleRequest = typeof appointmentRescheduleRequests.$inferSelect;
export type StaffAvailability = typeof staffAvailability.$inferSelect;
export type StaffBookingSettings = typeof staffBookingSettings.$inferSelect;
export type StaffPublicBookingLink = typeof staffPublicBookingLinks.$inferSelect;
export type PublicBookingAvailability = typeof publicBookingAvailability.$inferSelect;
export type BookingRequest = typeof bookingRequests.$inferSelect;
export type NewBookingRequest = typeof bookingRequests.$inferInsert;
