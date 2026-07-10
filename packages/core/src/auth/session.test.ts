// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, it, expect } from 'vitest';

import {
  generateSessionId,
  generateCsrfToken,
  sessionKey,
  isStepUpFresh,
  type StaffSession,
} from './session';

describe('session helpers', () => {
  it('generates 64-char hex session ids that are unique', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSessionId()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates 48-char hex CSRF tokens', () => {
    expect(generateCsrfToken()).toMatch(/^[0-9a-f]{48}$/);
  });

  it('hashes session ids when computing the Redis key', () => {
    const sid = 'a'.repeat(64);
    const key = sessionKey('staff', sid);
    expect(key).toMatch(/^session:staff:[0-9a-f]{64}$/);
    expect(key).not.toContain(sid);
  });

  it('uses realm-specific key prefixes', () => {
    const sid = generateSessionId();
    expect(sessionKey('staff', sid)).not.toBe(sessionKey('portal', sid));
  });

  it('flags step-up as stale once timeout elapses', () => {
    const base: StaffSession = {
      realm: 'staff',
      sid: 'sid',
      appUserId: 'u',
      firmId: 'f',
      createdAt: 0,
      lastSeenAt: 0,
      lastStepUpAt: 0,
      csrfToken: 'csrf',
      ip: null,
      userAgent: null,
    };
    expect(isStepUpFresh({ ...base, lastStepUpAt: 10_000 }, 1, 50_000)).toBe(true);
    expect(isStepUpFresh({ ...base, lastStepUpAt: 10_000 }, 1, 90_000)).toBe(false);
    expect(isStepUpFresh({ ...base, lastStepUpAt: null }, 30, Date.now())).toBe(false);
  });
});
