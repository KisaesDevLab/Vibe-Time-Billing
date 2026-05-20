// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Session record shape and key helpers.
//
// Sessions live in Redis. Cookie value is the session id (an opaque
// 32-byte hex token). The session record holds subject id, firm id,
// step-up timestamp, and the realm. Sliding expiration is enforced by
// touching the TTL on each authenticated request.

import { randomBytes, createHash } from 'node:crypto';

import type { AuthRealm } from './magic-link';

export interface StaffSession {
  realm: 'staff';
  sid: string; // session id (the cookie value, unhashed — never stored)
  appUserId: string;
  firmId: string;
  createdAt: number;
  lastSeenAt: number;
  lastStepUpAt: number | null;
  csrfToken: string;
  ip: string | null;
  userAgent: string | null;
}

export interface PortalSession {
  realm: 'portal';
  sid: string;
  portalIdentityId: string;
  firmId: string;
  activeClientId: string;
  createdAt: number;
  lastSeenAt: number;
  csrfToken: string;
  ip: string | null;
  userAgent: string | null;
}

export type AnySession = StaffSession | PortalSession;

export function generateSessionId(): string {
  return randomBytes(32).toString('hex');
}

export function generateCsrfToken(): string {
  return randomBytes(24).toString('hex');
}

/** Sessions are keyed by HASH of the id, never by the raw id. */
export function sessionKey(realm: AuthRealm, sid: string): string {
  const hash = createHash('sha256').update(sid).digest('hex');
  return `session:${realm}:${hash}`;
}

export function isStepUpFresh(
  session: StaffSession,
  timeoutMinutes: number,
  now = Date.now(),
): boolean {
  if (session.lastStepUpAt == null) return false;
  return now - session.lastStepUpAt < timeoutMinutes * 60_000;
}
