// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
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
import { parseCsv } from '../clients/import';

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

  it('skip-existing dedupe: external_id then case-insensitive name', async () => {
    const seed = await seedMinimalFirm(harness.db);
    // Pre-existing client with external id and a known name.
    await harness.db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id, external_id)
          VALUES (${seed.firmId}, 'Existing Co', ${seed.appUserId},
                  (SELECT id FROM office WHERE firm_id = ${seed.firmId} LIMIT 1), 'EXT-DUP')`,
    );
    const r = router(harness.db, seed.appUserId);
    const csv = [
      'name,client_owner_email,external_id',
      'Brand New,sarah@test.example,EXT-DUP', // dup external_id → skip
      'existing co,sarah@test.example,', // dup name (case-insensitive) → skip
      'Truly New,sarah@test.example,', // creates
    ].join('\n');
    const res = await invoke(
      r,
      'post',
      '/import/commit',
      req(seed.firmId, seed.appUserId, { csv }),
    );
    const body = res.jsonBody as { created: number; skipped: Array<{ reason: string }> };
    expect(body.created).toBe(1);
    expect(body.skipped.map((s) => s.reason).sort()).toEqual([
      'duplicate_external_id',
      'duplicate_name',
    ]);
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
