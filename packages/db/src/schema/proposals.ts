// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Drizzle schema for the Vibe T&B Proposal Module (Phase P01).
//
// Mirrors `packages/db/migrations/0074_proposal_module.sql`. Both
// files must be edited together when the schema changes.
//
// The retainer addendum lives in retainers.ts; this lives in
// proposals.ts to follow the same per-addendum pattern. The full
// surface is re-exported from the schema barrel.
//
// Naming: addendum says `proposals` (plural table). Drizzle export is
// `proposals` (matches SQL). Foreign-key columns to portal-side
// tables (payment_method, portal_identity, client_account) are loose
// (no .references()) to avoid circular imports across schema files.
// Migration enforces the FKs.

import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appUsers, clients, engagements, firms } from './core';

// =====================================================================
// custom type: bytea (PG bytea for encrypted secrets)
// =====================================================================

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return 'bytea';
  },
});

// =====================================================================
// ENUMS
// =====================================================================

export const proposalStatus = pgEnum('proposal_status', [
  'DRAFT',
  'SENT',
  'VIEWED',
  'IN_PROGRESS',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'CANCELLED',
  'COUNTERED',
]);

export const serviceCategory = pgEnum('service_category', [
  'TAX',
  'BOOKKEEPING',
  'AUDIT',
  'ADVISORY',
  'PAYROLL',
  'CFO',
]);

export const proposalBillingType = pgEnum('proposal_billing_type', [
  'ONE_TIME',
  'RECURRING',
  'ON_COMPLETION',
  'SPLIT_DEPOSIT_RECURRING',
]);

export const proposalRecurringInterval = pgEnum('proposal_recurring_interval', [
  'MONTHLY',
  'QUARTERLY',
  'SEMIANNUALLY',
  'ANNUALLY',
]);

export const signatureRole = pgEnum('signature_role', ['PRIMARY', 'COSIGNER', 'WITNESS']);
export const signatureMethod = pgEnum('signature_method', ['TYPED_NAME', 'DRAWN_SVG', 'OPENSIGN']);
export const signatureState = pgEnum('signature_state', ['PENDING', 'SIGNED', 'DECLINED']);

export const paymentMandateKind = pgEnum('payment_mandate_kind', ['CARD', 'ACH', 'LINK', 'WALLET']);
export const paymentMandateState = pgEnum('payment_mandate_state', [
  'PENDING_VERIFICATION',
  'ACTIVE',
  'INVALID',
  'REVOKED',
]);

export const webhookEventState = pgEnum('webhook_event_state', [
  'PENDING',
  'PROCESSED',
  'FAILED',
  'IGNORED',
]);

export const magicLinkPurpose = pgEnum('magic_link_purpose', [
  'PROPOSAL',
  'ENGAGEMENT',
  'PASSWORD_RESET',
  'INVOICE',
]);

export const proposalActivityKind = pgEnum('proposal_activity_kind', [
  'CREATED',
  'SENT',
  'OPENED',
  'SECTION_VIEWED',
  'TIER_SELECTED',
  'SIGNATURE_STARTED',
  'SIGNATURE_COMPLETED',
  'PAYMENT_STARTED',
  'PAYMENT_COMPLETED',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'CANCELLED',
  'COUNTERED',
]);

export const quickBillState = pgEnum('quick_bill_state', ['DRAFT', 'SENT', 'PAID', 'VOID']);

export const renewalState = pgEnum('renewal_state', [
  'CANDIDATE',
  'PROPOSED',
  'ACCEPTED',
  'DECLINED',
  'LAPSED',
]);

export const upliftMode = pgEnum('uplift_mode', [
  'MANUAL_PERCENT',
  'REALIZATION_BASED',
  'CPI_INDEXED',
]);

export const engagementDeliverableState = pgEnum('engagement_deliverable_state', [
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
]);

// =====================================================================
// services catalog + tags
// =====================================================================

export const servicesCatalog = pgTable(
  'services_catalog',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    category: serviceCategory('category').notNull(),
    defaultPriceCents: bigint('default_price_cents', { mode: 'number' }).notNull().default(0),
    billingType: proposalBillingType('billing_type').notNull().default('ONE_TIME'),
    recurringInterval: proposalRecurringInterval('recurring_interval'),
    isAddon: boolean('is_addon').notNull().default(false),
    parentServiceId: uuid('parent_service_id'),
    coaCode: text('coa_code'),
    // 0123 — when imported from the system template library, the source slug
    // + pack version (else null for hand-created rows).
    clonedFromSlug: text('cloned_from_slug'),
    clonedFromPackVersion: text('cloned_from_pack_version'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdById: uuid('created_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    priceNonneg: check('services_catalog_price_nonneg', sql`${t.defaultPriceCents} >= 0`),
    recurringConsistency: check(
      'services_catalog_recurring_consistency',
      sql`(${t.billingType} IN ('RECURRING', 'SPLIT_DEPOSIT_RECURRING') AND ${t.recurringInterval} IS NOT NULL)
          OR (${t.billingType} NOT IN ('RECURRING', 'SPLIT_DEPOSIT_RECURRING') AND ${t.recurringInterval} IS NULL)`,
    ),
    firmCategoryIdx: index('services_catalog_firm_category_idx').on(t.firmId, t.category),
    parentIdx: index('services_catalog_parent_idx').on(t.parentServiceId),
  }),
);

export const serviceTags = pgTable(
  'service_tags',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Migration creates this with `lower(name)`; Drizzle's index API
    // only accepts plain columns, so this signature is illustrative.
    // The SQL constraint is authoritative.
    firmNameUk: uniqueIndex('service_tags_firm_name_uk').on(t.firmId, t.name),
  }),
);

export const serviceTagAssignments = pgTable(
  'service_tag_assignments',
  {
    serviceId: uuid('service_id')
      .notNull()
      .references(() => servicesCatalog.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => serviceTags.id, { onDelete: 'cascade' }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serviceId, t.tagId] }),
  }),
);

// =====================================================================
// packages (Bronze / Silver / Gold)
// =====================================================================

export const packages = pgTable(
  'packages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tierLabel: text('tier_label').notNull().default('Standard'),
    position: integer('position').notNull().default(0),
    description: text('description').notNull().default(''),
    // 0125 — optional flat price for the tier. When set, it overrides the
    // computed sum-of-included-services price in the catalog + proposal block.
    priceOverrideCents: bigint('price_override_cents', { mode: 'number' }),
    clonedFromSlug: text('cloned_from_slug'),
    clonedFromPackVersion: text('cloned_from_pack_version'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdById: uuid('created_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmPositionIdx: index('packages_firm_position_idx').on(t.firmId, t.position),
  }),
);

export const packageServices = pgTable(
  'package_services',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    packageId: uuid('package_id')
      .notNull()
      .references(() => packages.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => servicesCatalog.id, { onDelete: 'restrict' }),
    overridePriceCents: bigint('override_price_cents', { mode: 'number' }),
    included: boolean('included').notNull().default(true),
    sequence: integer('sequence').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    overrideNonneg: check(
      'package_services_override_nonneg',
      sql`${t.overridePriceCents} IS NULL OR ${t.overridePriceCents} >= 0`,
    ),
    pkgSvcUk: uniqueIndex('package_services_pkg_svc_uk').on(t.packageId, t.serviceId),
    pkgSeqIdx: index('package_services_pkg_seq_idx').on(t.packageId, t.sequence),
  }),
);

// =====================================================================
// terms templates
// =====================================================================

export const termsTemplates = pgTable(
  'terms_templates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    category: serviceCategory('category').notNull(),
    name: text('name').notNull(),
    contentMd: text('content_md').notNull().default(''),
    version: integer('version').notNull().default(1),
    isDefault: boolean('is_default').notNull().default(false),
    clonedFromSlug: text('cloned_from_slug'),
    clonedFromPackVersion: text('cloned_from_pack_version'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdById: uuid('created_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    versionPositive: check('terms_templates_version_positive', sql`${t.version} > 0`),
    firmCategoryIdx: index('terms_templates_firm_category_idx').on(t.firmId, t.category),
  }),
);

// =====================================================================
// firm_settings_proposals
// =====================================================================

export const firmSettingsProposals = pgTable('firm_settings_proposals', {
  firmId: uuid('firm_id')
    .primaryKey()
    .references(() => firms.id, { onDelete: 'cascade' }),
  stripeAccountId: text('stripe_account_id'),
  stripePublishableKey: text('stripe_publishable_key'),
  stripeAccountCapabilities: jsonb('stripe_account_capabilities')
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  stripeConnectedAt: timestamp('stripe_connected_at', { withTimezone: true }),
  stripeDisconnectedAt: timestamp('stripe_disconnected_at', { withTimezone: true }),
  hmacSecretEncrypted: bytea('hmac_secret_encrypted'),
  brandingLogoUrl: text('branding_logo_url'),
  brandingPrimaryColor: text('branding_primary_color'),
  brandingAccentColor: text('branding_accent_color'),
  customDomain: text('custom_domain'),
  customDomainVerifiedAt: timestamp('custom_domain_verified_at', { withTimezone: true }),
  notificationsConfig: jsonb('notifications_config')
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  // 0098 — per-firm e-signature provider. 'native' (default) signs
  // inline in our portal; 'opensign' delegates to the AGPL sidecar over
  // HTTP (only honored when OPENSIGN_URL is configured). CHECK in the
  // migration constrains the value to native|opensign.
  esignProvider: text('esign_provider').notNull().default('native'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// =====================================================================
// proposal_pending_mandate (0098 — OpenSign async completion context)
// =====================================================================
//
// Stashes the Stripe ACH mandate inputs captured at the portal "start
// OpenSign signing" step so the async completion (webhook / poll) can
// capture the mandate idempotently. One row per signer signing attempt.

export const proposalPendingMandate = pgTable(
  'proposal_pending_mandate',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    signatureId: uuid('signature_id').notNull(),
    selectedPackageId: uuid('selected_package_id'),
    stripeCustomerId: text('stripe_customer_id'),
    stripePaymentMethodId: text('stripe_payment_method_id'),
    stripeMandateId: text('stripe_mandate_id'),
    mandateTextRendered: text('mandate_text_rendered'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    signatureUk: uniqueIndex('proposal_pending_mandate_signature_uk').on(t.signatureId),
    proposalIdx: index('proposal_pending_mandate_proposal_idx').on(t.proposalId),
  }),
);

// =====================================================================
// opensign_webhook_events (0098 — OpenSign webhook idempotency ledger)
// =====================================================================
//
// Mirrors the Stripe webhook_events pattern: keyed on the OpenSign event
// id so a redelivery is a no-op.

export const opensignWebhookEvents = pgTable(
  'opensign_webhook_events',
  {
    opensignEventId: text('opensign_event_id').primaryKey(),
    firmId: uuid('firm_id').references(() => firms.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    envelopeId: text('envelope_id'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    state: text('state').notNull().default('PENDING'),
    lastError: text('last_error'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => ({
    stateChk: check(
      'opensign_webhook_events_state_chk',
      sql`${t.state} IN ('PENDING', 'PROCESSED', 'FAILED', 'IGNORED')`,
    ),
    envelopeIdx: index('opensign_webhook_events_envelope_idx').on(t.envelopeId),
  }),
);

// =====================================================================
// proposals + versions
// =====================================================================

export const proposals = pgTable(
  'proposals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    status: proposalStatus('status').notNull().default('DRAFT'),
    // 0097 — PARALLEL (default) or SEQUENTIAL signer ordering. Stored as
    // a CHECK-constrained text column (see migration) rather than an enum.
    signingOrderMode: text('signing_order_mode').notNull().default('PARALLEL'),
    title: text('title').notNull(),
    brochureJsonb: jsonb('brochure_jsonb').$type<Record<string, unknown>>().notNull().default({}),
    totalOneTimeCents: bigint('total_one_time_cents', { mode: 'number' }).notNull().default(0),
    totalRecurringCents: bigint('total_recurring_cents', { mode: 'number' }).notNull().default(0),
    recurringInterval: proposalRecurringInterval('recurring_interval'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    firstViewedAt: timestamp('first_viewed_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    declinedReason: text('declined_reason'),
    counteredAt: timestamp('countered_at', { withTimezone: true }),
    counteredNote: text('countered_note'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledById: uuid('cancelled_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
    // FK added by ALTER TABLE later in the migration to avoid forward
    // reference to engagement before its column extension. Drizzle FK
    // skipped here — migration is authoritative.
    renewedFromEngagementId: uuid('renewed_from_engagement_id'),
    draftRevision: integer('draft_revision').notNull().default(0),
    // 0124 — on-acceptance actions. createEngagementOnAccept gates the
    // always-on engagement freeze; requestTemplateIdOnAccept (when set, and
    // engagement creation is on) spawns a request list on the new engagement.
    createEngagementOnAccept: boolean('create_engagement_on_accept').notNull().default(true),
    requestTemplateIdOnAccept: uuid('request_template_id_on_accept'),
    createdById: uuid('created_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    totalOneTimeNonneg: check('proposals_total_one_time_nonneg', sql`${t.totalOneTimeCents} >= 0`),
    totalRecurringNonneg: check(
      'proposals_total_recurring_nonneg',
      sql`${t.totalRecurringCents} >= 0`,
    ),
    expiresAfterSent: check(
      'proposals_expires_after_sent',
      sql`${t.expiresAt} IS NULL OR ${t.sentAt} IS NULL OR ${t.expiresAt} > ${t.sentAt}`,
    ),
    recurringConsistency: check(
      'proposals_recurring_consistency',
      sql`(${t.totalRecurringCents} > 0 AND ${t.recurringInterval} IS NOT NULL)
          OR (${t.totalRecurringCents} = 0)`,
    ),
    firmStatusIdx: index('proposals_firm_status_idx').on(t.firmId, t.status),
    clientStatusIdx: index('proposals_client_status_idx').on(t.clientId, t.status),
  }),
);

export const proposalVersions = pgTable(
  'proposal_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    contentJsonb: jsonb('content_jsonb').$type<Record<string, unknown>>().notNull(),
    contentHash: text('content_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdById: uuid('created_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
    reason: proposalActivityKind('reason').notNull(),
  },
  (t) => ({
    versionPositive: check('proposal_versions_version_positive', sql`${t.version} > 0`),
    hashFormat: check('proposal_versions_hash_format', sql`${t.contentHash} ~ '^[a-f0-9]{64}$'`),
    proposalVersionUk: uniqueIndex('proposal_versions_proposal_version_uk').on(
      t.proposalId,
      t.version,
    ),
  }),
);

// =====================================================================
// proposal line items + package junction
// =====================================================================

export const proposalLineItems = pgTable(
  'proposal_line_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id').references(() => servicesCatalog.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    qty: numeric('qty', { precision: 12, scale: 4 }).notNull().default('1'),
    unitPriceCents: bigint('unit_price_cents', { mode: 'number' }).notNull(),
    billingType: proposalBillingType('billing_type').notNull(),
    recurringInterval: proposalRecurringInterval('recurring_interval'),
    optional: boolean('optional').notNull().default(false),
    sequence: integer('sequence').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    priceNonneg: check('proposal_line_items_price_nonneg', sql`${t.unitPriceCents} >= 0`),
    qtyPositive: check('proposal_line_items_qty_positive', sql`${t.qty} > 0`),
    recurringConsistency: check(
      'proposal_line_items_recurring_consistency',
      sql`(${t.billingType} IN ('RECURRING', 'SPLIT_DEPOSIT_RECURRING') AND ${t.recurringInterval} IS NOT NULL)
          OR (${t.billingType} NOT IN ('RECURRING', 'SPLIT_DEPOSIT_RECURRING') AND ${t.recurringInterval} IS NULL)`,
    ),
    proposalSeqIdx: index('proposal_line_items_proposal_seq_idx').on(t.proposalId, t.sequence),
  }),
);

export const proposalPackages = pgTable(
  'proposal_packages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    packageId: uuid('package_id')
      .notNull()
      .references(() => packages.id, { onDelete: 'restrict' }),
    overrideLabel: text('override_label'),
    sequence: integer('sequence').notNull().default(0),
    selected: boolean('selected').notNull().default(false),
    selectedAt: timestamp('selected_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    proposalPackageUk: uniqueIndex('proposal_packages_proposal_package_uk').on(
      t.proposalId,
      t.packageId,
    ),
    proposalSeqIdx: index('proposal_packages_proposal_seq_idx').on(t.proposalId, t.sequence),
  }),
);

// =====================================================================
// proposal terms snapshot
// =====================================================================

export const proposalTermsSnapshot = pgTable(
  'proposal_terms_snapshot',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    termsTemplateId: uuid('terms_template_id').references(() => termsTemplates.id, {
      onDelete: 'restrict',
    }),
    templateVersion: integer('template_version').notNull(),
    contentMdRendered: text('content_md_rendered').notNull(),
    contentHash: text('content_hash').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hashFormat: check(
      'proposal_terms_snapshot_hash_format',
      sql`${t.contentHash} ~ '^[a-f0-9]{64}$'`,
    ),
    versionPositive: check(
      'proposal_terms_snapshot_version_positive',
      sql`${t.templateVersion} > 0`,
    ),
    proposalIdx: index('proposal_terms_snapshot_proposal_idx').on(t.proposalId, t.capturedAt),
  }),
);

// =====================================================================
// signatures (plural design — §0.3 #1)
// =====================================================================

export const signatures = pgTable(
  'signatures',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    role: signatureRole('role').notNull().default('PRIMARY'),
    sequence: integer('sequence').notNull().default(0),
    // 0097 — does this signer gate ACCEPTED? WITNESS rows can be made
    // non-required so they don't block the engagement freeze.
    required: boolean('required').notNull().default(true),
    signerName: text('signer_name').notNull(),
    signerEmail: text('signer_email').notNull(),
    signerPhone: text('signer_phone'),
    signerIp: text('signer_ip'),
    signerUa: text('signer_ua'),
    clientAccountId: uuid('client_account_id'),
    // 0097 — nullable: a PENDING roster row has no signing method yet.
    method: signatureMethod('method'),
    state: signatureState('state').notNull().default('PENDING'),
    typedName: text('typed_name'),
    signatureSvg: text('signature_svg'),
    opensignEnvelopeId: text('opensign_envelope_id'),
    opensignCertificateObjectKey: text('opensign_certificate_object_key'),
    payloadHash: text('payload_hash'),
    hmacSignature: text('hmac_signature'),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    declinedReason: text('declined_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    payloadHashFormat: check(
      'signatures_payload_hash_format',
      sql`${t.payloadHash} IS NULL OR ${t.payloadHash} ~ '^[a-f0-9]{64}$'`,
    ),
    signedConsistency: check(
      'signatures_signed_state_consistency',
      sql`(${t.state} = 'SIGNED' AND ${t.signedAt} IS NOT NULL AND ${t.payloadHash} IS NOT NULL)
          OR ${t.state} <> 'SIGNED'`,
    ),
    methodPayload: check(
      'signatures_method_payload',
      sql`(${t.method} = 'TYPED_NAME' AND ${t.typedName} IS NOT NULL)
          OR (${t.method} = 'DRAWN_SVG' AND ${t.signatureSvg} IS NOT NULL)
          OR (${t.method} = 'OPENSIGN' AND ${t.opensignEnvelopeId} IS NOT NULL)
          OR (${t.method} IS NULL AND ${t.state} IN ('PENDING', 'DECLINED'))`,
    ),
    proposalIdx: index('signatures_proposal_idx').on(t.proposalId, t.sequence),
    stateIdx: index('signatures_state_idx').on(t.state),
  }),
);

// =====================================================================
// payment_mandates
// =====================================================================

export const paymentMandates = pgTable(
  'payment_mandates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    proposalId: uuid('proposal_id').references(() => proposals.id, { onDelete: 'set null' }),
    engagementId: uuid('engagement_id'),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    paymentMethodId: uuid('payment_method_id'),
    kind: paymentMandateKind('kind').notNull(),
    stripeAccountId: text('stripe_account_id').notNull(),
    stripeCustomerId: text('stripe_customer_id'),
    stripePaymentMethodId: text('stripe_payment_method_id'),
    stripeMandateId: text('stripe_mandate_id'),
    mandateTextRendered: text('mandate_text_rendered'),
    mandateTextHash: text('mandate_text_hash'),
    state: paymentMandateState('state').notNull().default('PENDING_VERIFICATION'),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    invalidatedReason: text('invalidated_reason'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: uuid('revoked_by_user_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    textHashFormat: check(
      'payment_mandates_text_hash_format',
      sql`${t.mandateTextHash} IS NULL OR ${t.mandateTextHash} ~ '^[a-f0-9]{64}$'`,
    ),
    achTextRequired: check(
      'payment_mandates_ach_text_required',
      sql`${t.kind} <> 'ACH' OR (${t.mandateTextRendered} IS NOT NULL AND ${t.mandateTextHash} IS NOT NULL)`,
    ),
    firmStateIdx: index('payment_mandates_firm_state_idx').on(t.firmId, t.state),
    clientIdx: index('payment_mandates_client_idx').on(t.clientId),
  }),
);

// =====================================================================
// webhook_events (Stripe idempotency)
// =====================================================================

export const webhookEvents = pgTable(
  'webhook_events',
  {
    stripeEventId: text('stripe_event_id').primaryKey(),
    firmId: uuid('firm_id').references(() => firms.id, { onDelete: 'cascade' }),
    stripeAccountId: text('stripe_account_id').notNull(),
    eventType: text('event_type').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    state: webhookEventState('state').notNull().default('PENDING'),
    retryCount: integer('retry_count').notNull().default(0),
    lastError: text('last_error'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  },
  (t) => ({
    retryNonneg: check('webhook_events_retry_nonneg', sql`${t.retryCount} >= 0`),
    accountReceivedIdx: index('webhook_events_account_received_idx').on(
      t.stripeAccountId,
      t.receivedAt,
    ),
  }),
);

// =====================================================================
// magic_links
// =====================================================================

export const magicLinks = pgTable(
  'magic_links',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    purpose: magicLinkPurpose('purpose').notNull(),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'cascade' }),
    proposalId: uuid('proposal_id').references(() => proposals.id, { onDelete: 'cascade' }),
    engagementId: uuid('engagement_id'),
    clientAccountId: uuid('client_account_id'),
    // 0097 — per-signer magic links for multi-signer proposals. NULL for
    // the legacy single-link flow and other magic-link purposes.
    signatureId: uuid('signature_id').references(() => signatures.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    usedFromIp: text('used_from_ip'),
    usedFromUa: text('used_from_ua'),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    // Self-reference defined at the migration level via ALTER (Drizzle
    // would need a circular import here).
    supersededById: uuid('superseded_by_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdById: uuid('created_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
  },
  (t) => ({
    expiryAfterCreation: check(
      'magic_links_expiry_after_creation',
      sql`${t.expiresAt} > ${t.createdAt}`,
    ),
    tokenHashUk: uniqueIndex('magic_links_token_hash_uk').on(t.tokenHash),
  }),
);

// =====================================================================
// client_accounts (optional portal password)
// =====================================================================

export const clientAccounts = pgTable(
  'client_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    mfaSecretEncrypted: bytea('mfa_secret_encrypted'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    failedLoginNonneg: check(
      'client_accounts_failed_login_nonneg',
      sql`${t.failedLoginCount} >= 0`,
    ),
    // Same lower(email) caveat — SQL migration is authoritative.
    firmEmailUk: uniqueIndex('client_accounts_firm_email_uk').on(t.firmId, t.email),
    clientIdx: index('client_accounts_client_idx').on(t.clientId),
  }),
);

// =====================================================================
// engagement_scope + engagement_deliverables
// =====================================================================

export const engagementScope = pgTable(
  'engagement_scope',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id').references(() => servicesCatalog.id, { onDelete: 'set null' }),
    proposalLineItemId: uuid('proposal_line_item_id').references(() => proposalLineItems.id, {
      onDelete: 'set null',
    }),
    frozenFromVersionId: uuid('frozen_from_version_id')
      .notNull()
      .references(() => proposalVersions.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    qty: numeric('qty', { precision: 12, scale: 4 }).notNull(),
    unitPriceCents: bigint('unit_price_cents', { mode: 'number' }).notNull(),
    billingType: proposalBillingType('billing_type').notNull(),
    recurringInterval: proposalRecurringInterval('recurring_interval'),
    sequence: integer('sequence').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    priceNonneg: check('engagement_scope_price_nonneg', sql`${t.unitPriceCents} >= 0`),
    qtyPositive: check('engagement_scope_qty_positive', sql`${t.qty} > 0`),
    engagementSeqIdx: index('engagement_scope_engagement_seq_idx').on(t.engagementId, t.sequence),
  }),
);

export const engagementDeliverables = pgTable(
  'engagement_deliverables',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    dueDate: date('due_date'),
    state: engagementDeliverableState('state').notNull().default('PENDING'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    sequence: integer('sequence').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    engagementIdx: index('engagement_deliverables_engagement_idx').on(t.engagementId, t.sequence),
  }),
);

// =====================================================================
// stripe mapping tables
// =====================================================================

export const stripeCustomers = pgTable(
  'stripe_customers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    stripeAccountId: text('stripe_account_id').notNull(),
    stripeCustomerId: text('stripe_customer_id').notNull(),
    emailAtCreation: text('email_at_creation'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountCustomerUk: uniqueIndex('stripe_customers_account_customer_uk').on(
      t.stripeAccountId,
      t.stripeCustomerId,
    ),
    firmClientUk: uniqueIndex('stripe_customers_firm_client_uk').on(t.firmId, t.clientId),
  }),
);

export const stripeSubscriptions = pgTable(
  'stripe_subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    stripeAccountId: text('stripe_account_id').notNull(),
    stripeCustomerId: text('stripe_customer_id').notNull(),
    stripeSubscriptionId: text('stripe_subscription_id').notNull(),
    stripeStatus: text('stripe_status').notNull(),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    billingCycleAnchor: timestamp('billing_cycle_anchor', { withTimezone: true }),
    cancelAt: timestamp('cancel_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    pauseCollectionBehavior: text('pause_collection_behavior'),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    stripeUk: uniqueIndex('stripe_subscriptions_stripe_uk').on(t.stripeSubscriptionId),
    engagementIdx: index('stripe_subscriptions_engagement_idx').on(t.engagementId),
    firmStatusIdx: index('stripe_subscriptions_firm_status_idx').on(t.firmId, t.stripeStatus),
  }),
);

export const stripeInvoices = pgTable(
  'stripe_invoices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    engagementId: uuid('engagement_id').references(() => engagements.id, { onDelete: 'set null' }),
    stripeAccountId: text('stripe_account_id').notNull(),
    stripeCustomerId: text('stripe_customer_id').notNull(),
    stripeSubscriptionId: text('stripe_subscription_id'),
    stripeInvoiceId: text('stripe_invoice_id').notNull(),
    stripeStatus: text('stripe_status').notNull(),
    amountDueCents: bigint('amount_due_cents', { mode: 'number' }).notNull().default(0),
    amountPaidCents: bigint('amount_paid_cents', { mode: 'number' }).notNull().default(0),
    amountRemainingCents: bigint('amount_remaining_cents', { mode: 'number' }).notNull().default(0),
    dueAt: timestamp('due_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    hostedInvoiceUrl: text('hosted_invoice_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    amountDueNonneg: check('stripe_invoices_amount_due_nonneg', sql`${t.amountDueCents} >= 0`),
    amountPaidNonneg: check('stripe_invoices_amount_paid_nonneg', sql`${t.amountPaidCents} >= 0`),
    stripeUk: uniqueIndex('stripe_invoices_stripe_uk').on(t.stripeInvoiceId),
    firmStatusIdx: index('stripe_invoices_firm_status_idx').on(t.firmId, t.stripeStatus),
  }),
);

// =====================================================================
// proposal activity + section views
// =====================================================================

export const proposalActivity = pgTable(
  'proposal_activity',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    kind: proposalActivityKind('kind').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    occurredFromIp: text('occurred_from_ip'),
    occurredFromUa: text('occurred_from_ua'),
    magicLinkId: uuid('magic_link_id').references(() => magicLinks.id, { onDelete: 'set null' }),
    clientAccountId: uuid('client_account_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => ({
    proposalOccurredIdx: index('proposal_activity_proposal_occurred_idx').on(
      t.proposalId,
      t.occurredAt,
    ),
    kindIdx: index('proposal_activity_kind_idx').on(t.kind),
  }),
);

export const proposalSectionViews = pgTable(
  'proposal_section_views',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    sectionBlockId: text('section_block_id').notNull(),
    sessionId: text('session_id').notNull(),
    clientAccountId: uuid('client_account_id'),
    firstViewedAt: timestamp('first_viewed_at', { withTimezone: true }).notNull().defaultNow(),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }).notNull().defaultNow(),
    viewCount: integer('view_count').notNull().default(1),
    totalDwellMs: bigint('total_dwell_ms', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    countPositive: check('proposal_section_views_count_positive', sql`${t.viewCount} > 0`),
    dwellNonneg: check('proposal_section_views_dwell_nonneg', sql`${t.totalDwellMs} >= 0`),
    proposalSectionSessionUk: uniqueIndex('proposal_section_views_proposal_section_session_uk').on(
      t.proposalId,
      t.sectionBlockId,
      t.sessionId,
    ),
    proposalIdx: index('proposal_section_views_proposal_idx').on(t.proposalId, t.lastViewedAt),
  }),
);

// =====================================================================
// quick bills (ad-hoc invoices)
// =====================================================================

export const quickBills = pgTable(
  'quick_bills',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    state: quickBillState('state').notNull().default('DRAFT'),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),
    description: text('description').notNull().default(''),
    paymentMethodId: uuid('payment_method_id'),
    stripeInvoiceId: text('stripe_invoice_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    voidAt: timestamp('void_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    createdById: uuid('created_by_id').references(() => appUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    totalNonneg: check('quick_bills_total_nonneg', sql`${t.totalCents} >= 0`),
    firmStateIdx: index('quick_bills_firm_state_idx').on(t.firmId, t.state),
    clientIdx: index('quick_bills_client_idx').on(t.clientId, t.createdAt),
  }),
);

export const quickBillLineItems = pgTable(
  'quick_bill_line_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    quickBillId: uuid('quick_bill_id')
      .notNull()
      .references(() => quickBills.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    qty: numeric('qty', { precision: 12, scale: 4 }).notNull().default('1'),
    unitPriceCents: bigint('unit_price_cents', { mode: 'number' }).notNull(),
    sequence: integer('sequence').notNull().default(0),
  },
  (t) => ({
    qtyPositive: check('quick_bill_line_items_qty_positive', sql`${t.qty} > 0`),
    priceNonneg: check('quick_bill_line_items_price_nonneg', sql`${t.unitPriceCents} >= 0`),
    qbSeqIdx: index('quick_bill_line_items_qb_seq_idx').on(t.quickBillId, t.sequence),
  }),
);

// =====================================================================
// renewals
// =====================================================================

export const renewals = pgTable(
  'renewals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    currentEngagementId: uuid('current_engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    upliftMode: upliftMode('uplift_mode').notNull().default('MANUAL_PERCENT'),
    upliftBps: integer('uplift_bps').notNull().default(0),
    suggestedTotalCents: bigint('suggested_total_cents', { mode: 'number' }),
    candidateAt: timestamp('candidate_at', { withTimezone: true }).notNull().defaultNow(),
    sendWindowStart: date('send_window_start'),
    sendWindowEnd: date('send_window_end'),
    state: renewalState('state').notNull().default('CANDIDATE'),
    proposalId: uuid('proposal_id').references(() => proposals.id, { onDelete: 'set null' }),
    autoRenew: boolean('auto_renew').notNull().default(false),
    cpiSnapshot: jsonb('cpi_snapshot').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    upliftRange: check('renewals_uplift_bps_range', sql`${t.upliftBps} BETWEEN -10000 AND 100000`),
    suggestedNonneg: check(
      'renewals_suggested_nonneg',
      sql`${t.suggestedTotalCents} IS NULL OR ${t.suggestedTotalCents} >= 0`,
    ),
    firmStateIdx: index('renewals_firm_state_idx').on(t.firmId, t.state),
    engagementIdx: index('renewals_engagement_idx').on(t.currentEngagementId),
  }),
);
