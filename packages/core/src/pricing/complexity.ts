// SPDX-License-Identifier: Elastic-2.0
//
// Complexity dimension for the cohort key, computed from the tax-return
// form/schedule/K-1 count (data already captured). A manual override tag wins
// when present. Tax-prep only; non-tax engagements use 'NA' (type-only cohort).

export type ComplexityBucket = 'SIMPLE' | 'MODERATE' | 'COMPLEX' | 'NA';

const OVERRIDES = new Set(['SIMPLE', 'MODERATE', 'COMPLEX']);

/**
 * Bucket by section count. Thresholds (deterministic, documented):
 *   ≤3 sections → SIMPLE, 4–8 → MODERATE, ≥9 → COMPLEX.
 * A manual override (if one of the three buckets) takes precedence.
 */
export function complexityBucket(
  sectionCount: number,
  manualOverride?: string | null,
): ComplexityBucket {
  if (manualOverride && OVERRIDES.has(manualOverride)) return manualOverride as ComplexityBucket;
  if (sectionCount <= 0) return 'NA';
  if (sectionCount <= 3) return 'SIMPLE';
  if (sectionCount <= 8) return 'MODERATE';
  return 'COMPLEX';
}
