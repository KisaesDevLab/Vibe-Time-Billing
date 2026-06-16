// SPDX-License-Identifier: Elastic-2.0
import { describe, expect, it } from 'vitest';

import { wrapPlainTextEmail } from './email-template';

describe('wrapPlainTextEmail', () => {
  it('renders the logo when a logoUrl is set', () => {
    const html = wrapPlainTextEmail({
      text: 'Hello',
      branding: { firmName: 'Acme CPA', logoUrl: 'https://app.example/api/portal/branding/logo' },
    });
    expect(html).toContain('<img src="https://app.example/api/portal/branding/logo"');
    expect(html).toContain('alt="Acme CPA"');
  });

  it('falls back to the firm name when no logo', () => {
    const html = wrapPlainTextEmail({ text: 'Hi', branding: { firmName: 'Acme CPA' } });
    expect(html).not.toContain('<img');
    expect(html).toContain('Acme CPA');
  });

  it('escapes HTML and linkifies bare URLs, preserving line breaks', () => {
    const html = wrapPlainTextEmail({
      text: 'Click https://app.example/x to pay.\n<script>alert(1)</script>',
      branding: {},
    });
    expect(html).toContain('<a href="https://app.example/x"');
    expect(html).toContain('&lt;script&gt;'); // escaped, not executable
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('<br>');
  });
});
