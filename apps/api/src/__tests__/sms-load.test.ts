// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Phase 13 — load: 500 reminder-style sends through the send service in
// one batch (concurrency 20) against a stubbed Twilio. Asserts every row
// lands, sids are unique, the conversation upsert doesn't deadlock on
// repeated numbers, and the batch finishes inside a generous budget.

import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { crypto as core } from '@vibe/core';
import { smsConversations, smsMessages } from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedMinimalFirm,
  seedSmsLine,
  type PgliteHarness,
} from './_pglite-harness';
import { createSmsSendService } from '../sms/send-service';

const KMS_KEY = 'a'.repeat(64);
const AC = 'AC' + 'a'.repeat(32);
const MG = 'MG' + 'b'.repeat(32);
const log = pino({ enabled: false });

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  process.env['KMS_KEY'] = KMS_KEY;
  const envelope = core.encryptJson(
    { provider: 'twilio', accountSid: AC, authToken: 'token-12345', messagingServiceSid: MG },
    core.resolveKey(KMS_KEY),
  );
  await harness.db.execute(
    sql`INSERT INTO firm_settings (firm_id, sms_config_encrypted, sms_inbox_enabled, sms_consent_enforced) VALUES (${seed.firmId}, ${envelope}, true, false)`,
  );
  await seedSmsLine(harness.db, { firmId: seed.firmId });
});

afterEach(async () => {
  await harness.close();
});

describe('load: 500 reminder sends', () => {
  it('lands every row with unique sids inside budget', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return {
        ok: true,
        status: 201,
        json: async () => ({
          sid: `SM${String(n).padStart(32, '0')}`,
          status: 'accepted',
          num_segments: '1',
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const svc = createSmsSendService({
      db: harness.db,
      log,
      fallback: null,
      config: { APP_BASE_URL: 'http://localhost:3001' },
      fetchImpl,
    });
    const TOTAL = 500;
    const CONCURRENCY = 20;
    const started = Date.now();
    let next = 0;
    const results: boolean[] = [];
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (next < TOTAL) {
          const i = next++;
          // 100 distinct numbers → 5 sends per conversation (upsert contention).
          const to = `+1312555${String(i % 100).padStart(4, '0')}`;
          const r = await svc.send({
            to,
            body: `Reminder ${i}`,
            context: { kind: 'appointment_reminder', firmId: seed.firmId },
          });
          results.push(r.ok);
        }
      }),
    );
    const elapsed = Date.now() - started;
    expect(results).toHaveLength(TOTAL);
    expect(results.every(Boolean)).toBe(true);
    const rows = await harness.db.select({ sid: smsMessages.providerMessageId }).from(smsMessages);
    expect(rows).toHaveLength(TOTAL);
    expect(new Set(rows.map((r) => r.sid)).size).toBe(TOTAL);
    expect(
      await harness.db.select({ id: smsConversations.id }).from(smsConversations),
    ).toHaveLength(100);
    expect(elapsed).toBeLessThan(120_000);
  }, 180_000);
});
