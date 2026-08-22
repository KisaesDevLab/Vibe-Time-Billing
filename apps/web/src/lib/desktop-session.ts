// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-3 — "remember this device" for the desktop shell. The refresh
// credential lives in the OS credential store (Windows Credential Manager
// via the shell's `secret_*` commands), never in web storage. See
// apps/api/src/auth/desktop-devices.ts for the server half.

import { api, setCsrfToken } from '../api-client';
import { deviceInfo, isDesktop, secretDelete, secretGet, secretSet } from './desktop';

const SECRET_KEY = 'desktop-refresh-token';

interface RefreshResponse {
  ok: true;
  csrfToken: string;
  refreshToken: string;
  expiresAt: string;
}

/**
 * Try to mint a cookie session from the stored device credential. Returns
 * true when a session now exists. Safe to call in the browser (no-op).
 */
export async function tryDesktopSessionRefresh(): Promise<boolean> {
  if (!isDesktop()) return false;
  let token: string | null = null;
  try {
    token = await secretGet(SECRET_KEY);
  } catch {
    return false;
  }
  if (!token) return false;
  try {
    const info = await deviceInfo();
    const r = await api<RefreshResponse>('/api/auth/desktop/refresh', {
      method: 'POST',
      body: JSON.stringify({ deviceId: info.deviceId, refreshToken: token }),
    });
    // Rotated — persist the replacement before anything else can fail.
    await secretSet(SECRET_KEY, r.refreshToken);
    setCsrfToken(r.csrfToken);
    return true;
  } catch (err) {
    const status = (err as { status?: number }).status;
    // 401 = revoked/rotated elsewhere: drop the dead credential so we stop
    // retrying on every launch. Anything else (offline) keeps it.
    if (status === 401) await secretDelete(SECRET_KEY).catch(() => undefined);
    return false;
  }
}

/** Enroll this device for the signed-in user (idempotent per device). */
export async function enrollDesktopDevice(): Promise<boolean> {
  if (!isDesktop()) return false;
  try {
    const info = await deviceInfo();
    const r = await api<{ refreshToken: string }>('/api/auth/desktop/enroll', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: info.deviceId,
        deviceName: `${info.hostname} (${info.os})`.slice(0, 120),
      }),
    });
    await secretSet(SECRET_KEY, r.refreshToken);
    return true;
  } catch {
    return false;
  }
}

export async function hasDesktopCredential(): Promise<boolean> {
  if (!isDesktop()) return false;
  try {
    return !!(await secretGet(SECRET_KEY));
  } catch {
    return false;
  }
}

/** Forget the local credential (the server-side record is revoked via
 *  DELETE /api/staff/desktop/devices/:id from Account → Desktop). */
export async function forgetDesktopCredential(): Promise<void> {
  if (!isDesktop()) return;
  await secretDelete(SECRET_KEY).catch(() => undefined);
}
