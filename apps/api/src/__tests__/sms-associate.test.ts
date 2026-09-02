// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0234 — association engine (§3): manual links are never overridden,
// existing links are kept unless forced, reply-context (recent outbound
// with an engagement / client request) wins over a phone match, a unique
// phone match links + suggests the client's only ACTIVE engagement, and a
// shared number flags triage with candidates.

import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { smsConversations, smsMessages } from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  seedSmsLine,
  type PgliteHarness,
} from './_pglite-harness';
import { associateConversation } from '../sms/associate';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let lineId: string;
const NUMBER = '+13125550148';
const NOW = new Date('2026-09-02T12:00:00Z');

async function conversation(
  extra: Partial<typeof smsConversations.$inferInsert> = {},
): Promise<string> {
  const [c] = await harness.db
    .insert(smsConversations)
    .values({ firmId: seed.firmId, lineId, externalNumberE164: NUMBER, ...extra })
    .returning({ id: smsConversations.id });
  return c!.id;
}

async function otherClient(name: string): Promise<string> {
  const r = await harness.db.execute(
    sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
        SELECT firm_id, ${name}, partner_in_charge_id, office_id FROM client WHERE id = ${seed.clientId} RETURNING id`,
  );
  return (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  ({ lineId } = await seedSmsLine(harness.db, { firmId: seed.firmId }));
  await harness.db.execute(
    sql`UPDATE engagement SET status = 'ACTIVE' WHERE id = ${seed.engagementId}`,
  );
});

afterEach(async () => {
  await harness.close();
});

describe('associateConversation', () => {
  it('unique phone match links the contact and suggests the only ACTIVE engagement', async () => {
    const { personId, contactId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat',
      mobile: NUMBER,
    });
    const id = await conversation();
    const r = await associateConversation(harness.db, { conversationId: id, now: NOW });
    expect(r.method).toBe('phone_unique');
    expect(r).toMatchObject({
      personId,
      clientContactId: contactId,
      clientId: seed.clientId,
      engagementId: seed.engagementId,
      engagementSuggested: true,
    });
    const [c] = await harness.db.select().from(smsConversations).where(eq(smsConversations.id, id));
    expect(c!.linkSource).toBe('phone');
    // second run is a no-op ("existing"), and a second ACTIVE engagement would not be suggested
    expect((await associateConversation(harness.db, { conversationId: id, now: NOW })).method).toBe(
      'existing',
    );
  });

  it('does not suggest when the client has two ACTIVE engagements', async () => {
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat',
      mobile: NUMBER,
    });
    await harness.db.execute(
      sql`INSERT INTO engagement (client_id, name, fee_structure, status) VALUES (${seed.clientId}, 'Second', 'HOURLY', 'ACTIVE')`,
    );
    const id = await conversation();
    const r = await associateConversation(harness.db, { conversationId: id, now: NOW });
    expect(r.method).toBe('phone_unique');
    expect(r.engagementId).toBeNull();
    expect(r.engagementSuggested).toBe(false);
  });

  it('never overrides a manual link, even when forced', async () => {
    const other = await otherClient('Other Co');
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat',
      mobile: NUMBER,
    });
    const id = await conversation({ clientId: other, linkSource: 'manual' });
    const r = await associateConversation(harness.db, {
      conversationId: id,
      force: true,
      now: NOW,
    });
    expect(r.method).toBe('manual');
    expect(r.clientId).toBe(other);
  });

  it('reply-context beats a phone match and carries the engagement', async () => {
    const other = await otherClient('Other Co');
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: other,
      fullName: 'Pat',
      mobile: NUMBER,
    });
    const id = await conversation();
    await harness.db.insert(smsMessages).values({
      firmId: seed.firmId,
      conversationId: id,
      direction: 'outbound',
      fromE164: '+12025550100',
      toE164: NUMBER,
      body: 'reminder',
      contextKind: 'client_request',
      engagementId: seed.engagementId,
      createdAt: new Date('2026-09-01T12:00:00Z'),
    });
    const r = await associateConversation(harness.db, { conversationId: id, now: NOW });
    expect(r.method).toBe('reply_context');
    expect(r.clientId).toBe(seed.clientId);
    expect(r.engagementId).toBe(seed.engagementId);
    expect(r.engagementSuggested).toBe(false);
    const [c] = await harness.db.select().from(smsConversations).where(eq(smsConversations.id, id));
    expect(c!.linkSource).toBe('reply_context');
  });

  it('ignores reply context older than 14 days', async () => {
    const id = await conversation();
    await harness.db.insert(smsMessages).values({
      firmId: seed.firmId,
      conversationId: id,
      direction: 'outbound',
      fromE164: '+12025550100',
      toE164: NUMBER,
      body: 'old',
      contextKind: 'notification',
      engagementId: seed.engagementId,
      createdAt: new Date('2026-08-01T12:00:00Z'),
    });
    const r = await associateConversation(harness.db, { conversationId: id, now: NOW });
    expect(r.method).toBe('none');
  });

  it('flags triage with candidates when two clients share the number, and force re-runs after a fix', async () => {
    const other = await otherClient('Other Co');
    const a = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'A',
      mobile: NUMBER,
    });
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: other,
      fullName: 'B',
      phone: NUMBER,
    });
    const id = await conversation();
    const r = await associateConversation(harness.db, { conversationId: id, now: NOW });
    expect(r.method).toBe('phone_multiple');
    expect(r.candidates.map((c) => c.fullName).sort()).toEqual(['A', 'B']);
    let [c] = await harness.db.select().from(smsConversations).where(eq(smsConversations.id, id));
    expect(c!.needsTriage).toBe(true);
    // B's number gets corrected → forced re-run resolves to A
    await harness.db.execute(sql`UPDATE person SET phone = NULL WHERE full_name = 'B'`);
    const r2 = await associateConversation(harness.db, {
      conversationId: id,
      force: true,
      now: NOW,
    });
    expect(r2.method).toBe('phone_unique');
    expect(r2.personId).toBe(a.personId);
    [c] = await harness.db.select().from(smsConversations).where(eq(smsConversations.id, id));
    expect(c!.needsTriage).toBe(false);
  });
});
