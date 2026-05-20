// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
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

export function writeSessionCookie(res: Response, realm: 'staff' | 'portal', sid: string): void {
  const cfg = loadConfig();
  const name = realm === 'staff' ? cfg.STAFF_COOKIE_NAME : cfg.PORTAL_COOKIE_NAME;
  res.append(
    'Set-Cookie',
    serialize(name, sid, {
      httpOnly: true,
      sameSite: 'strict',
      secure: cfg.NODE_ENV === 'production',
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
      secure: cfg.NODE_ENV === 'production',
      path: '/',
      maxAge: 0,
    }),
  );
}
