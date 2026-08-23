// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0221 — People-page bulk email. Sends to selected people, skipping
// blank emails and bulk-email opt-outs; presence filters and the PATCH
// opt-out flag round-trip.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import {
  buildPgliteHarness,
  seedMinimalFirm,
  seedContact,
  type PgliteHarness,
} from './_pglite-harness';
import type { Database } from '@vibe/db';
import { persons } from '@vibe/db/schema';
import { eq } from 'drizzle-orm';

import { createPeopleRouter } from '../people/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});

afterEach(async () => {
  await harness.close();
});

async function invoke(
  router: ReturnType<typeof createPeopleRouter>,
  method: 'get' | 'post' | 'patch',
  path: string,
  req: Record<string, unknown>,
): Promise<{ statusCode: number; body: unknown }> {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(n: number) {
      this.statusCode = n;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  const stack = (
    router as unknown as {
      stack: {
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: { handle: (...a: unknown[]) => unknown }[];
        };
      }[];
    }
  ).stack;
  const layer = stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`route not registered: ${method} ${path}`);
  const handler = layer.route.stack[layer.route.stack.length - 1]!.handle;
  await (handler as (rq: unknown, rs: unknown) => Promise<void>)(req, res);
  return res;
}

function staffReq(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    body: {},
    params: {},
    query: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
    ...over,
  };
}

describe('0221 — people bulk email + opt-out', () => {
  it('sends to emailable people, skips opted-out and blank', async () => {
    const a = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Alice Emailer',
      email: 'alice@x.example',
    });
    const b = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Bob Blocked',
      email: 'bob@x.example',
    });
    const c = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Cara NoEmail',
      phone: '+15550001111',
    });
    const sent: { to: string; subject: string }[] = [];
    const router = createPeopleRouter({
      db: harness.db as Database,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
      sendStaffMail: async (m) => {
        sent.push({ to: m.to, subject: m.subject });
      },
    });

    // Block Bob via the PATCH opt-out flag.
    const patched = await invoke(
      router,
      'patch',
      '/:id',
      staffReq({ params: { id: b.personId }, body: { bulkEmailOptOut: true } }),
    );
    expect(patched.statusCode).toBe(200);
    const check = (await harness.db.execute(
      sql`SELECT bulk_email_opt_out FROM person WHERE id = ${b.personId}`,
    )) as unknown as { rows: { bulk_email_opt_out: boolean }[] };
    expect(check.rows[0]?.bulk_email_opt_out).toBe(true);

    const res = await invoke(
      router,
      'post',
      '/bulk-email',
      staffReq({
        body: {
          people: [
            { kind: 'person', id: a.personId },
            { kind: 'person', id: b.personId },
            { kind: 'person', id: c.personId },
          ],
          subject: 'Hello {{person.name}}',
          body: 'Office update from {{firm.name}}.',
        },
      }),
    );
    expect(res.statusCode).toBe(200);
    const results = (res.body as { results: { sent: boolean; reason: string | null }[] }).results;
    expect(results).toHaveLength(3);
    expect(results.filter((r) => r.sent)).toHaveLength(1);
    expect(results.map((r) => r.reason).sort()).toEqual([null, 'no_email', 'opted_out'].sort());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('alice@x.example');
    expect(sent[0]!.subject).toBe('Hello Alice Emailer');
  });
});

describe('0221 — people merge', () => {
  it('0224 — merge keeps any opt-out from the merged records', async () => {
    const a = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Survivor',
      isPrimary: true,
    });
    const b = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Dupe',
      mobile: '+15555550199',
    });
    await harness.db
      .update(persons)
      .set({ smsOptOut: true, doNotCall: true })
      .where(eq(persons.id, b.personId));
    const router = createPeopleRouter({
      db: harness.db as Database,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const res = await invoke(
      router,
      'post',
      '/merge',
      staffReq({ body: { survivorId: a.personId, mergeIds: [b.personId] } }),
    );
    expect(res.statusCode).toBe(200);
    const [surv] = await harness.db.select().from(persons).where(eq(persons.id, a.personId));
    expect(surv!.mobile).toBe('+15555550199');
    expect(surv!.smsOptOut).toBe(true);
    expect(surv!.doNotCall).toBe(true);
  });

  it('0224 — PATCH rolls the flags back when the email collides', async () => {
    const a = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'A',
      email: 'a@x.example',
    });
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'B',
      email: 'b@x.example',
    });
    const router = createPeopleRouter({
      db: harness.db as Database,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const res = await invoke(
      router,
      'patch',
      '/:id',
      staffReq({ params: { id: a.personId }, body: { email: 'b@x.example', smsOptOut: true } }),
    );
    expect(res.statusCode).toBe(409);
    const [row] = await harness.db.select().from(persons).where(eq(persons.id, a.personId));
    expect(row!.smsOptOut).toBe(false);
    expect(row!.email).toBe('a@x.example');
  });

  it('0224 — PATCH stores blank phone/mobile as NULL', async () => {
    const a = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'A',
      mobile: '+15555550100',
    });
    const router = createPeopleRouter({
      db: harness.db as Database,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const res = await invoke(
      router,
      'patch',
      '/:id',
      staffReq({ params: { id: a.personId }, body: { mobile: '  ' } }),
    );
    expect(res.statusCode).toBe(200);
    const [row] = await harness.db.select().from(persons).where(eq(persons.id, a.personId));
    expect(row!.mobile).toBeNull();
  });

  it('repoints contacts, merges flags, archives the duplicate person', async () => {
    const a = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat Survivor',
      isPrimary: true,
    });
    const b = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat Duplicate',
      email: 'pat@x.example',
      isBilling: true,
    });
    const router = createPeopleRouter({
      db: harness.db as Database,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const res = await invoke(
      router,
      'post',
      '/merge',
      staffReq({ body: { survivorId: a.personId, mergeIds: [b.personId] } }),
    );
    expect(res.statusCode).toBe(200);

    const survivor = (await harness.db.execute(
      sql`SELECT email, status FROM person WHERE id = ${a.personId}`,
    )) as unknown as { rows: { email: string | null; status: string }[] };
    // Backfilled from the merged duplicate.
    expect(survivor.rows[0]?.email).toBe('pat@x.example');
    expect(survivor.rows[0]?.status).toBe('ACTIVE');

    const merged = (await harness.db.execute(
      sql`SELECT email, status FROM person WHERE id = ${b.personId}`,
    )) as unknown as { rows: { email: string | null; status: string }[] };
    expect(merged.rows[0]?.status).toBe('ARCHIVED');
    expect(merged.rows[0]?.email).toBeNull();

    // Survivor's contact carries both flags; duplicate contact archived.
    const contacts = (await harness.db.execute(
      sql`SELECT person_id, is_primary, is_billing, status FROM client_contact
          WHERE client_id = ${seed.clientId} ORDER BY created_at`,
    )) as unknown as {
      rows: { person_id: string; is_primary: boolean; is_billing: boolean; status: string }[];
    };
    const surv = contacts.rows.find((r) => r.person_id === a.personId && r.status === 'ACTIVE');
    expect(surv?.is_primary).toBe(true);
    expect(surv?.is_billing).toBe(true);
    const dup = contacts.rows.find((r) => r.person_id === b.personId);
    expect(dup?.status).toBe('ARCHIVED');
    expect(dup?.is_billing).toBe(false);

    // The archived duplicate disappears from the People directory list.
    const list = await invoke(router, 'get', '/', staffReq());
    const rows = (list.body as { rows: { id: string }[] }).rows;
    expect(rows.some((r) => r.id === b.personId)).toBe(false);
    expect(rows.some((r) => r.id === a.personId)).toBe(true);
  });
});
