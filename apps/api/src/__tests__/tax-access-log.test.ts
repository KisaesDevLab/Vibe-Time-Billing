// SPDX-License-Identifier: Elastic-2.0
//
// TR-8 — Access log tests.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { taxReturns } from '@vibe/db/schema';
import { appendAccessLog, exportAccessLogCsv, listAccessLog } from '../tax-returns/access-log';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

async function seedReturn(): Promise<{ firmId: string; returnId: string }> {
  const seed = await seedMinimalFirm(harness.db);
  const [r] = await harness.db
    .insert(taxReturns)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      taxYear: 2025,
      formCode: '1040',
      title: 'T',
    })
    .returning();
  return { firmId: seed.firmId, returnId: r!.id };
}

describe('TR-8 — appendAccessLog + listAccessLog', () => {
  it('appends a row and lists it back', async () => {
    const f = await seedReturn();
    await appendAccessLog({
      db: harness.db,
      returnId: f.returnId,
      event: 'RELEASED',
      actorKind: 'STAFF',
      actorRef: 'user-1',
      actorIp: '127.0.0.1',
      metadata: { scope: 'FULL' },
    });
    const r = await listAccessLog({
      db: harness.db,
      returnId: f.returnId,
      firmId: f.firmId,
      cursor: null,
      pageSize: 50,
      clientVisibleOnly: false,
    });
    expect(r.items.length).toBe(1);
    expect(r.items[0]!.event).toBe('RELEASED');
    expect(r.items[0]!.metadata).toEqual({ scope: 'FULL' });
  });

  it('paginates via cursor', async () => {
    const f = await seedReturn();
    for (let i = 0; i < 5; i++) {
      await appendAccessLog({
        db: harness.db,
        returnId: f.returnId,
        event: 'VIEW',
        actorKind: 'CLIENT',
        metadata: { i },
      });
      // ensure strict ordering by `at`
      await new Promise((r) => setTimeout(r, 5));
    }
    const page1 = await listAccessLog({
      db: harness.db,
      returnId: f.returnId,
      firmId: f.firmId,
      cursor: null,
      pageSize: 2,
      clientVisibleOnly: false,
    });
    expect(page1.items.length).toBe(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listAccessLog({
      db: harness.db,
      returnId: f.returnId,
      firmId: f.firmId,
      cursor: page1.nextCursor,
      pageSize: 2,
      clientVisibleOnly: false,
    });
    expect(page2.items.length).toBe(2);
    // No overlap
    const ids1 = new Set(page1.items.map((i) => i.id));
    for (const i of page2.items) expect(ids1.has(i.id)).toBe(false);
  });

  it('clientVisibleOnly filters out PARSED + SECTION_EDITED', async () => {
    const f = await seedReturn();
    await appendAccessLog({
      db: harness.db,
      returnId: f.returnId,
      event: 'PARSED',
      actorKind: 'SYSTEM',
    });
    await appendAccessLog({
      db: harness.db,
      returnId: f.returnId,
      event: 'SECTION_EDITED',
      actorKind: 'STAFF',
      actorRef: 'u1',
    });
    await appendAccessLog({
      db: harness.db,
      returnId: f.returnId,
      event: 'RELEASED',
      actorKind: 'STAFF',
      actorRef: 'u1',
    });
    await appendAccessLog({
      db: harness.db,
      returnId: f.returnId,
      event: 'VIEW',
      actorKind: 'CLIENT',
    });

    const staffView = await listAccessLog({
      db: harness.db,
      returnId: f.returnId,
      firmId: f.firmId,
      cursor: null,
      pageSize: 50,
      clientVisibleOnly: false,
    });
    expect(staffView.items.length).toBe(4);

    const clientView = await listAccessLog({
      db: harness.db,
      returnId: f.returnId,
      firmId: f.firmId,
      cursor: null,
      pageSize: 50,
      clientVisibleOnly: true,
    });
    const kinds = clientView.items.map((i) => i.event);
    expect(kinds).not.toContain('PARSED');
    expect(kinds).not.toContain('SECTION_EDITED');
    expect(kinds).toContain('RELEASED');
    expect(kinds).toContain('VIEW');
  });

  it('cross-firm scope returns empty', async () => {
    const f = await seedReturn();
    await appendAccessLog({
      db: harness.db,
      returnId: f.returnId,
      event: 'VIEW',
      actorKind: 'CLIENT',
    });
    const r = await listAccessLog({
      db: harness.db,
      returnId: f.returnId,
      firmId: '00000000-0000-4000-8000-000000000000',
      cursor: null,
      pageSize: 50,
      clientVisibleOnly: false,
    });
    expect(r.items.length).toBe(0);
  });
});

describe('TR-8 — exportAccessLogCsv', () => {
  it('emits header + one row per event', async () => {
    const f = await seedReturn();
    await appendAccessLog({
      db: harness.db,
      returnId: f.returnId,
      event: 'RELEASED',
      actorKind: 'STAFF',
      actorRef: 'u1',
      actorIp: '127.0.0.1',
      actorUserAgent: 'curl',
      metadata: { scope: 'FULL' },
    });
    await appendAccessLog({
      db: harness.db,
      returnId: f.returnId,
      event: 'PAGE_RENDER',
      actorKind: 'RECIPIENT',
      pageNumber: 3,
      metadata: { ms: 42 },
    });
    const csv = await exportAccessLogCsv({
      db: harness.db,
      returnId: f.returnId,
      firmId: f.firmId,
    });
    expect(csv.split('\n')[0]).toContain('at,event,actor_kind');
    expect(csv).toContain('RELEASED');
    expect(csv).toContain('PAGE_RENDER');
    expect(csv).toContain('"{""scope"":""FULL""}"'); // JSON metadata escaped
  });

  it('cross-firm returns empty string', async () => {
    const f = await seedReturn();
    await appendAccessLog({
      db: harness.db,
      returnId: f.returnId,
      event: 'VIEW',
      actorKind: 'CLIENT',
    });
    const csv = await exportAccessLogCsv({
      db: harness.db,
      returnId: f.returnId,
      firmId: '00000000-0000-4000-8000-000000000000',
    });
    expect(csv).toBe('');
  });

  void sql;
});
