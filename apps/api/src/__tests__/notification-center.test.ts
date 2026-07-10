// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// BK-7 — staff notification center: list, unread-count, read, dismiss,
// and per-recipient isolation.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';

import { staffNotifications } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createNotificationCenterRouter } from '../notifications/center-routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

function app(appUserId: string): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId,
    };
    next();
  });
  a.use('/api/staff/notifications', createNotificationCenterRouter({ db: harness.db }));
  return a;
}

async function notify(recipient: string, type: string): Promise<string> {
  const [r] = await harness.db
    .insert(staffNotifications)
    .values({
      firmId: seed.firmId,
      recipientAppUserId: recipient,
      type,
      entityType: 'appointment',
      title: 'Test',
    })
    .returning({ id: staffNotifications.id });
  return r!.id;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('notification center', () => {
  it('lists + counts + marks read for the recipient only', async () => {
    const other = (
      (await harness.db.execute(
        sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
            VALUES (${seed.firmId}, 'o@test.example', 'O', 'O', 'O') RETURNING id`,
      )) as unknown as { rows: { id: string }[] }
    ).rows[0]!.id;
    const id1 = await notify(seed.appUserId, 'reschedule_requested');
    await notify(seed.appUserId, 'provider_write_failed');
    await notify(other, 'reschedule_requested'); // not mine

    const mine = app(seed.appUserId);
    const list = await request(mine).get('/api/staff/notifications');
    expect(list.body.items).toHaveLength(2);

    const count = await request(mine).get('/api/staff/notifications/unread-count');
    expect(count.body.count).toBe(2);

    await request(mine).post(`/api/staff/notifications/${id1}/read`);
    const count2 = await request(mine).get('/api/staff/notifications/unread-count');
    expect(count2.body.count).toBe(1);

    // read-all clears the rest.
    await request(mine).post('/api/staff/notifications/read-all');
    const count3 = await request(mine).get('/api/staff/notifications/unread-count');
    expect(count3.body.count).toBe(0);
  });

  it('cannot read another user’s notification', async () => {
    const id = await notify(seed.appUserId, 'x');
    const other = (
      (await harness.db.execute(
        sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
            VALUES (${seed.firmId}, 'o2@test.example', 'O2', 'O', '2') RETURNING id`,
      )) as unknown as { rows: { id: string }[] }
    ).rows[0]!.id;
    await request(app(other)).post(`/api/staff/notifications/${id}/read`);
    const [row] = await harness.db
      .select()
      .from(staffNotifications)
      .where(eq(staffNotifications.id, id));
    expect(row!.status).toBe('UNREAD'); // unchanged — not the owner
  });
});
