// SPDX-License-Identifier: Elastic-2.0
//
// Redis-backed session store. Sliding expiration: every read touches the
// TTL. Cookie value is the session id; Redis key is the SHA-256 of the
// id so a database dump alone never yields valid cookies.

import type { Redis } from 'ioredis';

import {
  type AnySession,
  type AuthRealm,
  type StaffSession,
  type PortalSession,
  sessionKey,
} from '@vibe/core/auth';

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export interface SessionStore {
  put(session: AnySession): Promise<void>;
  get(realm: AuthRealm, sid: string): Promise<AnySession | null>;
  touch(realm: AuthRealm, sid: string): Promise<void>;
  destroy(realm: AuthRealm, sid: string): Promise<void>;
  destroyAllForUser(realm: AuthRealm, subjectId: string): Promise<number>;
  /**
   * List all live sessions owned by the given subject. Cleans up
   * the reverse index when individual session rows have expired.
   * CP5 — backs the portal /profile/sessions endpoint.
   */
  listForUser(realm: AuthRealm, subjectId: string): Promise<AnySession[]>;
  /**
   * Destroy every session in the subject's reverse index EXCEPT the
   * one matching `keepSid`. Returns the count of destroyed sessions.
   * CP5 — backs the "Sign out everywhere else" action.
   */
  destroyOthers(realm: AuthRealm, subjectId: string, keepSid: string): Promise<number>;
}

export function createSessionStore(redis: Redis): SessionStore {
  return {
    async put(session) {
      const key = sessionKey(session.realm, session.sid);
      // Don't serialize `sid` into the value — it's already the key derivation input.
      const { sid: _sid, ...rest } = session;
      void _sid;
      await redis.set(key, JSON.stringify(rest), 'EX', SESSION_TTL_SECONDS);
      // Reverse index so we can revoke all sessions for a user (logout-all).
      const subjectId = subjectOf(session);
      await redis.sadd(userIndexKey(session.realm, subjectId), session.sid);
      await redis.expire(userIndexKey(session.realm, subjectId), SESSION_TTL_SECONDS);
    },
    async get(realm, sid) {
      const key = sessionKey(realm, sid);
      const raw = await redis.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Omit<AnySession, 'sid'>;
      return { ...parsed, sid } as AnySession;
    },
    async touch(realm, sid) {
      await redis.expire(sessionKey(realm, sid), SESSION_TTL_SECONDS);
    },
    async destroy(realm, sid) {
      await redis.del(sessionKey(realm, sid));
    },
    async destroyAllForUser(realm, subjectId) {
      const indexKey = userIndexKey(realm, subjectId);
      const sids = await redis.smembers(indexKey);
      if (sids.length === 0) return 0;
      const keys = sids.map((s) => sessionKey(realm, s));
      await redis.del(...keys, indexKey);
      return sids.length;
    },
    async listForUser(realm, subjectId) {
      const indexKey = userIndexKey(realm, subjectId);
      const sids = await redis.smembers(indexKey);
      if (sids.length === 0) return [];
      const sessions: AnySession[] = [];
      const stale: string[] = [];
      for (const sid of sids) {
        const raw = await redis.get(sessionKey(realm, sid));
        if (!raw) {
          stale.push(sid);
          continue;
        }
        const parsed = JSON.parse(raw) as Omit<AnySession, 'sid'>;
        sessions.push({ ...parsed, sid } as AnySession);
      }
      // Best-effort cleanup of expired entries in the reverse index.
      if (stale.length > 0) {
        await redis.srem(indexKey, ...stale).catch(() => undefined);
      }
      return sessions;
    },
    async destroyOthers(realm, subjectId, keepSid) {
      const indexKey = userIndexKey(realm, subjectId);
      const sids = await redis.smembers(indexKey);
      const victims = sids.filter((s) => s !== keepSid);
      if (victims.length === 0) return 0;
      const keys = victims.map((s) => sessionKey(realm, s));
      await redis.del(...keys);
      await redis.srem(indexKey, ...victims).catch(() => undefined);
      return victims.length;
    },
  };
}

function subjectOf(s: AnySession): string {
  return s.realm === 'staff'
    ? (s as StaffSession).appUserId
    : (s as PortalSession).portalIdentityId;
}

function userIndexKey(realm: AuthRealm, subjectId: string): string {
  return `session-index:${realm}:${subjectId}`;
}
