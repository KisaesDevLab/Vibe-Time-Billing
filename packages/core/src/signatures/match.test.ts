// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0

import { describe, expect, it } from 'vitest';

import type { FlatSection } from '../tax-returns/outline-walker';
import { matchSignaturePages, type SignaturePageRule } from './match';
import { returnTypeFamily, ruleAppliesToReturn } from './return-types';

function section(
  partial: Partial<FlatSection> & { startPage: number; rawTitle: string },
): FlatSection {
  return {
    ordinal: 0,
    parentOrdinal: null,
    depth: 0,
    normalizedTitle: '',
    kind: 'UNKNOWN',
    formCode: null,
    recipientName: null,
    endPage: partial.startPage,
    releasable: true,
    parseConfidence: 100,
    ...partial,
  } as FlatSection;
}

function rule(
  partial: Partial<SignaturePageRule> & { id: string; bookmarkPattern: string },
): SignaturePageRule {
  return {
    formType: '*',
    matchMode: 'contains',
    caseSensitive: false,
    layoutKey: 'generic',
    enabled: true,
    sortOrder: 0,
    ...partial,
  };
}

describe('returnTypeFamily', () => {
  it('folds family variants to the base key', () => {
    expect(returnTypeFamily('1040-SR')).toBe('1040');
    expect(returnTypeFamily('1040')).toBe('1040');
    expect(returnTypeFamily('1120-S')).toBe('1120-S');
    expect(returnTypeFamily('MO-1040')).toBe('MO-1040'); // custom state code preserved
  });
});

describe('ruleAppliesToReturn', () => {
  it('matches family, exact, and wildcard', () => {
    expect(ruleAppliesToReturn('1040', '1040-SR')).toBe(true);
    expect(ruleAppliesToReturn('1120-S', '1120-S')).toBe(true);
    expect(ruleAppliesToReturn('*', '706')).toBe(true);
    expect(ruleAppliesToReturn('1065', '1120')).toBe(false);
  });
});

describe('matchSignaturePages', () => {
  const sections = [
    section({ startPage: 1, rawTitle: 'Form 1040' }),
    section({ startPage: 5, rawTitle: 'Form 8879 e-file Authorization' }),
    section({ startPage: 9, rawTitle: 'NY TR-579-IT' }),
    section({ startPage: 12, rawTitle: 'California e-file Signature Authorization' }),
  ];

  it('finds the federal 8879 and multiple state-auth pages', () => {
    const rules: SignaturePageRule[] = [
      rule({ id: 'r1', formType: '1040', bookmarkPattern: '8879', layoutKey: 'us-8879' }),
      rule({ id: 'r2', formType: '*', bookmarkPattern: 'TR-579', layoutKey: 'state-auth' }),
      rule({
        id: 'r3',
        formType: '*',
        bookmarkPattern: 'e-file Signature Authorization',
        layoutKey: 'state-auth',
      }),
    ];
    const out = matchSignaturePages(sections, rules, '1040');
    expect(out.map((m) => m.pageNumber)).toEqual([5, 9, 12]);
    expect(out[0]!.layoutKey).toBe('us-8879');
    expect(out[1]!.layoutKey).toBe('state-auth');
  });

  it('respects exact and regex modes', () => {
    expect(
      matchSignaturePages(
        sections,
        [rule({ id: 'x', bookmarkPattern: 'Form 8879 e-file Authorization', matchMode: 'exact' })],
        '1040',
      ).map((m) => m.pageNumber),
    ).toEqual([5]);
    expect(
      matchSignaturePages(
        sections,
        [rule({ id: 'x', bookmarkPattern: 'TR-\\d{3}', matchMode: 'regex' })],
        '1040',
      ).map((m) => m.pageNumber),
    ).toEqual([9]);
  });

  it('ignores disabled rules and non-applicable form types, and dedupes per page', () => {
    const rules: SignaturePageRule[] = [
      rule({ id: 'd', bookmarkPattern: '8879', enabled: false }),
      rule({ id: 'n', formType: '1065', bookmarkPattern: '8879' }),
      rule({ id: 'a', formType: '1040', bookmarkPattern: '8879', sortOrder: 1 }),
      rule({ id: 'b', formType: '1040', bookmarkPattern: 'Authorization', sortOrder: 2 }),
    ];
    const out = matchSignaturePages(sections, rules, '1040');
    // page 5 matches both 'a' and 'b'; first by sortOrder ('a') wins, emitted once
    expect(out.filter((m) => m.pageNumber === 5)).toHaveLength(1);
    expect(out.find((m) => m.pageNumber === 5)!.ruleId).toBe('a');
  });
});
