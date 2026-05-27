// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-1 §3.1 — Lexicon normalization tests.

import { describe, expect, it } from 'vitest';
import { normalizeTitle } from './lexicon';

describe('TR-1 — normalizeTitle: main forms', () => {
  it('1040', () => {
    const r = normalizeTitle('Form 1040');
    expect(r.formCode).toBe('1040');
    expect(r.kind).toBe('MAIN_FORM');
    expect(r.normalizedTitle).toBe('Form 1040');
    expect(r.parseConfidence).toBe(100);
  });

  it('1040-SR is still 1040', () => {
    const r = normalizeTitle('Form 1040-SR');
    expect(r.formCode).toBe('1040');
    expect(r.normalizedTitle).toBe('Form 1040');
  });

  it('1040-X is amended-form-aware', () => {
    const r = normalizeTitle('Form 1040-X');
    expect(r.formCode).toBe('1040-X');
    expect(r.normalizedTitle).toBe('Form 1040-X');
  });

  it('1120-S accepts hyphen or unhyphenated', () => {
    expect(normalizeTitle('Form 1120-S').formCode).toBe('1120-S');
    expect(normalizeTitle('Form 1120S').formCode).toBe('1120-S');
  });

  it('1120 (C-corp) not confused with 1120-S', () => {
    const r = normalizeTitle('Form 1120');
    expect(r.formCode).toBe('1120');
  });

  it('1065 + 1041 + 990 + 706', () => {
    expect(normalizeTitle('Form 1065').formCode).toBe('1065');
    expect(normalizeTitle('Form 1041').formCode).toBe('1041');
    expect(normalizeTitle('Form 990').formCode).toBe('990');
    expect(normalizeTitle('Form 706').formCode).toBe('706');
  });
});

describe('TR-1 — schedules', () => {
  it('Schedule A → SCHEDULE kind', () => {
    const r = normalizeTitle('Schedule A — Itemized Deductions');
    expect(r.kind).toBe('SCHEDULE');
    expect(r.formCode).toBe('Schedule A');
    expect(r.normalizedTitle).toBe('Schedule A');
  });

  it('Schedule M-1 (with dash)', () => {
    const r = normalizeTitle('Schedule M-1');
    expect(r.formCode).toBe('Schedule M-1');
  });

  it('Schedule D, E, L all recognized', () => {
    expect(normalizeTitle('Schedule D').kind).toBe('SCHEDULE');
    expect(normalizeTitle('Schedule E').kind).toBe('SCHEDULE');
    expect(normalizeTitle('Schedule L').kind).toBe('SCHEDULE');
  });
});

describe('TR-1 — K-1 with recipient capture', () => {
  it('captures partner name from em-dash format', () => {
    const r = normalizeTitle('Schedule K-1 — Maya Calderón');
    expect(r.kind).toBe('K1');
    expect(r.formCode).toBe('K-1');
    expect(r.recipientName).toBe('Maya Calderón');
    expect(r.normalizedTitle).toBe('Schedule K-1 — Maya Calderón');
  });

  it('captures with hyphen separator', () => {
    const r = normalizeTitle('Schedule K-1 - Devin Holland');
    expect(r.recipientName).toBe('Devin Holland');
  });

  it('plain Schedule K-1 with no name still classifies', () => {
    const r = normalizeTitle('Schedule K-1');
    expect(r.kind).toBe('K1');
    expect(r.recipientName).toBeNull();
  });

  it('handles UltraTax "Schedule K-1 (Form 1065) — Name" variant', () => {
    const r = normalizeTitle('Schedule K-1 (Form 1065) — Alex Wu');
    expect(r.kind).toBe('K1');
    expect(r.recipientName).toBe('Alex Wu');
    expect(r.normalizedTitle).toBe('Schedule K-1 — Alex Wu');
  });

  it('handles "Schedule K-1 (Form 1120-S) - Name"', () => {
    const r = normalizeTitle('Schedule K-1 (Form 1120-S) - Priya Patel');
    expect(r.kind).toBe('K1');
    expect(r.recipientName).toBe('Priya Patel');
  });

  it('handles bare "K-1 — Name" without "Schedule"', () => {
    const r = normalizeTitle('K-1 — Jordan Lee');
    expect(r.kind).toBe('K1');
    expect(r.recipientName).toBe('Jordan Lee');
  });

  it('handles "K-1: Name" colon separator', () => {
    const r = normalizeTitle('K-1: Sam Rivera');
    expect(r.kind).toBe('K1');
    expect(r.recipientName).toBe('Sam Rivera');
  });

  it('handles "K-1 for Name"', () => {
    const r = normalizeTitle('K-1 for Casey Morgan');
    expect(r.kind).toBe('K1');
    expect(r.recipientName).toBe('Casey Morgan');
  });

  it('handles "Partner K-1: Name"', () => {
    const r = normalizeTitle('Partner K-1: Robin Chen');
    expect(r.kind).toBe('K1');
    expect(r.recipientName).toBe('Robin Chen');
  });

  it('handles "Shareholder K-1 — Name"', () => {
    const r = normalizeTitle('Shareholder K-1 — Drew Park');
    expect(r.kind).toBe('K1');
    expect(r.recipientName).toBe('Drew Park');
  });
});

describe('TR-1 — state returns + worksheets', () => {
  it('State — Illinois', () => {
    const r = normalizeTitle('State — Illinois');
    expect(r.kind).toBe('STATE');
    expect(r.normalizedTitle).toBe('State — Illinois');
  });

  it('Worksheets default releasable=false', () => {
    const r = normalizeTitle('Worksheets');
    expect(r.kind).toBe('WORKSHEET');
    expect(r.defaultReleasable).toBe(false);
  });
});

describe('TR-1 — generic numbered forms', () => {
  it('Form 8949 picked up by generic numbered-form rule', () => {
    const r = normalizeTitle('Form 8949');
    expect(r.formCode).toBe('Form 8949');
    expect(r.kind).toBe('SCHEDULE');
  });

  it('Form 8606', () => {
    const r = normalizeTitle('Form 8606');
    expect(r.formCode).toBe('Form 8606');
  });
});

describe('TR-1 — unmatched titles', () => {
  it('falls through to UNKNOWN with 0 confidence', () => {
    const r = normalizeTitle('Random Notes Page');
    expect(r.kind).toBe('UNKNOWN');
    expect(r.parseConfidence).toBe(0);
    expect(r.normalizedTitle).toBe('Random Notes Page');
  });
});
