// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { complexityBucket } from './complexity';
import { expectedHours, median, trimmedMean } from './stats';

describe('pricing stats', () => {
  it('median of odd/even sets', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it('trimmed mean drops outliers', () => {
    // 100 is an outlier; with 10 values, trim=0.1 drops 1 each side.
    expect(trimmedMean([5, 5, 5, 5, 5, 5, 5, 5, 5, 100])).toBe(5);
    // too few to trim → plain mean
    expect(trimmedMean([2, 4])).toBe(3);
  });

  it('expectedHours dispatches on the statistic', () => {
    const xs = [10, 12, 14, 16, 1000];
    expect(expectedHours(xs, 'MEDIAN')).toBe(14);
    expect(expectedHours(xs, 'TRIMMED_MEAN')).not.toBe(median(xs));
  });
});

describe('complexity bucket', () => {
  it('buckets by section count', () => {
    expect(complexityBucket(0)).toBe('NA');
    expect(complexityBucket(3)).toBe('SIMPLE');
    expect(complexityBucket(8)).toBe('MODERATE');
    expect(complexityBucket(20)).toBe('COMPLEX');
  });
  it('honors a valid manual override', () => {
    expect(complexityBucket(20, 'SIMPLE')).toBe('SIMPLE');
    expect(complexityBucket(1, 'bogus')).toBe('SIMPLE'); // override ignored, falls to count
  });
});
