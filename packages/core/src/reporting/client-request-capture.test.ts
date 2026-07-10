// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { clientRequestBillableCaptureRate } from './client-request-capture';

describe('clientRequestBillableCaptureRate (G.9)', () => {
  it('returns 0 capture rate when no requests fulfilled', () => {
    const r = clientRequestBillableCaptureRate([
      { fulfilled: false, hasLinkedTimeEntry: false },
      { fulfilled: false, hasLinkedTimeEntry: true },
    ]);
    expect(r).toEqual({ fulfilledCount: 0, capturedCount: 0, captureRate: 0 });
  });

  it('ignores unfulfilled rows in the denominator', () => {
    const r = clientRequestBillableCaptureRate([
      { fulfilled: true, hasLinkedTimeEntry: true },
      { fulfilled: true, hasLinkedTimeEntry: false },
      { fulfilled: false, hasLinkedTimeEntry: true }, // ignored
    ]);
    expect(r.fulfilledCount).toBe(2);
    expect(r.capturedCount).toBe(1);
    expect(r.captureRate).toBe(0.5);
  });

  it('reports 100% capture when every fulfilled row has a link', () => {
    const r = clientRequestBillableCaptureRate([
      { fulfilled: true, hasLinkedTimeEntry: true },
      { fulfilled: true, hasLinkedTimeEntry: true },
      { fulfilled: true, hasLinkedTimeEntry: true },
    ]);
    expect(r.captureRate).toBe(1);
  });

  it('reports 0% capture when nothing was linked', () => {
    const r = clientRequestBillableCaptureRate([
      { fulfilled: true, hasLinkedTimeEntry: false },
      { fulfilled: true, hasLinkedTimeEntry: false },
    ]);
    expect(r.captureRate).toBe(0);
  });
});
