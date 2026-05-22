// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
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

interface Me {
  appUserId: string;
  firmId: string;
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
      setMe(null);
      setCsrfToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
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
