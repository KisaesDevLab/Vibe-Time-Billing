// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P1.6 — Request suggestion lifecycle test (G.11)
//
// Covers the client-request → time-entry suggestion flow plus the
// hourly expiration sweep. The full request router (fulfill / accept /
// dismiss) is mid-thickness API code; this test exercises the row
// states directly so the lock semantics survive future refactors.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, isNull, and } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';

import { clientRequestTimeEntryLinks, clientRequests, timeEntries } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { runRequestSuggestionSweep } from '../../../worker/src/jobs/request-suggestion-sweep';

const silentLog = pino({ level: 'silent' });

describe('client-request suggestion lifecycle (G.11)', () => {
  let h: PgliteHarness;
  let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
  let sealDir: string;

  beforeEach(async () => {
    sealDir = await mkdtemp(join(tmpdir(), 'vibe-test-seal-'));
    process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
    h = await buildPgliteHarness();
    seed = await seedMinimalFirm(h.db);
  });

  afterEach(async () => {
    await h.close();
    await rm(sealDir, { recursive: true, force: true });
  });

  async function createRequestWithSuggestion(args: {
    expiresAt: Date;
  }): Promise<{ requestId: string; suggestionId: string }> {
    const [req] = await h.db
      .insert(clientRequests)
      .values({
        firmId: seed.firmId,
        engagementId: seed.engagementId,
        title: 'Send last year K-1',
        body: 'Need it by month end',
        status: 'FULFILLED',
        assignedAppUserId: seed.appUserId,
        fulfilledAt: new Date(),
        fulfilledByAppUserId: seed.appUserId,
      })
      .returning({ id: clientRequests.id });
    const [suggestion] = await h.db
      .insert(clientRequestTimeEntryLinks)
      .values({
        clientRequestId: req!.id,
        suggestedForAppUserId: seed.appUserId,
        expiresAt: args.expiresAt,
      })
      .returning({ id: clientRequestTimeEntryLinks.id });
    return { requestId: req!.id, suggestionId: suggestion!.id };
  }

  it('fresh suggestion appears in the pending set (acceptedAt + dismissedAt null)', async () => {
    const future = new Date(Date.now() + 7 * 86_400_000);
    const { suggestionId } = await createRequestWithSuggestion({ expiresAt: future });
    const pending = await h.db
      .select()
      .from(clientRequestTimeEntryLinks)
      .where(
        and(
          isNull(clientRequestTimeEntryLinks.acceptedAt),
          isNull(clientRequestTimeEntryLinks.dismissedAt),
        ),
      );
    expect(pending.length).toBe(1);
    expect(pending[0]!.id).toBe(suggestionId);
  });

  it('accept flow sets acceptedAt and the attached timeEntryId', async () => {
    const future = new Date(Date.now() + 7 * 86_400_000);
    const { suggestionId } = await createRequestWithSuggestion({ expiresAt: future });
    // Create a time entry to attach
    const [te] = await h.db
      .insert(timeEntries)
      .values({
        engagementId: seed.engagementId,
        appUserId: seed.appUserId,
        entryDate: '2026-05-24',
        hours: '0.50',
        standardRateSnapshotCents: 30000,
        standardAmountCents: 15000,
      })
      .returning({ id: timeEntries.id });

    await h.db
      .update(clientRequestTimeEntryLinks)
      .set({ acceptedAt: new Date(), timeEntryId: te!.id })
      .where(eq(clientRequestTimeEntryLinks.id, suggestionId));

    const [row] = await h.db
      .select()
      .from(clientRequestTimeEntryLinks)
      .where(eq(clientRequestTimeEntryLinks.id, suggestionId))
      .limit(1);
    expect(row!.acceptedAt).toBeInstanceOf(Date);
    expect(row!.dismissedAt).toBeNull();
    expect(row!.timeEntryId).toBe(te!.id);
  });

  it('sweep marks expired suggestions dismissed with reason=expired', async () => {
    // Set expires_at to yesterday so the sweep picks it up.
    const yesterday = new Date(Date.now() - 86_400_000);
    const { suggestionId } = await createRequestWithSuggestion({ expiresAt: yesterday });

    const result = await runRequestSuggestionSweep(h.db, silentLog);
    expect(result.expired).toBe(1);

    const [row] = await h.db
      .select()
      .from(clientRequestTimeEntryLinks)
      .where(eq(clientRequestTimeEntryLinks.id, suggestionId))
      .limit(1);
    expect(row!.dismissedAt).toBeInstanceOf(Date);
    expect(row!.dismissedReason).toBe('expired');
    expect(row!.acceptedAt).toBeNull();
  });

  it('sweep skips suggestions that are already accepted', async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    const { suggestionId } = await createRequestWithSuggestion({ expiresAt: yesterday });
    // Accept the suggestion first
    const [te] = await h.db
      .insert(timeEntries)
      .values({
        engagementId: seed.engagementId,
        appUserId: seed.appUserId,
        entryDate: '2026-05-24',
        hours: '0.50',
        standardRateSnapshotCents: 30000,
        standardAmountCents: 15000,
      })
      .returning({ id: timeEntries.id });
    await h.db
      .update(clientRequestTimeEntryLinks)
      .set({ acceptedAt: new Date(), timeEntryId: te!.id })
      .where(eq(clientRequestTimeEntryLinks.id, suggestionId));

    const result = await runRequestSuggestionSweep(h.db, silentLog);
    expect(result.expired).toBe(0);

    const [row] = await h.db
      .select()
      .from(clientRequestTimeEntryLinks)
      .where(eq(clientRequestTimeEntryLinks.id, suggestionId))
      .limit(1);
    expect(row!.dismissedAt).toBeNull();
    expect(row!.acceptedAt).toBeInstanceOf(Date);
  });

  it('sweep does not expire suggestions whose expires_at is still in the future', async () => {
    const future = new Date(Date.now() + 86_400_000);
    await createRequestWithSuggestion({ expiresAt: future });
    const result = await runRequestSuggestionSweep(h.db, silentLog);
    expect(result.expired).toBe(0);
  });

  it('sweep is idempotent — a second run finds zero', async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    await createRequestWithSuggestion({ expiresAt: yesterday });
    const first = await runRequestSuggestionSweep(h.db, silentLog);
    expect(first.expired).toBe(1);
    const second = await runRequestSuggestionSweep(h.db, silentLog);
    expect(second.expired).toBe(0);
  });
});
