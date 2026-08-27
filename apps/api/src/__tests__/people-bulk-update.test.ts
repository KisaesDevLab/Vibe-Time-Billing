// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Admin "Update people": paste a directory list and write contact fields
// onto the people already in the firm. The cases below are the real ones
// from the appliance's own directory — a person stored with a middle
// initial, a name whose only difference is a period, a mobile number
// already filed as a landline, and 227 name collisions that make
// name-only matching unsafe.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type express from 'express';

import { auditLog, persons } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createPeopleRouter } from '../people/routes';
import {
  autoMap,
  buildDirectoryContext,
  matchPerson,
  validatePeopleRows,
  type DirectoryPerson,
} from '../people/bulk-update';
import { parseCsv, sniffDelimiter } from '../clients/import';

let harness: PgliteHarness;
beforeEach(async () => {
  harness = await buildPgliteHarness();
});
afterEach(async () => {
  await harness.close();
});

// The six rows the firm actually pasted, tab-separated as Excel gives them.
const LIST = [
  'Taxpayer Name\tMobile Phone\tLandline Phone\tEmail',
  'Dusty Hayes\t\t(417) 592-7847\tabbeyscott30@gmail.com',
  'Aaron Shockley\t(417) 229-6903\t\tshockleyaaron35@yahoo.com',
  'John Beard\t(316) 210-5952\t\t',
  'Christopher Mettlach\t\t\tcmettlach@diamondwildcats.org',
  'Hunter Voris\t(314) 448-3079\t\t',
  'Tyler L. Waterman\t(417) 317-4557\t\t',
].join('\n');

// The directory as it stands on the appliance for those six.
const DIRECTORY: DirectoryPerson[] = [
  {
    id: 'p-dusty',
    fullName: 'Dusty Hayes',
    email: 'abbeyscott30@gmail.com',
    phone: null,
    mobile: null,
  },
  {
    id: 'p-aaron',
    fullName: 'Aaron Shockley',
    email: 'shockleyaaron35@yahoo.com',
    phone: '+14172296903',
    mobile: null,
  },
  {
    id: 'p-john',
    fullName: 'John Beard',
    email: 'asbeard03@gmail.com',
    phone: '+13167298389',
    mobile: null,
  },
  {
    id: 'p-chris',
    fullName: 'Christopher J Mettlach',
    email: 'cmettlach@diamondwildcats.org',
    phone: '+14178669245',
    mobile: null,
  },
  { id: 'p-hunter', fullName: 'Hunter Voris', email: null, phone: null, mobile: '+13144483079' },
  { id: 'p-tyler', fullName: 'Tyler L Waterman', email: null, phone: null, mobile: null },
];

function run(list: string, opts = {}) {
  const { header, rows } = parseCsv(list, sniffDelimiter(list));
  const ctx = buildDirectoryContext(DIRECTORY);
  return { ctx, ...validatePeopleRows(ctx, rows, autoMap(header), opts) };
}

describe('people bulk update — column mapping', () => {
  it('maps the roster headers, including "Taxpayer Name" and "Landline Phone"', () => {
    const { header } = parseCsv(LIST, sniffDelimiter(LIST));
    expect(autoMap(header)).toEqual({ full_name: 0, mobile: 1, phone: 2, email: 3 });
  });
});

describe('people bulk update — matching', () => {
  const ctx = buildDirectoryContext(DIRECTORY);

  it('email wins over a name that does not match', () => {
    const hit = matchPerson(ctx, {
      name: 'Christopher Mettlach',
      email: 'cmettlach@diamondwildcats.org',
      phone: null,
      mobile: null,
    });
    expect(hit).toMatchObject({ matchedBy: 'email', person: { id: 'p-chris' } });
  });

  it('falls back to a loose name when there is no email or phone on file', () => {
    const hit = matchPerson(ctx, {
      name: 'Tyler L. Waterman',
      email: null,
      phone: null,
      mobile: null,
    });
    expect(hit).toMatchObject({ matchedBy: 'loose_name', person: { id: 'p-tyler' } });
  });

  it('matches on a phone number the person already carries', () => {
    const hit = matchPerson(ctx, {
      name: 'H. Voris',
      email: null,
      phone: null,
      mobile: '+13144483079',
    });
    expect(hit).toMatchObject({ matchedBy: 'phone', person: { id: 'p-hunter' } });
  });

  it('a name shared by two people is inconclusive, not a guess', () => {
    const twins = buildDirectoryContext([
      { id: 'a', fullName: 'John Beard', email: null, phone: null, mobile: null },
      { id: 'b', fullName: 'John Beard', email: null, phone: null, mobile: null },
    ]);
    expect(
      matchPerson(twins, { name: 'John Beard', email: null, phone: null, mobile: null }),
    ).toEqual({
      ambiguous: true,
    });
  });

  it('a shared household number still resolves when the name is unique', () => {
    const household = buildDirectoryContext([
      { id: 'h1', fullName: 'Pat Smith', email: null, phone: '+14170000000', mobile: null },
      { id: 'h2', fullName: 'Chris Smith', email: null, phone: '+14170000000', mobile: null },
    ]);
    const hit = matchPerson(household, {
      name: 'Chris Smith',
      email: null,
      phone: '+14170000000',
      mobile: null,
    });
    expect(hit).toMatchObject({ matchedBy: 'name', person: { id: 'h2' } });
  });
});

describe('people bulk update — the firm’s six rows', () => {
  it('resolves all six and writes only what is actually new', () => {
    const r = run(LIST);
    expect(r.willSkip).toBe(0);
    expect(r.willCreate).toBe(0);
    expect(r.willUpdate).toBe(6);
    const by = (name: string) =>
      r.outcomes.find((o) => o.name === name) as Extract<
        (typeof r.outcomes)[number],
        { action: 'update' }
      >;

    // Landline lands on an empty field.
    expect(by('Dusty Hayes').changes).toEqual([{ field: 'phone', from: null, to: '+14175927847' }]);
    // The "mobile" is already on file as his landline — reported, not copied.
    expect(by('Aaron Shockley').changes).toEqual([]);
    expect(by('Aaron Shockley').warnings).toContain('mobile_already_on_file_as_landline');
    // A genuinely new mobile, on a person whose landline is a different number.
    expect(by('John Beard').changes).toEqual([{ field: 'mobile', from: null, to: '+13162105952' }]);
    // Matched by email; the stored middle initial is flagged, never rewritten.
    expect(by('Christopher Mettlach').matchedBy).toBe('email');
    expect(by('Christopher Mettlach').changes).toEqual([]);
    expect(by('Christopher Mettlach').warnings).toContain('name_differs');
    // Already correct.
    expect(by('Hunter Voris').changes).toEqual([]);
    expect(by('Hunter Voris').warnings).toEqual([]);
    // Found by loose name, gains its first phone number.
    expect(by('Tyler L. Waterman').matchedBy).toBe('loose_name');
    expect(by('Tyler L. Waterman').changes).toEqual([
      { field: 'mobile', from: null, to: '+14173174557' },
    ]);
  });

  it('updateNames rewrites the stored spelling', () => {
    const r = run(LIST, { updateNames: true });
    const chris = r.outcomes.find((o) => o.name === 'Christopher Mettlach');
    expect(chris).toMatchObject({
      changes: [{ field: 'fullName', from: 'Christopher J Mettlach', to: 'Christopher Mettlach' }],
    });
  });
});

describe('people bulk update — conflicts', () => {
  it('a differing email is overwritten by default and kept with fillBlanksOnly', () => {
    const list = 'Name\tEmail\nJohn Beard\tjbeard@newfirm.com';
    const overwrite = run(list);
    expect(overwrite.outcomes[0]).toMatchObject({
      action: 'update',
      changes: [{ field: 'email', from: 'asbeard03@gmail.com', to: 'jbeard@newfirm.com' }],
    });
    const keep = run(list, { fillBlanksOnly: true });
    expect(keep.outcomes[0]).toMatchObject({ changes: [], warnings: ['email_conflict_kept'] });
  });

  it('an email that belongs to a different named person is a conflict, not a write', () => {
    // The row says Hunter Voris but carries John Beard's address: matching
    // on email alone would quietly edit John's record.
    const list = 'Name\tEmail\nHunter Voris\tasbeard03@gmail.com';
    const r = run(list);
    expect(r.outcomes[0]).toMatchObject({
      action: 'skip',
      reason: 'conflicting_match',
      detail: 'John Beard vs Hunter Voris',
    });
  });

  it('an email owned by someone the row does not name is refused too', () => {
    // No name collision to cross-check against, so the row resolves to the
    // email's owner — but that owner already holds the address, and the
    // unique index would reject writing it onto anyone else.
    const list = 'Name\tEmail\nBrand New Person\tasbeard03@gmail.com';
    const r = run(list, { createMissing: true });
    expect(r.outcomes[0]).toMatchObject({ action: 'update', personName: 'John Beard' });
  });

  it('two rows claiming the same person are written once', () => {
    const list = [
      'Name\tMobile',
      'Tyler L. Waterman\t(417) 317-4557',
      'Tyler Waterman\t(417) 000-1111',
    ].join('\n');
    const r = run(list);
    expect(r.willUpdate).toBe(1);
    expect(r.outcomes[1]).toMatchObject({ action: 'skip', reason: 'duplicate_row_for_person' });
  });

  it('an unknown person is reported, and created only on request', () => {
    const list = 'Name\tEmail\nBrand New\tbrand.new@example.com';
    expect(run(list).outcomes[0]).toMatchObject({ action: 'skip', reason: 'not_in_platform' });
    const withCreate = run(list, { createMissing: true });
    expect(withCreate.willCreate).toBe(1);
    expect(withCreate.outcomes[0]).toMatchObject({ action: 'create', name: 'Brand New' });
  });

  it('rejects unparseable numbers and emails rather than storing junk', () => {
    const list = ['Name\tMobile\tEmail', 'Dusty Hayes\t12\t', 'Hunter Voris\t\tnot-an-email'].join(
      '\n',
    );
    const r = run(list);
    expect(r.outcomes.map((o) => (o as { reason?: string }).reason)).toEqual([
      'invalid_mobile',
      'invalid_email',
    ]);
  });
});

// --------------------------------------------------------------- route level

interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
}
function makeRes(): FakeRes {
  return {
    statusCode: 200,
    jsonBody: undefined,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.jsonBody = b;
      return this;
    },
  };
}
async function invoke(
  router: express.Router,
  path: string,
  req: Record<string, unknown>,
): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods['post'] === true;
  });
  if (!layer) throw new Error(`route not registered: post ${path}`);
  const chain = (layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] })
    .stack;
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

describe('people bulk update — commit', () => {
  it('writes the fields, audits each person, and leaves the rest alone', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const router = createPeopleRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    await harness.db.insert(persons).values([
      { firmId: seed.firmId, fullName: 'Tyler L Waterman' },
      { firmId: seed.firmId, fullName: 'Hunter Voris', mobile: '+13144483079' },
    ]);
    const body = {
      csv: [
        'Taxpayer Name\tMobile Phone',
        'Tyler L. Waterman\t(417) 317-4557',
        'Hunter Voris\t(314) 448-3079',
      ].join('\n'),
    };
    const req = (b: unknown): Record<string, unknown> => ({
      body: b,
      params: {},
      query: {},
      headers: {},
      staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
      ip: '127.0.0.1',
      header: () => undefined,
      get: () => undefined,
    });

    const preview = await invoke(router, '/bulk-update/preview', req(body));
    expect(preview.statusCode).toBe(200);
    expect(preview.jsonBody).toMatchObject({ total: 2, willUpdate: 2, willCreate: 0, willSkip: 0 });

    const commit = await invoke(router, '/bulk-update/commit', req(body));
    expect(commit.jsonBody).toMatchObject({ updated: 1, created: 0 });

    const [tyler] = await harness.db
      .select()
      .from(persons)
      .where(and(eq(persons.firmId, seed.firmId), eq(persons.fullName, 'Tyler L Waterman')));
    expect(tyler!.mobile).toBe('+14173174557');
    const audits = await harness.db
      .select({ before: auditLog.beforeJson, after: auditLog.afterJson })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, tyler!.id), eq(auditLog.action, 'UPDATE')));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({ mobile: '+14173174557', kind: 'bulk_update' });

    // Hunter already carried that number — untouched, unaudited.
    const [hunter] = await harness.db
      .select()
      .from(persons)
      .where(and(eq(persons.firmId, seed.firmId), eq(persons.fullName, 'Hunter Voris')));
    const hunterAudits = await harness.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.entityId, hunter!.id));
    expect(hunterAudits).toHaveLength(0);
  });
});
