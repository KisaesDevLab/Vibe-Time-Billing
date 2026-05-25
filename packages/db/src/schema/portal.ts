// =====================================================================
// packages/db/src/schema/portal.ts
//
// Portal schema for Vibe Time & Billing (Phase 16).
//
// Design notes:
//   - portal_identity is THE PERSON. Email and phone are contact methods
//     ON the identity, not the identity itself.
//   - client_portal_access is the many-to-many join. A single identity
//     can have access to multiple clients at the same firm. Switching
//     entities in the UI updates portal_session.active_client_id, which
//     scopes the API surface to that client at request time.
//   - Identity is scoped per firm (firm_id on portal_identity). Cross-firm
//     identity is explicitly out of scope per architecture principle 10.
//   - Email magic-link and SMS OTP are unified under one table
//     (portal_auth_challenge). They share the same lifecycle, retry,
//     and rate-limit logic; only the delivery channel differs.
//   - payment_method belongs to the IDENTITY, not the client. Lisa's
//     saved Visa works for all three of her entities — this is a
//     deliberate UX choice that the schema enables.
//
// References to tables outside this file:
//   - firms (./core.ts)
//   - clients (./core.ts)
//   - appUsers (./core.ts) — staff users; portal_identity is a separate
//     auth realm
//
// All TIMESTAMP columns use TIMESTAMPTZ via { withTimezone: true } per
// repository convention. All IDs are UUIDv4 (random) per convention.
// =====================================================================

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// External tables — imported from sibling schema files
import { firms, clients, appUsers } from './core';

// =====================================================================
// ENUMS
// =====================================================================

/**
 * Preferred login method. Both methods can be used if both contact
 * methods are verified; this is just what the UI suggests first.
 */
export const portalLoginMethod = pgEnum('portal_login_method', [
  'EMAIL',
  'SMS',
]);

/**
 * Role a portal_identity has against a specific client.
 *
 * - FULL:      view invoices, pay invoices, manage payment methods
 *              (within identity), configure auto-pay, see statements
 * - VIEW_ONLY: view invoices and statements; cannot pay
 * - PAY_ONLY:  view amounts and pay invoices; cannot see line-item
 *              detail or statements (used for treasurers / admin
 *              staff who handle payments without seeing engagement
 *              detail)
 */
export const portalAccessRole = pgEnum('portal_access_role', [
  'FULL',
  'VIEW_ONLY',
  'PAY_ONLY',
]);

/**
 * Lifecycle of a client_portal_access row.
 *
 * - INVITED:  invitation sent, not yet accepted (identity may not yet
 *             exist if this is a brand-new portal user)
 * - ACTIVE:   accepted, in use
 * - INACTIVE: revoked by firm or person; preserved for audit
 */
export const portalAccessStatus = pgEnum('portal_access_status', [
  'INVITED',
  'ACTIVE',
  'INACTIVE',
]);

/**
 * Channel kind used for auth challenges (email magic link or SMS OTP)
 * and for client-side notification preferences.
 */
export const portalChannel = pgEnum('portal_channel', ['EMAIL', 'SMS']);

/**
 * Lifecycle of an auth challenge or invitation token.
 *
 * - ACTIVE:  in flight, not yet consumed
 * - USED:    successfully consumed
 * - EXPIRED: time-bounded expiry passed without use
 * - REVOKED: explicitly invalidated (e.g., new challenge supersedes)
 */
export const tokenStatus = pgEnum('token_status', [
  'ACTIVE',
  'USED',
  'EXPIRED',
  'REVOKED',
]);

/**
 * Payment method kind.
 */
export const paymentMethodKind = pgEnum('payment_method_kind', [
  'CARD',
  'ACH',
]);

/**
 * Payment provider that holds the tokenized credential.
 */
export const paymentProvider = pgEnum('payment_provider', [
  'STRIPE',
  'CPACHARGE',
]);

/**
 * Payment method status.
 */
export const paymentMethodStatus = pgEnum('payment_method_status', [
  'ACTIVE',
  'EXPIRED',
  'REVOKED',
]);

// =====================================================================
// JSON COLUMN TYPES
// =====================================================================

/**
 * The set of events a portal_identity can be notified about, per their
 * client_portal_access row. Each event has zero or more channels.
 *
 * Channel semantics: each channel listed for an event means we send
 * that event to that channel. An empty array means "no notification".
 *
 * Defaults: see DEFAULT_NOTIFICATION_PREFERENCES below.
 */
export type NotificationPreferences = {
  newInvoice: PortalChannel[];
  paymentConfirmation: PortalChannel[];
  paymentFailed: PortalChannel[];
  documentReady: PortalChannel[];
  autoPayUpcoming: PortalChannel[];
  statementMonthly: PortalChannel[];
};

export type PortalChannel = 'EMAIL' | 'SMS';

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  newInvoice: ['EMAIL'],
  paymentConfirmation: ['EMAIL'],
  paymentFailed: ['EMAIL', 'SMS'], // urgency justifies dual channel
  documentReady: ['EMAIL'],
  autoPayUpcoming: [],
  statementMonthly: ['EMAIL'],
};

// =====================================================================
// TABLE: portal_identity
//
// The person. One row per human who can sign into the portal at this
// firm. Email and phone are stored here as contact methods. Either or
// both may be verified; at least one must be non-null (enforced by a
// CHECK constraint).
// =====================================================================

export const portalIdentity = pgTable(
  'portal_identity',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),

    fullName: text('full_name').notNull(),

    // Contact methods — at least one must be set (CHECK constraint).
    primaryEmail: text('primary_email'),
    primaryEmailVerifiedAt: timestamp('primary_email_verified_at', {
      withTimezone: true,
    }),

    primaryPhone: text('primary_phone'), // E.164 normalized, e.g. "+13125550148"
    primaryPhoneVerifiedAt: timestamp('primary_phone_verified_at', {
      withTimezone: true,
    }),

    // P4.3 — H.5 — TCPA SMS opt-in capture. We record the consent text
    // verbatim (so a later regulator can audit exactly what the user
    // agreed to), the version of the consent string we showed, and the
    // timestamp + IP when they agreed. Phone verification flows write
    // these alongside primaryPhoneVerifiedAt. NULL means "no SMS consent
    // on file" — the SMS provider must not deliver to this identity
    // until consent is captured.
    smsConsentText: text('sms_consent_text'),
    smsConsentVersion: text('sms_consent_version'),
    smsConsentAt: timestamp('sms_consent_at', { withTimezone: true }),
    smsConsentIp: text('sms_consent_ip'),

    preferredMethod: portalLoginMethod('preferred_method')
      .notNull()
      .default('EMAIL'),

    // Lifecycle
    status: text('status', { enum: ['ACTIVE', 'DISABLED'] })
      .notNull()
      .default('ACTIVE'),

    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    lastLoginChannel: portalChannel('last_login_channel'),
    lastLoginIp: text('last_login_ip'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Within a firm, an email or phone is unique. Postgres treats NULL
    // as distinct from any other NULL, so multiple identities can have
    // a NULL email or phone — but two identities cannot share the same
    // non-null value.
    firmEmailUnique: uniqueIndex('portal_identity_firm_email_uk').on(
      t.firmId,
      t.primaryEmail,
    ),
    firmPhoneUnique: uniqueIndex('portal_identity_firm_phone_uk').on(
      t.firmId,
      t.primaryPhone,
    ),

    // At least one contact method must be set.
    contactRequired: check(
      'portal_identity_contact_required',
      sql`${t.primaryEmail} IS NOT NULL OR ${t.primaryPhone} IS NOT NULL`,
    ),

    firmIdx: index('portal_identity_firm_idx').on(t.firmId),
  }),
);

// =====================================================================
// TABLE: portal_alt_contact
//
// Alternate (non-primary) contact addresses per identity. Each row holds
// its own verification state + OTP material. Added Phase 19 #22.
// =====================================================================

export const portalAltContact = pgTable(
  'portal_alt_contact',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    portalIdentityId: uuid('portal_identity_id')
      .notNull()
      .references(() => portalIdentity.id, { onDelete: 'cascade' }),

    channel: text('channel', { enum: ['EMAIL', 'SMS'] }).notNull(),
    value: text('value').notNull(),

    verifiedAt: timestamp('verified_at', { withTimezone: true }),

    otpHash: text('otp_hash'),
    otpExpiresAt: timestamp('otp_expires_at', { withTimezone: true }),
    otpAttempts: integer('otp_attempts').notNull().default(0),
    otpLastSentAt: timestamp('otp_last_sent_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    identityIdx: index('portal_alt_contact_identity_idx').on(t.portalIdentityId),
    uniqueTriplet: uniqueIndex('portal_alt_contact_unique').on(
      t.portalIdentityId,
      t.channel,
      t.value,
    ),
  }),
);

// =====================================================================
// TABLE: client_portal_access
//
// The join table between portal_identity and client. One row per
// (identity, client) pair. Notification preferences are per-access,
// so the same person can have different notification settings for
// different entities (Lisa wants email for the LLC, SMS for the trust).
// =====================================================================

export const clientPortalAccess = pgTable(
  'client_portal_access',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    portalIdentityId: uuid('portal_identity_id')
      .notNull()
      .references(() => portalIdentity.id, { onDelete: 'cascade' }),

    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),

    role: portalAccessRole('role').notNull().default('FULL'),

    // JSON to keep the schema stable as we add notification event types.
    notificationPreferences: jsonb('notification_preferences')
      .$type<NotificationPreferences>()
      .notNull()
      .default(DEFAULT_NOTIFICATION_PREFERENCES),

    status: portalAccessStatus('status').notNull().default('INVITED'),

    // Invitation provenance
    invitedBy: uuid('invited_by').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    invitedAt: timestamp('invited_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => appUsers.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Each identity has at most one access row per client. If the
    // person is removed and re-added, the same row is reactivated
    // (status returns to ACTIVE) — preserving the audit trail.
    identityClientUnique: uniqueIndex(
      'client_portal_access_identity_client_uk',
    ).on(t.portalIdentityId, t.clientId),

    clientIdx: index('client_portal_access_client_idx').on(t.clientId),
    statusIdx: index('client_portal_access_status_idx').on(t.status),
  }),
);

// =====================================================================
// TABLE: portal_session
//
// Active sessions. Carries active_client_id — the current entity the
// session is scoped to. Switching entities in the UI is a server-side
// mutation that updates this column and emits an audit event.
//
// Distinct from staff sessions: portal sessions live in their own
// table with their own cookie name, signing key, and expiry policy.
// A staff session is never valid in the portal and vice versa.
// =====================================================================

export const portalSession = pgTable(
  'portal_session',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    portalIdentityId: uuid('portal_identity_id')
      .notNull()
      .references(() => portalIdentity.id, { onDelete: 'cascade' }),

    // The currently-active entity for this session. Server-side enforcement
    // ensures (portal_identity_id, active_client_id) corresponds to a
    // row in client_portal_access with status = 'ACTIVE'.
    activeClientId: uuid('active_client_id')
      .notNull()
      .references(() => clients.id),

    // Opaque session token; we store only the hash.
    tokenHash: text('token_hash').notNull().unique(),

    ip: text('ip'),
    userAgent: text('user_agent'),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    identityIdx: index('portal_session_identity_idx').on(t.portalIdentityId),
    expiresIdx: index('portal_session_expires_idx').on(t.expiresAt),
    activityIdx: index('portal_session_activity_idx').on(t.lastActivityAt),
  }),
);

// =====================================================================
// TABLE: portal_invitation
//
// An invite sent from the firm side. Either email-delivered (magic
// link to accept) or SMS-delivered (link in SMS). Resolution to a
// portal_identity happens at accept time:
//   - If identity already exists for (firm_id, invited_email) or
//     (firm_id, invited_phone), link to existing identity and create
//     only a client_portal_access row.
//   - Otherwise, create new portal_identity and client_portal_access
//     together as an atomic operation.
// =====================================================================

export const portalInvitation = pgTable(
  'portal_invitation',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),

    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),

    // Nullable: if the firm invites someone who already has an
    // identity at this firm, we link immediately. Otherwise this
    // gets populated when the invite is accepted.
    portalIdentityId: uuid('portal_identity_id').references(
      () => portalIdentity.id,
      { onDelete: 'set null' },
    ),

    // The contact details proposed at invite time. Used to either
    // populate a new identity or match an existing one.
    invitedEmail: text('invited_email'),
    invitedPhone: text('invited_phone'), // E.164 normalized
    proposedFullName: text('proposed_full_name').notNull(),
    proposedRole: portalAccessRole('proposed_role').notNull().default('FULL'),
    proposedNotificationPreferences: jsonb('proposed_notification_preferences')
      .$type<NotificationPreferences>()
      .notNull()
      .default(DEFAULT_NOTIFICATION_PREFERENCES),

    deliveryChannel: portalChannel('delivery_channel').notNull(),

    tokenHash: text('token_hash').notNull().unique(),
    status: tokenStatus('status').notNull().default('ACTIVE'),

    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => appUsers.id),
    invitedAt: timestamp('invited_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    clientIdx: index('portal_invitation_client_idx').on(t.clientId),
    emailIdx: index('portal_invitation_email_idx').on(t.invitedEmail),
    phoneIdx: index('portal_invitation_phone_idx').on(t.invitedPhone),
    statusIdx: index('portal_invitation_status_idx').on(t.status),
    contactRequired: check(
      'portal_invitation_contact_required',
      sql`${t.invitedEmail} IS NOT NULL OR ${t.invitedPhone} IS NOT NULL`,
    ),
  }),
);

// =====================================================================
// TABLE: portal_auth_challenge
//
// Unified table for email magic links and SMS OTP codes. Both flows
// share lifecycle, rate limiting, attempt counting, and expiry — only
// the delivery channel and token format differ.
//
// For email: tokenHash hashes the full opaque link token (long random).
// For SMS:   tokenHash hashes the 6-digit code.
//
// We store hashes only; the clear-text token/code is never persisted.
// =====================================================================

export const portalAuthChallenge = pgTable(
  'portal_auth_challenge',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),

    channel: portalChannel('channel').notNull(),

    // Normalized contact value (email lowercased; phone E.164).
    contactValue: text('contact_value').notNull(),

    // For SMS this is the hash of the 6-digit code; for email this is
    // the hash of the long opaque token in the URL.
    tokenHash: text('token_hash').notNull().unique(),

    status: tokenStatus('status').notNull().default('ACTIVE'),

    // SMS-flow needs attempt counting. Email-flow ignores this.
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),

    ip: text('ip'),
    userAgent: text('user_agent'),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    contactStatusIdx: index('portal_auth_challenge_contact_status_idx').on(
      t.contactValue,
      t.status,
    ),
    expiresIdx: index('portal_auth_challenge_expires_idx').on(t.expiresAt),
    firmIdx: index('portal_auth_challenge_firm_idx').on(t.firmId),
  }),
);

// =====================================================================
// TABLE: payment_method
//
// Payment methods belong to the IDENTITY, not the client. This means
// Lisa's saved Visa is available when she pays an invoice for any of
// her three client entities. She manages payment methods once, in her
// profile, and they appear at every payment screen.
//
// We never store PAN or full account numbers — only the provider's
// token and a display-only "last four" for UX.
// =====================================================================

export const paymentMethod = pgTable(
  'payment_method',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    portalIdentityId: uuid('portal_identity_id')
      .notNull()
      .references(() => portalIdentity.id, { onDelete: 'cascade' }),

    kind: paymentMethodKind('kind').notNull(),
    provider: paymentProvider('provider').notNull(),

    // Tokenized credential from the provider. Opaque to us.
    providerToken: text('provider_token').notNull(),
    providerCustomerId: text('provider_customer_id'), // Stripe customer ID, CPACharge equivalent

    // Display fields — derived from provider response, never sensitive.
    lastFour: text('last_four').notNull(),
    displayLabel: text('display_label').notNull(), // e.g. "Visa ····3204"
    brand: text('brand'), // e.g. "Visa", "Mastercard", "Chase"
    expMonth: integer('exp_month'), // null for ACH
    expYear: integer('exp_year'),

    isDefault: boolean('is_default').notNull().default(false),
    status: paymentMethodStatus('status').notNull().default('ACTIVE'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    identityIdx: index('payment_method_identity_idx').on(t.portalIdentityId),
    // Application-level invariant: at most one default per identity.
    // Enforced by transaction logic rather than partial unique index
    // for portability.
    identityDefaultIdx: index('payment_method_identity_default_idx').on(
      t.portalIdentityId,
      t.isDefault,
    ),
    statusIdx: index('payment_method_status_idx').on(t.status),
  }),
);

// =====================================================================
// TABLE: portal_step_up_challenge (0064)
//
// Portal-side step-up verification. Different from the staff
// `step_up_verifications` table because portal challenges are not
// TOTP-only — the firm can configure ssn-last-4, ein, email-otp, or
// sms-otp. The middleware issues a challenge on access to a gated
// resource; the user completes it via the portal modal; success
// stamps completed_at and the session-scoped step-up TTL begins.
// =====================================================================

export const portalStepUpChallenge = pgTable(
  'portal_step_up_challenge',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    portalIdentityId: uuid('portal_identity_id')
      .notNull()
      .references(() => portalIdentity.id, { onDelete: 'cascade' }),
    activeClientId: uuid('active_client_id').references(() => clients.id, {
      onDelete: 'set null',
    }),
    challengeType: text('challenge_type', {
      enum: ['ssn-last-4', 'ein', 'email-otp', 'sms-otp'],
    }).notNull(),
    // sha256 hex of the OTP for email-otp / sms-otp; NULL for the
    // knowledge-factor variants (ssn / ein) where the comparison
    // happens against the client record.
    otpHash: text('otp_hash'),
    reason: text('reason'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => ({
    identityIdx: index('portal_step_up_challenge_identity_idx').on(
      t.portalIdentityId,
      t.issuedAt,
    ),
  }),
);

// =====================================================================
// RELATIONS
//
// Drizzle's relations() API enables type-safe joins via the query
// builder. These mirror the foreign keys defined above.
// =====================================================================

export const portalIdentityRelations = relations(portalIdentity, ({ one, many }) => ({
  firm: one(firms, {
    fields: [portalIdentity.firmId],
    references: [firms.id],
  }),
  accesses: many(clientPortalAccess),
  sessions: many(portalSession),
  paymentMethods: many(paymentMethod),
}));

export const clientPortalAccessRelations = relations(clientPortalAccess, ({ one }) => ({
  identity: one(portalIdentity, {
    fields: [clientPortalAccess.portalIdentityId],
    references: [portalIdentity.id],
  }),
  client: one(clients, {
    fields: [clientPortalAccess.clientId],
    references: [clients.id],
  }),
  invitedByUser: one(appUsers, {
    fields: [clientPortalAccess.invitedBy],
    references: [appUsers.id],
    relationName: 'invitedBy',
  }),
  revokedByUser: one(appUsers, {
    fields: [clientPortalAccess.revokedBy],
    references: [appUsers.id],
    relationName: 'revokedBy',
  }),
}));

export const portalSessionRelations = relations(portalSession, ({ one }) => ({
  identity: one(portalIdentity, {
    fields: [portalSession.portalIdentityId],
    references: [portalIdentity.id],
  }),
  activeClient: one(clients, {
    fields: [portalSession.activeClientId],
    references: [clients.id],
  }),
}));

export const portalInvitationRelations = relations(portalInvitation, ({ one }) => ({
  firm: one(firms, {
    fields: [portalInvitation.firmId],
    references: [firms.id],
  }),
  client: one(clients, {
    fields: [portalInvitation.clientId],
    references: [clients.id],
  }),
  identity: one(portalIdentity, {
    fields: [portalInvitation.portalIdentityId],
    references: [portalIdentity.id],
  }),
  invitedByUser: one(appUsers, {
    fields: [portalInvitation.invitedBy],
    references: [appUsers.id],
  }),
}));

export const paymentMethodRelations = relations(paymentMethod, ({ one }) => ({
  identity: one(portalIdentity, {
    fields: [paymentMethod.portalIdentityId],
    references: [portalIdentity.id],
  }),
}));

// =====================================================================
// INFERRED TYPES
//
// Use these throughout the application code so any schema change
// flows through to call sites at compile time.
// =====================================================================

export type PortalIdentity = typeof portalIdentity.$inferSelect;
export type NewPortalIdentity = typeof portalIdentity.$inferInsert;

export type ClientPortalAccess = typeof clientPortalAccess.$inferSelect;
export type NewClientPortalAccess = typeof clientPortalAccess.$inferInsert;

export type PortalSession = typeof portalSession.$inferSelect;
export type NewPortalSession = typeof portalSession.$inferInsert;

export type PortalInvitation = typeof portalInvitation.$inferSelect;
export type NewPortalInvitation = typeof portalInvitation.$inferInsert;

export type PortalAuthChallenge = typeof portalAuthChallenge.$inferSelect;
export type NewPortalAuthChallenge = typeof portalAuthChallenge.$inferInsert;

export type PaymentMethod = typeof paymentMethod.$inferSelect;
export type NewPaymentMethod = typeof paymentMethod.$inferInsert;

// =====================================================================
// CONSTANTS
// =====================================================================

/**
 * Auth challenge expiry windows. Email links live longer than SMS codes
 * because email delivery latency is higher and codes are short enough
 * that brute-force risk increases with time.
 */
export const AUTH_CHALLENGE_TTL = {
  EMAIL_MS: 15 * 60 * 1000, //  15 minutes
  SMS_MS: 5 * 60 * 1000, //      5 minutes
} as const;

/**
 * Portal session expiry. Sliding window — every request extends.
 */
export const PORTAL_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Invitation expiry — longer than auth challenge because firms invite
 * people who may not check email immediately.
 */
export const PORTAL_INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * Max OTP attempts before invalidating the challenge.
 */
export const SMS_OTP_MAX_ATTEMPTS = 5;

// =====================================================================
// HELPER QUERY EXAMPLES (commented; move to packages/db/src/queries/)
//
// These are sketches — not exported from this schema file. They show
// the intended consumption pattern.
// =====================================================================

/*
import { db } from '../client';
import { and, eq, isNull, or, sql } from 'drizzle-orm';

/// Login: find identity by contact value.
export async function findIdentityByContact(
  firmId: string,
  contactValue: string,
): Promise<PortalIdentity | null> {
  const isEmail = contactValue.includes('@');
  const normalized = isEmail
    ? contactValue.toLowerCase()
    : contactValue; // assume already E.164 normalized upstream
  const [row] = await db
    .select()
    .from(portalIdentity)
    .where(
      and(
        eq(portalIdentity.firmId, firmId),
        eq(portalIdentity.status, 'ACTIVE'),
        isEmail
          ? eq(portalIdentity.primaryEmail, normalized)
          : eq(portalIdentity.primaryPhone, normalized),
      ),
    )
    .limit(1);
  return row ?? null;
}

/// Resolve session: validate token, identity active, access row still
/// ACTIVE for current active_client_id. Returns null on any failure.
export async function resolvePortalSession(tokenHash: string) {
  const now = new Date();
  const [row] = await db
    .select({
      session: portalSession,
      identity: portalIdentity,
      access: clientPortalAccess,
    })
    .from(portalSession)
    .innerJoin(
      portalIdentity,
      eq(portalSession.portalIdentityId, portalIdentity.id),
    )
    .innerJoin(
      clientPortalAccess,
      and(
        eq(clientPortalAccess.portalIdentityId, portalIdentity.id),
        eq(clientPortalAccess.clientId, portalSession.activeClientId),
      ),
    )
    .where(
      and(
        eq(portalSession.tokenHash, tokenHash),
        isNull(portalSession.revokedAt),
        sql`${portalSession.expiresAt} > ${now}`,
        eq(portalIdentity.status, 'ACTIVE'),
        eq(clientPortalAccess.status, 'ACTIVE'),
      ),
    )
    .limit(1);
  return row ?? null;
}

/// Invitation accept: find-or-create identity, link access.
export async function acceptInvitation(
  invitationId: string,
  acceptingContact: { email?: string; phone?: string; fullName: string },
) {
  return db.transaction(async (tx) => {
    const [inv] = await tx
      .select()
      .from(portalInvitation)
      .where(
        and(
          eq(portalInvitation.id, invitationId),
          eq(portalInvitation.status, 'ACTIVE'),
          sql`${portalInvitation.expiresAt} > now()`,
        ),
      )
      .limit(1);
    if (!inv) throw new Error('Invitation not found or expired');

    // Find-or-create identity
    let identity = await findIdentityByContact(
      inv.firmId,
      inv.invitedEmail ?? inv.invitedPhone!,
    );
    if (!identity) {
      const [created] = await tx
        .insert(portalIdentity)
        .values({
          firmId: inv.firmId,
          fullName: acceptingContact.fullName ?? inv.proposedFullName,
          primaryEmail: inv.invitedEmail,
          primaryEmailVerifiedAt: inv.deliveryChannel === 'EMAIL' ? new Date() : undefined,
          primaryPhone: inv.invitedPhone,
          primaryPhoneVerifiedAt: inv.deliveryChannel === 'SMS' ? new Date() : undefined,
          preferredMethod: inv.deliveryChannel,
        })
        .returning();
      identity = created;
    }

    // Upsert access row (reactivates if previously INACTIVE)
    await tx
      .insert(clientPortalAccess)
      .values({
        portalIdentityId: identity.id,
        clientId: inv.clientId,
        role: inv.proposedRole,
        notificationPreferences: inv.proposedNotificationPreferences,
        invitedBy: inv.invitedBy,
        invitedAt: inv.invitedAt,
        acceptedAt: new Date(),
        status: 'ACTIVE',
      })
      .onConflictDoUpdate({
        target: [
          clientPortalAccess.portalIdentityId,
          clientPortalAccess.clientId,
        ],
        set: {
          status: 'ACTIVE',
          acceptedAt: new Date(),
          revokedAt: null,
          revokedBy: null,
          updatedAt: new Date(),
        },
      });

    await tx
      .update(portalInvitation)
      .set({ status: 'USED', usedAt: new Date(), portalIdentityId: identity.id })
      .where(eq(portalInvitation.id, invitationId));

    return identity;
  });
}
*/

// =====================================================================
// MIGRATION NOTES
//
// 1. Migration order: portal_identity → client_portal_access →
//    portal_session → portal_invitation → portal_auth_challenge →
//    payment_method. FK dependencies require this order.
//
// 2. Application-level invariants to enforce in code (not in schema):
//    a. At most one payment_method per portal_identity has is_default=true.
//       Enforce in transaction when setting a new default.
//    b. portal_session.active_client_id must always correspond to an
//       ACTIVE row in client_portal_access for the same identity.
//       Check on session creation and on every active_client_id update.
//    c. When a client_portal_access row is set to INACTIVE, revoke any
//       portal_session where active_client_id matches that client AND
//       the identity has no other ACTIVE access at this firm. (If the
//       identity has other active accesses, switch active_client_id to
//       another accessible client instead of revoking the session.)
//
// 3. Audit log integration: every state change on these tables should
//    emit an audit_log row with actor_portal_identity_id when the
//    actor is a portal user, or actor_app_user_id when the actor is
//    firm staff. Both columns coexist on audit_log so portal and staff
//    actions are queryable in the same view.
//
// 4. SMS rate limiting: implement in Redis ahead of the database write.
//    Counts to track:
//      - per phone, per minute (anti-flood)
//      - per phone, per day (anti-abuse)
//      - per firm, per day (cost cap — see Phase 20 admin UI)
//
// 5. Phone re-verification (Phase 16 QUESTIONS item): when implemented,
//    add `primary_phone_verification_due_at` and a background job that
//    nullifies primary_phone_verified_at when the due date passes.
// =====================================================================
