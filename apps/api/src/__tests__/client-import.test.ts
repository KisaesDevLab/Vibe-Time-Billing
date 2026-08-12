// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Q36 — CSV client import. Preview is a dry-run (no writes); commit
// inserts in one transaction with skip-existing dedupe (external_id then
// case-insensitive name). Both gated by client:write.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq, and } from 'drizzle-orm';
import type express from 'express';

import { clients, clientContacts, persons } from '@vibe/db/schema';

import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createClientRouter } from '../clients/routes';
import { CANONICAL_FIELDS, buildImportTemplateCsv, parseCsv } from '../clients/import';

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
