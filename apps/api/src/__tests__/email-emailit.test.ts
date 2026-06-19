// SPDX-License-Identifier: Elastic-2.0
//
// EmailIt provider is wired through the config schema, masking, and factory.

import { describe, expect, it } from 'vitest';
import { pino } from 'pino';

import { EmailConfig, maskEmailConfig } from '../messaging/config';
import { buildMailProvider } from '../messaging/factory';

describe('EmailIt email provider', () => {
  it('parses, masks (no secret echoed), and builds a provider', () => {
    const parsed = EmailConfig.parse({
      provider: 'emailit',
      from: 'billing@firm.example',
      apiKey: 'secret-key-1234',
    });
    expect(parsed.provider).toBe('emailit');

    const masked = maskEmailConfig(parsed);
    expect(masked.provider).toBe('emailit');
    expect(masked.apiKeyMasked).not.toContain('secret-key-1234');
    expect((masked as { apiKey?: string }).apiKey).toBeUndefined();

    const provider = buildMailProvider(parsed, pino({ enabled: false }));
    expect(provider.id).toBe('emailit');
  });

  it('rejects an emailit config missing the apiKey', () => {
    const r = EmailConfig.safeParse({ provider: 'emailit', from: 'a@b.example' });
    expect(r.success).toBe(false);
  });
});
