// SPDX-License-Identifier: Elastic-2.0
//
// The mail-branding wrapper: a plain-text email gets a branded HTML body; an
// email that already carries HTML is passed through untouched.

import { describe, expect, it } from 'vitest';

import { wrapMailWithBranding } from '../notifications/branding-mail';
import type { MailMessage, MailProvider } from '../mail/provider';

function captureProvider(): { provider: MailProvider; sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  const provider: MailProvider = {
    id: 'console',
    async send(msg) {
      sent.push(msg);
      return { ok: true };
    },
  };
  return { provider, sent };
}

describe('wrapMailWithBranding', () => {
  it('adds a branded HTML body to a plain-text email', async () => {
    const { provider, sent } = captureProvider();
    const mailer = wrapMailWithBranding(provider, { db: null });
    await mailer.send({ to: 'c@x.example', subject: 'Hi', body: 'Your invoice is ready.' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toBeTruthy();
    expect(sent[0]!.html).toContain('Your invoice is ready.');
    expect(sent[0]!.body).toBe('Your invoice is ready.'); // text preserved
  });

  it('leaves an email that already has HTML untouched', async () => {
    const { provider, sent } = captureProvider();
    const mailer = wrapMailWithBranding(provider, { db: null });
    await mailer.send({ to: 'c@x.example', subject: 'Hi', body: 'text', html: '<p>custom</p>' });
    expect(sent[0]!.html).toBe('<p>custom</p>');
  });
});
