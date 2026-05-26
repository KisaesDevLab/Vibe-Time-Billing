// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-2 — Extract-plan tests.

import { describe, expect, it } from 'vitest';
import {
  ExtractPlanError,
  planExtraction,
  type SectionPageRange,
  type WatermarkContext,
} from './extract-plan';

const catalog: SectionPageRange[] = [
  { id: 'cover', ordinal: 0, startPage: 1, endPage: 1 },
  { id: 'f1040', ordinal: 1, startPage: 1, endPage: 5 },
  { id: 'schA', ordinal: 2, startPage: 6, endPage: 7 },
  { id: 'schB', ordinal: 3, startPage: 8, endPage: 8 },
  { id: 'schD', ordinal: 4, startPage: 9, endPage: 11 },
  { id: 'f8949', ordinal: 5, startPage: 12, endPage: 13 },
  { id: 'state-IL', ordinal: 6, startPage: 18, endPage: 22 },
];

const clientWatermark: WatermarkContext = {
  audience: 'CLIENT',
  timestamp: '2026-05-26T12:00:00.000Z',
  primary: 'Acme Industries Inc',
};

describe('TR-2 — planExtraction: FULL scope', () => {
  it('returns every page 1..totalPages', () => {
    const plan = planExtraction({
      returnId: 'r1',
      anchorId: 'rel1',
      scope: 'FULL',
      sectionIds: [],
      sectionCatalog: catalog,
      totalPages: 22,
      watermark: clientWatermark,
    });
    expect(plan.pageIndices1Based.length).toBe(22);
    expect(plan.pageIndices1Based[0]).toBe(1);
    expect(plan.pageIndices1Based[21]).toBe(22);
  });

  it('rejects FULL with non-empty sectionIds', () => {
    expect(() =>
      planExtraction({
        returnId: 'r1',
        anchorId: 'rel1',
        scope: 'FULL',
        sectionIds: ['cover'],
        sectionCatalog: catalog,
        totalPages: 22,
        watermark: clientWatermark,
      }),
    ).toThrow(ExtractPlanError);
  });
});

describe('TR-2 — planExtraction: SELECTED scope', () => {
  it('reorders by ordinal regardless of caller input order', () => {
    const plan = planExtraction({
      returnId: 'r1',
      anchorId: 'rel1',
      scope: 'SELECTED',
      sectionIds: ['schD', 'cover'], // out of order
      sectionCatalog: catalog,
      totalPages: 22,
      watermark: clientWatermark,
    });
    // cover (p1) then schD (pp 9-11) → [1, 9, 10, 11]
    expect(plan.pageIndices1Based).toEqual([1, 9, 10, 11]);
  });

  it('deduplicates pages covered by overlapping sections', () => {
    // f1040 covers 1-5; cover covers 1-1; overlap on page 1.
    const plan = planExtraction({
      returnId: 'r1',
      anchorId: 'rel1',
      scope: 'SELECTED',
      sectionIds: ['cover', 'f1040'],
      sectionCatalog: catalog,
      totalPages: 22,
      watermark: clientWatermark,
    });
    expect(plan.pageIndices1Based).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects unknown section id', () => {
    expect(() =>
      planExtraction({
        returnId: 'r1',
        anchorId: 'rel1',
        scope: 'SELECTED',
        sectionIds: ['ghost'],
        sectionCatalog: catalog,
        totalPages: 22,
        watermark: clientWatermark,
      }),
    ).toThrow(/unknown_section/);
  });

  it('rejects empty SELECTED', () => {
    expect(() =>
      planExtraction({
        returnId: 'r1',
        anchorId: 'rel1',
        scope: 'SELECTED',
        sectionIds: [],
        sectionCatalog: catalog,
        totalPages: 22,
        watermark: clientWatermark,
      }),
    ).toThrow(/selected_scope_empty/);
  });
});

describe('TR-2 — watermark formatting', () => {
  it('CLIENT: client_name · viewed {ts}', () => {
    const plan = planExtraction({
      returnId: 'r1',
      anchorId: 'rel1',
      scope: 'SELECTED',
      sectionIds: ['cover'],
      sectionCatalog: catalog,
      totalPages: 22,
      watermark: clientWatermark,
    });
    expect(plan.watermarkText).toBe('Acme Industries Inc · viewed 2026-05-26T12:00:00.000Z');
  });

  it('STAFF_IMPERSONATION', () => {
    const plan = planExtraction({
      returnId: 'r1',
      anchorId: 'rel1',
      scope: 'FULL',
      sectionIds: [],
      sectionCatalog: catalog,
      totalPages: 22,
      watermark: {
        audience: 'STAFF_IMPERSONATION',
        timestamp: '2026-05-26T12:00:00.000Z',
        primary: 'Sarah Chen',
        secondary: 'Acme Industries Inc',
      },
    });
    expect(plan.watermarkText).toBe(
      'VIEW AS CLIENT · Sarah Chen · Acme Industries Inc · 2026-05-26T12:00:00.000Z',
    );
  });

  it('RECIPIENT', () => {
    const plan = planExtraction({
      returnId: 'r1',
      anchorId: 'share1',
      scope: 'SELECTED',
      sectionIds: ['schA'],
      sectionCatalog: catalog,
      totalPages: 22,
      watermark: {
        audience: 'RECIPIENT',
        timestamp: '2026-05-26T12:00:00.000Z',
        primary: 'banker@chase.example',
        secondary: 'Chase Commercial Banking',
      },
    });
    expect(plan.watermarkText).toBe(
      'banker@chase.example · Chase Commercial Banking · viewed 2026-05-26T12:00:00.000Z',
    );
  });
});

describe('TR-2 — cache key determinism', () => {
  function plan(over: { sectionIds?: string[]; anchorId?: string; primary?: string } = {}): string {
    return planExtraction({
      returnId: 'r1',
      anchorId: over.anchorId ?? 'rel1',
      scope: 'SELECTED',
      sectionIds: over.sectionIds ?? ['cover', 'f1040'],
      sectionCatalog: catalog,
      totalPages: 22,
      watermark: { ...clientWatermark, primary: over.primary ?? clientWatermark.primary },
    }).cacheKey;
  }

  it('same inputs → same key', () => {
    expect(plan()).toBe(plan());
  });

  it('different section order → SAME key (we sort before hashing)', () => {
    const a = plan({ sectionIds: ['cover', 'f1040'] });
    const b = plan({ sectionIds: ['f1040', 'cover'] });
    expect(a).toBe(b);
  });

  it('different anchor → different key', () => {
    expect(plan({ anchorId: 'rel1' })).not.toBe(plan({ anchorId: 'rel2' }));
  });

  it('different watermark → different key', () => {
    expect(plan({ primary: 'Acme' })).not.toBe(plan({ primary: 'Other' }));
  });

  it('key is 64-char hex (sha256)', () => {
    expect(plan()).toMatch(/^[a-f0-9]{64}$/);
  });
});
