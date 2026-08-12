// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Q36 — CSV client import. A two-step flow: POST /import/preview runs a
// dry-run (parse + validate, no writes) and reports per-row create/skip
// decisions with reasons; POST /import/commit re-validates and inserts in
// a single transaction. Dedupe is skip-existing — a row matching an
// existing client (by external_id when present, else case-insensitive
// name within the firm) is skipped, never updated. Mirrors the
// portal-invite bulk CSV style (skip rows with reasons) but is
// all-or-nothing on unexpected DB faults so a 200-client onboarding file
// can be fixed and re-run cleanly.

import { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  clientContacts,
  clientEntityType,
  clients,
  contactRoles,
  offices,
} from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { csvField } from '../lib/csv';
import { logger } from '../logger';
import { findOrCreatePerson } from './person-helpers';

export interface ClientImportDeps extends RbacDeps {
  db: Database | null;
}

// ---------------------------------------------------------------- CSV parse

/**
 * RFC-4180-aware CSV parser. Handles quoted fields with embedded commas,
 * escaped quotes (""), and CRLF/LF line endings. Returns the header row
 * plus the data rows as string arrays (ragged rows are tolerated).
 */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const records: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  // Strip a leading UTF-8 BOM if present.
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      // Consume \r\n as one terminator.
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      records.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  // Flush trailing field/row when the file doesn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  // Drop fully-empty trailing rows.
  const cleaned = records.filter((r) => !(r.length === 1 && r[0]!.trim() === ''));
  const header = (cleaned.shift() ?? []).map((h) => h.trim());
  return { header, rows: cleaned };
}

/**
 * True for the `#`-prefixed column-notes row the template download ships as
 * its first data row. Recognized (and skipped) rather than dropped from the
 * row list, so every row keeps its real spreadsheet line number in the
 * preview. Restricted to the first data row so a client whose name genuinely
 * starts with '#' further down the file still imports.
 */
export function isTemplateNotesRow(row: string[], rowIndex: number): boolean {
  return rowIndex === 0 && (row[0] ?? '').trim().startsWith('#');
}

// ---------------------------------------------------------------- template
//
// GET /import/template — a starter CSV for the upload step. Row 1 is the
// header; row 2 is a `#`-prefixed column-notes row (recognized by
// isTemplateNotesRow and reported as a skip, so leaving it in on re-upload
// is harmless); rows 3-4 are worked examples (an individual with a spouse, a
// business with an officer contact) showing the multi-contact-slot shape.
// client_owner_email/office are left blank in the examples since real values
// must match this firm's data — and the examples are ordinary rows, so the
// preview step shows them as creates unless the user deletes them.
const TEMPLATE_COLUMNS = [
  'name',
  'client_owner_email',
  'client_owner_name',
  'office',
  'client_type',
  'entity_type',
  'external_id',
  'filing_status',
  'pipeline_stage',
  'terms_days',
  'invoice_consolidation_preference',
  'tags',
  'mailing_street1',
  'mailing_street2',
  'mailing_city',
  'mailing_state',
  'mailing_postal',
  'mailing_country',
  'taxpayer_name',
  'taxpayer_email',
  'taxpayer_phone',
  'taxpayer_mobile',
  'spouse_name',
  'spouse_email',
  'spouse_mobile',
  'contact3_name',
  'contact3_email',
  'contact3_role',
  'billing_contact_name',
  'billing_contact_email',
] as const;
type TemplateColumn = (typeof TEMPLATE_COLUMNS)[number];

const TEMPLATE_NOTES: Record<TemplateColumn, string> = {
  name: 'Client display name (required)',
  client_owner_email: "Existing staff owner's email; blank uses the import default",
  client_owner_name: 'Alternative to client_owner_email; email wins when both are set',
  office: 'Office name, exact match; blank uses the import default',
  client_type: 'INDIVIDUAL or BUSINESS (defaults to BUSINESS)',
  entity_type:
    'BUSINESS legal/tax entity: SOLE_PROPRIETOR, JOINT_VENTURE, PARTNERSHIP_1065, S_CORP_1120S, C_CORP_1120, EXEMPT_ORG_990, TRUST_1041, ESTATE_706, GIFT_709, OTHER',
  external_id: 'Your own record id; matches an existing client to update it',
  filing_status: 'SINGLE, MFJ, MFS, HOH, or QW',
  pipeline_stage: 'PROSPECT, CLIENT, or OTHER',
  terms_days: 'Invoice due terms in days, 0-365',
  invoice_consolidation_preference: 'CONSOLIDATED or SEPARATE',
  tags: 'Semicolon- or pipe-separated list',
  mailing_street1: 'Mailing address line 1',
  mailing_street2: 'Mailing address line 2 (suite, unit)',
  mailing_city: 'Mailing city',
  mailing_state: 'Mailing state or province',
  mailing_postal: 'Mailing ZIP or postal code',
  mailing_country: 'Mailing country',
  taxpayer_name: 'Primary contact full name',
  taxpayer_email: 'Primary contact email',
  taxpayer_phone: 'Primary contact phone',
  taxpayer_mobile: 'Primary contact mobile',
  spouse_name: 'Secondary contact full name',
  spouse_email: 'Secondary contact email',
  spouse_mobile: 'Secondary contact mobile',
  contact3_name: 'Extra contact full name',
  contact3_email: 'Extra contact email',
  contact3_role: "Extra contact's role, e.g. Officer",
  billing_contact_name: 'Billing contact name; defaults to the primary contact',
  billing_contact_email: 'Billing contact email',
};

const TEMPLATE_SAMPLE_ROWS: Record<TemplateColumn, string>[] = [
  {
    name: 'Doe, John & Jane',
    client_owner_email: '',
    client_owner_name: '',
    office: '',
    client_type: 'INDIVIDUAL',
    entity_type: '',
    external_id: '1040-DOE-2026',
    filing_status: 'MFJ',
    pipeline_stage: 'CLIENT',
    terms_days: '30',
    invoice_consolidation_preference: 'CONSOLIDATED',
    tags: '1040;VIP',
    mailing_street1: '123 Main St',
    mailing_street2: '',
    mailing_city: 'Springfield',
    mailing_state: 'IL',
    mailing_postal: '62704',
    mailing_country: 'US',
    taxpayer_name: 'John Doe',
    taxpayer_email: 'john.doe@example.com',
    taxpayer_phone: '217-555-0101',
    taxpayer_mobile: '217-555-0102',
    spouse_name: 'Jane Doe',
    spouse_email: 'jane.doe@example.com',
    spouse_mobile: '217-555-0103',
    contact3_name: '',
    contact3_email: '',
    contact3_role: '',
    billing_contact_name: '',
    billing_contact_email: '',
  },
  {
    name: 'Acme Manufacturing LLC',
    client_owner_email: '',
    client_owner_name: '',
    office: '',
    client_type: 'BUSINESS',
    entity_type: 'S_CORP_1120S',
    external_id: 'ACME-01',
    filing_status: '',
    pipeline_stage: 'CLIENT',
    terms_days: '15',
    invoice_consolidation_preference: 'SEPARATE',
    tags: '1120-S;monthly-bookkeeping',
    mailing_street1: '500 Industrial Pkwy',
    mailing_street2: 'Suite 210',
    mailing_city: 'Springfield',
    mailing_state: 'IL',
    mailing_postal: '62711',
    mailing_country: 'US',
    taxpayer_name: 'Alex Owner',
    taxpayer_email: 'alex@acme.example',
    taxpayer_phone: '217-555-0201',
    taxpayer_mobile: '',
    spouse_name: '',
    spouse_email: '',
    spouse_mobile: '',
    contact3_name: 'Morgan Officer',
    contact3_email: 'morgan@acme.example',
    contact3_role: 'Officer',
    billing_contact_name: 'AP Department',
    billing_contact_email: 'ap@acme.example',
  },
];

export function buildImportTemplateCsv(): string {
  const lines = [
    TEMPLATE_COLUMNS.join(','),
    TEMPLATE_COLUMNS.map((c, i) =>
      csvField(i === 0 ? `#${TEMPLATE_NOTES[c]}` : TEMPLATE_NOTES[c]),
    ).join(','),
    ...TEMPLATE_SAMPLE_ROWS.map((row) => TEMPLATE_COLUMNS.map((c) => csvField(row[c])).join(',')),
  ];
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- columns

// Exported so a test can assert the template offers every one of them —
// the template is meant to be a complete description of the client-level
// import surface, not a subset someone remembered to update.
export const CANONICAL_FIELDS = [
  'name',
  'client_owner_email',
  'client_owner_name',
  'office',
  'client_type',
  'entity_type',
  'external_id',
  'filing_status',
  'pipeline_stage',
  'terms_days',
  'invoice_consolidation_preference',
  'tags',
  'mailing_street1',
  'mailing_street2',
  'mailing_city',
  'mailing_state',
  'mailing_postal',
  'mailing_country',
] as const;
type CanonicalField = (typeof CANONICAL_FIELDS)[number];

// Header aliases → canonical field. Keys are normalized (lowercased, any
// run of non-alphanumeric collapsed to a single underscore).
const ALIASES: Record<string, CanonicalField> = {
  name: 'name',
  client_name: 'name',
  client_owner_email: 'client_owner_email',
  owner_email: 'client_owner_email',
  partner_email: 'client_owner_email',
  client_owner_name: 'client_owner_name',
  owner: 'client_owner_name',
  owner_name: 'client_owner_name',
  partner: 'client_owner_name',
  client_owner: 'client_owner_name',
  office: 'office',
  office_name: 'office',
  client_type: 'client_type',
  type: 'client_type',
  // 0212 — legal/tax entity for BUSINESS clients. Left optional here to
  // match the API's own nullable contract: client_type defaults to
  // BUSINESS, so requiring it would break every existing name-only import.
  entity_type: 'entity_type',
  entity: 'entity_type',
  business_entity_type: 'entity_type',
  external_id: 'external_id',
  externalid: 'external_id',
  filing_status: 'filing_status',
  pipeline_stage: 'pipeline_stage',
  stage: 'pipeline_stage',
  terms_days: 'terms_days',
  terms: 'terms_days',
  invoice_consolidation_preference: 'invoice_consolidation_preference',
  consolidation: 'invoice_consolidation_preference',
  tags: 'tags',
  mailing_street1: 'mailing_street1',
  street1: 'mailing_street1',
  address: 'mailing_street1',
  mailing_street2: 'mailing_street2',
  street2: 'mailing_street2',
  mailing_city: 'mailing_city',
  city: 'mailing_city',
  mailing_state: 'mailing_state',
  state: 'mailing_state',
  mailing_postal: 'mailing_postal',
  postal: 'mailing_postal',
  zip: 'mailing_postal',
  mailing_country: 'mailing_country',
  country: 'mailing_country',
};

// ---------------------------------------------------------------- contacts
//
// Contacts are extracted per "slot" so multiple people can attach to one
// client (taxpayer + spouse for a 1040, plus officers for a business). Each
// slot maps a set of header bases to name/email/phone/mobile/role columns.
// The taxpayer/primary slot is the primary contact; the billing slot is the
// billing contact. Bare `email`/`phone`/`mobile` and the legacy
// `billing_contact_*` map to the billing slot for backward compatibility.
const CONTACT_ATTRS = ['name', 'email', 'phone', 'mobile', 'role'] as const;
type ContactAttr = (typeof CONTACT_ATTRS)[number];

interface ContactSlot {
  slot: string;
  bases: string[];
  primary?: boolean;
  billing?: boolean;
}
const CONTACT_SLOTS: ContactSlot[] = [
  { slot: 'taxpayer', bases: ['taxpayer', 'primary_contact', 'primary'], primary: true },
  { slot: 'spouse', bases: ['spouse'] },
  { slot: 'billing', bases: ['billing_contact', 'billing'], billing: true },
  { slot: 'contact3', bases: ['contact3', 'contact_3', 'contact'] },
  { slot: 'contact4', bases: ['contact4', 'contact_4'] },
  { slot: 'contact5', bases: ['contact5', 'contact_5'] },
  { slot: 'contact6', bases: ['contact6', 'contact_6'] },
];

/** slot key → attr → column index. Also folds the bare backward-compat aliases. */
function mapContactColumns(header: string[]): Map<string, Partial<Record<ContactAttr, number>>> {
  const bySlot = new Map<string, Partial<Record<ContactAttr, number>>>();
  const setCol = (slot: string, attr: ContactAttr, idx: number): void => {
    const m = bySlot.get(slot) ?? {};
    if (m[attr] === undefined) m[attr] = idx;
    bySlot.set(slot, m);
  };
  header.forEach((raw, idx) => {
    const h = normalizeHeader(raw);
    for (const s of CONTACT_SLOTS) {
      for (const base of s.bases) {
        if (h === base || h === `${base}_name`) return void setCol(s.slot, 'name', idx);
        if (h === `${base}_email`) return void setCol(s.slot, 'email', idx);
        if (h === `${base}_phone`) return void setCol(s.slot, 'phone', idx);
        if (h === `${base}_mobile` || h === `${base}_cell` || h === `${base}_cellphone`)
          return void setCol(s.slot, 'mobile', idx);
        if (h === `${base}_role`) return void setCol(s.slot, 'role', idx);
      }
    }
    // Bare aliases → billing slot (legacy single-contact behavior).
    if (h === 'email') return void setCol('billing', 'email', idx);
    if (h === 'phone') return void setCol('billing', 'phone', idx);
    if (h === 'mobile' || h === 'cell') return void setCol('billing', 'mobile', idx);
  });
  return bySlot;
}

interface PreparedContact {
  key: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  roleId: string | null;
  isPrimary: boolean;
  isBilling: boolean;
}

function digitsOf(v: string | null): string {
  return v ? v.replace(/\D/g, '') : '';
}

/** Build the per-row contact list, deduped, with exactly one primary + billing. */
function extractContacts(
  row: string[],
  contactCols: Map<string, Partial<Record<ContactAttr, number>>>,
  clientName: string,
  roleByName: Map<string, string>,
): PreparedContact[] {
  const out: PreparedContact[] = [];
  for (const s of CONTACT_SLOTS) {
    const cols = contactCols.get(s.slot);
    if (!cols) continue;
    const email = cell(row, cols.email) || null;
    const phone = cell(row, cols.phone) || null;
    const mobile = cell(row, cols.mobile) || null;
    let fullName = cell(row, cols.name) || null;
    if (!email && !phone && !mobile && !fullName) continue;
    if (!fullName) {
      // No name: legacy billing rows fall back to the client name; otherwise
      // derive a usable name from the email local-part (person needs a name).
      fullName = s.billing ? clientName : email ? (email.split('@')[0] ?? null) : (phone ?? mobile);
    }
    if (!fullName) continue;
    const key = email
      ? `e:${email.toLowerCase()}`
      : phone
        ? `p:${digitsOf(phone)}`
        : mobile
          ? `m:${digitsOf(mobile)}`
          : `n:${fullName.toLowerCase()}:${s.slot}`;
    const dupe = out.find((c) => c.key === key);
    if (dupe) {
      if (s.primary) dupe.isPrimary = true;
      if (s.billing) dupe.isBilling = true;
      continue;
    }
    const roleName = (cell(row, cols.role) || '').toLowerCase();
    out.push({
      key,
      fullName: fullName.slice(0, 200),
      email,
      phone,
      mobile,
      roleId: roleName ? (roleByName.get(roleName) ?? null) : null,
      isPrimary: Boolean(s.primary),
      isBilling: Boolean(s.billing),
    });
  }
  if (out.length === 0) return out;
  // Exactly one primary (designated, else the first) and one billing (designated,
  // else the primary) — the schema enforces one of each per client.
  if (!out.some((c) => c.isPrimary)) out[0]!.isPrimary = true;
  let sawPrimary = false;
  for (const c of out) {
    if (c.isPrimary && sawPrimary) c.isPrimary = false;
    else if (c.isPrimary) sawPrimary = true;
  }
  if (!out.some((c) => c.isBilling)) (out.find((c) => c.isPrimary) ?? out[0]!).isBilling = true;
  let sawBilling = false;
  for (const c of out) {
    if (c.isBilling && sawBilling) c.isBilling = false;
    else if (c.isBilling) sawBilling = true;
  }
  return out;
}

function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Build a canonical-field → column-index map by header name. */
function autoMap(header: string[]): Partial<Record<CanonicalField, number>> {
  const map: Partial<Record<CanonicalField, number>> = {};
  header.forEach((h, idx) => {
    const field = ALIASES[normalizeHeader(h)];
    if (field && map[field] === undefined) map[field] = idx;
  });
  return map;
}

// ---------------------------------------------------------------- validate

const CLIENT_TYPES = new Set(['INDIVIDUAL', 'BUSINESS']);
// 0212 — derived from the pgEnum rather than hand-copied, so a new entity
// type becomes importable without a second edit here.
const ENTITY_TYPES = new Set<string>(clientEntityType.enumValues);
const FILING_STATUSES = new Set(['SINGLE', 'MFJ', 'MFS', 'HOH', 'QW']);
const PIPELINE_STAGES = new Set(['PROSPECT', 'CLIENT', 'OTHER']);
const CONSOLIDATION = new Set(['CONSOLIDATED', 'SEPARATE']);

interface ClientContactState {
  personIds: Set<string>;
  hasPrimary: boolean;
  hasBilling: boolean;
}
interface LookupContext {
  ownerByEmail: Map<string, string>;
  ownerByName: Map<string, string>;
  officeByName: Map<string, string>;
  // externalId / lower(name) → existing client id (for upsert-onto-existing).
  clientIdByExternalId: Map<string, string>;
  clientIdByName: Map<string, string>;
  // lower(role name) → contact_role id.
  roleByName: Map<string, string>;
  // existing client id → its current contact state (dedupe + primary/billing).
  contactsByClient: Map<string, ClientContactState>;
  defaultOwnerId: string | null;
  defaultOfficeId: string | null;
}

type ClientInsert = typeof clients.$inferInsert;
interface PreparedRow {
  mode: 'create' | 'update';
  // create: validated column values (name / partnerInChargeId / officeId set).
  values?: Record<string, unknown>;
  // update: the existing client to attach contacts to.
  clientId?: string;
  contacts: PreparedContact[];
}

export type RowOutcome =
  | {
      row: number;
      action: 'create';
      name: string;
      contactCount: number;
      ownerResolved: boolean;
      officeResolved: boolean;
    }
  | { row: number; action: 'update'; name: string; contactCount: number }
  | { row: number; action: 'skip'; name: string; reason: string };

interface ValidationResult {
  outcomes: RowOutcome[];
  prepared: Array<{ rowIndex: number; prepared: PreparedRow }>;
  willCreate: number;
  willUpdate: number;
  willSkip: number;
}

function cell(row: string[], idx: number | undefined): string {
  if (idx === undefined) return '';
  return (row[idx] ?? '').trim();
}

/**
 * Pure validation pass — never writes. Produces per-row outcomes plus the
 * prepared values. A row matching an EXISTING client (external_id, else a
 * case-insensitive name) becomes an `update` that attaches any new contacts
 * (upsert); a non-matching row is a `create`. Within-file duplicate keys among
 * NEW clients are still skipped so a file can't create the same client twice.
 * Contacts are extracted from the taxpayer/spouse/billing/contactN slots.
 */
export function validateImportRows(
  ctx: LookupContext,
  header: string[],
  rows: string[][],
  mapping: Partial<Record<CanonicalField, number>>,
): ValidationResult {
  const contactCols = mapContactColumns(header);
  const outcomes: RowOutcome[] = [];
  const prepared: Array<{ rowIndex: number; prepared: PreparedRow }> = [];
  const seenExternalIds = new Set<string>();
  const seenNames = new Set<string>();
  let willCreate = 0;
  let willUpdate = 0;
  let willSkip = 0;

  rows.forEach((row, i) => {
    // The template's column-notes row, left in place by a user who didn't
    // delete it. Reported as a skip (not silently dropped) so the preview
    // accounts for every line in the file.
    if (isTemplateNotesRow(row, i)) {
      outcomes.push({ row: i, action: 'skip', name: '', reason: 'template_notes_row' });
      willSkip++;
      return;
    }
    const name = cell(row, mapping.name);
    if (!name) {
      outcomes.push({ row: i, action: 'skip', name: '', reason: 'missing_name' });
      willSkip++;
      return;
    }
    const skip = (reason: string): void => {
      outcomes.push({ row: i, action: 'skip', name, reason });
      willSkip++;
    };

    // Existing-client match → upsert contacts onto it (no client edits).
    const externalId = cell(row, mapping.external_id);
    const nameKey = name.toLowerCase();
    const existingClientId = externalId
      ? (ctx.clientIdByExternalId.get(externalId) ?? null)
      : (ctx.clientIdByName.get(nameKey) ?? null);
    if (existingClientId) {
      const contacts = extractContacts(row, contactCols, name, ctx.roleByName);
      prepared.push({
        rowIndex: i,
        prepared: { mode: 'update', clientId: existingClientId, contacts },
      });
      outcomes.push({ row: i, action: 'update', name, contactCount: contacts.length });
      willUpdate++;
      return;
    }

    // Owner resolution: row email, then row name, then default owner.
    const ownerEmail = cell(row, mapping.client_owner_email).toLowerCase();
    const ownerName = cell(row, mapping.client_owner_name).toLowerCase();
    let ownerId: string | null = null;
    if (ownerEmail) ownerId = ctx.ownerByEmail.get(ownerEmail) ?? null;
    else if (ownerName) ownerId = ctx.ownerByName.get(ownerName) ?? null;
    if (!ownerId) ownerId = ctx.defaultOwnerId;
    if (!ownerId) {
      skip(ownerEmail || ownerName ? 'owner_not_found' : 'owner_required');
      return;
    }

    // Office resolution: row office name, then default office.
    const officeName = cell(row, mapping.office).toLowerCase();
    let officeId: string | null = null;
    if (officeName) {
      officeId = ctx.officeByName.get(officeName) ?? null;
      if (!officeId) {
        skip('office_not_found');
        return;
      }
    } else {
      officeId = ctx.defaultOfficeId;
    }
    if (!officeId) {
      skip('no_office_available');
      return;
    }

    // Enum validation.
    const clientType = cell(row, mapping.client_type).toUpperCase();
    if (clientType && !CLIENT_TYPES.has(clientType)) return skip('invalid_client_type');
    // Accept the friendlier spellings a spreadsheet is likely to carry
    // ("S-Corp 1120S", "s_corp_1120s") by normalising to the enum shape.
    const entityRaw = cell(row, mapping.entity_type);
    const entityType = entityRaw
      ? entityRaw
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
      : '';
    if (entityType && !ENTITY_TYPES.has(entityType)) return skip('invalid_entity_type');
    const filingStatus = cell(row, mapping.filing_status).toUpperCase();
    if (filingStatus && !FILING_STATUSES.has(filingStatus)) return skip('invalid_filing_status');
    const pipelineStage = cell(row, mapping.pipeline_stage).toUpperCase();
    if (pipelineStage && !PIPELINE_STAGES.has(pipelineStage)) return skip('invalid_pipeline_stage');
    const consolidation = cell(row, mapping.invoice_consolidation_preference).toUpperCase();
    if (consolidation && !CONSOLIDATION.has(consolidation)) return skip('invalid_consolidation');

    const termsRaw = cell(row, mapping.terms_days);
    let termsDays: number | undefined;
    if (termsRaw) {
      const n = Number(termsRaw);
      if (!Number.isInteger(n) || n < 0 || n > 365) return skip('invalid_terms_days');
      termsDays = n;
    }

    // Within-file dedupe among NEW clients (existing ones took the update path
    // above), so a file can't create the same client twice.
    if (externalId) {
      if (seenExternalIds.has(externalId)) return skip('duplicate_external_id');
      seenExternalIds.add(externalId);
    } else {
      if (seenNames.has(nameKey)) return skip('duplicate_name');
      seenNames.add(nameKey);
    }

    const tagsRaw = cell(row, mapping.tags);
    const tags = tagsRaw
      ? tagsRaw
          .split(/[;|]/)
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 20)
      : undefined;

    const values: Record<string, unknown> = {
      name: name.slice(0, 200),
      partnerInChargeId: ownerId,
      officeId,
    };
    if (clientType) values['clientType'] = clientType;
    if (entityType) values['entityType'] = entityType;
    if (externalId) values['externalId'] = externalId.slice(0, 120);
    if (filingStatus) values['filingStatus'] = filingStatus;
    if (pipelineStage) values['pipelineStage'] = pipelineStage;
    if (consolidation) values['invoiceConsolidationPreference'] = consolidation;
    if (termsDays !== undefined) values['termsDays'] = termsDays;
    if (tags && tags.length) values['tags'] = tags;
    const addr: Array<[string, CanonicalField]> = [
      ['mailingStreet1', 'mailing_street1'],
      ['mailingStreet2', 'mailing_street2'],
      ['mailingCity', 'mailing_city'],
      ['mailingState', 'mailing_state'],
      ['mailingPostal', 'mailing_postal'],
      ['mailingCountry', 'mailing_country'],
    ];
    for (const [col, field] of addr) {
      const v = cell(row, mapping[field]);
      if (v) values[col] = v.slice(0, 200);
    }

    const contacts = extractContacts(row, contactCols, name, ctx.roleByName);

    prepared.push({ rowIndex: i, prepared: { mode: 'create', values, contacts } });
    outcomes.push({
      row: i,
      action: 'create',
      name,
      contactCount: contacts.length,
      ownerResolved: Boolean(ownerEmail || ownerName),
      officeResolved: Boolean(officeName),
    });
    willCreate++;
  });

  return { outcomes, prepared, willCreate, willUpdate, willSkip };
}

// ---------------------------------------------------------------- lookups

async function buildContext(
  db: Database,
  firmId: string,
  defaultOwnerId: string | null,
  defaultOfficeName: string | null,
): Promise<LookupContext> {
  const owners = await db
    .select({ id: appUsers.id, email: appUsers.email, name: appUsers.fullName })
    .from(appUsers)
    .where(eq(appUsers.firmId, firmId));
  const ownerByEmail = new Map<string, string>();
  const ownerByName = new Map<string, string>();
  for (const o of owners) {
    if (o.email) ownerByEmail.set(o.email.toLowerCase(), o.id);
    if (o.name) ownerByName.set(o.name.toLowerCase(), o.id);
  }

  const officeRows = await db
    .select({ id: offices.id, name: offices.name, isDefault: offices.isDefault })
    .from(offices)
    .where(eq(offices.firmId, firmId));
  const officeByName = new Map<string, string>();
  let firmDefaultOfficeId: string | null = null;
  for (const o of officeRows) {
    officeByName.set(o.name.toLowerCase(), o.id);
    if (o.isDefault && !firmDefaultOfficeId) firmDefaultOfficeId = o.id;
  }
  if (!firmDefaultOfficeId && officeRows[0]) firmDefaultOfficeId = officeRows[0].id;
  const defaultOfficeId = defaultOfficeName
    ? (officeByName.get(defaultOfficeName.toLowerCase()) ?? null)
    : firmDefaultOfficeId;

  // Existing clients → id (external_id primary, name fallback) for upsert.
  const clientRows = await db
    .select({ id: clients.id, name: clients.name, externalId: clients.externalId })
    .from(clients)
    .where(eq(clients.firmId, firmId));
  const clientIdByExternalId = new Map<string, string>();
  const clientIdByName = new Map<string, string>();
  for (const r of clientRows) {
    if (r.externalId) clientIdByExternalId.set(r.externalId, r.id);
    if (!clientIdByName.has(r.name.toLowerCase())) clientIdByName.set(r.name.toLowerCase(), r.id);
  }

  // Contact roles by name (for the *_role columns).
  const roleRows = await db
    .select({ id: contactRoles.id, name: contactRoles.name })
    .from(contactRoles)
    .where(eq(contactRoles.firmId, firmId));
  const roleByName = new Map<string, string>();
  for (const r of roleRows) roleByName.set(r.name.toLowerCase(), r.id);

  // Current contacts per client — used on upsert to avoid duplicating a person
  // and to not violate the one-primary / one-billing-per-client indexes.
  const contactRows = await db
    .select({
      clientId: clientContacts.clientId,
      personId: clientContacts.personId,
      isPrimary: clientContacts.isPrimary,
      isBilling: clientContacts.isBilling,
    })
    .from(clientContacts)
    .innerJoin(clients, eq(clients.id, clientContacts.clientId))
    .where(eq(clients.firmId, firmId));
  const contactsByClient = new Map<string, ClientContactState>();
  for (const r of contactRows) {
    const state = contactsByClient.get(r.clientId) ?? {
      personIds: new Set<string>(),
      hasPrimary: false,
      hasBilling: false,
    };
    state.personIds.add(r.personId);
    if (r.isPrimary) state.hasPrimary = true;
    if (r.isBilling) state.hasBilling = true;
    contactsByClient.set(r.clientId, state);
  }

  // Validate the default owner belongs to the firm.
  const resolvedDefaultOwner =
    defaultOwnerId && owners.some((o) => o.id === defaultOwnerId) ? defaultOwnerId : null;

  return {
    ownerByEmail,
    ownerByName,
    officeByName,
    clientIdByExternalId,
    clientIdByName,
    roleByName,
    contactsByClient,
    defaultOwnerId: resolvedDefaultOwner,
    defaultOfficeId,
  };
}

// ---------------------------------------------------------------- routes

const PreviewSchema = z.object({
  csv: z.string().min(1).max(5_000_000),
  defaultOwnerId: z.string().uuid().optional(),
  defaultOfficeName: z.string().max(200).optional(),
});

const MAX_ROWS = 5000;

function ip(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

export function mountClientImportRoutes(router: Router, deps: ClientImportDeps): void {
  router.get(
    '/import/template',
    requirePermission(deps, 'client:write'),
    (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="client-import-template.csv"');
      res.send(buildImportTemplateCsv());
    },
  );

  router.post(
    '/import/preview',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const parsed = PreviewSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (!deps.db) {
        res.json({ columns: [], total: 0, willCreate: 0, willUpdate: 0, willSkip: 0, rows: [] });
        return;
      }
      const firmId = req.staffSession!.firmId;
      const { header, rows } = parseCsv(parsed.data.csv);
      if (header.length === 0) {
        res.status(400).json({ error: 'empty_csv' });
        return;
      }
      if (rows.length > MAX_ROWS) {
        res.status(400).json({ error: 'too_many_rows', max: MAX_ROWS });
        return;
      }
      const mapping = autoMap(header);
      if (mapping.name === undefined) {
        res.status(400).json({ error: 'missing_name_column', columns: header });
        return;
      }
      const ctx = await buildContext(
        deps.db,
        firmId,
        parsed.data.defaultOwnerId ?? null,
        parsed.data.defaultOfficeName ?? null,
      );
      const result = validateImportRows(ctx, header, rows, mapping);
      res.json({
        columns: header,
        mappedColumns: Object.keys(mapping),
        total: rows.length,
        willCreate: result.willCreate,
        willUpdate: result.willUpdate,
        willSkip: result.willSkip,
        rows: result.outcomes,
      });
    },
  );

  router.post(
    '/import/commit',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const parsed = PreviewSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (!deps.db) {
        res.json({ created: 0, skipped: [], createdIds: [] });
        return;
      }
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      const { header, rows } = parseCsv(parsed.data.csv);
      if (header.length === 0) {
        res.status(400).json({ error: 'empty_csv' });
        return;
      }
      if (rows.length > MAX_ROWS) {
        res.status(400).json({ error: 'too_many_rows', max: MAX_ROWS });
        return;
      }
      const mapping = autoMap(header);
      if (mapping.name === undefined) {
        res.status(400).json({ error: 'missing_name_column', columns: header });
        return;
      }
      // Re-validate from scratch — never trust a client-submitted preview.
      const ctx = await buildContext(
        deps.db,
        firmId,
        parsed.data.defaultOwnerId ?? null,
        parsed.data.defaultOfficeName ?? null,
      );
      const result = validateImportRows(ctx, header, rows, mapping);
      const skipped = result.outcomes
        .filter((o): o is Extract<RowOutcome, { action: 'skip' }> => o.action === 'skip')
        .map((o) => ({ row: o.row, reason: o.reason }));

      const createdIds: string[] = [];
      let updated = 0;
      let contactsAdded = 0;
      try {
        await deps.db.transaction(async (tx) => {
          // Attach a contact to a client, honoring the one-primary/one-billing
          // indexes via the running per-client state. Returns true if inserted.
          const attach = async (
            clientId: string,
            state: ClientContactState,
            c: PreparedContact,
          ): Promise<boolean> => {
            const personId = await findOrCreatePerson(tx, {
              firmId,
              fullName: c.fullName,
              email: c.email,
              phone: c.phone,
              mobile: c.mobile,
            });
            if (state.personIds.has(personId)) return false; // already linked
            const isPrimary = c.isPrimary && !state.hasPrimary;
            const isBilling = c.isBilling && !state.hasBilling;
            await tx.insert(clientContacts).values({
              clientId,
              personId,
              roleId: c.roleId,
              isPrimary,
              isBilling,
            });
            state.personIds.add(personId);
            if (isPrimary) state.hasPrimary = true;
            if (isBilling) state.hasBilling = true;
            return true;
          };

          for (const { prepared } of result.prepared) {
            if (prepared.mode === 'create') {
              const [newRow] = await tx
                .insert(clients)
                // reason: validateImportRows guarantees the required columns
                // (name/partnerInChargeId/officeId) and validates enum values.
                .values({ firmId, ...prepared.values } as ClientInsert)
                .returning({ id: clients.id });
              if (!newRow) continue;
              createdIds.push(newRow.id);
              const state: ClientContactState = {
                personIds: new Set(),
                hasPrimary: false,
                hasBilling: false,
              };
              for (const c of prepared.contacts) {
                if (await attach(newRow.id, state, c)) contactsAdded++;
              }
            } else {
              // Upsert contacts onto an existing client.
              const cid = prepared.clientId!;
              const state = ctx.contactsByClient.get(cid) ?? {
                personIds: new Set<string>(),
                hasPrimary: false,
                hasBilling: false,
              };
              ctx.contactsByClient.set(cid, state);
              let touched = false;
              for (const c of prepared.contacts) {
                if (await attach(cid, state, c)) {
                  contactsAdded++;
                  touched = true;
                }
              }
              if (touched) updated++;
            }
          }
        });
      } catch (err) {
        // Post-validation DB fault (e.g. a race on the external_id unique
        // index) → roll back the whole batch so the operator can fix and
        // re-run cleanly rather than land a partial import.
        logger.error({ err }, 'client csv import rolled back');
        res.status(409).json({ error: 'import_conflict' });
        return;
      }

      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client',
        entityId: createdIds[0],
        actorAppUserId: session.appUserId,
        after: {
          kind: 'csv_import',
          created: createdIds.length,
          updated,
          contactsAdded,
          skipped: skipped.length,
        },
        ip: ip(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      res.json({ created: createdIds.length, createdIds, updated, contactsAdded, skipped });
    },
  );
}
