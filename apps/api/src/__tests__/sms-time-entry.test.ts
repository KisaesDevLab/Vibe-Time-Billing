// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// D12 / Phase 12 — time entry from a thread: prefill resolves the default
// work code (firm setting → engagement in-scope code), estimates hours
// from the message count rounded up to the firm increment, and POST goes
// through the shared time-entry core (a PAUSED engagement is refused).

import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  smsConversations,
  smsMessages,
  staffRateSnapshotEntries,
  staffRateSnapshots,
  timeEntries,
} from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedMinimalFirm,
  seedSmsLine,
  type PgliteHarness,
} from './_pglite-harness';
import { createSmsInboxRouter } from '../sms/routes';
import type { SmsSendService } from '../sms/send-service';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let conversationId: string;

const smsSend: SmsSendService = {
  async send() {
    return { ok: true, mode: 'inbox', messageId: null, conversationId: null };
  },
};

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    // reason: test stub — the real middleware attaches a full StaffSession
    req.staffSession = { firmId: seed.firmId, appUserId: seed.appUserId } as never;
    next();
  });
  const roles = new Map([[seed.appUserId, ['admin' as const]]]);
  a.use(
    '/sms',
    createSmsInboxRouter({
      db: harness.db,
      smsSend,
      fakeUserRoles: roles,
      timeEntryDeps: { db: harness.db, fakeUserRoles: roles },
      redisUrl: null,
    }),
  );
  return a;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  await harness.db.execute(
    sql`INSERT INTO firm_settings (firm_id, time_entry_rounding_hours) VALUES (${seed.firmId}, 0.25)`,
  );
  await harness.db.execute(
    sql`UPDATE engagement SET status = 'ACTIVE', in_scope_work_code_ids = ${JSON.stringify([seed.workCodeId])}::jsonb WHERE id = ${seed.engagementId}`,
  );
  // A bill rate for the user so the time-entry core can snapshot it.
  const [snap] = await harness.db
    .insert(staffRateSnapshots)
    .values({ appUserId: seed.appUserId, effectiveDate: '2026-01-01', costRateCents: 12000 })
    .returning({ id: staffRateSnapshots.id });
  await harness.db.insert(staffRateSnapshotEntries).values({
    snapshotId: snap!.id,
    rateCodeId: seed.rateCodeId,
    billRateCents: 30000,
  });
  const { lineId } = await seedSmsLine(harness.db, { firmId: seed.firmId });
  const [c] = await harness.db
    .insert(smsConversations)
    .values({
      firmId: seed.firmId,
      lineId,
      externalNumberE164: '+13125550148',
      clientId: seed.clientId,
      engagementId: seed.engagementId,
    })
    .returning({ id: smsConversations.id });
  conversationId = c!.id;
  for (let i = 0; i < 9; i++) {
    await harness.db.insert(smsMessages).values({
      firmId: seed.firmId,
      conversationId,
      direction: i % 2 ? 'outbound' : 'inbound',
      fromE164: '+13125550148',
      toE164: '+12025550100',
      body: `m${i}`,
      contextKind: i % 2 ? 'manual' : 'inbound',
      createdAt: new Date(Date.UTC(2026, 8, 1, 10, i)),
    });
  }
});

afterEach(async () => {
  await harness.close();
});

describe('time entry from an SMS thread', () => {
  it('prefills engagement, in-scope work code, and a rounded-up estimate', async () => {
    const r = await request(app()).get(`/sms/conversations/${conversationId}/time-entry/prefill`);
    expect(r.status).toBe(200);
    expect(r.body.engagementId).toBe(seed.engagementId);
    expect(r.body.workCodeId).toBe(seed.workCodeId); // engagement in-scope fallback
    expect(r.body.messageCount).toBe(9);
    expect(r.body.hours).toBe(0.5); // 9 × 2 min = 0.3h → rounded up to 0.25 increments
    expect(r.body.description).toContain('9 messages');
    // firm default work code wins when set
    await harness.db.execute(
      sql`UPDATE firm_settings SET sms_default_work_code_id = ${seed.workCodeId}`,
    );
    expect(
      (await request(app()).get(`/sms/conversations/${conversationId}/time-entry/prefill`)).body
        .workCodeId,
    ).toBe(seed.workCodeId);
  });

  it('creates the entry through the shared core and audits it', async () => {
    const r = await request(app()).post(`/sms/conversations/${conversationId}/time-entry`).send({
      workCodeId: seed.workCodeId,
      entryDate: '2026-09-02',
      hours: 0.5,
      description: 'Texted about W-2',
    });
    expect(r.status).toBe(201);
    const rows = await harness.db.select().from(timeEntries);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.engagementId).toBe(seed.engagementId);
    expect(Number(rows[0]!.hours)).toBe(0.5);
  });

  it('refuses a paused engagement via the core guards', async () => {
    await harness.db.execute(
      sql`UPDATE engagement SET status = 'PAUSED' WHERE id = ${seed.engagementId}`,
    );
    const r = await request(app())
      .post(`/sms/conversations/${conversationId}/time-entry`)
      .send({ workCodeId: seed.workCodeId, entryDate: '2026-09-02', hours: 0.5 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('engagement_not_writable');
  });
});
