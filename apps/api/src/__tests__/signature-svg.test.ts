// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CP8 — Signature SVG sanitizer. These tests pin the security
// contract: anything outside the allowlisted tag set returns null
// (which the route surfaces as 400).

import { describe, expect, it } from 'vitest';

import { sanitizeSignatureSvg } from '../portal/signature-svg';

describe('sanitizeSignatureSvg', () => {
  it('accepts a clean signature SVG and returns it verbatim', () => {
    const input = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 160"><path d="M 10 10 L 100 100" fill="none" stroke="#111" stroke-width="2.5"/></svg>`;
    const result = sanitizeSignatureSvg(input);
    expect(result).toBe(input);
  });

  it('strips wrapper content outside the <svg>', () => {
    const wrapped = `<!DOCTYPE html><html><body><svg viewBox="0 0 10 10"><path d="M0 0"/></svg></body></html>`;
    const result = sanitizeSignatureSvg(wrapped);
    expect(result).toBe('<svg viewBox="0 0 10 10"><path d="M0 0"/></svg>');
  });

  it('rejects <script> tags', () => {
    const bad = `<svg><script>alert(1)</script><path d="M0 0"/></svg>`;
    expect(sanitizeSignatureSvg(bad)).toBeNull();
  });

  it('rejects <foreignObject>', () => {
    const bad = `<svg><foreignObject><div>x</div></foreignObject></svg>`;
    expect(sanitizeSignatureSvg(bad)).toBeNull();
  });

  it('rejects <image> with href', () => {
    const bad = `<svg><image href="javascript:alert(1)"/></svg>`;
    expect(sanitizeSignatureSvg(bad)).toBeNull();
  });

  it('rejects javascript: URI in any href', () => {
    const bad = `<svg><path href="javascript:alert(1)" d="M0 0"/></svg>`;
    expect(sanitizeSignatureSvg(bad)).toBeNull();
  });

  it('rejects inline event handlers (onclick, onload)', () => {
    const bad = `<svg onload="evil()"><path d="M0 0"/></svg>`;
    expect(sanitizeSignatureSvg(bad)).toBeNull();
  });

  it('rejects empty input', () => {
    expect(sanitizeSignatureSvg('')).toBeNull();
  });

  it('rejects non-SVG content', () => {
    expect(sanitizeSignatureSvg('<div>hello</div>')).toBeNull();
  });

  it('rejects oversize payloads', () => {
    const big = '<svg>' + '<path d="' + 'M0 0 '.repeat(3000) + '"/>'.repeat(1) + '</svg>';
    // big is well over 10 KB
    expect(sanitizeSignatureSvg(big)).toBeNull();
  });

  it('strips HTML comments inside the SVG', () => {
    const input = `<svg><!-- malicious comment with </svg --><path d="M0 0"/></svg>`;
    const result = sanitizeSignatureSvg(input);
    expect(result).not.toBeNull();
    expect(result).not.toContain('<!--');
    expect(result).toContain('<path');
  });

  it('accepts multiple path strokes', () => {
    const input = `<svg viewBox="0 0 100 50"><path d="M0 0 L 50 50"/><path d="M 50 0 L 100 50"/></svg>`;
    const result = sanitizeSignatureSvg(input);
    expect(result).toBe(input);
  });
});
