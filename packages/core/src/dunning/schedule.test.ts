// SPDX-License-Identifier: Elastic-2.0
import { describe, it, expect } from 'vitest';

import { stepsDueOn } from './schedule';

describe('dunning schedule', () => {
  it('returns only steps whose threshold is reached', () => {
    const r = stepsDueOn({ invoiceDueDate: '2026-05-01', today: '2026-05-22' });
    // 21 days overdue → friendly + firm are due.
    expect(r.map((s) => s.kind)).toEqual(['REMINDER_FRIENDLY', 'REMINDER_FIRM']);
  });

  it('skips steps already sent', () => {
    const r = stepsDueOn({
      invoiceDueDate: '2026-05-01',
      today: '2026-05-22',
      alreadySentKinds: new Set(['REMINDER_FRIENDLY']),
    });
    expect(r.map((s) => s.kind)).toEqual(['REMINDER_FIRM']);
  });

  it('emits the auto-pause step on day 90', () => {
    const r = stepsDueOn({ invoiceDueDate: '2026-01-01', today: '2026-04-01' });
    expect(r.find((s) => s.kind === 'AUTO_PAUSE')).toBeDefined();
  });

  it('returns nothing before due date', () => {
    expect(stepsDueOn({ invoiceDueDate: '2026-05-30', today: '2026-05-22' })).toEqual([]);
  });
});
