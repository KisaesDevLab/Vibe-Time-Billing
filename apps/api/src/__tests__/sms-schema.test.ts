// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0234 — SMS inbox schema: the person phone_e164/mobile_e164 columns are
// trigger-owned (derived on insert/update), conversations are unique per
// (line, number), provider message ids are unique, and the down file
// reverses the migration cleanly.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { persons, smsConversations, smsMessages } from '@vibe/db/schema';

import {
  buildPgliteHarness,
  expectDbReject,
  seedContact,
  seedMinimalFirm,
  seedSmsLine,
  type PgliteHarness,
} from './_pglite-harness';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});

afterEach(async () => {
  await harness.close();
});

describe('sms schema (0234)', () => {
  it('derives E.164 columns from phone/mobile on insert and update', async () => {
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat Client',
      phone: '(312) 555-0148',
      mobile: '1-202-555-0100',
    });
    let [p] = await harness.db.select().from(persons).where(eq(persons.id, personId));
    expect(p!.phoneE164).toBe('+13125550148');
    expect(p!.mobileE164).toBe('+12025550100');
    await harness.db
      .update(persons)
      .set({ mobile: '+44 20 7946 0958', phone: 'ext 12' })
      .where(eq(persons.id, personId));
    [p] = await harness.db.select().from(persons).where(eq(persons.id, personId));
    expect(p!.mobileE164).toBe('+442079460958');
    expect(p!.phoneE164).toBeNull();
  });

  it('enforces one conversation per (line, number) and unique provider ids', async () => {
    const { lineId } = await seedSmsLine(harness.db, { firmId: seed.firmId });
    const [conv] = await harness.db
      .insert(smsConversations)
      .values({ firmId: seed.firmId, lineId, externalNumberE164: '+13125550148' })
      .returning({ id: smsConversations.id });
    await expectDbReject(
      harness.db
        .insert(smsConversations)
        .values({ firmId: seed.firmId, lineId, externalNumberE164: '+13125550148' }),
      /sms_conversation_line_number_uk/,
    );
    const base = {
      firmId: seed.firmId,
      conversationId: conv!.id,
      direction: 'inbound' as const,
      fromE164: '+13125550148',
      toE164: '+12025550100',
      body: 'hi',
      providerMessageId: 'SM1',
      providerStatus: 'received' as const,
      contextKind: 'inbound' as const,
      ingestSource: 'webhook' as const,
    };
    await harness.db.insert(smsMessages).values(base);
    await expectDbReject(harness.db.insert(smsMessages).values(base), /sms_message_provider_id_uk/);
    // Outbound rows without a sid yet are fine in any number.
    await harness.db
      .insert(smsMessages)
      .values({ ...base, direction: 'outbound', providerMessageId: null });
    await harness.db
      .insert(smsMessages)
      .values({ ...base, direction: 'outbound', providerMessageId: null });
  });

  it('rejects an unknown consent source and accepts the catalog', async () => {
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat Client',
    });
    await harness.db
      .update(persons)
      .set({ smsConsentAt: new Date(), smsConsentSource: 'verbal' })
      .where(eq(persons.id, personId));
    await expectDbReject(
      harness.db.update(persons).set({ smsConsentSource: 'guess' }).where(eq(persons.id, personId)),
      /person_sms_consent_source_ck/,
    );
  });

  it('down migration reverses 0234 cleanly', async () => {
    const dir = join(__dirname, '../../../../packages/db/migrations');
    const down = readFileSync(join(dir, 'down/0234_sms_inbox.down.sql'), 'utf8');
    await harness.pglite.exec(down);
    const tables = await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM information_schema.tables
          WHERE table_schema = 'vibetb' AND table_name IN ('sms_conversation','sms_message','sms_media','sms_template')`,
    );
    expect((tables as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(0);
    const cols = await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_schema = 'vibetb' AND table_name = 'person' AND column_name IN ('phone_e164','sms_consent_at')`,
    );
    expect((cols as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(0);
    // Re-applying the up file works (idempotent DDL) so a rollback is recoverable.
    const up = readFileSync(join(dir, '0234_sms_inbox.sql'), 'utf8');
    await harness.pglite.exec(up);
  });
});
