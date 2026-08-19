// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Q36 — CSV client import. Preview is a dry-run (no writes); commit
// inserts in one transaction with skip-existing dedupe (external_id then
// case-insensitive name). Both gated by client:write.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq, and } from 'drizzle-orm';
import type express from 'express';

import AdmZip from 'adm-zip';

import { auditLog, clients, clientContacts, contactRoles, persons } from '@vibe/db/schema';

import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createClientRouter } from '../clients/routes';
import {
  CANONICAL_FIELDS,
  buildImportTemplateCsv,
  looseNameKey,
  parseCsv,
} from '../clients/import';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});
afterEach(async () => {
  await harness.close();
});

interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
  textBody: string | undefined;
  headers: Record<string, string>;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
  setHeader(name: string, value: string): FakeRes;
  send(b: string): FakeRes;
}
function makeRes(): FakeRes {
  return {
    statusCode: 200,
    jsonBody: undefined,
    textBody: undefined,
    headers: {},
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.jsonBody = b;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    send(b) {
      this.textBody = b;
      return this;
    },
  };
}
async function invoke(
  router: express.Router,
  method: 'get' | 'post' | 'patch',
  path: string,
  req: Record<string, unknown>,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const chain = route.stack;
  for (let i = 0; i < chain.length - 1; i++) {
    let advanced = false;
    await (chain[i]!.handle as (rq: unknown, rs: unknown, nx: () => void) => unknown)(
      req,
      res,
      () => {
        advanced = true;
      },
    );
    if (!advanced) return res;
  }
  await (chain[chain.length - 1]!.handle as (rq: unknown, rs: unknown) => unknown)(req, res);
  return res;
}
function req(
  firmId: string,
  appUserId: string,
  body: unknown,
  roles: string[] = ['partner'],
): Record<string, unknown> {
  void roles;
  return {
    body,
    params: {},
    query: {},
    headers: {},
    staffSession: { firmId, appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
}
function router(
  harnessDb: PgliteHarness['db'],
  appUserId: string,
  roles: RoleSlug[] = ['partner'],
) {
  return createClientRouter({ db: harnessDb, fakeUserRoles: new Map([[appUserId, roles]]) });
}

describe('parseCsv', () => {
  it('parses quoted fields with embedded commas and escaped quotes', () => {
    const { header, rows } = parseCsv('name,note\n"Smith, John","say ""hi"""\nAcme,plain\n');
    expect(header).toEqual(['name', 'note']);
    expect(rows[0]).toEqual(['Smith, John', 'say "hi"']);
    expect(rows[1]).toEqual(['Acme', 'plain']);
  });
  it('handles CRLF and a trailing row without newline', () => {
    const { rows } = parseCsv('name\r\nAcme\r\nBeta');
    expect(rows).toEqual([['Acme'], ['Beta']]);
  });
  it('keeps every data row, including comment rows, so line numbers stay honest', () => {
    const { rows } = parseCsv('name,note\n#Client display name,ignored\nAcme,plain\n');
    expect(rows).toEqual([
      ['#Client display name', 'ignored'],
      ['Acme', 'plain'],
    ]);
  });
});

describe('client import template', () => {
  it('produces a header, a notes row, and two parseable sample rows', () => {
    const csv = buildImportTemplateCsv();
    const { header, rows } = parseCsv(csv);
    expect(header[0]).toBe('name');
    expect(header).toContain('taxpayer_name');
    expect(header).toContain('billing_contact_email');
    // Notes row + two worked examples, all retained by the parser.
    expect(rows).toHaveLength(3);
    expect(rows[0]![0]).toMatch(/^#/);
    expect(rows[1]![header.indexOf('name')]).toBe('Doe, John & Jane');
    expect(rows[2]![header.indexOf('name')]).toBe('Acme Manufacturing LLC');
  });

  it('every template column is a header the importer actually recognizes', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = router(harness.db, seed.appUserId);
    const csv = buildImportTemplateCsv();
    const res = await invoke(
      r,
      'post',
      '/import/preview',
      req(seed.firmId, seed.appUserId, { csv, defaultOwnerId: seed.appUserId }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.jsonBody as { columns: string[]; mappedColumns: string[] };
    // Client-level columns must all auto-map; the rest are contact-slot
    // columns, which map through mapContactColumns instead.
    const contactCols = body.columns.filter((c) =>
      /^(taxpayer|spouse|contact3|billing_contact)_/.test(c),
    );
    const unmapped = body.columns.filter(
      (c) => !body.mappedColumns.includes(c) && !contactCols.includes(c),
    );
    expect(unmapped).toEqual([]);
  });

  it('every client-level field the importer supports is offered in the template', () => {
    // The gap that let entity_type ship unimportable. Compared against
    // CANONICAL_FIELDS, not against the template's own parsed headers —
    // deriving the expectation from the template would make this vacuous.
    const { header } = parseCsv(buildImportTemplateCsv());
    const missing = CANONICAL_FIELDS.filter((f) => !header.includes(f));
    expect(missing, `template omits importable field(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('the unedited template imports cleanly: notes row skipped, examples created', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = router(harness.db, seed.appUserId);
    const csv = buildImportTemplateCsv();
    const res = await invoke(
      r,
      'post',
      '/import/preview',
      req(seed.firmId, seed.appUserId, { csv, defaultOwnerId: seed.appUserId }),
    );
    const body = res.jsonBody as {
      total: number;
      willCreate: number;
      willSkip: number;
      rows: Array<{ row: number; action: string; reason?: string }>;
    };
    expect(body.total).toBe(3);
    expect(body.willSkip).toBe(1);
    expect(body.rows[0]!.reason).toBe('template_notes_row');
    // Both example rows validate — every enum/terms value in the template is
    // legal, so a user editing in place never hits a bogus skip.
    expect(body.willCreate).toBe(2);
    // Row numbers are the real spreadsheet lines (index + 2), unshifted by
    // the skipped notes row.
    expect(body.rows.map((x) => x.row)).toEqual([0, 1, 2]);
  });

  it('a client whose name starts with # still imports below the first row', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = router(harness.db, seed.appUserId);
    const csv = ['name', 'Regular Co', '#1 Auto Repair'].join('\n');
    const res = await invoke(
      r,
      'post',
      '/import/commit',
      req(seed.firmId, seed.appUserId, { csv, defaultOwnerId: seed.appUserId }),
    );
    const body = res.jsonBody as { created: number; skipped: unknown[] };
    expect(body.created).toBe(2);
    expect(body.skipped).toHaveLength(0);
  });

  it('GET /import/template requires client:write and streams the CSV', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = router(harness.db, seed.appUserId);
    const res = await invoke(r, 'get', '/import/template', req(seed.firmId, seed.appUserId, {}));
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/csv');
    expect(res.headers['Content-Disposition']).toContain('client-import-template.csv');
    expect(res.textBody).toContain('taxpayer_name');

    const staffRouter = router(harness.db, seed.appUserId, ['staff']);
    const denied = await invoke(
      staffRouter,
      'get',
      '/import/template',
      req(seed.firmId, seed.appUserId, {}),
    );
    expect(denied.statusCode).toBe(403);
  });
});

describe('client CSV import', () => {
  it('preview is a dry-run: reports create/skip without writing', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = router(harness.db, seed.appUserId);
    const csv = `name,client_owner_email,office\nNewCo,sarah@test.example,Headquarters\n,sarah@test.example,Headquarters\n`;
    const res = await invoke(
      r,
      'post',
      '/import/preview',
      req(seed.firmId, seed.appUserId, { csv }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.jsonBody as {
      total: number;
      willCreate: number;
      willSkip: number;
      rows: Array<{ action: string; reason?: string }>;
    };
    expect(body.total).toBe(2);
    expect(body.willCreate).toBe(1);
    expect(body.willSkip).toBe(1);
    expect(body.rows.find((x) => x.action === 'skip')!.reason).toBe('missing_name');
    // No rows written (seed created exactly one client).
    const all = await harness.db.select().from(clients).where(eq(clients.firmId, seed.firmId));
    expect(all).toHaveLength(1);
  });

  it('commit creates clients + primary/billing contacts, resolves owner by email and office by name', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = router(harness.db, seed.appUserId);
    const csv = [
      'name,client_owner_email,office,billing_contact_email,external_id',
      'Alpha LLC,sarah@test.example,Headquarters,billing@alpha.example,EXT-1',
      'Beta Inc,sarah@test.example,Headquarters,,EXT-2',
    ].join('\n');
    const res = await invoke(
      r,
      'post',
      '/import/commit',
      req(seed.firmId, seed.appUserId, { csv }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.jsonBody as { created: number; skipped: unknown[] };
    expect(body.created).toBe(2);
    expect(body.skipped).toHaveLength(0);

    const alpha = await harness.db
      .select()
      .from(clients)
      .where(and(eq(clients.firmId, seed.firmId), eq(clients.name, 'Alpha LLC')));
    expect(alpha[0]!.partnerInChargeId).toBe(seed.appUserId);
    // 0115 — email is canonical on the linked person.
    const contacts = await harness.db
      .select({
        isPrimary: clientContacts.isPrimary,
        isBilling: clientContacts.isBilling,
        email: persons.email,
      })
      .from(clientContacts)
      .innerJoin(persons, eq(persons.id, clientContacts.personId))
      .where(eq(clientContacts.clientId, alpha[0]!.id));
    expect(contacts[0]!.isPrimary).toBe(true);
    expect(contacts[0]!.isBilling).toBe(true);
    expect(contacts[0]!.email).toBe('billing@alpha.example');
  });

  it('skips unknown owner and unknown office with reasons', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = router(harness.db, seed.appUserId);
    const csv = [
      'name,client_owner_email,office',
      'NoOwner,ghost@nope.example,Headquarters',
      'NoOffice,sarah@test.example,Mars Branch',
    ].join('\n');
    const res = await invoke(
      r,
      'post',
      '/import/commit',
      req(seed.firmId, seed.appUserId, { csv }),
    );
    const body = res.jsonBody as { created: number; skipped: Array<{ reason: string }> };
    expect(body.created).toBe(0);
    expect(body.skipped.map((s) => s.reason).sort()).toEqual([
      'office_not_found',
      'owner_not_found',
    ]);
  });

  it('default owner fills rows with no owner column value', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = router(harness.db, seed.appUserId);
    const csv = 'name\nDefaultedCo\n';
    const res = await invoke(
      r,
      'post',
      '/import/commit',
      req(seed.firmId, seed.appUserId, { csv, defaultOwnerId: seed.appUserId }),
    );
    const body = res.jsonBody as { created: number };
    expect(body.created).toBe(1);
  });

  it('rejects invalid enum values', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = router(harness.db, seed.appUserId);
    const csv = 'name,client_owner_email,client_type\nBadType,sarah@test.example,LLC\n';
    const res = await invoke(
      r,
      'post',
      '/import/commit',
      req(seed.firmId, seed.appUserId, { csv }),
    );
    const body = res.jsonBody as { created: number; skipped: Array<{ reason: string }> };
    expect(body.created).toBe(0);
    expect(body.skipped[0]!.reason).toBe('invalid_client_type');
  });

  it('existing clients (external_id then name) are upserted, not duplicated', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await harness.db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id, external_id)
          VALUES (${seed.firmId}, 'Existing Co', ${seed.appUserId},
                  (SELECT id FROM office WHERE firm_id = ${seed.firmId} LIMIT 1), 'EXT-DUP')`,
    );
    const before = await harness.db.select().from(clients).where(eq(clients.firmId, seed.firmId));
    const r = router(harness.db, seed.appUserId);
    const csv = [
      'name,client_owner_email,external_id',
      'Brand New,sarah@test.example,EXT-DUP', // matches existing by external_id → update (no contacts)
      'existing co,sarah@test.example,', // matches existing by name → update (no contacts)
      'Truly New,sarah@test.example,', // creates
    ].join('\n');
    const res = await invoke(
      r,
      'post',
      '/import/commit',
      req(seed.firmId, seed.appUserId, { csv }),
    );
    const body = res.jsonBody as { created: number; updated: number; skipped: unknown[] };
    expect(body.created).toBe(1); // only Truly New
    expect(body.skipped).toHaveLength(0); // matches are updates, not skips
    const after = await harness.db.select().from(clients).where(eq(clients.firmId, seed.firmId));
    expect(after.length).toBe(before.length + 1); // no duplicate clients created
  });

  it('imports multiple contacts per client (taxpayer primary + spouse) with mobile', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = router(harness.db, seed.appUserId);
    const csv = [
      'name,client_owner_email,taxpayer_name,taxpayer_email,taxpayer_mobile,spouse_name,spouse_email',
      'The Does,sarah@test.example,John Doe,john@doe.example,555-111-2222,Jane Doe,jane@doe.example',
    ].join('\n');
    const res = await invoke(
      r,
      'post',
      '/import/commit',
      req(seed.firmId, seed.appUserId, { csv }),
    );
    const body = res.jsonBody as { created: number; contactsAdded: number };
    expect(body.created).toBe(1);
    expect(body.contactsAdded).toBe(2);
    const [client] = await harness.db
      .select()
      .from(clients)
      .where(and(eq(clients.firmId, seed.firmId), eq(clients.name, 'The Does')));
    const contacts = await harness.db
      .select({
        fullName: persons.fullName,
        email: persons.email,
        mobile: persons.mobile,
        isPrimary: clientContacts.isPrimary,
        isBilling: clientContacts.isBilling,
      })
      .from(clientContacts)
      .innerJoin(persons, eq(persons.id, clientContacts.personId))
      .where(eq(clientContacts.clientId, client!.id));
    expect(contacts).toHaveLength(2);
    const john = contacts.find((c) => c.email === 'john@doe.example')!;
    const jane = contacts.find((c) => c.email === 'jane@doe.example')!;
    expect(john.isPrimary).toBe(true); // taxpayer is primary
    expect(john.isBilling).toBe(true); // no billing slot → primary is billing
    expect(john.mobile).toBe('+15551112222'); // normalized to E.164 on store
    expect(jane.isPrimary).toBe(false);
    expect(jane.isBilling).toBe(false);
  });

  it('upsert adds a new contact to an existing client without duplicating people', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = router(harness.db, seed.appUserId);
    // Create the client with a taxpayer.
    await invoke(
      r,
      'post',
      '/import/commit',
      req(seed.firmId, seed.appUserId, {
        csv: [
          'name,client_owner_email,external_id,taxpayer_name,taxpayer_email',
          'Acme Inc,sarah@test.example,ACME,Pat Owner,pat@acme.example',
        ].join('\n'),
      }),
    );
    // Re-import: same taxpayer (dedup) + a new spouse.
    const res = await invoke(
      r,
      'post',
      '/import/commit',
      req(seed.firmId, seed.appUserId, {
        csv: [
          'name,client_owner_email,external_id,taxpayer_email,spouse_name,spouse_email',
          'Acme Inc,sarah@test.example,ACME,pat@acme.example,Sam Spouse,sam@acme.example',
        ].join('\n'),
      }),
    );
    const body = res.jsonBody as { created: number; updated: number; contactsAdded: number };
    expect(body.created).toBe(0);
    expect(body.updated).toBe(1);
    expect(body.contactsAdded).toBe(1); // only Sam; Pat already linked
    const [client] = await harness.db
      .select()
      .from(clients)
      .where(and(eq(clients.firmId, seed.firmId), eq(clients.name, 'Acme Inc')));
    const emails = (
      await harness.db
        .select({ email: persons.email })
        .from(clientContacts)
        .innerJoin(persons, eq(persons.id, clientContacts.personId))
        .where(eq(clientContacts.clientId, client!.id))
    )
      .map((c) => c.email)
      .sort();
    expect(emails).toEqual(['pat@acme.example', 'sam@acme.example']);
  });

  it('imports entity_type, normalising spreadsheet spellings', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = router(harness.db, seed.appUserId);
    const csv = [
      'name,client_owner_email,client_type,entity_type',
      'Acme SCorp,sarah@test.example,BUSINESS,S_CORP_1120S',
      'Beta Partners,sarah@test.example,BUSINESS,partnership 1065', // loose spelling
      'Gamma Trust,sarah@test.example,BUSINESS,Trust-1041', // hyphen + mixed case
    ].join('\n');
    const res = await invoke(
      r,
      'post',
      '/import/commit',
      req(seed.firmId, seed.appUserId, { csv }),
    );
    expect((res.jsonBody as { created: number }).created).toBe(3);
    const rows = await harness.db
      .select({ name: clients.name, entityType: clients.entityType })
      .from(clients)
      .where(eq(clients.firmId, seed.firmId));
    const byName = new Map(rows.map((x) => [x.name, x.entityType]));
    expect(byName.get('Acme SCorp')).toBe('S_CORP_1120S');
    expect(byName.get('Beta Partners')).toBe('PARTNERSHIP_1065');
    expect(byName.get('Gamma Trust')).toBe('TRUST_1041');
  });

  it('rejects an unknown entity_type', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = router(harness.db, seed.appUserId);
    const csv = 'name,client_owner_email,entity_type\nBadEntity,sarah@test.example,LLC_SOMETHING\n';
    const res = await invoke(
      r,
      'post',
      '/import/commit',
      req(seed.firmId, seed.appUserId, { csv }),
    );
    const body = res.jsonBody as { created: number; skipped: Array<{ reason: string }> };
    expect(body.created).toBe(0);
    expect(body.skipped[0]!.reason).toBe('invalid_entity_type');
  });

  it('entity_type stays optional — a name-only import still works', async () => {
    // client_type defaults to BUSINESS, so requiring entity_type would have
    // broken every existing minimal import file.
    const seed = await seedMinimalFirm(harness.db);
    const r = router(harness.db, seed.appUserId);
    const res = await invoke(
      r,
      'post',
      '/import/commit',
      req(seed.firmId, seed.appUserId, {
        csv: 'name\nNoEntityCo\n',
        defaultOwnerId: seed.appUserId,
      }),
    );
    expect((res.jsonBody as { created: number }).created).toBe(1);
  });

  it('within-file duplicate external_id is skipped', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = router(harness.db, seed.appUserId);
    const csv = [
      'name,client_owner_email,external_id',
      'One,sarah@test.example,SAME',
      'Two,sarah@test.example,SAME',
    ].join('\n');
    const res = await invoke(
      r,
      'post',
      '/import/commit',
      req(seed.firmId, seed.appUserId, { csv }),
    );
    const body = res.jsonBody as { created: number; skipped: Array<{ reason: string }> };
    expect(body.created).toBe(1);
    expect(body.skipped[0]!.reason).toBe('duplicate_external_id');
  });

  it('requires client:write (403 for staff role without it)', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = router(harness.db, seed.appUserId, ['staff']);
    const csv = 'name,client_owner_email\nX,sarah@test.example\n';
    const res = await invoke(
      r,
      'post',
      '/import/commit',
      req(seed.firmId, seed.appUserId, { csv }),
    );
    expect(res.statusCode).toBe(403);
  });

  it('missing name column is rejected', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const r = router(harness.db, seed.appUserId);
    const csv = 'foo,bar\n1,2\n';
    const res = await invoke(
      r,
      'post',
      '/import/preview',
      req(seed.firmId, seed.appUserId, { csv }),
    );
    expect(res.statusCode).toBe(400);
    expect((res.jsonBody as { error: string }).error).toBe('missing_name_column');
  });
});

// ---------------------------------------------------------------- UltraTax

// The UltraTax CS "Data Mining" export header, verbatim.
const UT_HEADER = [
  'Client ID',
  'Client name',
  'Client name (first last)',
  'Contact email address',
  'Contact address 1',
  'Contact address 2',
  'Contact city',
  'Contact state',
  'Contact zip code',
  'Filing status',
  'Federal entity type',
  '1040, Tp first name',
  '1040, Tp last name',
  'Contact, Tp email address',
  '1040, Tp daytime phone number',
  'Contact, Mobile telephone number',
  '1040, Sp first name',
  '1040, Sp last name',
  'Contact, Sp email address',
  '1040, Sp daytime phone number',
  'Contact, Sp Mobile telephone number',
  'Preparer name',
];
type UtRow = Partial<Record<(typeof UT_HEADER)[number], string>>;
const ZIMMERMAN: UtRow = {
  'Client ID': 'ZIMM4432',
  'Client name': 'Zimmerman, Kyler S & Jenna L',
  'Client name (first last)': 'Kyler S & Jenna L Zimmerman',
  'Contact email address': 'kyler@bookworks.us',
  'Contact address 1': '29371 Highway 52',
  'Contact city': 'Cole Camp',
  'Contact state': 'MO',
  'Contact zip code': '65325',
  'Filing status': 'Married filing joint',
  'Federal entity type': 'I',
  '1040, Tp first name': 'Kyler S',
  '1040, Tp last name': 'Zimmerman',
  'Contact, Tp email address': 'kyler@bookworks.us',
  'Contact, Mobile telephone number': '563-203-4171',
  '1040, Sp first name': 'Jenna L',
  '1040, Sp last name': 'Zimmerman',
  'Contact, Sp email address': 'kyszim@gmail.com',
  'Contact, Sp Mobile telephone number': '563-203-1041',
  'Preparer name': 'Kurt W. Krueger',
};
// Spouse on one return, HOH filer on her own — same email, and the HOH
// row carries stray "Sp" email/mobile cells with no spouse name.
const WAWRA_JOINT: UtRow = {
  'Client ID': 'WAWR6673',
  'Client name': 'Wawra, Dennis & Candace',
  'Client name (first last)': 'Dennis & Candace Wawra',
  'Contact email address': 'myworkshop47@gmail.com',
  'Contact address 1': '5040 S Grasshill Court',
  'Contact city': 'Battlefield',
  'Contact state': 'MO',
  'Contact zip code': '65619',
  'Filing status': 'Married filing joint',
  'Federal entity type': 'I',
  '1040, Tp first name': 'Dennis',
  '1040, Tp last name': 'Wawra',
  'Contact, Tp email address': 'myworkshop47@gmail.com',
  '1040, Tp daytime phone number': '417-887-8499',
  'Contact, Mobile telephone number': '417-529-3149',
  '1040, Sp first name': 'Candace',
  '1040, Sp last name': 'Wawra',
  'Contact, Sp email address': 'candace@hearlifewell.com',
  '1040, Sp daytime phone number': '417-887-8499',
  'Contact, Sp Mobile telephone number': '417-887-8499',
  'Preparer name': 'Kurt W. Krueger',
};
const WAWRA_HOH: UtRow = {
  'Client ID': 'WAWR3954',
  'Client name': 'Wawra, Candace',
  'Client name (first last)': 'Candace Wawra',
  'Contact email address': 'candace@hearlifewell.com',
  'Contact address 1': '5040 S Grasshill Court',
  'Contact city': 'Battlefield',
  'Contact state': 'MO',
  'Contact zip code': '65619',
  'Filing status': 'Head of household',
  'Federal entity type': 'I',
  '1040, Tp first name': 'Candace',
  '1040, Tp last name': 'Wawra',
  'Contact, Tp email address': 'candace@hearlifewell.com',
  '1040, Tp daytime phone number': '417-887-8499',
  'Contact, Mobile telephone number': '417-887-8499',
  'Contact, Sp email address': 'candace@hearlifewell.com',
  'Contact, Sp Mobile telephone number': '417-887-8499',
  'Preparer name': 'Dawnata E. Hopkins',
};
// Taxpayer row where the export put the spouse's email on both people.
const WITT: UtRow = {
  'Client ID': 'WITT6869',
  'Client name': 'Witt, Vincent W. & Janelle R.',
  'Client name (first last)': 'Vincent W. & Janelle R. Witt',
  'Contact email address': 'Janelle.witt1961@gmail.com',
  'Contact address 1': '2886 Highway 97',
  'Contact city': 'Pierce City',
  'Contact state': 'MO',
  'Contact zip code': '65723',
  'Filing status': 'Married filing joint',
  'Federal entity type': 'I',
  '1040, Tp first name': 'Vincent W.',
  '1040, Tp last name': 'Witt',
  'Contact, Tp email address': 'Janelle.witt1961@gmail.com',
  '1040, Tp daytime phone number': '417-466-2774',
  'Contact, Mobile telephone number': '417-825-6089',
  '1040, Sp first name': 'Janelle R.',
  '1040, Sp last name': 'Witt',
  'Contact, Sp email address': 'Janelle.witt1961@gmail.com',
  '1040, Sp daytime phone number': '417-476-2297',
  'Contact, Sp Mobile telephone number': '417-849-6049',
  'Preparer name': 'Dawnata E. Hopkins',
};

function utCsv(rows: UtRow[]): string {
  const q = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [
    UT_HEADER.map(q).join(','),
    ...rows.map((r) => UT_HEADER.map((h) => q(r[h] ?? '')).join(',')),
  ].join('\r\n');
}

/** A workbook shaped like UltraTax's: shared-string header, blanks omitted. */
function utXlsxBase64(rows: UtRow[]): string {
  const col = (i: number): string => {
    let n = i + 1;
    let s = '';
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  };
  const esc = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const shared = [...UT_HEADER];
  const sst = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared
    .map((s) => `<si><t>${esc(s)}</t></si>`)
    .join('')}</sst>`;
  const headerRow = `<row r="1">${UT_HEADER.map((_, i) => `<c r="${col(i)}1" t="s"><v>${i}</v></c>`).join('')}</row>`;
  const dataRows = rows
    .map(
      (r, ri) =>
        `<row r="${ri + 2}">${UT_HEADER.map((h, i) =>
          r[h] ? `<c r="${col(i)}${ri + 2}" t="inlineStr"><is><t>${esc(r[h]!)}</t></is></c>` : '',
        ).join('')}</row>`,
    )
    .join('');
  const zip = new AdmZip();
  zip.addFile(
    'xl/workbook.xml',
    Buffer.from(
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
  );
  zip.addFile(
    'xl/_rels/workbook.xml.rels',
    Buffer.from(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
  );
  zip.addFile('xl/sharedStrings.xml', Buffer.from(sst));
  zip.addFile(
    'xl/worksheets/sheet1.xml',
    Buffer.from(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${headerRow}${dataRows}</sheetData></worksheet>`,
    ),
  );
  return zip.toBuffer().toString('base64');
}

async function seedUltraTaxFirm(
  db: PgliteHarness['db'],
): Promise<{ firmId: string; appUserId: string; kurtId: string }> {
  const seed = await seedMinimalFirm(db);
  // Staff record spelled without the middle initial — the loose match target.
  const kurt = await db.execute(
    sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
        VALUES (${seed.firmId}, 'kurt@test.example', 'Kurt Krueger', 'Kurt', 'Krueger') RETURNING id`,
  );
  const kurtId = (kurt as unknown as { rows: { id: string }[] }).rows[0]!.id;
  await db.insert(contactRoles).values([
    { firmId: seed.firmId, key: 'spouse', name: 'Spouse' },
    { firmId: seed.firmId, key: 'taxpayer', name: 'Taxpayer' },
  ]);
  return { firmId: seed.firmId, appUserId: seed.appUserId, kurtId };
}

async function contactsOf(db: PgliteHarness['db'], clientId: string) {
  return db
    .select({
      fullName: persons.fullName,
      email: persons.email,
      phone: persons.phone,
      mobile: persons.mobile,
      personId: persons.id,
      roleKey: contactRoles.key,
      isPrimary: clientContacts.isPrimary,
      isBilling: clientContacts.isBilling,
    })
    .from(clientContacts)
    .innerJoin(persons, eq(persons.id, clientContacts.personId))
    .leftJoin(contactRoles, eq(contactRoles.id, clientContacts.roleId))
    .where(eq(clientContacts.clientId, clientId));
}

describe('looseNameKey', () => {
  it('keeps first + last, drops middle initials and punctuation', () => {
    expect(looseNameKey('Kurt W. Krueger')).toBe('kurt krueger');
    expect(looseNameKey('Dawnata E. Hopkins')).toBe('dawnata hopkins');
    expect(looseNameKey('Sarah Chen')).toBe('sarah chen');
    expect(looseNameKey('Cher')).toBe('cher');
  });
});

describe('UltraTax data-mining import', () => {
  it('preview auto-maps the UltraTax headers and resolves the preparer loosely', async () => {
    const f = await seedUltraTaxFirm(harness.db);
    const r = router(harness.db, f.appUserId);
    const res = await invoke(
      r,
      'post',
      '/import/preview',
      req(f.firmId, f.appUserId, {
        csv: utCsv([ZIMMERMAN, WAWRA_HOH]),
        defaultOwnerId: f.appUserId,
      }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.jsonBody as {
      mappedColumns: string[];
      willCreate: number;
      rows: Array<{
        action: string;
        ownerName: string | null;
        warnings: string[];
        contactCount: number;
      }>;
    };
    expect(body.willCreate).toBe(2);
    for (const f2 of [
      'name',
      'client_facing_name',
      'external_id',
      'filing_status',
      'entity_type',
      'client_owner_name',
      'mailing_street1',
      'mailing_street2',
      'mailing_city',
      'mailing_state',
      'mailing_postal',
    ])
      expect(body.mappedColumns).toContain(f2);
    // "Kurt W. Krueger" → staff "Kurt Krueger"; "Dawnata E. Hopkins" → default owner + warning.
    expect(body.rows[0]!.ownerName).toBe('Kurt Krueger');
    expect(body.rows[0]!.warnings).toEqual([]);
    expect(body.rows[0]!.contactCount).toBe(2);
    expect(body.rows[1]!.ownerName).toBe('Sarah Chen');
    expect(body.rows[1]!.warnings).toContain('owner_fallback');
    // Stray "Sp email" with no spouse name does not become a person.
    expect(body.rows[1]!.contactCount).toBe(1);
  });

  it('commit writes client fields (Client ID → external id) and taxpayer/spouse people with roles', async () => {
    const f = await seedUltraTaxFirm(harness.db);
    const r = router(harness.db, f.appUserId);
    const res = await invoke(
      r,
      'post',
      '/import/commit',
      req(f.firmId, f.appUserId, { csv: utCsv([ZIMMERMAN]), defaultOwnerId: f.appUserId }),
    );
    expect(res.statusCode).toBe(200);
    expect((res.jsonBody as { created: number }).created).toBe(1);
    const [c] = await harness.db
      .select()
      .from(clients)
      .where(and(eq(clients.firmId, f.firmId), eq(clients.externalId, 'ZIMM4432')));
    expect(c).toBeDefined();
    expect(c!.name).toBe('Zimmerman, Kyler S & Jenna L');
    expect(c!.clientFacingName).toBe('Kyler S & Jenna L Zimmerman');
    expect(c!.externalId).toBe('ZIMM4432');
    expect(c!.clientType).toBe('INDIVIDUAL');
    expect(c!.entityType).toBeNull();
    expect(c!.filingStatus).toBe('MFJ');
    expect(c!.mailingStreet1).toBe('29371 Highway 52');
    expect(c!.mailingCity).toBe('Cole Camp');
    expect(c!.mailingState).toBe('MO');
    expect(c!.mailingPostal).toBe('65325');
    expect(c!.partnerInChargeId).toBe(f.kurtId);

    const people = await contactsOf(harness.db, c!.id);
    expect(people).toHaveLength(2);
    const kyler = people.find((p) => p.fullName === 'Kyler S Zimmerman')!;
    const jenna = people.find((p) => p.fullName === 'Jenna L Zimmerman')!;
    expect(kyler.email).toBe('kyler@bookworks.us');
    expect(kyler.mobile).toBe('+15632034171');
    expect(kyler.isPrimary).toBe(true);
    expect(kyler.isBilling).toBe(true);
    expect(kyler.roleKey).toBe('taxpayer');
    expect(jenna.email).toBe('kyszim@gmail.com');
    expect(jenna.mobile).toBe('+15632031041');
    expect(jenna.isPrimary).toBe(false);
    expect(jenna.roleKey).toBe('spouse');
  });

  it('accepts the workbook itself (xlsxBase64) with identical results', async () => {
    const f = await seedUltraTaxFirm(harness.db);
    const r = router(harness.db, f.appUserId);
    const res = await invoke(
      r,
      'post',
      '/import/commit',
      req(f.firmId, f.appUserId, {
        xlsxBase64: utXlsxBase64([ZIMMERMAN, WAWRA_HOH]),
        defaultOwnerId: f.appUserId,
      }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.jsonBody as { created: number; contactsAdded: number };
    expect(body.created).toBe(2);
    expect(body.contactsAdded).toBe(3);
    const [c] = await harness.db
      .select()
      .from(clients)
      .where(and(eq(clients.firmId, f.firmId), eq(clients.externalId, 'WAWR3954')));
    expect(c!.filingStatus).toBe('HOH');
    expect(c!.mailingStreet2).toBeNull();
  });

  it('rejects a non-workbook xlsxBase64 and a body with both csv and xlsx', async () => {
    const f = await seedUltraTaxFirm(harness.db);
    const r = router(harness.db, f.appUserId);
    const bad = await invoke(
      r,
      'post',
      '/import/preview',
      req(f.firmId, f.appUserId, { xlsxBase64: Buffer.from('name\nAcme\n').toString('base64') }),
    );
    expect(bad.statusCode).toBe(400);
    expect((bad.jsonBody as { error: string }).error).toBe('invalid_xlsx');
    const both = await invoke(
      r,
      'post',
      '/import/preview',
      req(f.firmId, f.appUserId, { csv: 'name\nAcme\n', xlsxBase64: 'AAAA' }),
    );
    expect(both.statusCode).toBe(400);
    expect((both.jsonBody as { error: string }).error).toBe('invalid_payload');
  });

  it('links one person across clients (spouse on one return, taxpayer on her own) and keeps a same-email spouse separate', async () => {
    const f = await seedUltraTaxFirm(harness.db);
    const r = router(harness.db, f.appUserId);
    const preview = await invoke(
      r,
      'post',
      '/import/preview',
      req(f.firmId, f.appUserId, {
        csv: utCsv([WAWRA_JOINT, WAWRA_HOH, WITT]),
        defaultOwnerId: f.appUserId,
      }),
    );
    const prows = (
      preview.jsonBody as { rows: Array<{ warnings: string[]; contactCount: number }> }
    ).rows;
    // Witt: spouse shares the taxpayer's email → kept as two people, email dropped on the spouse.
    expect(prows[2]!.warnings).toContain('shared_email');
    expect(prows[2]!.contactCount).toBe(2);
    const res = await invoke(
      r,
      'post',
      '/import/commit',
      req(f.firmId, f.appUserId, {
        csv: utCsv([WAWRA_JOINT, WAWRA_HOH, WITT]),
        defaultOwnerId: f.appUserId,
      }),
    );
    expect((res.jsonBody as { created: number }).created).toBe(3);
    const byTaxId = async (id: string) =>
      (
        await harness.db
          .select()
          .from(clients)
          .where(and(eq(clients.firmId, f.firmId), eq(clients.externalId, id)))
      )[0]!;
    const joint = await contactsOf(harness.db, (await byTaxId('WAWR6673')).id);
    const hoh = await contactsOf(harness.db, (await byTaxId('WAWR3954')).id);
    expect(joint).toHaveLength(2);
    expect(hoh).toHaveLength(1);
    const candaceOnJoint = joint.find((p) => p.email === 'candace@hearlifewell.com')!;
    expect(candaceOnJoint.roleKey).toBe('spouse');
    // Same person row on both clients.
    expect(hoh[0]!.personId).toBe(candaceOnJoint.personId);
    expect(hoh[0]!.roleKey).toBe('taxpayer');
    expect(hoh[0]!.isPrimary).toBe(true);
    // Dennis/Candace share the daytime phone but both have emails — Candace keeps hers.
    expect(candaceOnJoint.phone).toBeNull(); // dropped: equals the taxpayer's phone
    expect(candaceOnJoint.email).toBe('candace@hearlifewell.com');

    const witt = await contactsOf(harness.db, (await byTaxId('WITT6869')).id);
    expect(witt).toHaveLength(2);
    const vincent = witt.find((p) => p.fullName === 'Vincent W. Witt')!;
    const janelle = witt.find((p) => p.fullName === 'Janelle R. Witt')!;
    expect(vincent.email).toBe('janelle.witt1961@gmail.com'); // normalized on store
    expect(janelle.email).toBeNull();
    expect(janelle.mobile).toBe('+14178496049');
    expect(janelle.personId).not.toBe(vincent.personId);

    // Persons: Dennis, Candace, Vincent, Janelle — no duplicates.
    const count = await harness.db
      .select({ n: sql<number>`count(*)::int` })
      .from(persons)
      .where(eq(persons.firmId, f.firmId));
    expect(count[0]!.n).toBe(4);
  });

  it('re-importing the same file is idempotent, and updateExisting rewrites only changed columns', async () => {
    const f = await seedUltraTaxFirm(harness.db);
    const r = router(harness.db, f.appUserId);
    const body = (rows: UtRow[], extra: Record<string, unknown> = {}) =>
      req(f.firmId, f.appUserId, { csv: utCsv(rows), defaultOwnerId: f.appUserId, ...extra });
    await invoke(r, 'post', '/import/commit', body([ZIMMERMAN]));
    // Same file again, default mode: nothing created, no new people.
    const again = await invoke(r, 'post', '/import/commit', body([ZIMMERMAN]));
    const a = again.jsonBody as {
      created: number;
      updated: number;
      contactsAdded: number;
      fieldUpdates: number;
    };
    expect(a.created).toBe(0);
    expect(a.contactsAdded).toBe(0);
    expect(a.fieldUpdates).toBe(0);
    const personCount = async () =>
      (
        await harness.db
          .select({ n: sql<number>`count(*)::int` })
          .from(persons)
          .where(eq(persons.firmId, f.firmId))
      )[0]!.n;
    expect(await personCount()).toBe(2);

    // Moved house + now a different preparer that does NOT resolve.
    const moved: UtRow = {
      ...ZIMMERMAN,
      'Contact address 1': '1 New Rd',
      'Contact city': 'Sedalia',
      'Preparer name': 'Gary T Shaffer',
    };
    // Flag off: preview says update with no field changes; the row is untouched.
    const offPreview = await invoke(r, 'post', '/import/preview', body([moved]));
    const offRow = (
      offPreview.jsonBody as { rows: Array<{ action: string; fieldsChanged: string[] }> }
    ).rows[0]!;
    expect(offRow.action).toBe('update');
    expect(offRow.fieldsChanged).toEqual([]);
    await invoke(r, 'post', '/import/commit', body([moved]));
    const [stillOld] = await harness.db
      .select()
      .from(clients)
      .where(and(eq(clients.firmId, f.firmId), eq(clients.externalId, 'ZIMM4432')));
    expect(stillOld!.mailingStreet1).toBe('29371 Highway 52');

    // Flag on: preview lists the changed columns; commit rewrites them, keeps
    // the owner (unresolved preparer → no overwrite), audits before/after.
    const onPreview = await invoke(
      r,
      'post',
      '/import/preview',
      body([moved], { updateExisting: true }),
    );
    const onRow = (
      onPreview.jsonBody as {
        willUpdate: number;
        rows: Array<{ action: string; fieldsChanged: string[]; warnings: string[] }>;
      }
    ).rows[0]!;
    expect(onRow.action).toBe('update');
    expect(onRow.fieldsChanged.sort()).toEqual(['mailingCity', 'mailingStreet1']);
    expect(onRow.warnings).toContain('owner_fallback');
    const commit = await invoke(
      r,
      'post',
      '/import/commit',
      body([moved], { updateExisting: true }),
    );
    const cb = commit.jsonBody as { created: number; updated: number; fieldUpdates: number };
    expect(cb.created).toBe(0);
    expect(cb.updated).toBe(1);
    expect(cb.fieldUpdates).toBe(1);
    const [now] = await harness.db
      .select()
      .from(clients)
      .where(and(eq(clients.firmId, f.firmId), eq(clients.externalId, 'ZIMM4432')));
    expect(now!.mailingStreet1).toBe('1 New Rd');
    expect(now!.mailingCity).toBe('Sedalia');
    expect(now!.partnerInChargeId).toBe(f.kurtId); // not replaced by the default owner
    expect(await personCount()).toBe(2);
    const audits = await harness.db
      .select({ action: auditLog.action, before: auditLog.beforeJson, after: auditLog.afterJson })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, now!.id), eq(auditLog.action, 'UPDATE')));
    expect(audits).toHaveLength(1);
    expect((audits[0]!.before as { mailingStreet1: string }).mailingStreet1).toBe(
      '29371 Highway 52',
    );
    expect((audits[0]!.after as { mailingStreet1: string }).mailingStreet1).toBe('1 New Rd');
  });
});
