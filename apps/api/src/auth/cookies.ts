// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { parse, serialize } from 'cookie';
import type { Request, Response } from 'express';

import { loadConfig } from '../config';

const SEVEN_DAYS = 7 * 24 * 60 * 60;

export function readSessionCookie(req: Request, realm: 'staff' | 'portal'): string | null {
  const header = req.headers['cookie'];
  if (!header) return null;
  const cookies = parse(header);
  const cfg = loadConfig();
  const name = realm === 'staff' ? cfg.STAFF_COOKIE_NAME : cfg.PORTAL_COOKIE_NAME;
  return cookies[name] ?? null;
}

/**
 * Decide whether to mark a session cookie Secure. We can't just key on
 * NODE_ENV — appliance operators frequently boot the prod image on a
 * LAN behind a tunnel that terminates TLS at the edge, OR test it
 * locally on http://localhost. If we set Secure unconditionally in
 * "production", the browser refuses to send the cookie back over the
 * http leg and sign-in silently breaks.
 *
 * Rules:
 *   - APP_BASE_URL starts with https:// → Secure on (real TLS at edge).
 *   - Otherwise → Secure off (local http://localhost, LAN-only IP).
 *
 * The request itself doesn't tell us reliably — Caddy proxies plain
 * HTTP into the api container even when the user-facing URL is HTTPS.
 * Trusting APP_BASE_URL is the authoritative answer.
 */
function shouldMarkSecure(): boolean {
  const cfg = loadConfig();
  return (cfg.APP_BASE_URL ?? '').toLowerCase().startsWith('https://');
}

export function writeSessionCookie(res: Response, realm: 'staff' | 'portal', sid: string): void {
  const cfg = loadConfig();
  const name = realm === 'staff' ? cfg.STAFF_COOKIE_NAME : cfg.PORTAL_COOKIE_NAME;
  res.append(
    'Set-Cookie',
    serialize(name, sid, {
      httpOnly: true,
      sameSite: 'strict',
      secure: shouldMarkSecure(),
      path: '/',
      maxAge: SEVEN_DAYS,
    }),
  );
}

export function clearSessionCookie(res: Response, realm: 'staff' | 'portal'): void {
  const cfg = loadConfig();
  const name = realm === 'staff' ? cfg.STAFF_COOKIE_NAME : cfg.PORTAL_COOKIE_NAME;
  res.append(
    'Set-Cookie',
    serialize(name, '', {
      httpOnly: true,
      sameSite: 'strict',
      secure: shouldMarkSecure(),
      path: '/',
      maxAge: 0,
    }),
  );
}
