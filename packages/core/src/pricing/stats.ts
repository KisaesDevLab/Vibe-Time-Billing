// SPDX-License-Identifier: Elastic-2.0
//
// Pure statistics for normalizing cohort hours. We use a normalized figure
// (median / trimmed mean) rather than raw actuals so overruns aren't rewarded.

export type HoursStatistic = 'TRIMMED_MEAN' | 'MEDIAN';

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Mean after dropping the top/bottom `trim` fraction (default 10%) each side. */
export function trimmedMean(xs: number[], trim = 0.1): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const k = Math.floor(s.length * trim);
  const kept = s.length - 2 * k > 0 ? s.slice(k, s.length - k) : s;
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

export function expectedHours(xs: number[], statistic: HoursStatistic): number {
  return statistic === 'MEDIAN' ? median(xs) : trimmedMean(xs);
}
