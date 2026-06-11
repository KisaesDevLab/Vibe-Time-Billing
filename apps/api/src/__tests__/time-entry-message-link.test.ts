// SPDX-License-Identifier: Elastic-2.0
//
// P1.5 — Time-entry message link permission test (D.10)
//
// Exercises linkTimeEntryMessages directly to lock in the permission
// boundary:
//   - Non-member tries to link a message → -1 (caller 403s)
//   - Messages from a different thread → -1
//   - Happy path persists with stable `sequence` numbering
// Also covers idempotency (same call twice = unique constraint hits
// `onConflictDoNothing`).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql, eq, and } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appUsers,
  engagements,
  messages,
  threadMembers,
  threads,
  timeEntries,
  timeEntryMessageLinks,
} from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import { provisionThreadForEngagement } from '../engagement-messaging/lifecycle';
import { encryptForThread } from '../engagement-messaging/thread-crypto';
import { linkTimeEntryMessages } from '../time-entries/routes';

describe('time-entry message link permission (D.10)', () => {
  let h: PgliteHarness;
  let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
  let sealDir: string;
  let threadId: string;
  let messageA: string;
  let messageB: string;
  let timeEntryId: string;
  let outsiderUserId: string;

  beforeEach(async () => {
    sealDir = await mkdtemp(join(tmpdir(), 'vibe-test-seal-'));
    process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
    resetFirmKeyManagerForTests();
    h = await buildPgliteHarness();
    seed = await seedMinimalFirm(h.db);
    const mgr = getFirmKeyManager(h.db);
    await mgr.bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
    setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });

    // Provision the thread for the engagement; the creator (seed.appUserId)
    // is the only thread member.
    const tid = await provisionThreadForEngagement(h.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      creatorAppUserId: seed.appUserId,
      title: 'D10 thread',
    });
    threadId = tid!;

    // Insert two messages into the thread.
    const ct1 = await encryptForThread(
      { db: h.db, firmId: seed.firmId, threadId },
      'message A body',
    );
    const ct2 = await encryptForThread(
      { db: h.db, firmId: seed.firmId, threadId },
      'message B body',
    );
    const [m1] = await h.db
      .insert(messages)
      .values({
        threadId,
        senderAppUserId: seed.appUserId,
        bodyCiphertext: ct1,
        excerptPlaintext: 'message A body',
      })
      .returning({ id: messages.id });
    const [m2] = await h.db
      .insert(messages)
      .values({
        threadId,
        senderAppUserId: seed.appUserId,
        bodyCiphertext: ct2,
        excerptPlaintext: 'message B body',
      })
      .returning({ id: messages.id });
    messageA = m1!.id;
    messageB = m2!.id;

    // Create a time entry to link to.
    const [te] = await h.db
      .insert(timeEntries)
      .values({
        engagementId: seed.engagementId,
        appUserId: seed.appUserId,
        entryDate: '2026-05-24',
        hours: '1.50',
        standardRateSnapshotCents: 30000,
        standardAmountCents: 45000,
        costRateSnapshotCents: 12000,
      })
      .returning({ id: timeEntries.id });
    timeEntryId = te!.id;

    // Outsider: another firm staff user, NOT a member of the thread.
    const [outsider] = await h.db
      .insert(appUsers)
      .values({
        firmId: seed.firmId,
        email: 'outsider@test.example',
        fullName: 'Outsider',
        firstName: 'Out',
        lastName: 'Sider',
      })
      .returning({ id: appUsers.id });
    outsiderUserId = outsider!.id;
  });

  afterEach(async () => {
    resetFirmKeyManagerForTests();
    await h.close();
    await rm(sealDir, { recursive: true, force: true });
  });

  it('happy path: thread member links one message and the row persists with sequence=0', async () => {
    const n = await linkTimeEntryMessages(h.db, {
      engagementId: seed.engagementId,
      timeEntryId,
      messageIds: [messageA],
      appUserId: seed.appUserId,
    });
    expect(n).toBe(1);
    const rows = await h.db
      .select()
      .from(timeEntryMessageLinks)
      .where(eq(timeEntryMessageLinks.timeEntryId, timeEntryId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.messageId).toBe(messageA);
    expect(rows[0]!.sequence).toBe(0);
  });

  it('multiple messages persist with stable sequence numbering', async () => {
    const n = await linkTimeEntryMessages(h.db, {
      engagementId: seed.engagementId,
      timeEntryId,
      messageIds: [messageA, messageB],
      appUserId: seed.appUserId,
    });
    expect(n).toBe(2);
    const rows = await h.db
      .select()
      .from(timeEntryMessageLinks)
      .where(eq(timeEntryMessageLinks.timeEntryId, timeEntryId))
      .orderBy(timeEntryMessageLinks.sequence);
    expect(rows.length).toBe(2);
    expect(rows[0]!.messageId).toBe(messageA);
    expect(rows[0]!.sequence).toBe(0);
    expect(rows[1]!.messageId).toBe(messageB);
    expect(rows[1]!.sequence).toBe(1);
  });

  it('non-member returns -1 (caller 403s)', async () => {
    const n = await linkTimeEntryMessages(h.db, {
      engagementId: seed.engagementId,
      timeEntryId,
      messageIds: [messageA],
      appUserId: outsiderUserId,
    });
    expect(n).toBe(-1);
    // No row was inserted
    const rows = await h.db
      .select()
      .from(timeEntryMessageLinks)
      .where(eq(timeEntryMessageLinks.timeEntryId, timeEntryId));
    expect(rows.length).toBe(0);
  });

  it('message from a different thread returns -1', async () => {
    // Create a second engagement + thread + message that lives elsewhere
    const [eng2] = await h.db
      .insert(engagements)
      .values({
        clientId: seed.clientId,
        name: 'Other engagement',
        feeStructure: 'HOURLY',
      })
      .returning({ id: engagements.id });
    const thread2Id = await provisionThreadForEngagement(h.db, {
      firmId: seed.firmId,
      engagementId: eng2!.id,
      creatorAppUserId: seed.appUserId,
    });
    const otherCt = await encryptForThread(
      { db: h.db, firmId: seed.firmId, threadId: thread2Id! },
      'other thread message',
    );
    const [otherMsg] = await h.db
      .insert(messages)
      .values({
        threadId: thread2Id!,
        senderAppUserId: seed.appUserId,
        bodyCiphertext: otherCt,
        excerptPlaintext: 'other thread message',
      })
      .returning({ id: messages.id });

    // Try to link the OTHER thread's message to our engagement's time
    // entry — the helper checks both thread membership AND that
    // every message is in the target engagement's thread.
    const n = await linkTimeEntryMessages(h.db, {
      engagementId: seed.engagementId,
      timeEntryId,
      messageIds: [otherMsg!.id],
      appUserId: seed.appUserId,
    });
    expect(n).toBe(-1);
  });

  it('engagement with no thread returns -1', async () => {
    // Create an engagement that never had a thread provisioned.
    const [orphan] = await h.db
      .insert(engagements)
      .values({
        clientId: seed.clientId,
        name: 'No thread engagement',
        feeStructure: 'HOURLY',
      })
      .returning({ id: engagements.id });
    const [te] = await h.db
      .insert(timeEntries)
      .values({
        engagementId: orphan!.id,
        appUserId: seed.appUserId,
        entryDate: '2026-05-24',
        hours: '0.50',
        standardRateSnapshotCents: 30000,
        standardAmountCents: 15000,
      })
      .returning({ id: timeEntries.id });
    const n = await linkTimeEntryMessages(h.db, {
      engagementId: orphan!.id,
      timeEntryId: te!.id,
      messageIds: [messageA],
      appUserId: seed.appUserId,
    });
    expect(n).toBe(-1);
  });

  it('empty messageIds array returns 0 without DB writes', async () => {
    const n = await linkTimeEntryMessages(h.db, {
      engagementId: seed.engagementId,
      timeEntryId,
      messageIds: [],
      appUserId: seed.appUserId,
    });
    expect(n).toBe(0);
    const rows = await h.db
      .select()
      .from(timeEntryMessageLinks)
      .where(eq(timeEntryMessageLinks.timeEntryId, timeEntryId));
    expect(rows.length).toBe(0);
  });

  it('repeat call with the same (time_entry, message) pair is a no-op (unique constraint + onConflictDoNothing)', async () => {
    const first = await linkTimeEntryMessages(h.db, {
      engagementId: seed.engagementId,
      timeEntryId,
      messageIds: [messageA],
      appUserId: seed.appUserId,
    });
    expect(first).toBe(1);
    // Second call: same message → unique index swallows it
    const second = await linkTimeEntryMessages(h.db, {
      engagementId: seed.engagementId,
      timeEntryId,
      messageIds: [messageA],
      appUserId: seed.appUserId,
    });
    expect(second).toBe(0); // 0 returning rows
    const rows = await h.db
      .select()
      .from(timeEntryMessageLinks)
      .where(eq(timeEntryMessageLinks.timeEntryId, timeEntryId));
    expect(rows.length).toBe(1);
  });

  // Reference unused imports so they're not pruned in CI
  void sql;
  void threads;
  void threadMembers;
  void and;
});
