// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P6.1 — Connect addendum G.9 — client request billable capture rate.
//
// Measure: of all client requests that reached state=FULFILLED in a
// period, how many had a time entry linked at the time of fulfillment
// (or within the suggestion window)?
//
// A "high" capture rate means the firm is consistently turning client
// communication into billable work. A "low" rate means the firm is
// either fulfilling requests without logging the time, or the
// suggestion sweep is dismissing rows before staff act on them.

export interface RequestCaptureInputRow {
  /** True iff the request landed in FULFILLED status. */
  fulfilled: boolean;
  /** True iff a `time_entry_message_link` row exists for this request. */
  hasLinkedTimeEntry: boolean;
}

export interface RequestCaptureMeasure {
  fulfilledCount: number;
  capturedCount: number;
  captureRate: number; // 0..1; NaN-safe — 0 when fulfilledCount === 0
}

export function clientRequestBillableCaptureRate(
  rows: ReadonlyArray<RequestCaptureInputRow>,
): RequestCaptureMeasure {
  let fulfilled = 0;
  let captured = 0;
  for (const r of rows) {
    if (!r.fulfilled) continue;
    fulfilled += 1;
    if (r.hasLinkedTimeEntry) captured += 1;
  }
  return {
    fulfilledCount: fulfilled,
    capturedCount: captured,
    captureRate: fulfilled === 0 ? 0 : captured / fulfilled,
  };
}
