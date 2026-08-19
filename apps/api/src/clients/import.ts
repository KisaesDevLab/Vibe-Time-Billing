// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Q36 — CSV / XLSX client import. A two-step flow: POST /import/preview
// runs a dry-run (parse + validate, no writes) and reports per-row
// create/update/skip decisions with reasons; POST /import/commit
// re-validates and writes in a single transaction. A row matching an
// existing client (by external_id — which is also where a tax-software
// "Client ID" lands — then case-insensitive name within the firm) attaches
// any new contacts to it and — only when the caller opts in with
// `updateExisting` — rewrites the mapped client columns. Mirrors the portal-invite bulk CSV style (skip
// rows with reasons) but is all-or-nothing on unexpected DB faults so a
// 200-client onboarding file can be fixed and re-run cleanly.
//
// Header matching is alias-driven and also understands the UltraTax CS
// "Data Mining" export layout (Client ID, "1040, Tp first name",
// "Contact, Sp email address", "Preparer name", …) so that workbook can be
// uploaded as exported.

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
import { normalizeFilingStatus } from '../lib/filing-status';
import { parseXlsx, XlsxParseError } from '../lib/xlsx';
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
  'client_facing_name',
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
  client_facing_name: 'Name shown to the client (e.g. "John & Jane Doe"); blank uses name',
  client_owner_email: "Existing staff owner's email; blank uses the import default",
  client_owner_name:
    'Alternative to client_owner_email (also: preparer_name); email wins when both are set',
  office: 'Office name, exact match; blank uses the import default',
  client_type: 'INDIVIDUAL or BUSINESS (defaults to BUSINESS)',
  entity_type:
    'BUSINESS legal/tax entity: SOLE_PROPRIETOR, JOINT_VENTURE, PARTNERSHIP_1065, S_CORP_1120S, C_CORP_1120, EXEMPT_ORG_990, TRUST_1041, ESTATE_706, GIFT_709, OTHER (tax-software codes I/S/C/P/F/X also accepted)',
  external_id:
    'The client id — your own, or the tax-software one (UltraTax "Client ID"); matches an existing client to update it',
  filing_status: 'SINGLE, MFJ, MFS, HOH, or QW (spelled-out labels also accepted)',
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
  taxpayer_name: 'Primary contact full name (or taxpayer_first_name + taxpayer_last_name)',
  taxpayer_email: 'Primary contact email',
  taxpayer_phone: 'Primary contact phone',
  taxpayer_mobile: 'Primary contact mobile',
  spouse_name: 'Secondary contact full name (or spouse_first_name + spouse_last_name)',
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
    client_facing_name: 'John & Jane Doe',
    client_owner_email: '',
    client_owner_name: '',
    office: '',
    client_type: 'INDIVIDUAL',
    entity_type: '',
    external_id: 'DOEJ1234',
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
    client_facing_name: '',
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
  'client_facing_name',
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
  client_facing_name: 'client_facing_name',
  // UltraTax data mining: "Client name (first last)".
  client_name_first_last: 'client_facing_name',
  display_name: 'client_facing_name',
  client_owner_email: 'client_owner_email',
  owner_email: 'client_owner_email',
  partner_email: 'client_owner_email',
  preparer_email: 'client_owner_email',
  client_owner_name: 'client_owner_name',
  owner: 'client_owner_name',
  owner_name: 'client_owner_name',
  partner: 'client_owner_name',
  client_owner: 'client_owner_name',
  // UltraTax: the preparer is the closest thing to a client owner.
  preparer: 'client_owner_name',
  preparer_name: 'client_owner_name',
  office: 'office',
  office_name: 'office',
  // UltraTax data-mining office item labels.
  client_office: 'office',
  office_location: 'office',
  location: 'office',
  client_type: 'client_type',
  type: 'client_type',
  // 0212 — legal/tax entity for BUSINESS clients. Left optional here to
  // match the API's own nullable contract: client_type defaults to
  // BUSINESS, so requiring it would break every existing name-only import.
  entity_type: 'entity_type',
  entity: 'entity_type',
  business_entity_type: 'entity_type',
  // UltraTax: "Federal entity type" (I / S / C / P / F / X letter codes).
  federal_entity_type: 'entity_type',
  external_id: 'external_id',
  externalid: 'external_id',
  // The tax-software client id IS the client id — UltraTax "Client ID" etc.
  client_id: 'external_id',
  ut_client_id: 'external_id',
  ultratax_client_id: 'external_id',
  ultratax_id: 'external_id',
  tax_software_id: 'external_id',
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
  street_1: 'mailing_street1',
  address: 'mailing_street1',
  address_1: 'mailing_street1',
  address1: 'mailing_street1',
  contact_address_1: 'mailing_street1',
  mailing_street2: 'mailing_street2',
  street2: 'mailing_street2',
  street_2: 'mailing_street2',
  address_2: 'mailing_street2',
  address2: 'mailing_street2',
  contact_address_2: 'mailing_street2',
  mailing_city: 'mailing_city',
  city: 'mailing_city',
  contact_city: 'mailing_city',
  mailing_state: 'mailing_state',
  state: 'mailing_state',
  contact_state: 'mailing_state',
  mailing_postal: 'mailing_postal',
  postal: 'mailing_postal',
  postal_code: 'mailing_postal',
  zip: 'mailing_postal',
  zip_code: 'mailing_postal',
  contact_zip_code: 'mailing_postal',
  mailing_country: 'mailing_country',
  country: 'mailing_country',
};

// ---------------------------------------------------------------- contacts
//
// Contacts are extracted per "slot" so multiple people can attach to one
// client (taxpayer + spouse for a 1040, plus officers for a business). Each
// slot maps a set of header bases to name/first/last/email/phone/mobile/role
// columns. The taxpayer/primary slot is the primary contact; the billing
// slot is the billing contact. Bare `email`/`phone`/`mobile` and the legacy
// `billing_contact_*` map to the billing slot for backward compatibility.
// UltraTax data-mining headers ("1040, Tp first name", "Contact, Sp email
// address", "Contact, Mobile telephone number") normalize to the
// `1040_tp_*` / `contact_sp_*` / `contact_*` shapes handled below.
const CONTACT_ATTRS = [
  'name',
  'first_name',
  'last_name',
  'email',
  'email_fallback',
  'phone',
  'mobile',
  'role',
] as const;
type ContactAttr = (typeof CONTACT_ATTRS)[number];

interface ContactSlot {
  slot: string;
  bases: string[];
  primary?: boolean;
  billing?: boolean;
  /** contact_role.key auto-assigned when the row carries no explicit *_role. */
  defaultRoleKey?: string;
}
const CONTACT_SLOTS: ContactSlot[] = [
  {
    slot: 'taxpayer',
    bases: ['taxpayer', 'primary_contact', 'primary', '1040_tp', 'contact_tp', 'tp'],
    primary: true,
    defaultRoleKey: 'taxpayer',
  },
  { slot: 'spouse', bases: ['spouse', '1040_sp', 'contact_sp', 'sp'], defaultRoleKey: 'spouse' },
  { slot: 'billing', bases: ['billing_contact', 'billing'], billing: true },
  { slot: 'contact3', bases: ['contact3', 'contact_3', 'contact'] },
  { slot: 'contact4', bases: ['contact4', 'contact_4'] },
  { slot: 'contact5', bases: ['contact5', 'contact_5'] },
  { slot: 'contact6', bases: ['contact6', 'contact_6'] },
];

const EMAIL_SUFFIXES = ['email', 'email_address', 'e_mail'];
const PHONE_SUFFIXES = [
  'phone',
  'phone_number',
  'daytime_phone',
  'daytime_phone_number',
  'telephone',
];
const MOBILE_SUFFIXES = [
  'mobile',
  'cell',
  'cellphone',
  'cell_phone',
  'mobile_phone',
  'mobile_number',
  'mobile_telephone_number',
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
    // UltraTax data-mining specials: the un-prefixed "Contact, Mobile
    // telephone number" is the taxpayer's mobile and "Contact email address"
    // is the household email (used for the taxpayer only when the Tp email
    // column is blank). Checked before the generic loop so the `contact`
    // base (contact3 slot) doesn't claim them.
    if (h === 'contact_mobile_telephone_number') return void setCol('taxpayer', 'mobile', idx);
    if (h === 'contact_email_address') return void setCol('taxpayer', 'email_fallback', idx);
    for (const s of CONTACT_SLOTS) {
      for (const base of s.bases) {
        if (h === base || h === `${base}_name` || h === `${base}_full_name`)
          return void setCol(s.slot, 'name', idx);
        if (h === `${base}_first_name` || h === `${base}_first`)
          return void setCol(s.slot, 'first_name', idx);
        if (h === `${base}_last_name` || h === `${base}_last`)
          return void setCol(s.slot, 'last_name', idx);
        if (EMAIL_SUFFIXES.some((x) => h === `${base}_${x}`))
          return void setCol(s.slot, 'email', idx);
        if (PHONE_SUFFIXES.some((x) => h === `${base}_${x}`))
          return void setCol(s.slot, 'phone', idx);
        if (MOBILE_SUFFIXES.some((x) => h === `${base}_${x}`))
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

/**
 * Build the per-row contact list, deduped, with exactly one primary +
 * billing. Returns warnings for data quirks that were repaired rather than
 * rejected (a spouse sharing the taxpayer's email/phone keeps their own
 * person record with that field dropped — otherwise the shared key would
 * collapse the two people into one).
 */
function extractContacts(
  row: string[],
  contactCols: Map<string, Partial<Record<ContactAttr, number>>>,
  clientName: string,
  roleByName: Map<string, string>,
  roleByKey: Map<string, string>,
): { contacts: PreparedContact[]; warnings: string[] } {
  const out: PreparedContact[] = [];
  const warnings: string[] = [];
  for (const s of CONTACT_SLOTS) {
    const cols = contactCols.get(s.slot);
    if (!cols) continue;
    let email = cell(row, cols.email) || cell(row, cols.email_fallback) || null;
    let phone = cell(row, cols.phone) || null;
    let mobile = cell(row, cols.mobile) || null;
    const hasNameCols =
      cols.name !== undefined || cols.first_name !== undefined || cols.last_name !== undefined;
    let fullName: string | null = cell(row, cols.name) || null;
    if (!fullName) {
      const composed = [cell(row, cols.first_name), cell(row, cols.last_name)]
        .filter(Boolean)
        .join(' ')
        .trim();
      fullName = composed || null;
    }
    if (!email && !phone && !mobile && !fullName) continue;
    if (!fullName) {
      // The file has name columns for this slot but this row left them
      // blank (UltraTax emits stray "Sp email" cells on single filers):
      // nothing to build a person from — skip the slot rather than invent
      // a name from the email local-part.
      if (hasNameCols) continue;
      // No name column at all: legacy billing rows fall back to the client
      // name; otherwise derive a usable name from the email local-part
      // (person needs a name).
      fullName = s.billing ? clientName : email ? (email.split('@')[0] ?? null) : (phone ?? mobile);
    }
    if (!fullName) continue;

    // A spouse whose email/phone equals the taxpayer's must not be keyed
    // (here) or matched (findOrCreatePerson) into the same person — drop
    // the shared field from the spouse and flag it.
    if (s.slot === 'spouse') {
      const tp = out.find((c) => c.isPrimary);
      if (tp) {
        if (email && tp.email && email.toLowerCase() === tp.email.toLowerCase()) {
          email = null;
          warnings.push('shared_email');
        }
        const tpDigits = new Set([digitsOf(tp.phone), digitsOf(tp.mobile)].filter(Boolean));
        if (phone && tpDigits.has(digitsOf(phone))) {
          phone = null;
          warnings.push('shared_phone');
        }
        if (mobile && tpDigits.has(digitsOf(mobile))) {
          mobile = null;
          warnings.push('shared_phone');
        }
      }
    }

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
    const roleId = roleName
      ? (roleByName.get(roleName) ?? null)
      : s.defaultRoleKey
        ? (roleByKey.get(s.defaultRoleKey) ?? null)
        : null;
    out.push({
      key,
      fullName: fullName.slice(0, 200),
      email,
      phone,
      mobile,
      roleId,
      isPrimary: Boolean(s.primary),
      isBilling: Boolean(s.billing),
    });
  }
  if (out.length === 0) return { contacts: out, warnings };
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
  return { contacts: out, warnings: [...new Set(warnings)] };
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

/**
 * "Kurt W. Krueger" → "kurt krueger": lowercase, strip punctuation, keep
 * first + last token. Used as a second-chance owner match for tax-software
 * preparer names whose middle initial / punctuation differ from the staff
 * record's full_name.
 */
export function looseNameKey(name: string): string {
  const parts = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length <= 2) return parts.join(' ');
  return `${parts[0]} ${parts[parts.length - 1]}`;
}

// ---------------------------------------------------------------- validate

const CLIENT_TYPES = new Set(['INDIVIDUAL', 'BUSINESS']);
// 0212 — derived from the pgEnum rather than hand-copied, so a new entity
// type becomes importable without a second edit here.
const ENTITY_TYPES = new Set<string>(clientEntityType.enumValues);
const PIPELINE_STAGES = new Set(['PROSPECT', 'CLIENT', 'OTHER']);
const CONSOLIDATION = new Set(['CONSOLIDATED', 'SEPARATE']);

// Tax-software entity codes (UltraTax "Federal entity type" and the return
// form number) → client_type + entity_type. `I` is a 1040 individual,
// which has no business entity_type.
const ENTITY_CODES: Record<
  string,
  { clientType: 'INDIVIDUAL' | 'BUSINESS'; entityType: string | null }
> = {
  I: { clientType: 'INDIVIDUAL', entityType: null },
  IND: { clientType: 'INDIVIDUAL', entityType: null },
  INDIVIDUAL: { clientType: 'INDIVIDUAL', entityType: null },
  '1040': { clientType: 'INDIVIDUAL', entityType: null },
  S: { clientType: 'BUSINESS', entityType: 'S_CORP_1120S' },
  '1120S': { clientType: 'BUSINESS', entityType: 'S_CORP_1120S' },
  C: { clientType: 'BUSINESS', entityType: 'C_CORP_1120' },
  '1120': { clientType: 'BUSINESS', entityType: 'C_CORP_1120' },
  P: { clientType: 'BUSINESS', entityType: 'PARTNERSHIP_1065' },
  '1065': { clientType: 'BUSINESS', entityType: 'PARTNERSHIP_1065' },
  F: { clientType: 'BUSINESS', entityType: 'TRUST_1041' },
  '1041': { clientType: 'BUSINESS', entityType: 'TRUST_1041' },
  X: { clientType: 'BUSINESS', entityType: 'EXEMPT_ORG_990' },
  '990': { clientType: 'BUSINESS', entityType: 'EXEMPT_ORG_990' },
  '706': { clientType: 'BUSINESS', entityType: 'ESTATE_706' },
  '709': { clientType: 'BUSINESS', entityType: 'GIFT_709' },
};

/**
 * Normalise a spreadsheet entity value. Accepts the enum spellings
 * ("S-Corp 1120S" → S_CORP_1120S) and tax-software codes (I/S/C/P/F/X,
 * 1040/1120S/…). Returns null when unrecognised.
 */
function normalizeEntity(
  raw: string,
): { clientType: 'INDIVIDUAL' | 'BUSINESS' | null; entityType: string | null } | null {
  const norm = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!norm) return { clientType: null, entityType: null };
  if (ENTITY_TYPES.has(norm)) return { clientType: 'BUSINESS', entityType: norm };
  const code = ENTITY_CODES[norm.replace(/_/g, '')];
  if (code) return { clientType: code.clientType, entityType: code.entityType };
  return null;
}

interface ClientContactState {
  personIds: Set<string>;
  hasPrimary: boolean;
  hasBilling: boolean;
}
/** Current values of the columns the importer may rewrite on update. */
interface ExistingClient {
  id: string;
  name: string;
  clientFacingName: string | null;
  externalId: string | null;
  clientType: string;
  entityType: string | null;
  filingStatus: string | null;
  pipelineStage: string;
  invoiceConsolidationPreference: string;
  termsDays: number;
  partnerInChargeId: string;
  officeId: string;
  mailingStreet1: string | null;
  mailingStreet2: string | null;
  mailingCity: string | null;
  mailingState: string | null;
  mailingPostal: string | null;
  mailingCountry: string | null;
}
interface LookupContext {
  ownerByEmail: Map<string, string>;
  ownerByName: Map<string, string>;
  // loose "first last" key → owner id; absent when ambiguous.
  ownerByLooseName: Map<string, string>;
  ownerNameById: Map<string, string>;
  officeByName: Map<string, string>;
  // externalId / lower(name) → existing client id (for upsert-onto-existing).
  clientIdByExternalId: Map<string, string>;
  clientIdByName: Map<string, string>;
  clientById: Map<string, ExistingClient>;
  // lower(role name) / role key → contact_role id.
  roleByName: Map<string, string>;
  roleByKey: Map<string, string>;
  // existing client id → its current contact state (dedupe + primary/billing).
  contactsByClient: Map<string, ClientContactState>;
  defaultOwnerId: string | null;
  defaultOfficeId: string | null;
}

type ClientInsert = typeof clients.$inferInsert;
interface PreparedRow {
  mode: 'create' | 'update';
  // create: validated column values (name / partnerInChargeId / officeId set).
  // update (with updateExisting): the column values to rewrite.
  values?: Record<string, unknown>;
  // update: the existing client to attach contacts to.
  clientId?: string;
  // update: column keys whose value differs from the stored row.
  fieldsChanged?: string[];
  contacts: PreparedContact[];
}

export type RowOutcome =
  | {
      row: number;
      action: 'create';
      name: string;
      contactCount: number;
      ownerResolved: boolean;
      ownerName: string | null;
      officeResolved: boolean;
      warnings: string[];
    }
  | {
      row: number;
      action: 'update';
      name: string;
      contactCount: number;
      ownerName: string | null;
      fieldsChanged: string[];
      warnings: string[];
    }
  | { row: number; action: 'skip'; name: string; reason: string };

interface ValidationResult {
  outcomes: RowOutcome[];
  prepared: Array<{ rowIndex: number; prepared: PreparedRow }>;
  willCreate: number;
  willUpdate: number;
  willSkip: number;
}

export interface ValidateOptions {
  /** Rewrite mapped client columns on rows that match an existing client. */
  updateExisting?: boolean;
}

function cell(row: string[], idx: number | undefined): string {
  if (idx === undefined) return '';
  return (row[idx] ?? '').trim();
}

// Columns compared / rewritten in update mode (drizzle property names).
const UPDATABLE_COLUMNS: Array<keyof ExistingClient> = [
  'name',
  'clientFacingName',
  'externalId',
  'clientType',
  'entityType',
  'filingStatus',
  'pipelineStage',
  'invoiceConsolidationPreference',
  'termsDays',
  'partnerInChargeId',
  'officeId',
  'mailingStreet1',
  'mailingStreet2',
  'mailingCity',
  'mailingState',
  'mailingPostal',
  'mailingCountry',
];

/**
 * Pure validation pass — never writes. Produces per-row outcomes plus the
 * prepared values. A row matching an EXISTING client (external_id, else a
 * case-insensitive name) becomes an `update` that
 * attaches any new contacts (and, with `updateExisting`, rewrites the mapped
 * client columns); a non-matching row is a `create`. Within-file duplicate
 * keys among NEW clients are still skipped so a file can't create the same
 * client twice. Contacts are extracted from the taxpayer/spouse/billing/
 * contactN slots.
 */
export function validateImportRows(
  ctx: LookupContext,
  header: string[],
  rows: string[][],
  mapping: Partial<Record<CanonicalField, number>>,
  opts: ValidateOptions = {},
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
    const warnings: string[] = [];

    // Existing-client match: external_id (the client id), else name.
    const externalId = cell(row, mapping.external_id);
    const nameKey = name.toLowerCase();
    const existingClientId = externalId
      ? (ctx.clientIdByExternalId.get(externalId) ?? null)
      : (ctx.clientIdByName.get(nameKey) ?? null);
    const existing = existingClientId ? (ctx.clientById.get(existingClientId) ?? null) : null;
    const isUpdate = Boolean(existing);

    if (existing && !opts.updateExisting) {
      // Contacts-only upsert onto the existing client (no client edits).
      const { contacts, warnings: cw } = extractContacts(
        row,
        contactCols,
        name,
        ctx.roleByName,
        ctx.roleByKey,
      );
      prepared.push({
        rowIndex: i,
        prepared: { mode: 'update', clientId: existing.id, fieldsChanged: [], contacts },
      });
      outcomes.push({
        row: i,
        action: 'update',
        name,
        contactCount: contacts.length,
        ownerName: ctx.ownerNameById.get(existing.partnerInChargeId) ?? null,
        fieldsChanged: [],
        warnings: cw,
      });
      willUpdate++;
      return;
    }

    // Owner resolution: row email, then exact name, then loose name, then
    // the default owner.
    const ownerEmail = cell(row, mapping.client_owner_email).toLowerCase();
    const ownerName = cell(row, mapping.client_owner_name).toLowerCase();
    let ownerId: string | null = null;
    if (ownerEmail) ownerId = ctx.ownerByEmail.get(ownerEmail) ?? null;
    else if (ownerName)
      ownerId =
        ctx.ownerByName.get(ownerName) ?? ctx.ownerByLooseName.get(looseNameKey(ownerName)) ?? null;
    const ownerResolved = Boolean(ownerId);
    if (!ownerId) {
      ownerId = ctx.defaultOwnerId;
      if ((ownerEmail || ownerName) && ownerId) warnings.push('owner_fallback');
    }
    if (!ownerId && !isUpdate) {
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
    if (!officeId && !isUpdate) {
      skip('no_office_available');
      return;
    }

    // Enum validation.
    let clientType = cell(row, mapping.client_type).toUpperCase();
    if (clientType && !CLIENT_TYPES.has(clientType)) return skip('invalid_client_type');
    // Accept the friendlier spellings a spreadsheet is likely to carry
    // ("S-Corp 1120S", "s_corp_1120s") and tax-software codes (I/S/C/P…).
    const entity = normalizeEntity(cell(row, mapping.entity_type));
    if (!entity) return skip('invalid_entity_type');
    const entityType = entity.entityType;
    if (!clientType && entity.clientType) clientType = entity.clientType;
    const filingRaw = cell(row, mapping.filing_status);
    const filingStatus = normalizeFilingStatus(filingRaw);
    if (filingRaw && !filingStatus) return skip('invalid_filing_status');
    // A filing status implies an individual when the file carries no type.
    if (!clientType && filingStatus) clientType = 'INDIVIDUAL';
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

    // Within-file dedupe among NEW clients (existing ones took the update
    // path), so a file can't create the same client twice.
    if (!isUpdate) {
      if (externalId) {
        if (seenExternalIds.has(externalId)) return skip('duplicate_external_id');
        seenExternalIds.add(externalId);
      } else {
        if (seenNames.has(nameKey)) return skip('duplicate_name');
        seenNames.add(nameKey);
      }
    }

    const tagsRaw = cell(row, mapping.tags);
    const tags = tagsRaw
      ? tagsRaw
          .split(/[;|]/)
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 20)
      : undefined;

    const values: Record<string, unknown> = { name: name.slice(0, 200) };
    if (!isUpdate) {
      values['partnerInChargeId'] = ownerId;
      values['officeId'] = officeId;
    } else {
      // Never overwrite an existing owner with the import default — only an
      // explicitly matched name/email moves a client; same for office.
      if (ownerResolved) values['partnerInChargeId'] = ownerId;
      if (officeName && officeId) values['officeId'] = officeId;
    }
    if (clientType) values['clientType'] = clientType;
    if (entityType) values['entityType'] = entityType;
    else if (clientType === 'INDIVIDUAL' && cell(row, mapping.entity_type))
      values['entityType'] = null;
    if (externalId) values['externalId'] = externalId.slice(0, 120);
    const facing = cell(row, mapping.client_facing_name);
    if (facing) values['clientFacingName'] = facing.slice(0, 200);
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

    const { contacts, warnings: cw } = extractContacts(
      row,
      contactCols,
      name,
      ctx.roleByName,
      ctx.roleByKey,
    );
    warnings.push(...cw);
    const ownerNameOut = ownerId ? (ctx.ownerNameById.get(ownerId) ?? null) : null;

    if (existing) {
      // Update mode: keep only the columns that actually differ.
      const changed: Record<string, unknown> = {};
      const fieldsChanged: string[] = [];
      for (const col of UPDATABLE_COLUMNS) {
        if (!(col in values)) continue;
        const next = values[col];
        const cur = existing[col];
        if ((cur ?? null) === (next ?? null)) continue;
        changed[col] = next;
        fieldsChanged.push(col);
      }
      if ('tags' in values) changed['tags'] = values['tags'];
      prepared.push({
        rowIndex: i,
        prepared: {
          mode: 'update',
          clientId: existing.id,
          values: changed,
          fieldsChanged,
          contacts,
        },
      });
      outcomes.push({
        row: i,
        action: 'update',
        name,
        contactCount: contacts.length,
        ownerName: ownerResolved
          ? ownerNameOut
          : (ctx.ownerNameById.get(existing.partnerInChargeId) ?? null),
        fieldsChanged,
        warnings,
      });
      willUpdate++;
      return;
    }

    prepared.push({ rowIndex: i, prepared: { mode: 'create', values, contacts } });
    outcomes.push({
      row: i,
      action: 'create',
      name,
      contactCount: contacts.length,
      ownerResolved,
      ownerName: ownerNameOut,
      officeResolved: Boolean(officeName),
      warnings,
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
    .select({
      id: appUsers.id,
      email: appUsers.email,
      name: appUsers.fullName,
      displayId: appUsers.displayId,
    })
    .from(appUsers)
    .where(eq(appUsers.firmId, firmId));
  const ownerByEmail = new Map<string, string>();
  const ownerByName = new Map<string, string>();
  const ownerByLooseName = new Map<string, string>();
  const ownerNameById = new Map<string, string>();
  const ambiguousLoose = new Set<string>();
  for (const o of owners) {
    if (o.email) ownerByEmail.set(o.email.toLowerCase(), o.id);
    if (o.name) {
      ownerByName.set(o.name.toLowerCase(), o.id);
      ownerNameById.set(o.id, o.name);
      const loose = looseNameKey(o.name);
      if (loose) {
        if (ownerByLooseName.has(loose) && ownerByLooseName.get(loose) !== o.id)
          ambiguousLoose.add(loose);
        else ownerByLooseName.set(loose, o.id);
      }
    }
    // A firm-unique short login id ("KWK") is a handy spreadsheet value too.
    if (o.displayId) ownerByName.set(o.displayId.toLowerCase(), o.id);
  }
  for (const k of ambiguousLoose) ownerByLooseName.delete(k);

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

  // Existing clients → id (external_id, name fallback) for upsert, plus the
  // current values of the updatable columns for diffing.
  const clientRows = await db
    .select({
      id: clients.id,
      name: clients.name,
      clientFacingName: clients.clientFacingName,
      externalId: clients.externalId,
      clientType: clients.clientType,
      entityType: clients.entityType,
      filingStatus: clients.filingStatus,
      pipelineStage: clients.pipelineStage,
      invoiceConsolidationPreference: clients.invoiceConsolidationPreference,
      termsDays: clients.termsDays,
      partnerInChargeId: clients.partnerInChargeId,
      officeId: clients.officeId,
      mailingStreet1: clients.mailingStreet1,
      mailingStreet2: clients.mailingStreet2,
      mailingCity: clients.mailingCity,
      mailingState: clients.mailingState,
      mailingPostal: clients.mailingPostal,
      mailingCountry: clients.mailingCountry,
    })
    .from(clients)
    .where(eq(clients.firmId, firmId));
  const clientIdByExternalId = new Map<string, string>();
  const clientIdByName = new Map<string, string>();
  const clientById = new Map<string, ExistingClient>();
  for (const r of clientRows) {
    if (r.externalId) clientIdByExternalId.set(r.externalId, r.id);
    if (!clientIdByName.has(r.name.toLowerCase())) clientIdByName.set(r.name.toLowerCase(), r.id);
    clientById.set(r.id, r);
  }

  // Contact roles by name (for the *_role columns) and by key (slot defaults).
  const roleRows = await db
    .select({ id: contactRoles.id, key: contactRoles.key, name: contactRoles.name })
    .from(contactRoles)
    .where(eq(contactRoles.firmId, firmId));
  const roleByName = new Map<string, string>();
  const roleByKey = new Map<string, string>();
  for (const r of roleRows) {
    roleByName.set(r.name.toLowerCase(), r.id);
    roleByKey.set(r.key, r.id);
  }

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
    ownerByLooseName,
    ownerNameById,
    officeByName,
    clientIdByExternalId,
    clientIdByName,
    clientById,
    roleByName,
    roleByKey,
    contactsByClient,
    defaultOwnerId: resolvedDefaultOwner,
    defaultOfficeId,
  };
}

// ---------------------------------------------------------------- routes

const PreviewSchema = z
  .object({
    csv: z.string().min(1).max(5_000_000).optional(),
    // Base64 of an .xlsx workbook (first sheet is imported). ~5 MB binary.
    xlsxBase64: z.string().min(1).max(7_000_000).optional(),
    defaultOwnerId: z.string().uuid().optional(),
    defaultOfficeName: z.string().max(200).optional(),
    updateExisting: z.boolean().optional(),
  })
  .refine((d) => Boolean(d.csv) !== Boolean(d.xlsxBase64), {
    message: 'exactly one of csv or xlsxBase64 is required',
    path: ['csv'],
  });
type PreviewInput = z.infer<typeof PreviewSchema>;

const MAX_ROWS = 5000;

function ip(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

/**
 * Turn the upload (CSV text or base64 xlsx) into a header + rows table, or
 * an error code for the 400 response. Shared by preview and commit so both
 * see exactly the same rows.
 */
export function readUpload(
  input: Pick<PreviewInput, 'csv' | 'xlsxBase64'>,
): { ok: true; header: string[]; rows: string[][] } | { ok: false; error: string } {
  if (input.xlsxBase64) {
    let buf: Buffer;
    try {
      buf = Buffer.from(input.xlsxBase64, 'base64');
    } catch {
      return { ok: false, error: 'invalid_xlsx' };
    }
    try {
      const t = parseXlsx(buf, { maxRows: MAX_ROWS });
      return { ok: true, header: t.header, rows: t.rows };
    } catch (err) {
      if (err instanceof XlsxParseError) return { ok: false, error: 'invalid_xlsx' };
      throw err;
    }
  }
  const t = parseCsv(input.csv ?? '');
  return { ok: true, header: t.header, rows: t.rows };
}

/** Validate payload + parse the table; writes the 400 and returns null on failure. */
async function prepare(
  req: Request,
  res: Response,
  db: Database,
): Promise<{
  input: PreviewInput;
  header: string[];
  rows: string[][];
  mapping: Partial<Record<CanonicalField, number>>;
  ctx: LookupContext;
  result: ValidationResult;
} | null> {
  const parsed = PreviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_payload' });
    return null;
  }
  const input = parsed.data;
  const table = readUpload(input);
  if (!table.ok) {
    res.status(400).json({ error: table.error });
    return null;
  }
  const { header, rows } = table;
  if (header.length === 0) {
    res.status(400).json({ error: input.xlsxBase64 ? 'empty_xlsx' : 'empty_csv' });
    return null;
  }
  if (rows.length > MAX_ROWS) {
    res.status(400).json({ error: 'too_many_rows', max: MAX_ROWS });
    return null;
  }
  const mapping = autoMap(header);
  if (mapping.name === undefined) {
    res.status(400).json({ error: 'missing_name_column', columns: header });
    return null;
  }
  const firmId = req.staffSession!.firmId;
  const ctx = await buildContext(
    db,
    firmId,
    input.defaultOwnerId ?? null,
    input.defaultOfficeName ?? null,
  );
  const result = validateImportRows(ctx, header, rows, mapping, {
    updateExisting: Boolean(input.updateExisting),
  });
  return { input, header, rows, mapping, ctx, result };
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
      if (!deps.db) {
        const parsed = PreviewSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'invalid_payload' });
          return;
        }
        res.json({ columns: [], total: 0, willCreate: 0, willUpdate: 0, willSkip: 0, rows: [] });
        return;
      }
      const p = await prepare(req, res, deps.db);
      if (!p) return;
      const { header, rows, mapping, result } = p;
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
      if (!deps.db) {
        const parsed = PreviewSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'invalid_payload' });
          return;
        }
        res.json({ created: 0, skipped: [], createdIds: [] });
        return;
      }
      const db = deps.db;
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      // Re-validate from scratch — never trust a client-submitted preview.
      const p = await prepare(req, res, db);
      if (!p) return;
      const { ctx, result } = p;
      const skipped = result.outcomes
        .filter((o): o is Extract<RowOutcome, { action: 'skip' }> => o.action === 'skip')
        .map((o) => ({ row: o.row, reason: o.reason }));

      const createdIds: string[] = [];
      const fieldUpdates: Array<{
        clientId: string;
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      }> = [];
      let updated = 0;
      let contactsAdded = 0;
      try {
        await db.transaction(async (tx) => {
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
              const cid = prepared.clientId!;
              let touched = false;
              // Rewrite changed client columns (updateExisting only).
              const changed = prepared.fieldsChanged ?? [];
              if (changed.length > 0 && prepared.values) {
                const existing = ctx.clientById.get(cid);
                const before: Record<string, unknown> = {};
                for (const k of changed)
                  before[k] = existing ? existing[k as keyof ExistingClient] : null;
                await tx
                  .update(clients)
                  // reason: values were validated column-by-column above.
                  .set({ ...(prepared.values as Partial<ClientInsert>), updatedAt: new Date() })
                  .where(eq(clients.id, cid));
                fieldUpdates.push({ clientId: cid, before, after: prepared.values });
                touched = true;
              }
              // Upsert contacts onto the existing client.
              const state = ctx.contactsByClient.get(cid) ?? {
                personIds: new Set<string>(),
                hasPrimary: false,
                hasBilling: false,
              };
              ctx.contactsByClient.set(cid, state);
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

      const userAgent = req.header('user-agent') ?? null;
      await emitAudit(db, {
        action: 'CREATE',
        entityType: 'client',
        entityId: createdIds[0],
        actorAppUserId: session.appUserId,
        after: {
          kind: p.input.xlsxBase64 ? 'xlsx_import' : 'csv_import',
          created: createdIds.length,
          updated,
          fieldUpdates: fieldUpdates.length,
          contactsAdded,
          skipped: skipped.length,
        },
        ip: ip(req),
        userAgent,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      // One UPDATE row per client whose columns were rewritten, with the
      // before/after of just the changed columns.
      for (const u of fieldUpdates) {
        await emitAudit(db, {
          action: 'UPDATE',
          entityType: 'client',
          entityId: u.clientId,
          actorAppUserId: session.appUserId,
          before: u.before,
          after: { ...u.after, kind: 'import_update' },
          ip: ip(req),
          userAgent,
        }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      }

      res.json({
        created: createdIds.length,
        createdIds,
        updated,
        fieldUpdates: fieldUpdates.length,
        contactsAdded,
        skipped,
      });
    },
  );
}
