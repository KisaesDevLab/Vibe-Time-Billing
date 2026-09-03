// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Admin "Update people": paste a directory list (Taxpayer Name, Mobile
// Phone, Landline Phone, Email) and write the contact fields onto the
// people already in the firm directory. The clients-side counterpart is
// clients/import.ts; this one differs in the hard way — a client row
// carries a stable Client ID, a person row carries only a name, and 487 of
// this firm's people share a name with someone else. So matching is a
// ladder, most-specific first:
//
//   email → phone/mobile digits → exact name → loose name (first + last,
//   punctuation-insensitive, which is what makes "Tyler L. Waterman" find
//   "Tyler L Waterman" and "Christopher Mettlach" find "Christopher J
//   Mettlach" when the email doesn't)
//
// A step matching two or more people is not a match — it falls through to
// the next, and a row that never resolves to exactly one person is
// reported, never guessed at.
//
//   POST /bulk-update/preview   dry run: per-row before/after, no writes
//   POST /bulk-update/commit    re-validates from scratch, writes in one txn
//
// Pasted values win over what's on file (the list is the fresher source),
// except: names are a match key rather than a value to write unless the
// caller opts in, and a number already on file in the *other* phone field
// is reported instead of being duplicated into both.

import { type Request, type Response, type Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { persons } from '@vibe/db/schema';
import { normalizeEmail, normalizePhone } from '@vibe/core/auth';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { looseNameKey, parseCsv, sniffDelimiter, suffixConflict } from '../clients/import';
import { logger } from '../logger';

export interface PeopleBulkUpdateDeps extends RbacDeps {
  db: Database | null;
}

// ---------------------------------------------------------------- columns

export const PERSON_FIELDS = ['full_name', 'email', 'mobile', 'phone'] as const;
type PersonField = (typeof PERSON_FIELDS)[number];

/** Header text → comparable key: lowercase, non-alphanumerics → `_`. */
function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Header aliases → canonical field. "Taxpayer Name" is what a tax-software
// roster calls the person; "Landline Phone" is the person.phone column.
const ALIASES: Record<string, PersonField> = {
  name: 'full_name',
  full_name: 'full_name',
  person: 'full_name',
  person_name: 'full_name',
  contact: 'full_name',
  contact_name: 'full_name',
  taxpayer: 'full_name',
  taxpayer_name: 'full_name',
  client_contact: 'full_name',
  email: 'email',
  email_address: 'email',
  e_mail: 'email',
  contact_email: 'email',
  mobile: 'mobile',
  mobile_phone: 'mobile',
  mobile_number: 'mobile',
  cell: 'mobile',
  cell_phone: 'mobile',
  text_number: 'mobile',
  phone: 'phone',
  landline: 'phone',
  landline_phone: 'phone',
  home_phone: 'phone',
  work_phone: 'phone',
  office_phone: 'phone',
  phone_number: 'phone',
  primary_phone: 'phone',
};

export function autoMap(header: string[]): Partial<Record<PersonField, number>> {
  const map: Partial<Record<PersonField, number>> = {};
  header.forEach((h, idx) => {
    const field = ALIASES[normalizeHeader(h)];
    if (field && map[field] === undefined) map[field] = idx;
  });
  return map;
}

function cell(row: string[], idx: number | undefined): string {
  if (idx === undefined) return '';
  return (row[idx] ?? '').trim();
}

/** Comparable form of a phone number: digits only, null when empty. */
export function digitsOnly(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = s.replace(/\D/g, '');
  return d.length ? d : null;
}

/**
 * Comparable phone key: the last 10 digits.
 *
 * Pasted values are normalized to +1XXXXXXXXXX before matching, while
 * persons.phone holds whatever was typed ("(417) 592-7847") — the base
 * columns are never normalized on write, which is why the trigger-owned
 * *_e164 columns exist. Comparing raw digit strings therefore never
 * matched an 11-digit normalized value against a 10-digit stored one, so
 * the phone rung was dead for every legacy-formatted row and the
 * "don't copy the same number into both fields" guard never fired.
 */
export function phoneKey(s: string | null | undefined): string | null {
  const d = digitsOnly(s);
  if (!d) return null;
  return d.length > 10 ? d.slice(-10) : d;
}

// ---------------------------------------------------------------- context

export interface DirectoryPerson {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  /** Non-ACTIVE people are never match targets, but they still own their
   *  email as far as the unique index is concerned. */
  active?: boolean;
}

export interface DirectoryContext {
  byId: Map<string, DirectoryPerson>;
  byEmail: Map<string, string[]>;
  byDigits: Map<string, string[]>;
  byName: Map<string, string[]>;
  byLooseName: Map<string, string[]>;
  /**
   * Email → owners across EVERY status. person_firm_email_uk has no status
   * predicate, so an address held by an archived merge-loser still blocks
   * the write. Checking only the ACTIVE directory made the preview look
   * clean and then failed the UPDATE inside the transaction, rolling back
   * the whole paste with a 409 that named no row.
   */
  emailOwners: Map<string, string[]>;
}

function push(map: Map<string, string[]>, key: string, id: string): void {
  const cur = map.get(key);
  if (cur) {
    if (!cur.includes(id)) cur.push(id);
  } else map.set(key, [id]);
}

export function buildDirectoryContext(people: DirectoryPerson[]): DirectoryContext {
  const ctx: DirectoryContext = {
    byId: new Map(),
    byEmail: new Map(),
    byDigits: new Map(),
    byName: new Map(),
    byLooseName: new Map(),
    emailOwners: new Map(),
  };
  for (const p of people) {
    if (p.email) push(ctx.emailOwners, p.email.trim().toLowerCase(), p.id);
    if (p.active === false) continue;
    ctx.byId.set(p.id, p);
    if (p.email) push(ctx.byEmail, p.email.trim().toLowerCase(), p.id);
    for (const d of [phoneKey(p.phone), phoneKey(p.mobile)]) if (d) push(ctx.byDigits, d, p.id);
    const name = p.fullName.trim().toLowerCase();
    if (name) push(ctx.byName, name, p.id);
    const loose = looseNameKey(p.fullName);
    if (loose) push(ctx.byLooseName, loose, p.id);
  }
  return ctx;
}

// ---------------------------------------------------------------- validate

export type MatchedBy = 'email' | 'phone' | 'name' | 'loose_name';

export interface FieldChange {
  field: 'fullName' | 'email' | 'phone' | 'mobile';
  from: string | null;
  to: string | null;
}

export type PeopleRowOutcome =
  | {
      row: number;
      action: 'update';
      name: string;
      personId: string;
      personName: string;
      matchedBy: MatchedBy;
      changes: FieldChange[];
      warnings: string[];
    }
  | { row: number; action: 'create'; name: string; email: string | null }
  | { row: number; action: 'skip'; name: string; reason: string; detail?: string };

export type PreparedPeopleRow =
  | {
      mode: 'update';
      personId: string;
      values: Record<string, unknown>;
      before: Record<string, unknown>;
    }
  | {
      mode: 'create';
      values: {
        fullName: string;
        email: string | null;
        phone: string | null;
        mobile: string | null;
      };
    };

export interface PeopleValidationResult {
  outcomes: PeopleRowOutcome[];
  prepared: Array<{ rowIndex: number; prepared: PreparedPeopleRow }>;
  willUpdate: number;
  willCreate: number;
  willSkip: number;
}

export interface PeopleValidateOptions {
  /** Create the rows that match nobody (off by default: report only). */
  createMissing?: boolean;
  /** Rewrite the person's stored name from the list (off by default). */
  updateNames?: boolean;
  /** Write a field only when it is empty on the person (off by default). */
  fillBlanksOnly?: boolean;
}

/**
 * Resolve one row to exactly one person, most-specific key first. A step
 * that hits several people is inconclusive rather than fatal — the next,
 * narrower key gets its turn — so a shared household number still resolves
 * when the name is unambiguous.
 *
 * When the contact key (email/phone) and the name point at two DIFFERENT
 * people, that is a contradiction — a mistyped address on someone else's
 * row — and the answer is `conflict`, not a silent write to whichever key
 * ranked higher.
 */
export function matchPerson(
  ctx: DirectoryContext,
  row: { name: string; email: string | null; phone: string | null; mobile: string | null },
):
  | { person: DirectoryPerson; matchedBy: MatchedBy }
  | { ambiguous: true }
  | { conflict: true; keyed: DirectoryPerson; named: DirectoryPerson }
  | null {
  const steps: Array<{ by: MatchedBy; ids: string[] }> = [];
  if (row.email) steps.push({ by: 'email', ids: ctx.byEmail.get(row.email.toLowerCase()) ?? [] });
  for (const d of [phoneKey(row.mobile), phoneKey(row.phone)]) {
    if (d) steps.push({ by: 'phone', ids: ctx.byDigits.get(d) ?? [] });
  }
  const nameKey = row.name.trim().toLowerCase();
  if (nameKey) steps.push({ by: 'name', ids: ctx.byName.get(nameKey) ?? [] });
  const loose = looseNameKey(row.name);
  if (loose) steps.push({ by: 'loose_name', ids: ctx.byLooseName.get(loose) ?? [] });

  let sawAmbiguous = false;
  for (const step of steps) {
    if (step.ids.length === 1) {
      const person = ctx.byId.get(step.ids[0]!);
      if (!person) continue;
      // Cross-check a contact-key match against the name: one unambiguous
      // person of that exact name who ISN'T this one means the row's email
      // or number belongs to somebody else.
      if (step.by === 'email' || step.by === 'phone') {
        // Consult the loose index as well: a stored "Jane A Smith" is not
        // in byName under "jane smith", so an exact-name-only cross-check
        // let a contact-key match quietly win over a different person of
        // (nearly) the same name.
        const named = ctx.byName.get(nameKey) ?? ctx.byLooseName.get(loose) ?? [];
        if (named.length === 1 && named[0] !== person.id) {
          const other = ctx.byId.get(named[0]!);
          if (other) return { conflict: true, keyed: person, named: other };
        }
      }
      // Sr and Jr share a loose key by design (so "Robert Moeller Jr"
      // still matches "Robert Moeller"), but they are not the same person.
      if (step.by === 'loose_name' && suffixConflict(row.name, person.fullName)) {
        sawAmbiguous = true;
        continue;
      }
      return { person, matchedBy: step.by };
    } else if (step.ids.length > 1) sawAmbiguous = true;
  }
  return sawAmbiguous ? { ambiguous: true } : null;
}

/** Pure validation pass — never writes. */
export function validatePeopleRows(
  ctx: DirectoryContext,
  rows: string[][],
  mapping: Partial<Record<PersonField, number>>,
  opts: PeopleValidateOptions = {},
): PeopleValidationResult {
  const outcomes: PeopleRowOutcome[] = [];
  const prepared: Array<{ rowIndex: number; prepared: PreparedPeopleRow }> = [];
  let willUpdate = 0;
  let willCreate = 0;
  let willSkip = 0;
  // Within-file guards: one person must not be written twice, and two rows
  // must not claim the same new email.
  const seenPersonIds = new Set<string>();
  const seenEmails = new Set<string>();

  rows.forEach((row, i) => {
    const name = cell(row, mapping.full_name);
    const skip = (reason: string, detail?: string): void => {
      outcomes.push({ row: i, action: 'skip', name, reason, ...(detail ? { detail } : {}) });
      willSkip++;
    };
    if (!name) return skip('missing_name');

    const rawEmail = cell(row, mapping.email);
    const email = rawEmail ? normalizeEmail(rawEmail) : null;
    if (rawEmail && !email) return skip('invalid_email', rawEmail);
    const rawMobile = cell(row, mapping.mobile);
    const mobile = rawMobile ? normalizePhone(rawMobile) : null;
    if (rawMobile && !mobile) return skip('invalid_mobile', rawMobile);
    const rawPhone = cell(row, mapping.phone);
    const phone = rawPhone ? normalizePhone(rawPhone) : null;
    if (rawPhone && !phone) return skip('invalid_phone', rawPhone);
    if (!email && !mobile && !phone && !opts.updateNames) return skip('nothing_to_update');

    const hit = matchPerson(ctx, { name, email, phone, mobile });
    if (hit && 'ambiguous' in hit) return skip('ambiguous_match');
    if (hit && 'conflict' in hit)
      return skip('conflicting_match', `${hit.keyed.fullName} vs ${hit.named.fullName}`);

    if (!hit) {
      if (!opts.createMissing) return skip('not_in_platform');
      if (
        email &&
        (ctx.emailOwners.has(email.toLowerCase()) || seenEmails.has(email.toLowerCase()))
      )
        return skip('email_taken');
      if (email) seenEmails.add(email.toLowerCase());
      prepared.push({
        rowIndex: i,
        prepared: {
          mode: 'create',
          values: { fullName: name.slice(0, 200), email, phone, mobile },
        },
      });
      outcomes.push({ row: i, action: 'create', name, email });
      willCreate++;
      return;
    }

    const person = hit.person;
    if (seenPersonIds.has(person.id)) return skip('duplicate_row_for_person', person.fullName);

    const warnings: string[] = [];
    const changes: FieldChange[] = [];
    const values: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    const set = (field: FieldChange['field'], from: string | null, to: string | null): void => {
      values[field] = to;
      before[field] = from;
      changes.push({ field, from, to });
    };

    // Email. The (firm, lower(email)) unique index means a value owned by
    // somebody else can't be written at all — report rather than 409 later.
    if (email) {
      const owners = ctx.emailOwners.get(email.toLowerCase()) ?? [];
      const otherOwner = owners.find((id) => id !== person.id);
      if (otherOwner) {
        return skip('email_taken', ctx.byId.get(otherOwner)?.fullName ?? undefined);
      }
      if (seenEmails.has(email.toLowerCase())) return skip('email_taken');
      if ((person.email ?? '').trim().toLowerCase() !== email.toLowerCase()) {
        if (person.email && opts.fillBlanksOnly) warnings.push('email_conflict_kept');
        else {
          set('email', person.email, email);
          seenEmails.add(email.toLowerCase());
        }
      }
    }

    // Phones. A number already on file in the *other* field is reported,
    // not copied across — the same digits sitting in both columns is worse
    // than a stale label.
    const applyPhone = (
      field: 'mobile' | 'phone',
      next: string | null,
      current: string | null,
      other: string | null,
      crossWarning: string,
    ): void => {
      if (!next) return;
      const nd = phoneKey(next);
      if (nd && nd === phoneKey(current)) return; // already exactly this
      if (nd && nd === phoneKey(other)) {
        warnings.push(crossWarning);
        return;
      }
      if (current && opts.fillBlanksOnly) {
        warnings.push(`${field}_conflict_kept`);
        return;
      }
      set(field, current, next);
    };
    applyPhone('mobile', mobile, person.mobile, person.phone, 'mobile_already_on_file_as_landline');
    applyPhone('phone', phone, person.phone, person.mobile, 'landline_already_on_file_as_mobile');

    // The name is how the row was found, so it is only rewritten on
    // request; otherwise a spelling difference is surfaced and left alone.
    if (name.trim().toLowerCase() !== person.fullName.trim().toLowerCase()) {
      if (opts.updateNames) set('fullName', person.fullName, name.slice(0, 200));
      else warnings.push('name_differs');
    }

    seenPersonIds.add(person.id);
    if (changes.length === 0) {
      outcomes.push({
        row: i,
        action: 'update',
        name,
        personId: person.id,
        personName: person.fullName,
        matchedBy: hit.matchedBy,
        changes: [],
        warnings,
      });
      willUpdate++;
      return;
    }
    prepared.push({
      rowIndex: i,
      prepared: { mode: 'update', personId: person.id, values, before },
    });
    outcomes.push({
      row: i,
      action: 'update',
      name,
      personId: person.id,
      personName: person.fullName,
      matchedBy: hit.matchedBy,
      changes,
      warnings,
    });
    willUpdate++;
  });

  return { outcomes, prepared, willUpdate, willCreate, willSkip };
}

// ---------------------------------------------------------------- routes

const BodySchema = z.object({
  csv: z.string().min(1).max(5_000_000),
  createMissing: z.boolean().optional(),
  updateNames: z.boolean().optional(),
  fillBlanksOnly: z.boolean().optional(),
});
type BulkInput = z.infer<typeof BodySchema>;

const MAX_ROWS = 5000;

function ip(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

async function loadDirectory(db: Database, firmId: string): Promise<DirectoryPerson[]> {
  return db
    .select({
      id: persons.id,
      fullName: persons.fullName,
      email: persons.email,
      phone: persons.phone,
      mobile: persons.mobile,
      status: persons.status,
    })
    .from(persons)
    .where(eq(persons.firmId, firmId))
    .then((rows) => rows.map((r) => ({ ...r, active: r.status === 'ACTIVE' })));
}

/** Parse + validate; writes the 400 and returns null on failure. */
async function prepare(
  req: Request,
  res: Response,
  db: Database,
): Promise<{
  input: BulkInput;
  header: string[];
  rows: string[][];
  mapping: Partial<Record<PersonField, number>>;
  ctx: DirectoryContext;
  result: PeopleValidationResult;
} | null> {
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_payload' });
    return null;
  }
  const input = parsed.data;
  const { header, rows } = parseCsv(input.csv, sniffDelimiter(input.csv));
  if (header.length === 0) {
    res.status(400).json({ error: 'empty_csv' });
    return null;
  }
  if (rows.length > MAX_ROWS) {
    res.status(400).json({ error: 'too_many_rows', max: MAX_ROWS });
    return null;
  }
  const mapping = autoMap(header);
  if (mapping.full_name === undefined) {
    res.status(400).json({ error: 'missing_name_column', columns: header });
    return null;
  }
  const firmId = req.staffSession!.firmId;
  const ctx = buildDirectoryContext(await loadDirectory(db, firmId));
  const result = validatePeopleRows(ctx, rows, mapping, {
    createMissing: Boolean(input.createMissing),
    updateNames: Boolean(input.updateNames),
    fillBlanksOnly: Boolean(input.fillBlanksOnly),
  });
  return { input, header, rows, mapping, ctx, result };
}

export function mountPeopleBulkUpdateRoutes(router: Router, deps: PeopleBulkUpdateDeps): void {
  router.post(
    '/bulk-update/preview',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ columns: [], total: 0, willUpdate: 0, willCreate: 0, willSkip: 0, rows: [] });
        return;
      }
      const p = await prepare(req, res, deps.db);
      if (!p) return;
      res.json({
        columns: p.header,
        mappedColumns: Object.keys(p.mapping),
        total: p.rows.length,
        willUpdate: p.result.willUpdate,
        willCreate: p.result.willCreate,
        willSkip: p.result.willSkip,
        rows: p.result.outcomes,
      });
    },
  );

  router.post(
    '/bulk-update/commit',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ updated: 0, created: 0, skipped: [] });
        return;
      }
      const db = deps.db;
      const session = req.staffSession!;
      const firmId = session.firmId;
      // Never trust a client-submitted preview — re-validate from scratch.
      const p = await prepare(req, res, db);
      if (!p) return;
      const skipped = p.result.outcomes
        .filter((o): o is Extract<PeopleRowOutcome, { action: 'skip' }> => o.action === 'skip')
        .map((o) => ({ row: o.row, reason: o.reason }));

      const updates: Array<{
        personId: string;
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      }> = [];
      const createdIds: string[] = [];
      try {
        await db.transaction(async (tx) => {
          for (const { prepared } of p.result.prepared) {
            if (prepared.mode === 'create') {
              const [row] = await tx
                .insert(persons)
                .values({ firmId, ...prepared.values })
                .returning({ id: persons.id });
              if (row) createdIds.push(row.id);
              continue;
            }
            await tx
              .update(persons)
              .set({ ...prepared.values, updatedAt: new Date() })
              .where(and(eq(persons.id, prepared.personId), eq(persons.firmId, firmId)));
            updates.push({
              personId: prepared.personId,
              before: prepared.before,
              after: prepared.values,
            });
          }
        });
      } catch (err) {
        // Most likely the (firm, lower(email)) unique index under a race —
        // roll the whole batch back so the list can be fixed and re-run.
        logger.error({ err }, 'people bulk update rolled back');
        res.status(409).json({ error: 'bulk_update_conflict' });
        return;
      }

      const userAgent = req.header('user-agent') ?? null;
      for (const u of updates) {
        await emitAudit(db, {
          action: 'UPDATE',
          entityType: 'person',
          entityId: u.personId,
          actorAppUserId: session.appUserId,
          before: u.before,
          after: { ...u.after, kind: 'bulk_update' },
          ip: ip(req),
          userAgent,
        }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      }
      for (const id of createdIds) {
        await emitAudit(db, {
          action: 'CREATE',
          entityType: 'person',
          entityId: id,
          actorAppUserId: session.appUserId,
          after: { kind: 'bulk_update_create' },
          ip: ip(req),
          userAgent,
        }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      }

      res.json({
        updated: updates.length,
        created: createdIds.length,
        createdIds,
        skipped,
      });
    },
  );
}
