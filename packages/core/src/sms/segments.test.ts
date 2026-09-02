// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { countSmsSegments, isGsm7 } from './segments';

describe('countSmsSegments', () => {
  it('empty text is zero segments', () => {
    expect(countSmsSegments('')).toEqual({
      encoding: 'GSM-7',
      units: 0,
      segments: 0,
      perSegment: 160,
      remaining: 160,
    });
  });
  it('160 GSM-7 chars fit one segment; 161 spill to two (153 each)', () => {
    expect(countSmsSegments('a'.repeat(160))).toMatchObject({
      units: 160,
      segments: 1,
      remaining: 0,
    });
    expect(countSmsSegments('a'.repeat(161))).toMatchObject({
      units: 161,
      segments: 2,
      perSegment: 153,
      remaining: 145,
    });
  });
  it('GSM-7 extension characters count twice', () => {
    expect(countSmsSegments('€').units).toBe(2);
    expect(countSmsSegments('a{b}').units).toBe(6);
    expect(isGsm7('[ok] ~ €')).toBe(true);
  });
  it('a single emoji forces UCS-2 with 70/67 limits', () => {
    const r = countSmsSegments('hi 😀');
    expect(r.encoding).toBe('UCS-2');
    expect(r.units).toBe(5); // emoji = 2 UTF-16 units
    expect(r.segments).toBe(1);
    expect(countSmsSegments('é'.repeat(70)).encoding).toBe('GSM-7');
    expect(countSmsSegments('ą'.repeat(70)).segments).toBe(1);
    expect(countSmsSegments('ą'.repeat(71)).segments).toBe(2);
  });
});
