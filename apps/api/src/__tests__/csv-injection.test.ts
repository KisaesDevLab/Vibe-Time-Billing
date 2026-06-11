// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CSV formula-injection neutralization: cells that a spreadsheet would
// execute as a formula are forced to literal text.

import { describe, expect, it } from 'vitest';
import { csvField } from '../lib/csv';

describe('csvField — formula injection', () => {
  it("prefixes a leading = + - @ (and tab/CR) with '", () => {
    expect(csvField('=1+1')).toBe("'=1+1");
    expect(csvField('+1')).toBe("'+1");
    expect(csvField('-2')).toBe("'-2");
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvField('\tcmd')).toBe("'\tcmd");
  });

  it('quote-wraps a neutralized cell that also has a comma', () => {
    // =HYPERLINK("http://evil","x") — gets the ' prefix then RFC-4180 quoting.
    const out = csvField('=HYPERLINK("http://evil"),x');
    expect(out.startsWith('"\'=HYPERLINK')).toBe(true);
    expect(out).toContain('""'); // embedded quotes doubled
  });

  it('leaves ordinary values untouched', () => {
    expect(csvField('Acme LLC')).toBe('Acme LLC');
    expect(csvField(1234)).toBe('1234');
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('still escapes embedded quotes/newlines on a plain value', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('he said "hi"')).toBe('"he said ""hi"""');
  });
});
