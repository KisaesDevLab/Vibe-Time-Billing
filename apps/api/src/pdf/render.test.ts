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

  it('honors an explicit margin override', () => {
    expect(pdfPageOptions({ margin: { top: '1in', bottom: '1in' } })).toEqual({
      format: 'Letter',
      printBackground: true,
      margin: { top: '1in', bottom: '1in' },
    });
  });

  it('omits format+margin when preferCSSPageSize is set (CSS @page controls the page)', () => {
    expect(pdfPageOptions({ preferCSSPageSize: true })).toEqual({
      printBackground: true,
      preferCSSPageSize: true,
    });
    // margin is ignored in this mode.
    expect(pdfPageOptions({ preferCSSPageSize: true, margin: { top: '2in' } })).not.toHaveProperty(
      'margin',
    );
  });
});
