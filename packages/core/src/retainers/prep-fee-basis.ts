// SPDX-License-Identifier: Elastic-2.0
//
// R1 — Prep-fee basis math (D11 + D21).
//
// Sum the amount_cents of every invoice line whose work_code_id is in
// the firm's prep_fee_work_code_ids set. Returns 0 when no line matches
// — that triggers D21 (suppress offer when basis is zero).

export interface InvoiceLineForBasis {
  workCodeId: string | null;
  amountCents: number;
}

export function computePrepFeeBasis(
  lines: ReadonlyArray<InvoiceLineForBasis>,
  prepFeeWorkCodeIds: ReadonlyArray<string>,
): number {
  if (prepFeeWorkCodeIds.length === 0) return 0;
  const set = new Set(prepFeeWorkCodeIds);
  let total = 0;
  for (const line of lines) {
    if (line.workCodeId && set.has(line.workCodeId)) {
      total += line.amountCents;
    }
  }
  return total;
}
