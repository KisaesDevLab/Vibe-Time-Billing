// SPDX-License-Identifier: Elastic-2.0
import { describe, it, expect } from 'vitest';

import { issueMagicLink, verifyMagicLink, randomNonce } from './magic-link';

const staffKey = new TextEncoder().encode('a'.repeat(48));
const portalKey = new TextEncoder().encode('b'.repeat(48));

describe('magic-link', () => {
  it('round-trips a staff token', async () => {
    const nonce = randomNonce();
    const token = await issueMagicLink({
      subjectId: 'user-1',
      firmId: 'firm-1',
      realm: 'staff',
      signingKey: staffKey,
      ttlSeconds: 900,
      nonce,
    });
    const payload = await verifyMagicLink({ token, realm: 'staff', signingKey: staffKey });
    expect(payload.sub).toBe('user-1');
    expect(payload.fid).toBe('firm-1');
    expect(payload.rlm).toBe('staff');
    expect(payload.nce).toBe(nonce);
  });

  it('rejects a staff token when verified with the portal key (cross-realm isolation)', async () => {
    const token = await issueMagicLink({
      subjectId: 'user-1',
      firmId: 'firm-1',
      realm: 'staff',
      signingKey: staffKey,
      ttlSeconds: 900,
      nonce: randomNonce(),
    });
    await expect(
      verifyMagicLink({ token, realm: 'portal', signingKey: portalKey }),
    ).rejects.toThrow();
  });

  it('rejects a staff token when verifying with realm=portal even with same key', async () => {
    const token = await issueMagicLink({
      subjectId: 'user-1',
      firmId: 'firm-1',
      realm: 'staff',
      signingKey: staffKey,
      ttlSeconds: 900,
      nonce: randomNonce(),
    });
    await expect(
      verifyMagicLink({ token, realm: 'portal', signingKey: staffKey }),
    ).rejects.toThrow();
  });

  it('rejects expired tokens', async () => {
    const token = await issueMagicLink({
      subjectId: 'user-1',
      firmId: 'firm-1',
      realm: 'staff',
      signingKey: staffKey,
      ttlSeconds: -10,
      nonce: randomNonce(),
    });
    await expect(
      verifyMagicLink({ token, realm: 'staff', signingKey: staffKey }),
    ).rejects.toThrow();
  });

  it('produces unique nonces', () => {
    const set = new Set(Array.from({ length: 200 }, () => randomNonce()));
    expect(set.size).toBe(200);
  });
});
