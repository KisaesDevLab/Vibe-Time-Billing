// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, it, expect } from 'vitest';

import { signPayload, verifySignature } from './signing';

describe('webhook signing', () => {
  const secret = 'wh_test_secret_abcdef';
  const payload = JSON.stringify({ event: 'invoice.paid', id: 'inv_1' });

  it('round-trips', () => {
    const header = signPayload({ secret, payload, timestamp: 1_700_000_000 });
    const v = verifySignature({
      secret,
      payload,
      header,
      now: 1_700_000_000 + 60,
    });
    expect(v.ok).toBe(true);
  });

  it('rejects payload tampering', () => {
    const header = signPayload({ secret, payload, timestamp: 1_700_000_000 });
    const v = verifySignature({
      secret,
      payload: payload + 'X',
      header,
      now: 1_700_000_000 + 60,
    });
    expect(v.ok).toBe(false);
  });

  it('rejects stale timestamps (replay protection)', () => {
    const header = signPayload({ secret, payload, timestamp: 1_700_000_000 });
    const v = verifySignature({
      secret,
      payload,
      header,
      now: 1_700_000_000 + 24 * 60 * 60,
    });
    expect(v.ok).toBe(false);
  });

  it('rejects malformed headers', () => {
    const v = verifySignature({ secret, payload, header: 'garbage', now: 1_700_000_000 });
    expect(v.ok).toBe(false);
  });
});
