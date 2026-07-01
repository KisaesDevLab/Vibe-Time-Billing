// SPDX-License-Identifier: Elastic-2.0
import { describe, expect, it } from 'vitest';

import { pdfPageOptions } from './render';

describe('pdfPageOptions', () => {
  it('defaults to Letter + 0.5in margins (unchanged for existing callers)', () => {
    expect(pdfPageOptions({})).toEqual({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
    });
  });

  it('merges an explicit margin override per-side over the 0.5in default', () => {
    expect(pdfPageOptions({ margin: { top: '1in', bottom: '1in' } })).toEqual({
      format: 'Letter',
      printBackground: true,
      // top/bottom overridden; left/right keep the 0.5in default.
      margin: { top: '1in', right: '0.5in', bottom: '1in', left: '0.5in' },
    });
  });

  it('applies a full 1in margin (mail-merge letters)', () => {
    expect(
      pdfPageOptions({ margin: { top: '1in', right: '1in', bottom: '1in', left: '1in' } }).margin,
    ).toEqual({ top: '1in', right: '1in', bottom: '1in', left: '1in' });
  });
});
