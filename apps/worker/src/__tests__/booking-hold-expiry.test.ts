// SPDX-License-Identifier: Elastic-2.0
//
// 0168 — booking-request hold expiry sweep: PENDING holds past their
// hold_expires_at flip to EXPIRED (and notify the visitor); future PENDING
// holds and already-decided requests are untouched.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { pino } from 'pino';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as schema from '@vibe/db/schema';
import type { Database } from '@vibe/db';
import { bookingRequests } from '@vibe/db/schema';

import { runBookingHoldExpiryTick } from '../jobs/booking-hold-expiry';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', '..', 'packages', 'db', 'migrations');
const log = pino({ level: 'silent' });

let pglite: PGlite;
let db: Database;
let firmId: string;
let staffId: string;

async function build(): Promise<void> {
  pglite = new PGlite();
  for (const f of readdirSync(migrationsDir)
    .filter((x) => x.endsWith('.sql'))
    .sort()) {
    const cleaned = readFileSync(join(migrationsDir, f), 'utf8')
      .replace(/DO \$\$\s*BEGIN\s*IF NOT EXISTS[\s\S]*?END\s*\$\$;?/g, '-- skipped')
      .replace(/^(REVOKE|GRANT) .*$/gim, '-- skipped');
    await pglite.exec(cleaned);
  }
  db = drizzle(pglite, { schema }) as unknown as Database;
  const firm = await db.execute(sql`INSERT INTO firm (name) VALUES ('F') RETURNING id`);
  firmId = (firm as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const u = await db.execute(
    sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
        VALUES (${firmId}, 'a@test.example', 'A', 'A', 'B') RETURNING id`,
  );
  staffId = (u as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

async function addRequest(status: string, holdExpiresAt: Date): Promise<string> {
  const [r] = await db
    .insert(bookingRequests)
    .values({
      firmId,
      staffId,
      startsAt: new Date('2030-01-07T09:00:00Z'),
      endsAt: new Date('2030-01-07T10:00:00Z'),
      durationMinutes: 60,
      visitorName: 'V',
      visitorEmail: 'v@example.com',
      status: status as 'PENDING' | 'APPROVED',
      holdExpiresAt,
    })
    .returning({ id: bookingRequests.id });
  return r!.id;
}

beforeEach(build);
afterEach(async () => {
  await pglite.close();
});

describe('runBookingHoldExpiryTick', () => {
  it('expires past-due PENDING holds and leaves others alone', async () => {
    const past = await addRequest('PENDING', new Date(Date.now() - 3600_000));
    const future = await addRequest('PENDING', new Date(Date.now() + 3600_000));
    const approved = await addRequest('APPROVED', new Date(Date.now() - 3600_000));

    let emails = 0;
    const result = await runBookingHoldExpiryTick(db, log, {
      sendEmail: async () => {
        emails += 1;
      },
    });

    expect(result.expired).toBe(1);
    expect(result.notified).toBe(1);
    expect(emails).toBe(1);

    const status = async (id: string): Promise<string> =>
      (await db.select().from(bookingRequests).where(eq(bookingRequests.id, id)))[0]!.status;
    expect(await status(past)).toBe('EXPIRED');
    expect(await status(future)).toBe('PENDING');
    expect(await status(approved)).toBe('APPROVED');
  });

  it('is a no-op when nothing is due', async () => {
    await addRequest('PENDING', new Date(Date.now() + 3600_000));
    const result = await runBookingHoldExpiryTick(db, log, { sendEmail: async () => undefined });
    expect(result.expired).toBe(0);
  });
});
