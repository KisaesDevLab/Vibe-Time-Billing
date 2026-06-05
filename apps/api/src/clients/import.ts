// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
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
import { and, eq, isNotNull } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { appUsers, clientContacts, clients, offices } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
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

// ---------------------------------------------------------------- columns

const CANONICAL_FIELDS = [
  'name',
  'client_owner_email',
  'client_owner_name',
  'office',
  'client_type',
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
  'billing_contact_name',
  'billing_contact_email',
  'billing_contact_phone',
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
  billing_contact_name: 'billing_contact_name',
  billing_name: 'billing_contact_name',
  billing_contact_email: 'billing_contact_email',
  billing_email: 'billing_contact_email',
  email: 'billing_contact_email',
  billing_contact_phone: 'billing_contact_phone',
  billing_phone: 'billing_contact_phone',
  phone: 'billing_contact_phone',
};

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
const FILING_STATUSES = new Set(['SINGLE', 'MFJ', 'MFS', 'HOH', 'QW']);
const PIPELINE_STAGES = new Set(['PROSPECT', 'CLIENT', 'OTHER']);
const CONSOLIDATION = new Set(['CONSOLIDATED', 'SEPARATE']);

interface LookupContext {
  ownerByEmail: Map<string, string>;
  ownerByName: Map<string, string>;
  officeByName: Map<string, string>;
  existingExternalIds: Set<string>;
  existingNames: Set<string>;
  defaultOwnerId: string | null;
  defaultOfficeId: string | null;
}

type ClientInsert = typeof clients.$inferInsert;
interface PreparedClient {
  // Validated column values. name / partnerInChargeId / officeId are
  // always set by validateImportRows; enum columns hold validated strings,
  // so the insert site casts to the Drizzle insert type.
  values: Record<string, unknown>;
  contact: { fullName: string; email: string | null; phone: string | null } | null;
}

export type RowOutcome =
  | { row: number; action: 'create'; name: string; ownerResolved: boolean; officeResolved: boolean }
  | { row: number; action: 'skip'; name: string; reason: string };

interface ValidationResult {
  outcomes: RowOutcome[];
  prepared: Array<{ rowIndex: number; prepared: PreparedClient }>;
  willCreate: number;
  willSkip: number;
}

function cell(row: string[], idx: number | undefined): string {
  if (idx === undefined) return '';
  return (row[idx] ?? '').trim();
}

/**
 * Pure validation pass — never writes. Produces per-row outcomes plus the
 * prepared insert values for the rows that will be created. Dedupe is
 * skip-existing: external_id match (or, absent an external_id, a
 * case-insensitive name match) skips the row. Within-file duplicates are
 * skipped too so a file can't create two clients with the same key.
 */
export function validateImportRows(
  ctx: LookupContext,
  header: string[],
  rows: string[][],
  mapping: Partial<Record<CanonicalField, number>>,
): ValidationResult {
  const outcomes: RowOutcome[] = [];
  const prepared: Array<{ rowIndex: number; prepared: PreparedClient }> = [];
  const seenExternalIds = new Set<string>();
  const seenNames = new Set<string>();
  let willCreate = 0;
  let willSkip = 0;

  rows.forEach((row, i) => {
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

    // Dedupe — skip existing (external_id primary, name secondary).
    const externalId = cell(row, mapping.external_id);
    const nameKey = name.toLowerCase();
    if (externalId) {
      if (ctx.existingExternalIds.has(externalId) || seenExternalIds.has(externalId)) {
        return skip('duplicate_external_id');
      }
      seenExternalIds.add(externalId);
    } else {
      if (ctx.existingNames.has(nameKey) || seenNames.has(nameKey)) {
        return skip('duplicate_name');
      }
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

    const billingEmail = cell(row, mapping.billing_contact_email) || null;
    const billingPhone = cell(row, mapping.billing_contact_phone) || null;
    const billingName = cell(row, mapping.billing_contact_name) || name;
    const contact =
      billingEmail || billingPhone || cell(row, mapping.billing_contact_name)
        ? { fullName: billingName, email: billingEmail, phone: billingPhone }
        : null;

    prepared.push({ rowIndex: i, prepared: { values, contact } });
    outcomes.push({
      row: i,
      action: 'create',
      name,
      ownerResolved: Boolean(ownerEmail || ownerName),
      officeResolved: Boolean(officeName),
    });
    willCreate++;
  });

  // Reference header length so callers can echo it without re-parsing.
  void header.length;
  return { outcomes, prepared, willCreate, willSkip };
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

  const externalRows = await db
    .select({ externalId: clients.externalId })
    .from(clients)
    .where(and(eq(clients.firmId, firmId), isNotNull(clients.externalId)));
  const existingExternalIds = new Set<string>();
  for (const r of externalRows) if (r.externalId) existingExternalIds.add(r.externalId);

  const nameRows = await db
    .select({ name: clients.name })
    .from(clients)
    .where(eq(clients.firmId, firmId));
  const existingNames = new Set<string>(nameRows.map((r) => r.name.toLowerCase()));

  // Validate the default owner belongs to the firm.
  const resolvedDefaultOwner =
    defaultOwnerId && owners.some((o) => o.id === defaultOwnerId) ? defaultOwnerId : null;

  return {
    ownerByEmail,
    ownerByName,
    officeByName,
    existingExternalIds,
    existingNames,
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
        res.json({ columns: [], total: 0, willCreate: 0, willSkip: 0, rows: [] });
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
      try {
        await deps.db.transaction(async (tx) => {
          for (const { prepared } of result.prepared) {
            const [newRow] = await tx
              .insert(clients)
              // reason: validateImportRows guarantees the required columns
              // (name/partnerInChargeId/officeId) and validates enum values.
              .values({ firmId, ...prepared.values } as ClientInsert)
              .returning({ id: clients.id });
            if (!newRow) continue;
            createdIds.push(newRow.id);
            if (prepared.contact) {
              // 0115 — name/email/phone live on the firm-global person.
              const personId = await findOrCreatePerson(tx, {
                firmId,
                fullName: prepared.contact.fullName,
                email: prepared.contact.email,
                phone: prepared.contact.phone,
              });
              await tx.insert(clientContacts).values({
                clientId: newRow.id,
                personId,
                isPrimary: true,
                isBilling: Boolean(prepared.contact.email || prepared.contact.phone),
              });
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
        after: { kind: 'csv_import', created: createdIds.length, skipped: skipped.length },
        ip: ip(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      res.json({ created: createdIds.length, createdIds, skipped });
    },
  );
}
