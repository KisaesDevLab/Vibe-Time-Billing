// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0108 — Signatures module (OpenSign Integration Addendum). Arbitrary-PDF
// e-signature requests with drag-to-place fields and reusable, role-based
// placement profiles. Distinct from the proposal `signatures` table (which
// is proposal-bound + field-less); this module reuses the existing esign
// provider / webhook / poll but owns its own request lifecycle.
//
// Field positions are stored NORMALIZED ({nx,ny,nw,nh} ∈ [0,1] of page
// dims) so they survive any render scale; per-page point geometry is read
// from the PDF MediaBox at upload (pageGeometry). A single adapter
// (toOpenSignPlaceholder) maps normalized → OpenSign editor-pixel space.

import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { appUsers, clientContacts, clients, engagements, firms, persons } from './core';
import { portalIdentity } from './portal';
import { taxReturns } from './tax-returns';

export const signatureRequests = pgTable(
  'signature_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
    // 0133 — optional association with one of the client's engagements.
    engagementId: uuid('engagement_id').references(() => engagements.id, {
      onDelete: 'set null',
    }),
    opensignDocumentId: text('opensign_document_id'),
    title: text('title').notNull(),
    status: text('status').notNull().default('draft'),
    signerCount: integer('signer_count').notNull().default(0),
    signedCount: integer('signed_count').notNull().default(0),
    sourceFileKey: text('source_file_key'),
    signedFileUrl: text('signed_file_url'),
    // OpenSign completion/audit certificate (IP, signed date/time, signer
    // trail) — stored separately from the signed PDF. See migration 0138.
    certificateFileUrl: text('certificate_file_url'),
    // 0139 — in-office signing: 'in_person' suppresses email + (with an
    // identity attestation) bypasses the KBA gate.
    signingMode: text('signing_mode').notNull().default('remote'),
    // 0139 — the tax return this signature package was assembled from.
    taxReturnId: uuid('tax_return_id').references(() => taxReturns.id, {
      onDelete: 'set null',
    }),
    // 0139 — merged-package parts: [{ source, label, pageStart, pageEnd, refId? }].
    packageManifest: jsonb('package_manifest'),
    // [{ pageNumber, widthPt, heightPt }] read from each page's MediaBox.
    pageGeometry: jsonb('page_geometry'),
    formType: text('form_type'),
    sendInOrder: boolean('send_in_order').notNull().default(false),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => appUsers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmStatusIdx: index('signature_requests_firm_status_idx').on(t.firmId, t.status),
    firmEngagementIdx: index('signature_requests_firm_engagement_idx').on(t.firmId, t.engagementId),
    opensignIdx: index('signature_requests_opensign_idx').on(t.opensignDocumentId),
    taxReturnIdx: index('signature_requests_tax_return_idx').on(t.taxReturnId),
    statusCk: check(
      'signature_requests_status_ck',
      sql`${t.status} IN ('draft','sent','partially_signed','completed','declined','expired','voided')`,
    ),
    signingModeCk: check(
      'signature_requests_signing_mode_ck',
      sql`${t.signingMode} IN ('remote','in_person')`,
    ),
  }),
);

export const signatureSigners = pgTable(
  'signature_signers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => signatureRequests.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    email: text('email').notNull(),
    role: text('role'),
    order: integer('order').notNull().default(1),
    status: text('status').notNull().default('pending'),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    opensignSignerId: text('opensign_signer_id'),
    // 0133 — provenance when a signer was pulled from the client's people
    // list (vs. typed by hand). All nullable; name+email stay canonical.
    personId: uuid('person_id').references(() => persons.id, { onDelete: 'set null' }),
    clientContactId: uuid('client_contact_id').references(() => clientContacts.id, {
      onDelete: 'set null',
    }),
    portalIdentityId: uuid('portal_identity_id').references(() => portalIdentity.id, {
      onDelete: 'set null',
    }),
  },
  (t) => ({
    requestIdx: index('signature_signers_request_idx').on(t.requestId),
    statusCk: check(
      'signature_signers_status_ck',
      sql`${t.status} IN ('pending','viewed','signed','declined')`,
    ),
  }),
);

export const signatureFieldPlacements = pgTable(
  'signature_field_placements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => signatureRequests.id, { onDelete: 'cascade' }),
    signerId: uuid('signer_id')
      .notNull()
      .references(() => signatureSigners.id, { onDelete: 'cascade' }),
    fieldType: text('field_type').notNull(),
    pageNumber: integer('page_number').notNull(),
    nx: doublePrecision('nx').notNull(),
    ny: doublePrecision('ny').notNull(),
    nw: doublePrecision('nw').notNull(),
    nh: doublePrecision('nh').notNull(),
    required: boolean('required').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    requestIdx: index('signature_field_placements_request_idx').on(t.requestId),
    signerIdx: index('signature_field_placements_signer_idx').on(t.signerId),
    fieldTypeCk: check(
      'signature_field_placements_type_ck',
      sql`${t.fieldType} IN ('signature','initials','date','text','checkbox')`,
    ),
  }),
);

export const signaturePlacementProfiles = pgTable(
  'signature_placement_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    formType: text('form_type').notNull(),
    version: integer('version').notNull().default(1),
    // [{ role, fieldType, pageNumber, nx, ny, nw, nh, required }]
    fields: jsonb('fields').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmFormIdx: index('signature_placement_profiles_firm_form_idx').on(
      t.firmId,
      t.formType,
      t.version,
    ),
  }),
);

export const signatureEvents = pgTable(
  'signature_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => signatureRequests.id, { onDelete: 'cascade' }),
    actor: text('actor').notNull(),
    event: text('event').notNull(),
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    requestIdx: index('signature_events_request_idx').on(t.requestId),
  }),
);

// 0140 — Signature Page Rules. Per-return-type bookmark patterns that
// identify the signature page(s) inside a tax-return PDF. Mirrors
// migration 0140; modeled on the Filer routing rules.
export const signaturePageRules = pgTable(
  'signature_page_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    formType: text('form_type').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    bookmarkPattern: text('bookmark_pattern').notNull(),
    matchMode: text('match_mode').notNull().default('contains'),
    caseSensitive: boolean('case_sensitive').notNull().default(false),
    layoutKey: text('layout_key').notNull().default('generic'),
    // 0145 — optional reference to a firm placement profile (by form_type;
    // the latest version resolves at package-build time). NULL → layoutKey's
    // built-in layout.
    profileFormType: text('profile_form_type'),
    enabled: boolean('enabled').notNull().default(true),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmIdx: index('signature_page_rules_firm_idx').on(t.firmId, t.formType, t.sortOrder),
    matchModeCk: check(
      'signature_page_rules_match_mode_ck',
      sql`${t.matchMode} IN ('contains','exact','regex')`,
    ),
    layoutCk: check(
      'signature_page_rules_layout_ck',
      sql`${t.layoutKey} IN ('us-8879','entity-8879','state-auth','generic')`,
    ),
  }),
);

// 0141 — Signature Document Library. Firm default documents to append to a
// signing package, segregated by return type. `fields` optionally holds
// saved role-tagged placements. Mirrors migration 0141.
export const signatureDocumentTemplates = pgTable(
  'signature_document_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    formType: text('form_type').notNull(),
    name: text('name').notNull(),
    storageKey: text('storage_key').notNull(),
    totalPages: integer('total_pages').notNull().default(1),
    pageGeometry: jsonb('page_geometry'),
    fields: jsonb('fields'),
    autoInclude: boolean('auto_include').notNull().default(true),
    enabled: boolean('enabled').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firmIdx: index('signature_document_templates_firm_idx').on(t.firmId, t.formType, t.sortOrder),
  }),
);
