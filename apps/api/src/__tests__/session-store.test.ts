// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CP5 — Coverage for the new session-store methods backing the
// portal /profile/sessions endpoints.

import { createHash } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';

import { createSessionStore } from '../auth/session-store';
import type { PortalSession } from '@vibe/core/auth';

let redis: Redis;

beforeEach(async () => {
  // ioredis-mock shares data across instances by default.
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
});

function mkPortalSession(overrides: Partial<PortalSession> = {}): PortalSession {
  return {
    realm: 'portal',
    sid: `sid_${Math.random().toString(36).slice(2)}`,
    portalIdentityId: 'identity-a',
    firmId: 'firm-1',
    activeClientId: 'client-1',
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    csrfToken: 'csrf-x',
    ip: '10.0.0.1',
    userAgent: 'TestBrowser/1.0',
    ...overrides,
  };
}

describe('SessionStore.listForUser', () => {
  it('returns empty when subject has no sessions', async () => {
    const store = createSessionStore(redis);
    const result = await store.listForUser('portal', 'no-such-identity');
    expect(result).toEqual([]);
  });

  it('returns every live session owned by the subject', async () => {
    const store = createSessionStore(redis);
    const s1 = mkPortalSession({ ip: '10.0.0.1', userAgent: 'A' });
    const s2 = mkPortalSession({ ip: '10.0.0.2', userAgent: 'B' });
    await store.put(s1);
    await store.put(s2);
    const result = await store.listForUser('portal', 'identity-a');
    expect(result).toHaveLength(2);
    const sids = result.map((r) => r.sid).sort();
    expect(sids).toEqual([s1.sid, s2.sid].sort());
  });

  it('does NOT include sessions from a different identity', async () => {
    const store = createSessionStore(redis);
    await store.put(mkPortalSession({ portalIdentityId: 'identity-a' }));
    await store.put(mkPortalSession({ portalIdentityId: 'identity-b' }));
    const result = await store.listForUser('portal', 'identity-a');
    expect(result).toHaveLength(1);
    expect(result[0]!.portalIdentityId).toBe('identity-a');
  });

  it('cleans up stale sids from the reverse index when sessions have expired', async () => {
    const store = createSessionStore(redis);
    const s = mkPortalSession();
    await store.put(s);
    // Simulate expiration: delete the session key but leave the index entry.
    await redis.del(`session:portal:${createHash('sha256').update(s.sid).digest('hex')}`);
    // listForUser should skip the stale sid and not throw.
    const result = await store.listForUser('portal', 'identity-a');
    expect(result).toHaveLength(0);
    // Reverse index entry should be cleaned up too.
    const indexMembers = await redis.smembers('session-index:portal:identity-a');
    expect(indexMembers).not.toContain(s.sid);
  });
});

describe('SessionStore.destroyOthers', () => {
  it('removes every session EXCEPT the kept one', async () => {
    const store = createSessionStore(redis);
    const s1 = mkPortalSession();
    const s2 = mkPortalSession();
    const s3 = mkPortalSession();
    await store.put(s1);
    await store.put(s2);
    await store.put(s3);
    const destroyed = await store.destroyOthers('portal', 'identity-a', s2.sid);
    expect(destroyed).toBe(2);
    const after = await store.listForUser('portal', 'identity-a');
    expect(after).toHaveLength(1);
    expect(after[0]!.sid).toBe(s2.sid);
  });

  it('returns 0 when only the keepSid exists', async () => {
    const store = createSessionStore(redis);
    const s = mkPortalSession();
    await store.put(s);
    const destroyed = await store.destroyOthers('portal', 'identity-a', s.sid);
    expect(destroyed).toBe(0);
  });

  it('does not touch sessions from a different identity', async () => {
    const store = createSessionStore(redis);
    const sA = mkPortalSession({ portalIdentityId: 'identity-a' });
    const sB = mkPortalSession({ portalIdentityId: 'identity-b' });
    await store.put(sA);
    await store.put(sB);
    await store.destroyOthers('portal', 'identity-a', 'no-such-sid');
    const stillThere = await store.listForUser('portal', 'identity-b');
    expect(stillThere).toHaveLength(1);
  });
});
