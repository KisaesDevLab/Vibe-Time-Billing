// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Server-side pagination + filtering on the clients list (GET /). At firm
// scale (3000+ clients) the list must page in SQL, not slice a capped fetch:
//   - ?page= returns the { rows, total, page, pageSize } envelope
//   - pageSize is honored and clamped; page 2 differs from page 1
//   - total counts the whole filtered set, not the page
//   - multi-value filters (comma-separated) match as IN(...)
//   - free-text q searches name/externalId
// The no-page legacy shape ({ items }, capped 500) still works for old callers.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sql } from 'drizzle-orm';

import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createClientRouter } from '../clients/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

function app(): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  const roles = new Map<string, RoleSlug[]>([[seed.appUserId, ['admin']]]);
  a.use('/api/staff/clients', createClientRouter({ db: harness.db, fakeUserRoles: roles }));
  return a;
}

async function makeClient(name: string, extra: Record<string, unknown> = {}): Promise<void> {
  const r = await request(app())
    .post('/api/staff/clients')
    .send({ name, partnerInChargeId: seed.appUserId, ...extra });
  expect(r.status).toBe(201);
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  // Drop the seed's baseline client (+ its engagement) so row counts in these
  // tests are deterministic (start from an empty client list).
  await harness.db.execute(sql`DELETE FROM engagement WHERE client_id = ${seed.clientId}`);
  await harness.db.execute(sql`DELETE FROM client WHERE id = ${seed.clientId}`);
});
afterEach(async () => {
  await harness.close();
});

describe('clients list — server-side pagination', () => {
  it('returns the paginated envelope and honors pageSize', async () => {
    for (let i = 0; i < 7; i++) await makeClient(`Client ${String(i).padStart(2, '0')}`);

    const p1 = await request(app()).get('/api/staff/clients?page=1&pageSize=5&sort=name&dir=asc');
    expect(p1.status).toBe(200);
    expect(p1.body.total).toBe(7);
    expect(p1.body.page).toBe(1);
    expect(p1.body.pageSize).toBe(5);
    expect(p1.body.rows).toHaveLength(5);

    const p2 = await request(app()).get('/api/staff/clients?page=2&pageSize=5&sort=name&dir=asc');
    expect(p2.body.rows).toHaveLength(2);
    // Page 2 is disjoint from page 1.
    const ids1 = new Set((p1.body.rows as Array<{ id: string }>).map((r) => r.id));
    for (const r of p2.body.rows as Array<{ id: string }>) expect(ids1.has(r.id)).toBe(false);
  });

  it('total reflects the filtered set, not just the page', async () => {
    await makeClient('Alpha Corp', { clientType: 'BUSINESS' });
    await makeClient('Beta LLC', { clientType: 'BUSINESS' });
    await makeClient('Carl Individual', { clientType: 'INDIVIDUAL' });

    const r = await request(app()).get('/api/staff/clients?page=1&pageSize=50&clientType=BUSINESS');
    expect(r.body.total).toBe(2);
    expect(r.body.rows).toHaveLength(2);
  });

  it('accepts a comma-separated multi-value filter (IN set)', async () => {
    await makeClient('Alpha Corp', { clientType: 'BUSINESS' });
    await makeClient('Carl Individual', { clientType: 'INDIVIDUAL' });

    const both = await request(app()).get(
      '/api/staff/clients?page=1&pageSize=50&clientType=BUSINESS,INDIVIDUAL',
    );
    expect(both.body.total).toBe(2);

    const oneOnly = await request(app()).get(
      '/api/staff/clients?page=1&pageSize=50&clientType=INDIVIDUAL',
    );
    expect(oneOnly.body.total).toBe(1);
    expect((oneOnly.body.rows as Array<{ name: string }>)[0]!.name).toBe('Carl Individual');
  });

  it('free-text q searches by name', async () => {
    await makeClient('Findme Industries');
    await makeClient('Unrelated Co');

    const r = await request(app()).get('/api/staff/clients?page=1&pageSize=50&q=findme');
    expect(r.body.total).toBe(1);
    expect((r.body.rows as Array<{ name: string }>)[0]!.name).toBe('Findme Industries');
  });

  it('without ?page it keeps the legacy { items } shape', async () => {
    await makeClient('Legacy One');
    const r = await request(app()).get('/api/staff/clients');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.items)).toBe(true);
    expect(r.body.page).toBeUndefined();
  });
});
