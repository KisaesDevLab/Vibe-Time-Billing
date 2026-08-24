// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { api, setCsrfToken } from './api-client';
import { isDesktop } from './lib/desktop';
import {
  enrollDesktopDevice,
  forgetDesktopCredential,
  hasDesktopCredential,
  tryDesktopSessionRefresh,
} from './lib/desktop-session';
import { getDesktopSettings } from './lib/desktop-settings';

interface Me {
  appUserId: string;
  firmId: string;
  fullName?: string | null;
  email?: string | null;
  lastStepUpAt: number | null;
  csrfToken: string;
  /** Effective permission keys for this user. Loaded once per session
   *  by `/api/auth/me` so usePermission() is a cheap synchronous check. */
  permissions: string[];
}

interface AuthContextValue {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api<Me>('/api/auth/me');
      setMe(data);
      setCsrfToken(data.csrfToken);
    } catch {
      // DS-3 — inside the desktop shell a remembered device can mint a
      // fresh session before we give up and show the login page.
      if (
        isDesktop() &&
        getDesktopSettings().rememberDevice &&
        (await tryDesktopSessionRefresh())
      ) {
        try {
          const data = await api<Me>('/api/auth/me');
          setMe(data);
          setCsrfToken(data.csrfToken);
          return;
        } catch {
          /* fall through */
        }
      }
      setMe(null);
      setCsrfToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // DS-3 — once signed in inside the shell, remember this device (unless
  // the user turned that off in Account → Desktop). Idempotent per device.
  useEffect(() => {
    if (!me || !isDesktop() || !getDesktopSettings().rememberDevice) return;
    void hasDesktopCredential().then((has) => {
      if (!has) void enrollDesktopDevice();
    });
  }, [me]);

  const logout = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      // Explicit sign-out also forgets the device credential; otherwise the
      // next launch would silently sign back in.
      await forgetDesktopCredential();
      setMe(null);
      setCsrfToken(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(() => ({ me, loading, refresh, logout }), [me, loading, refresh, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/**
 * Returns true when the current session holds the named permission.
 * Used to drive disabled-with-tooltip on storage actions per the
 * addendum's "discover what they can't do" UX rule. While `loading`
 * is true (initial `/me` fetch), the result is `false` so a momentary
 * flash doesn't expose actions to an unauthenticated UI.
 */
export function usePermission(code: string): boolean {
  const { me } = useAuth();
  return !!me?.permissions?.includes(code);
}
