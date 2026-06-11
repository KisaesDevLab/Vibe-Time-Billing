// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from 'vitest';

import { assemblePackagePlan, layoutForKey, type PackagePart } from '../signatures/packaging';
import type { PageGeometry } from '../signatures/geometry';

const geo = (n: number): PageGeometry[] =>
  Array.from({ length: n }, (_, i) => ({ pageNumber: i + 1, widthPt: 612, heightPt: 792 }));

describe('assemblePackagePlan', () => {
  // 3-page merged PDF: page 1 = us-8879 (return), pages 2-3 = a template.
  const parts: PackagePart[] = [
    { source: 'return', label: '8879', pageStart: 1, pageEnd: 1, fields: layoutForKey('us-8879') },
    {
      source: 'template',
      label: 'Consent',
      pageStart: 2,
      pageEnd: 3,
      fields: [
        {
          role: 'taxpayer',
          fieldType: 'signature',
          pageNumber: 2,
          nx: 0.1,
          ny: 0.8,
          nw: 0.3,
          nh: 0.04,
        },
      ],
    },
  ];

  it('MFJ places taxpayer + spouse, remapped to merged pages', () => {
    const signers = [
      { id: 'tp', role: 'taxpayer' },
      { id: 'sp', role: 'spouse' },
    ];
    const { placements } = assemblePackagePlan(parts, signers, geo(3));
    // page 1: 2 taxpayer + 2 spouse fields
    const p1 = placements.filter((p) => p.pageNumber === 1);
    expect(p1.filter((p) => p.signerId === 'tp')).toHaveLength(2);
    expect(p1.filter((p) => p.signerId === 'sp')).toHaveLength(2);
    // template field was on its own page 2 → merged page 3 (pageStart 2 + 2 - 1)
    const tmpl = placements.filter((p) => p.pageNumber === 3);
    expect(tmpl).toHaveLength(1);
    expect(tmpl[0]!.signerId).toBe('tp');
  });

  it('Single (taxpayer only) drops the spouse fields', () => {
    const { placements } = assemblePackagePlan(parts, [{ id: 'tp', role: 'taxpayer' }], geo(3));
    expect(placements.every((p) => p.signerId === 'tp')).toBe(true);
    expect(placements.filter((p) => p.pageNumber === 1)).toHaveLength(2); // sig + date, no spouse
  });
});
