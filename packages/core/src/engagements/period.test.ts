// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Period helpers — advancePeriod cadence math + resolveEngagementName
// merge-token substitution.

import { describe, expect, it } from 'vitest';

import { advancePeriod, resolveEngagementName, type Period } from './period';

describe('advancePeriod', () => {
  it('MONTHLY bumps month by 1', () => {
    expect(advancePeriod({ year: 2026, month: 4, label: 'April 2026' }, 'MONTHLY')).toEqual({
      year: 2026,
      month: 5,
      label: 'April 2026',
    });
  });

  it('MONTHLY rolls Dec → Jan with year+1', () => {
    expect(advancePeriod({ year: 2026, month: 12, label: null }, 'MONTHLY')).toEqual({
      year: 2027,
      month: 1,
      label: null,
    });
  });

  it('QUARTERLY bumps by 3 months', () => {
    expect(advancePeriod({ year: 2026, month: 2, label: 'Q1' }, 'QUARTERLY')).toEqual({
      year: 2026,
      month: 5,
      label: 'Q1',
    });
  });

  it('QUARTERLY rolls year when crossing December', () => {
    expect(advancePeriod({ year: 2026, month: 11, label: null }, 'QUARTERLY')).toEqual({
      year: 2027,
      month: 2,
      label: null,
    });
  });

  it('SEMIANNUAL bumps by 6 months', () => {
    expect(advancePeriod({ year: 2026, month: 1, label: 'H1' }, 'SEMIANNUAL')).toEqual({
      year: 2026,
      month: 7,
      label: 'H1',
    });
  });

  it('ANNUAL bumps year, month stays', () => {
    expect(advancePeriod({ year: 2026, month: 4, label: 'Tax year 2026' }, 'ANNUAL')).toEqual({
      year: 2027,
      month: 4,
      label: 'Tax year 2026',
    });
  });

  it('WEEKLY / BIWEEKLY do not change year or month', () => {
    const seed: Period = { year: 2026, month: 4, label: 'wk 14' };
    expect(advancePeriod(seed, 'WEEKLY')).toEqual(seed);
    expect(advancePeriod(seed, 'BIWEEKLY')).toEqual(seed);
  });

  it('passes label through unchanged', () => {
    const seed: Period = { year: 2026, month: 4, label: 'April 2026' };
    expect(advancePeriod(seed, 'MONTHLY').label).toBe('April 2026');
  });

  it('null year + null month is a no-op for any cadence', () => {
    const seed: Period = { year: null, month: null, label: 'free' };
    expect(advancePeriod(seed, 'MONTHLY')).toEqual(seed);
    expect(advancePeriod(seed, 'ANNUAL')).toEqual(seed);
  });

  it('null month under ANNUAL still bumps year', () => {
    expect(advancePeriod({ year: 2026, month: null, label: null }, 'ANNUAL')).toEqual({
      year: 2027,
      month: null,
      label: null,
    });
  });

  it('null year under MONTHLY keeps year null (no anchor)', () => {
    expect(advancePeriod({ year: null, month: 4, label: null }, 'MONTHLY')).toEqual({
      year: null,
      month: 5,
      label: null,
    });
  });
});

describe('resolveEngagementName', () => {
  it('substitutes period.year and period.month', () => {
    const r = resolveEngagementName('Bookkeeping {{period.month}}/{{period.year}}', {
      period: { year: 2026, month: 4, label: null },
    });
    expect(r.output).toBe('Bookkeeping 4/2026');
    expect(r.unresolvedTokens).toEqual([]);
  });

  it('substitutes the free-text label', () => {
    const r = resolveEngagementName('{{client.name}} — {{period.label}}', {
      client: { name: 'Acme LLC' },
      period: { year: 2026, month: null, label: 'Q1 2026' },
    });
    expect(r.output).toBe('Acme LLC — Q1 2026');
  });

  it('reports unresolved tokens when the pattern references unbound fields', () => {
    const r = resolveEngagementName('Pre-bill for {{client.name}} ({{period.quarter}})', {
      client: { name: 'Acme' },
      period: { year: 2026, month: 4, label: null },
    });
    expect(r.output).toBe('Pre-bill for Acme ()');
    expect(r.unresolvedTokens).toContain('period.quarter');
  });

  it('renders empty strings for null period fields rather than the literal "null"', () => {
    const r = resolveEngagementName('Year {{period.year}} Month {{period.month}}', {
      period: { year: 2026, month: null, label: null },
    });
    expect(r.output).toBe('Year 2026 Month ');
  });

  it('returns empty output + no unresolved for empty/null pattern', () => {
    expect(resolveEngagementName(null, {})).toEqual({ output: '', unresolvedTokens: [] });
    expect(resolveEngagementName('', {})).toEqual({ output: '', unresolvedTokens: [] });
    expect(resolveEngagementName('   ', {})).toEqual({ output: '', unresolvedTokens: [] });
  });

  it('supports {{today}} scope', () => {
    const r = resolveEngagementName('Generated {{today}}', { today: '2026-05-31' });
    expect(r.output).toBe('Generated 2026-05-31');
  });

  it('substitutes engagement.* tokens from caller-supplied context', () => {
    const r = resolveEngagementName('{{engagement.tax_year}} 1040 — {{client.name}}', {
      engagement: { tax_year: 2025 },
      client: { name: 'Smith' },
    });
    expect(r.output).toBe('2025 1040 — Smith');
  });
});
