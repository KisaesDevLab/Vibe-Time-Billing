// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Money helpers for form inputs. The DB and API store every monetary
// value as an integer in cents (e.g. 75000 = $750.00). Inputs bound to
// `*Cents` columns were showing the raw cents value — users saw 75000
// and had to mentally divide by 100. These helpers translate between
// the cents-as-number storage shape and the dollars-as-string display
// shape used in <input type="text"> / <input type="number"> elements.
//
// Round-trip rules:
//   centsToDollarsInput(75000) === '750.00'
//   centsToDollarsInput(null)  === ''
//   dollarsInputToCents('750.00') === 75000
//   dollarsInputToCents('')    === null
//   dollarsInputToCents('1,200.5') === 120050     (commas + 1-decimal)
//   dollarsInputToCents('abc')  === null          (unparseable)

export function centsToDollarsInput(cents: number | null | undefined): string {
  if (cents == null) return '';
  // Show two decimals so $750 reads as "750.00" — clearer than "750".
  return (cents / 100).toFixed(2);
}

export function dollarsInputToCents(input: string): number | null {
  const trimmed = input.trim().replace(/[,$\s]/g, '');
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  // Round to avoid floating-point drift ($1.10 → 109.99999999 → 110).
  return Math.round(n * 100);
}

/** Display-only formatter for read-only labels (with $ + thousands sep). */
export function formatCents(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// Percentage helpers — same shape as the dollars pair but for rates
// stored as basis points (so 4.25% → 425 bps with no float drift).
//   bpsToPercentInput(425)   === '4.25'
//   percentInputToBps('4.25') === 425
//   percentInputToBps('')     === null
//   percentInputToBps('abc')  === null
export function bpsToPercentInput(bps: number | null | undefined): string {
  if (bps == null || bps === 0) return '';
  const pct = bps / 100;
  return pct.toFixed(pct % 1 === 0 ? 0 : 2);
}

export function percentInputToBps(input: string): number | null {
  const trimmed = input.trim().replace(/[%\s]/g, '');
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}
