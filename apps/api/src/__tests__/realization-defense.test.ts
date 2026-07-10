// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Connect D.7 — realization-defense payload + HTML render. The actual
// PDF render needs Puppeteer (not available in this test env); the
// route falls back to serving HTML when render fails. Tests exercise
// the data-gathering + HTML output and the cross-firm scope guard.
//
// Linked-message coverage is light here because exercising the
// thread-crypto path requires unlocking the appliance MFK — covered
// separately in the engagement-messaging tests. The defense builder
// surfaces an empty messageBodies list for any entry whose links
// couldn't be decrypted, so this test verifies the "no messages"
// rendering path; the "with messages" rendering is exercised via the
// renderDefenseHtml unit test below using a synthesized payload.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { timeEntries } from '@vibe/db/schema';
import {
  buildDefensePayload,
  renderDefenseHtml,
  type DefensePayload,
} from '../engagements/realization-defense';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

describe('buildDefensePayload', () => {
  it('returns null for an engagement that belongs to another firm', async () => {
    const seed = await seedMinimalFirm(harness.db);
    // Build a second firm + a different scope.
    const r = await harness.db.execute(sql`INSERT INTO firm (name) VALUES ('Other') RETURNING id`);
    const otherFirmId = (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const result = await buildDefensePayload({
      db: harness.db,
      engagementId: seed.engagementId,
      firmId: otherFirmId,
    });
    expect(result).toBeNull();
  });

  it('returns empty entries for an engagement with no time entries', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const result = await buildDefensePayload({
      db: harness.db,
      engagementId: seed.engagementId,
      firmId: seed.firmId,
    });
    expect(result).not.toBeNull();
    expect(result!.entries).toEqual([]);
    expect(result!.summary.entryCount).toBe(0);
    expect(result!.summary.totalHours).toBe(0);
  });

  it('aggregates time-entry totals into the summary', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await harness.db.insert(timeEntries).values([
      {
        engagementId: seed.engagementId,
        appUserId: seed.appUserId,
        workCodeId: seed.workCodeId,
        entryDate: '2026-04-01',
        hours: '2.50',
        description: 'Phone call w/ client re Q1 estimates',
        standardRateSnapshotCents: 30000,
        standardAmountCents: 75000,
        costRateSnapshotCents: 10000,
      },
      {
        engagementId: seed.engagementId,
        appUserId: seed.appUserId,
        workCodeId: seed.workCodeId,
        entryDate: '2026-04-02',
        hours: '1.75',
        description: 'Reconcile bank feeds',
        standardRateSnapshotCents: 30000,
        standardAmountCents: 52500,
        costRateSnapshotCents: 10000,
      },
    ]);
    const r = await buildDefensePayload({
      db: harness.db,
      engagementId: seed.engagementId,
      firmId: seed.firmId,
    });
    expect(r).not.toBeNull();
    expect(r!.summary.entryCount).toBe(2);
    expect(r!.summary.totalHours).toBeCloseTo(4.25);
    expect(r!.entries[0]!.description).toContain('Phone call');
    expect(r!.entries[1]!.description).toBe('Reconcile bank feeds');
  });
});

describe('renderDefenseHtml', () => {
  function payload(over?: Partial<DefensePayload>): DefensePayload {
    return {
      summary: {
        engagementName: 'Acme 2026 1120-S',
        clientName: 'Acme LLC',
        firmName: 'Big CPA',
        generatedAt: new Date('2026-05-31T10:00:00Z').toISOString(),
        entryCount: 1,
        linkedMessageCount: 0,
        totalHours: 1.5,
        ...over?.summary,
      },
      entries: over?.entries ?? [
        {
          id: 'te-1',
          entryDate: '2026-04-15',
          hours: 1.5,
          billableFlag: true,
          inScopeFlag: true,
          outOfScopeOverride: false,
          description: 'Phone call <strong>with</strong> client',
          staffName: 'Pat Partner',
          workCodeName: 'Bookkeeping',
          rateCents: 30000,
          amountCents: 45000,
          costCents: 15000,
          approverName: null,
          messageBodies: [],
        },
      ],
    };
  }

  it('renders the INTERNAL banner', () => {
    const html = renderDefenseHtml(payload());
    expect(html).toContain('INTERNAL FIRM-ONLY');
    expect(html).toContain('DO NOT SEND TO CLIENT');
  });

  it('escapes user content', () => {
    const html = renderDefenseHtml(payload());
    expect(html).toContain('Phone call &lt;strong&gt;with&lt;/strong&gt; client');
    expect(html).not.toContain('Phone call <strong>with</strong> client');
  });

  it('omits TOC when no entry has >=5 linked messages', () => {
    const html = renderDefenseHtml(payload());
    expect(html).not.toContain('Entries with extensive linked discussion');
  });

  it('includes TOC + anchor for heavy entries', () => {
    const heavyEntry = {
      id: 'te-heavy',
      entryDate: '2026-04-16',
      hours: 4,
      billableFlag: true,
      inScopeFlag: true,
      outOfScopeOverride: false,
      description: 'Long thread about deferral',
      staffName: 'Pat',
      workCodeName: 'Tax planning',
      rateCents: 30000,
      amountCents: 120000,
      costCents: 40000,
      approverName: null,
      messageBodies: Array.from({ length: 6 }, (_, i) => ({
        id: `m${i}`,
        createdAt: '2026-04-16T10:00:00Z',
        body: `Message ${i}`,
        senderKind: (i % 2 === 0 ? 'staff' : 'client') as 'staff' | 'client',
      })),
    };
    const html = renderDefenseHtml(payload({ entries: [heavyEntry] }));
    expect(html).toContain('Entries with extensive linked discussion');
    expect(html).toContain('href="#entry-te-heavy"');
    expect(html).toContain('id="entry-te-heavy"');
    expect(html).toContain('Linked messages (6)');
  });

  it('flags non-billable and out-of-scope', () => {
    const nonBillable = {
      ...payload().entries[0]!,
      id: 'te-2',
      billableFlag: false,
      outOfScopeOverride: true,
    };
    const html = renderDefenseHtml(payload({ entries: [nonBillable] }));
    expect(html).toContain('NON-BILLABLE');
    expect(html).toContain('OUT-OF-SCOPE');
  });
});
