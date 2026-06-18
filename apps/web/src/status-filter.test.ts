// SPDX-License-Identifier: Elastic-2.0
//
// 0167 — unit tests for the service-line status filtering rules.

import { describe, expect, it } from 'vitest';

import {
  allowedForServiceLine,
  filterStatuses,
  filterStatusesForMany,
  type StatusWithLines,
} from './status-filter';

const SL_TAX = 'sl-tax';
const SL_BOOK = 'sl-book';

const unrestricted: StatusWithLines = { workflowState: 'IN_PROGRESS', serviceLineIds: [] };
const taxOnly: StatusWithLines = { workflowState: 'WITH_CLIENT', serviceLineIds: [SL_TAX] };
const bookOnly: StatusWithLines = { workflowState: 'POSTED', serviceLineIds: [SL_BOOK] };

describe('allowedForServiceLine', () => {
  it('rule 1: an unmapped status is allowed for any service line', () => {
    expect(allowedForServiceLine(unrestricted, SL_TAX)).toBe(true);
    expect(allowedForServiceLine(unrestricted, null)).toBe(true);
  });

  it('rule 2: a mapped status is allowed only for a listed service line', () => {
    expect(allowedForServiceLine(taxOnly, SL_TAX)).toBe(true);
    expect(allowedForServiceLine(taxOnly, SL_BOOK)).toBe(false);
  });

  it('rule 3: an engagement with no service line sees everything', () => {
    expect(allowedForServiceLine(taxOnly, null)).toBe(true);
  });

  it('rule 4: the current value is never hidden, even if out of scope', () => {
    expect(allowedForServiceLine(taxOnly, SL_BOOK, 'WITH_CLIENT')).toBe(true);
    expect(allowedForServiceLine(taxOnly, SL_BOOK, 'SOMETHING_ELSE')).toBe(false);
  });
});

describe('filterStatuses', () => {
  const all = [unrestricted, taxOnly, bookOnly];

  it('keeps unrestricted + service-line matches', () => {
    expect(filterStatuses(all, SL_TAX).map((s) => s.workflowState)).toEqual([
      'IN_PROGRESS',
      'WITH_CLIENT',
    ]);
  });

  it('always keeps the current value', () => {
    expect(filterStatuses(all, SL_TAX, 'POSTED').map((s) => s.workflowState)).toEqual([
      'IN_PROGRESS',
      'WITH_CLIENT',
      'POSTED',
    ]);
  });
});

describe('filterStatusesForMany (bulk intersection)', () => {
  const all = [unrestricted, taxOnly, bookOnly];

  it('offers only statuses valid for every selected engagement', () => {
    // One tax + one bookkeeping engagement ⇒ only the unrestricted status.
    expect(filterStatusesForMany(all, [SL_TAX, SL_BOOK]).map((s) => s.workflowState)).toEqual([
      'IN_PROGRESS',
    ]);
  });

  it('offers a service-line status when all selected share it', () => {
    expect(filterStatusesForMany(all, [SL_TAX, SL_TAX]).map((s) => s.workflowState)).toEqual([
      'IN_PROGRESS',
      'WITH_CLIENT',
    ]);
  });

  it('keeps any current value of the selection', () => {
    expect(
      filterStatusesForMany(all, [SL_TAX, SL_BOOK], ['POSTED']).map((s) => s.workflowState),
    ).toEqual(['IN_PROGRESS', 'POSTED']);
  });
});
