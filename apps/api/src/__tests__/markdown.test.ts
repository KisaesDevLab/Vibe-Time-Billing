// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The shared Markdown→HTML helper used for ad-hoc client emails.

import { describe, expect, it } from 'vitest';

import { markdownToHtml, escapeHtml } from '../lib/markdown';

describe('markdownToHtml', () => {
  it('renders headings, bold/italic, links, lists, and paragraphs', () => {
    const html = markdownToHtml(
      ['# Hi', '', 'Some **bold** and *italic* text.', '', '- one', '- two'].join('\n'),
    );
    expect(html).toContain('<h1>Hi</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<p>Some');
  });

  it('renders links and an ordered list', () => {
    const html = markdownToHtml('See [our site](https://example.com)\n\n1. first\n2. second');
    expect(html).toContain('<a href="https://example.com">our site</a>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>first</li>');
  });

  it('escapes HTML so input cannot inject markup', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    const html = markdownToHtml('plain <b>x</b> & "q"');
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>x</b>');
  });
});
