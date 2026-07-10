// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Parser tests — the pure header-detection fallback + the
// applyParsedSections persistence (replace + flip to PARSED). The
// pdfjs outline path is integration-verified against a real PDF.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { taxReturns, taxReturnSections } from '@vibe/db/schema';
import { eq } from 'drizzle-orm';
import { walkOutline } from '@vibe/core/tax-returns';

import {
  applyParsedSections,
  detectSectionsFromHeaders,
  type ParsedSections,
} from '../tax-returns/parse';

describe('detectSectionsFromHeaders', () => {
  it('starts a section on each recognized form header, folding continuation pages', () => {
    const nodes = detectSectionsFromHeaders([
      'Form 1040 U.S. Individual Income Tax Return 2025',
      '...continuation of 1040, no header...',
      'Schedule A Itemized Deductions',
      'Schedule K-1 (Form 1065) — Jane Doe share of income',
      'more k-1 detail',
    ]);
    expect(nodes.map((n) => n.startPage)).toEqual([1, 3, 4]);
    expect(nodes[0]!.title).toMatch(/Form 1040/);
    expect(nodes[2]!.title).toMatch(/K-1/);
  });

  it('returns nothing when no page has a recognizable header', () => {
    expect(detectSectionsFromHeaders(['lorem ipsum', 'dolor sit amet'])).toEqual([]);
  });

  it('feeds walkOutline to yield page ranges', () => {
    const nodes = detectSectionsFromHeaders([
      'Form 1040 U.S. Individual Income Tax Return',
      'x',
      'Schedule C Profit or Loss',
    ]);
    const sections = walkOutline(nodes, { totalPages: 4, fallbackConfidence: true });
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ startPage: 1, endPage: 2, kind: 'MAIN_FORM' });
    expect(sections[1]).toMatchObject({ startPage: 3, endPage: 4, kind: 'SCHEDULE' });
    // fallback confidence is capped at 60.
    expect(sections[0]!.parseConfidence).toBeLessThanOrEqual(60);
  });
});

describe('applyParsedSections', () => {
  let harness: PgliteHarness;
  beforeEach(async () => {
    harness = await buildPgliteHarness();
  });
  afterEach(async () => {
    await harness.close();
  });

  it('replaces existing sections and flips the return to PARSED', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const [r] = await harness.db
      .insert(taxReturns)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        taxYear: 2025,
        formCode: '1040',
        title: '2025 1040',
        status: 'DRAFT',
        totalPages: 1,
      })
      .returning();
    // A stale catch-all section that should be wiped.
    await harness.db.insert(taxReturnSections).values({
      returnId: r!.id,
      ordinal: 0,
      rawTitle: 'Full return',
      normalizedTitle: 'Full return',
      kind: 'UNKNOWN',
      startPage: 1,
      endPage: 1,
    });

    const parsed: ParsedSections = {
      totalPages: 8,
      strategy: 'outline',
      sections: walkOutline(
        [
          { title: 'Form 1040', startPage: 1 },
          { title: 'Schedule A', startPage: 4 },
          { title: 'Worksheets', startPage: 7 },
        ],
        { totalPages: 8 },
      ),
    };
    await applyParsedSections(harness.db, r!.id, parsed);

    const rows = await harness.db
      .select()
      .from(taxReturnSections)
      .where(eq(taxReturnSections.returnId, r!.id));
    expect(rows).toHaveLength(3);
    expect(rows.find((x) => x.normalizedTitle === 'Full return')).toBeUndefined();
    // Worksheets default to internal-only.
    const ws = rows.find((x) => x.kind === 'WORKSHEET');
    expect(ws?.releasable).toBe(false);

    const [ret] = await harness.db
      .select({
        status: taxReturns.status,
        totalPages: taxReturns.totalPages,
        parsedAt: taxReturns.parsedAt,
      })
      .from(taxReturns)
      .where(eq(taxReturns.id, r!.id));
    expect(ret!.status).toBe('PARSED');
    expect(ret!.totalPages).toBe(8);
    expect(ret!.parsedAt).not.toBeNull();
  });
});
