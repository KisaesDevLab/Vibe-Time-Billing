// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { extractIdCandidates, parseFilename, stripIdSegment, yearWindow } from './parse';
import { evaluateRules, resolveYearSubfolder, type RoutingRule } from './rules';

const NOW = new Date('2026-06-09T00:00:00Z');

describe('parseFilename', () => {
  it('clean parse → name + id + year', () => {
    const r = parseFilename('Acme Corp_123456_2024-1040.pdf', { now: NOW });
    expect(r.unparseable).toBe(false);
    expect(r.name).toBe('Acme Corp');
    expect(r.id).toBe('123456');
    expect(r.year).toBe(2024);
    expect(r.ext).toBe('pdf');
  });

  it('non-greedy name anchors on the first id boundary (handles & and spaces)', () => {
    const r = parseFilename('Smith & Co_987654_W2_2025.pdf', { now: NOW });
    expect(r.name).toBe('Smith & Co');
    expect(r.id).toBe('987654');
    expect(r.year).toBe(2025);
  });

  it('missing/short id → name-only (id null)', () => {
    const r = parseFilename('Johnson_W2_2023.pdf', { now: NOW });
    expect(r.unparseable).toBe(false);
    expect(r.name).toBe('Johnson');
    expect(r.id).toBeNull();
    expect(r.year).toBe(2023);
  });

  it('no usable name or id → unparseable', () => {
    expect(parseFilename('scan0001', { now: NOW }).unparseable).toBe(true);
  });

  it('year only counts inside the rolling window', () => {
    // 1850 is out of [1976, 2036]; 2024 is in.
    const r = parseFilename('Doe_111111_1850_archive_2024.pdf', { now: NOW });
    expect(r.year).toBe(2024);
    const none = parseFilename('Doe_111111_1850.pdf', { now: NOW });
    expect(none.year).toBeNull();
  });

  it('respects a configurable id pattern', () => {
    const r = parseFilename('Acme_42_x.pdf', { now: NOW, idPattern: '\\d{2,}' });
    expect(r.id).toBe('42');
  });

  it('yearWindow is current-50 .. current+10', () => {
    expect(yearWindow(NOW)).toEqual({ min: 1976, max: 2036 });
  });
});

describe('stripIdSegment', () => {
  it('removes the _{id}_ segment', () => {
    expect(stripIdSegment('Smith_123456_2024.pdf', '123456')).toBe('Smith_2024.pdf');
  });
  it('no-op when id is null', () => {
    expect(stripIdSegment('Smith_2024.pdf', null)).toBe('Smith_2024.pdf');
  });
});

function rule(p: Partial<RoutingRule>): RoutingRule {
  return {
    id: p.id ?? 'r',
    sortOrder: p.sortOrder ?? 0,
    identifier: p.identifier ?? '',
    matchMode: p.matchMode ?? 'contains',
    caseSensitive: p.caseSensitive ?? false,
    targetPath: p.targetPath ?? '',
    yearBehavior: p.yearBehavior ?? 'none',
    isTaxReturn: p.isTaxReturn ?? false,
    enabled: p.enabled ?? true,
  };
}

describe('evaluateRules', () => {
  it('first enabled match by sortOrder wins', () => {
    const rules = [
      rule({ id: 'b', sortOrder: 2, identifier: '1040', targetPath: 'B/' }),
      rule({ id: 'a', sortOrder: 1, identifier: '1040', targetPath: 'A/' }),
    ];
    expect(evaluateRules('x_1040_.pdf', rules)?.id).toBe('a');
  });

  it('skips disabled rules', () => {
    const rules = [
      rule({ id: 'a', sortOrder: 1, identifier: '1040', enabled: false }),
      rule({ id: 'b', sortOrder: 2, identifier: '1040' }),
    ];
    expect(evaluateRules('1040.pdf', rules)?.id).toBe('b');
  });

  it('honors match modes + case sensitivity', () => {
    expect(
      evaluateRules('W2-form.pdf', [rule({ identifier: 'w2', matchMode: 'starts_with' })]),
    ).toBeTruthy();
    expect(
      evaluateRules('mid-W2-form.pdf', [rule({ identifier: 'w2', matchMode: 'starts_with' })]),
    ).toBeNull();
    expect(
      evaluateRules('FormW2.pdf', [rule({ identifier: 'w2', caseSensitive: true })]),
    ).toBeNull();
    expect(
      evaluateRules('Form2024.pdf', [rule({ identifier: '\\d{4}', matchMode: 'regex' })]),
    ).toBeTruthy();
  });

  it('invalid regex never matches (no throw)', () => {
    expect(evaluateRules('x.pdf', [rule({ identifier: '(', matchMode: 'regex' })])).toBeNull();
  });
});

describe('resolveYearSubfolder', () => {
  it('none → empty', () => expect(resolveYearSubfolder(2024, 'none')).toBe(''));
  it('current_only → {year}/', () =>
    expect(resolveYearSubfolder(2024, 'current_only')).toBe('2024/'));
  it('current_and_next files under the parsed year', () =>
    expect(resolveYearSubfolder(2024, 'current_and_next')).toBe('2024/'));
  it('previous → {year-1}/', () => expect(resolveYearSubfolder(2024, 'previous')).toBe('2023/'));
  it('missing year when required → null', () =>
    expect(resolveYearSubfolder(null, 'current_only')).toBeNull());
});

describe('extractIdCandidates (0149)', () => {
  it('finds every id-pattern token anywhere in the stem', () => {
    expect(extractIdCandidates('2024 W2 123456.pdf')).toEqual(['2024', '123456']);
    expect(extractIdCandidates('Smith-123456-W2.pdf')).toEqual(['123456']);
  });
  it('dedupes and ignores the extension', () => {
    expect(extractIdCandidates('123456_123456.7890')).toEqual(['123456']);
  });
  it('empty when nothing matches', () => {
    expect(extractIdCandidates('notes.pdf')).toEqual([]);
  });
});
