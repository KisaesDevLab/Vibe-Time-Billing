// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, it, expect } from 'vitest';

import { checkBudget } from './provider';

describe('AI cost budget', () => {
  it('ok when well under', () => {
    const r = checkBudget({ monthlyBudgetCents: 10000, warnThresholdPct: 80, spentCents: 1000 });
    expect(r.kind).toBe('ok');
  });
  it('warns at threshold', () => {
    const r = checkBudget({ monthlyBudgetCents: 10000, warnThresholdPct: 80, spentCents: 8500 });
    expect(r.kind).toBe('warn');
  });
  it('exhausted at 100%', () => {
    const r = checkBudget({ monthlyBudgetCents: 10000, warnThresholdPct: 80, spentCents: 10000 });
    expect(r.kind).toBe('exhausted');
  });
});
