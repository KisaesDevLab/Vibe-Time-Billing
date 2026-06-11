// SPDX-License-Identifier: Elastic-2.0
//
// TR-1 §3 — Outline walker tests.

import { describe, expect, it } from 'vitest';
import { walkOutline, type OutlineNode } from './outline-walker';

const sample1040: OutlineNode[] = [
  {
    title: 'Federal',
    startPage: 1,
    children: [
      {
        title: 'Form 1040',
        startPage: 1,
        children: [
          { title: 'Schedule 1 — Additional Income', startPage: 3 },
          { title: 'Schedule 2 — Additional Taxes', startPage: 4 },
          { title: 'Schedule 3 — Additional Credits', startPage: 5 },
        ],
      },
      { title: 'Schedule A — Itemized Deductions', startPage: 6 },
      { title: 'Schedule B — Interest & Ordinary Dividends', startPage: 8 },
      {
        title: 'Schedule D — Capital Gains',
        startPage: 9,
        children: [{ title: 'Form 8949', startPage: 12 }],
      },
    ],
  },
  { title: 'State — Illinois', startPage: 18 },
];

describe('TR-1 — walkOutline', () => {
  it('assigns ordinals in pre-order', () => {
    const result = walkOutline(sample1040, { totalPages: 22 });
    const titles = result.map((s) => s.rawTitle);
    expect(titles[0]).toBe('Federal');
    expect(titles[1]).toBe('Form 1040');
    expect(titles[2]).toBe('Schedule 1 — Additional Income');
    expect(titles[titles.length - 1]).toBe('State — Illinois');
  });

  it('computes end_page from the next same-or-shallower sibling', () => {
    const result = walkOutline(sample1040, { totalPages: 22 });
    const sch1 = result.find((s) => s.rawTitle.startsWith('Schedule 1'))!;
    expect(sch1.endPage).toBe(3); // next sibling Schedule 2 starts at 4
    const schA = result.find((s) => s.rawTitle.startsWith('Schedule A'))!;
    expect(schA.startPage).toBe(6);
    expect(schA.endPage).toBe(7); // Schedule B starts at 8
  });

  it('parent end_page extends to right before next shallower sibling, not its own child', () => {
    const result = walkOutline(sample1040, { totalPages: 22 });
    // Form 1040 (depth 1) has 3 children at depth 2. Its end_page
    // should be the page BEFORE the next depth-1 node (Schedule A
    // at page 6), so 5 — even though it has children that extend
    // through 5.
    const f1040 = result.find((s) => s.rawTitle === 'Form 1040')!;
    expect(f1040.endPage).toBe(5);
  });

  it('Schedule D extends past its child Form 8949', () => {
    const result = walkOutline(sample1040, { totalPages: 22 });
    const schD = result.find((s) => s.rawTitle.startsWith('Schedule D'))!;
    // State — Illinois starts at page 18 and is at depth 0 = same
    // shallower-or-equal as Schedule D (depth 1)? No, depth 0 is
    // shallower than depth 1. So Schedule D extends until page 17.
    expect(schD.endPage).toBe(17);
  });

  it('last node extends to totalPages', () => {
    const result = walkOutline(sample1040, { totalPages: 22 });
    const last = result[result.length - 1]!;
    expect(last.rawTitle).toBe('State — Illinois');
    expect(last.endPage).toBe(22);
  });

  it('depth + parentOrdinal track hierarchy', () => {
    const result = walkOutline(sample1040, { totalPages: 22 });
    const federal = result[0]!;
    expect(federal.depth).toBe(0);
    expect(federal.parentOrdinal).toBeNull();
    const f1040 = result.find((s) => s.rawTitle === 'Form 1040')!;
    expect(f1040.depth).toBe(1);
    expect(f1040.parentOrdinal).toBe(federal.ordinal);
    const sch1 = result.find((s) => s.rawTitle.startsWith('Schedule 1'))!;
    expect(sch1.depth).toBe(2);
    expect(sch1.parentOrdinal).toBe(f1040.ordinal);
  });

  it('applies the lexicon to normalize titles', () => {
    const result = walkOutline(sample1040, { totalPages: 22 });
    const sch1 = result.find((s) => s.rawTitle.startsWith('Schedule 1'))!;
    // "Schedule 1" matches the generic Schedule pattern → "Schedule 1"
    expect(sch1.formCode).toBe('Schedule 1');
    expect(sch1.kind).toBe('SCHEDULE');
  });

  it('1120-S with K-1s captures recipient names', () => {
    const corp1120s: OutlineNode[] = [
      { title: 'Form 1120-S', startPage: 1 },
      { title: 'Schedule K-1 — Maya Calderón', startPage: 6 },
      { title: 'Schedule K-1 — Devin Holland', startPage: 8 },
      { title: 'Schedule K-1 — Sasha Kim', startPage: 9 },
      { title: 'Schedule L', startPage: 10 },
    ];
    const result = walkOutline(corp1120s, { totalPages: 13 });
    const k1s = result.filter((s) => s.kind === 'K1');
    expect(k1s.length).toBe(3);
    expect(k1s[0]!.recipientName).toBe('Maya Calderón');
    expect(k1s[1]!.recipientName).toBe('Devin Holland');
  });

  it('fallback confidence caps at 60', () => {
    const result = walkOutline([{ title: 'Form 1040', startPage: 1 }], {
      totalPages: 5,
      fallbackConfidence: true,
    });
    expect(result[0]!.parseConfidence).toBe(60);
  });

  it('worksheet section defaults to releasable=false', () => {
    const result = walkOutline([{ title: 'Worksheets', startPage: 1 }], {
      totalPages: 5,
    });
    expect(result[0]!.releasable).toBe(false);
  });

  it('interleaved (non-monotonic) outlines do not swallow other wings’ pages', () => {
    // Drake/UltraTax shape: a "Reports" wing whose items point at pages
    // scattered through the document, followed by Federal/State wings that
    // own the in-between pages. Modeled on a real 40-page MO 1040 export.
    const drake: OutlineNode[] = [
      {
        title: 'Reports',
        startPage: 1,
        children: [
          {
            title: 'Federal',
            startPage: 1,
            children: [
              { title: 'Return Summary', startPage: 1 },
              { title: 'Tax Projection Worksheet 1', startPage: 18 },
              { title: 'Tax Projection Worksheet 2', startPage: 19 },
            ],
          },
          {
            title: 'Missouri',
            startPage: 23,
            children: [
              { title: 'MO Summary Report', startPage: 23 },
              { title: 'MO Tax Projection Worksheet', startPage: 38 },
            ],
          },
        ],
      },
      {
        title: 'Federal',
        startPage: 2,
        children: [
          { title: 'Transmittal Letter', startPage: 2 },
          { title: 'Form 8879', startPage: 11 },
          { title: 'Form 1040 Page 1', startPage: 13 },
          { title: 'TPW Item Ded Limit Wrk', startPage: 20 },
          { title: 'Tax Reconciliation Worksheet', startPage: 21 },
          { title: 'Consent to Use Tax Information', startPage: 39 },
        ],
      },
      {
        title: 'Missouri',
        startPage: 24,
        children: [
          { title: 'MO Form MO-1040ES Page 1', startPage: 24 },
          { title: 'MO Form MO-1040 Page 1', startPage: 29 },
          { title: 'MO Estimated Tax Worksheet', startPage: 37 },
        ],
      },
    ];
    const result = walkOutline(drake, { totalPages: 40 });
    const byTitle = (t: string) => result.find((s) => s.rawTitle === t)!;

    // The 1-page Return Summary must NOT claim pages 2–17 (transmittal
    // letter, 8879, 1040 …) just because its outline-neighbor starts at 18.
    expect(byTitle('Return Summary').endPage).toBe(1);
    // TPW2 (p19) must not claim 20–22, which other sections own.
    expect(byTitle('Tax Projection Worksheet 2').endPage).toBe(19);
    // Backward outline jump (38 → next wing at 2) must not clamp to a lie:
    // next page on which anything starts after 38 is 39.
    expect(byTitle('MO Tax Projection Worksheet').endPage).toBe(38);
    // Leaves before a gap keep the gap (no bookmark claims 14–17 except
    // the 1040, whose next-anywhere start is 18).
    expect(byTitle('Form 1040 Page 1').endPage).toBe(17);
    // Parents span their (scattered) descendants.
    expect(byTitle('Reports').startPage).toBe(1);
    expect(byTitle('Reports').endPage).toBe(38);
    const fedWing = result.find((s) => s.rawTitle === 'Federal' && s.depth === 0)!;
    expect(fedWing.endPage).toBe(40); // Consent@39 runs to totalPages
    // Last starts: Consent (39) → 40; MO Est Wrk (37) → 37.
    expect(byTitle('Consent to Use Tax Information').endPage).toBe(40);
    expect(byTitle('MO Estimated Tax Worksheet').endPage).toBe(37);
  });
});
