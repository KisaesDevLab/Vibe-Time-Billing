// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Shared money/date display formatting for client-facing invoice,
// statement, payment and notification copy. Keeps the "$1,234.56" and
// "MM/DD/YYYY" conventions consistent across documents and emails/SMS.

/** Format integer cents as "$1,234.56" (USD, thousands separators).
 *  Negatives render as "-$1,234.56" (sign before the symbol); non-finite
 *  input falls back to "$0.00". */
export function formatMoneyCents(c: number): string {
  const n = Number.isFinite(c) ? c : 0;
  const sign = n < 0 ? '-' : '';
  return `${sign}$${(Math.abs(n) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Format an ISO date (YYYY-MM-DD or ISO datetime) as MM/DD/YYYY. */
export function formatDateUS(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
}
