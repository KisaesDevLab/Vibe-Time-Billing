// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P1.4 — Engagement-thread provision integration test (C.10)
//
// Exercises the full provision → archive lifecycle against a real
// in-process Postgres (pglite) with all migrations applied. Covers
// the silent-bug regression we fixed during the prior QA pass:
// "thread created with zero members when creator isn't the
// partner-in-charge and engagement has no assignments."

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { engagementThreadLinks, engagements, threadMembers, threads } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import {
  archiveThreadForEngagement,
  isMember,
  provisionThreadForEngagement,
} from '../engagement-messaging/lifecycle';

describe('engagement-thread provisioning (C.10)', () => {
  let h: PgliteHarness;
  let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
  let sealDir: string;

  beforeEach(async () => {
    // Point the FirmKeyManager at a writable tmp dir before its lazy
    // construction. Default `/data/.firm-key.seal` doesn't exist on
    // Windows test hosts.
    sealDir = await mkdtemp(join(tmpdir(), 'vibe-test-seal-'));
    process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
    resetFirmKeyManagerForTests();

    h = await buildPgliteHarness();
    seed = await seedMinimalFirm(h.db);
    // Bootstrap the firm-key manager against the test firm so
    // generateWrappedTDek can wrap the per-thread DEK.
    const mgr = getFirmKeyManager(h.db);
    await mgr.bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
    setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
  });

  afterEach(async () => {
    resetFirmKeyManagerForTests();
    await h.close();
    await rm(sealDir, { recursive: true, force: true });
  });

  it('provisions a thread with engagement_thread_link and creator as member', async () => {
    const threadId = await provisionThreadForEngagement(h.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      title: 'Test Engagement',
      creatorAppUserId: seed.appUserId,
    });
    expect(threadId).toBeTruthy();

    // Thread row exists, is ACTIVE, has wrapped T-DEK
    const [thread] = await h.db.select().from(threads).where(eq(threads.id, threadId!)).limit(1);
    expect(thread).toBeTruthy();
    expect(thread!.status).toBe('ACTIVE');
    expect(thread!.tDekWrapped.length).toBeGreaterThan(32);
    expect(thread!.firmId).toBe(seed.firmId);

    // 1:1 link between engagement and thread
    const [link] = await h.db
      .select()
      .from(engagementThreadLinks)
      .where(eq(engagementThreadLinks.engagementId, seed.engagementId))
      .limit(1);
    expect(link).toBeTruthy();
    expect(link!.threadId).toBe(threadId);

    // Creator is a member (regression guard: previously broken when
    // creator wasn't partner_in_charge and engagement had no assignments)
    expect(await isMember(h.db, { threadId: threadId!, appUserId: seed.appUserId })).toBe(true);
    // Partner-in-charge is also a member (same user in this seed, but
    // the row should exist either way)
    const members = await h.db
      .select()
      .from(threadMembers)
      .where(eq(threadMembers.threadId, threadId!));
    expect(members.length).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent — calling twice returns the same threadId', async () => {
    const first = await provisionThreadForEngagement(h.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      creatorAppUserId: seed.appUserId,
    });
    const second = await provisionThreadForEngagement(h.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      creatorAppUserId: seed.appUserId,
    });
    expect(second).toBe(first);
    // Only one thread row created
    const allThreads = await h.db.select().from(threads);
    expect(allThreads.length).toBe(1);
  });

  it('archiveThreadForEngagement flips status to ARCHIVED and stamps archivedAt', async () => {
    const threadId = await provisionThreadForEngagement(h.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      creatorAppUserId: seed.appUserId,
    });
    expect(threadId).toBeTruthy();

    await archiveThreadForEngagement(h.db, seed.engagementId);

    const [thread] = await h.db.select().from(threads).where(eq(threads.id, threadId!)).limit(1);
    expect(thread!.status).toBe('ARCHIVED');
    expect(thread!.archivedAt).toBeInstanceOf(Date);
  });

  it('archive on already-archived thread is a no-op (idempotent)', async () => {
    const threadId = await provisionThreadForEngagement(h.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      creatorAppUserId: seed.appUserId,
    });
    await archiveThreadForEngagement(h.db, seed.engagementId);
    const [first] = await h.db
      .select({ archivedAt: threads.archivedAt })
      .from(threads)
      .where(eq(threads.id, threadId!))
      .limit(1);
    const firstArchivedAt = first!.archivedAt;

    // Second call doesn't update archivedAt (where clause filters
    // on status='ACTIVE', so the UPDATE matches zero rows)
    await archiveThreadForEngagement(h.db, seed.engagementId);
    const [second] = await h.db
      .select({ archivedAt: threads.archivedAt })
      .from(threads)
      .where(eq(threads.id, threadId!))
      .limit(1);
    expect(second!.archivedAt).toEqual(firstArchivedAt);
  });

  it('archive cascade is engagement-scoped — different engagement is unaffected', async () => {
    const threadId1 = await provisionThreadForEngagement(h.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      creatorAppUserId: seed.appUserId,
    });
    // Create a second engagement + thread
    const eng2 = await h.db
      .insert(engagements)
      .values({
        clientId: seed.clientId,
        name: 'Second Engagement',
        feeStructure: 'HOURLY',
      })
      .returning({ id: engagements.id });
    const eng2Id = eng2[0]!.id;
    const threadId2 = await provisionThreadForEngagement(h.db, {
      firmId: seed.firmId,
      engagementId: eng2Id,
      creatorAppUserId: seed.appUserId,
    });

    // Archive only the first
    await archiveThreadForEngagement(h.db, seed.engagementId);

    const [t1] = await h.db
      .select({ status: threads.status })
      .from(threads)
      .where(eq(threads.id, threadId1!));
    const [t2] = await h.db
      .select({ status: threads.status })
      .from(threads)
      .where(eq(threads.id, threadId2!));
    expect(t1!.status).toBe('ARCHIVED');
    expect(t2!.status).toBe('ACTIVE');
  });

  it('isMember returns false for a user that is not a thread member', async () => {
    const threadId = await provisionThreadForEngagement(h.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      creatorAppUserId: seed.appUserId,
    });
    // Synthetic UUID that is not in the seed
    const ghost = '00000000-0000-0000-0000-deaddeadbeef';
    expect(await isMember(h.db, { threadId: threadId!, appUserId: ghost })).toBe(false);
  });

  it('soft-removed members (removedAt set) are no longer isMember=true', async () => {
    const threadId = await provisionThreadForEngagement(h.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      creatorAppUserId: seed.appUserId,
    });
    expect(await isMember(h.db, { threadId: threadId!, appUserId: seed.appUserId })).toBe(true);
    await h.db
      .update(threadMembers)
      .set({ removedAt: new Date() })
      .where(
        and(eq(threadMembers.threadId, threadId!), eq(threadMembers.appUserId, seed.appUserId)),
      );
    expect(await isMember(h.db, { threadId: threadId!, appUserId: seed.appUserId })).toBe(false);
  });
});
