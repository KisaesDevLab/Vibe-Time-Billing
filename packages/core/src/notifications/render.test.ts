// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { buildFirmScope, renderNotification } from './render';

describe('renderNotification', () => {
  const fallback = { subject: 'Hi {{ client.name }}', body: 'From {{ firm.name }}.' };

  it('uses the fallback when no override', () => {
    const r = renderNotification({
      override: null,
      fallback,
      context: { client: { name: 'Acme' }, firm: { name: 'Books LLC' } },
    });
    expect(r.subject).toBe('Hi Acme');
    expect(r.body).toBe('From Books LLC.');
  });

  it('prefers an enabled override and keeps the fallback subject when override has none', () => {
    const r = renderNotification({
      override: { subject: null, body: 'Custom {{ firm.name }}' },
      fallback,
      context: { client: { name: 'Acme' }, firm: { name: 'Books LLC' } },
    });
    expect(r.subject).toBe('Hi Acme'); // fell back
    expect(r.body).toBe('Custom Books LLC');
  });

  it('blanks unknown tokens and collapses the empty lines they leave', () => {
    const r = renderNotification({
      override: null,
      fallback: { body: 'Line 1\n\n{{ missing.token }}\n\nLine 2' },
      context: {},
    });
    expect(r.body).toBe('Line 1\n\nLine 2');
  });
});

describe('buildFirmScope', () => {
  it('exposes the logo + support details under both naming conventions', () => {
    const f = buildFirmScope({
      name: 'Books LLC',
      displayName: 'Books',
      logoUrl: 'https://x/logo.png',
      supportEmail: 'help@books.com',
      supportPhone: '+13125550148',
    });
    expect(f.logo_url).toBe('https://x/logo.png');
    expect(f.logoUrl).toBe('https://x/logo.png');
    expect(f.displayName).toBe('Books');
    expect(f.support_email).toBe('help@books.com');
    expect(f.supportEmail).toBe('help@books.com');
    expect(f.email).toBe('help@books.com');
    expect(f.phone).toBe('+13125550148');
    expect(f.name).toBe('Books LLC');
  });

  it('falls back displayName to the legal name and tolerates missing fields', () => {
    const f = buildFirmScope({ name: 'Solo CPA' });
    expect(f.displayName).toBe('Solo CPA');
    expect(f.logo_url).toBe('');
    expect(f.support_email).toBe('');
  });
});
