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
  portalIdentityId: string;
  firmId: string;
  activeClientId: string;
  csrfToken: string;
  // TR-5 — staff "view as client" session. When true, the SPA renders
  // a banner naming the staff impersonator and the API rejects writes.
  isImpersonation?: boolean;
  impersonatedByEmail?: string | null;
}

interface AuthContextValue {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  switchClient: (clientId: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api<Me>('/api/portal/auth/me');
      setMe(data);
      setCsrfToken(data.csrfToken);
    } catch {
      setMe(null);
      setCsrfToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const switchClient = useCallback(
    async (clientId: string) => {
      await api('/api/portal/auth/switch-client', {
        method: 'POST',
        body: JSON.stringify({ clientId }),
      });
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    try {
      await api('/api/portal/auth/logout', { method: 'POST' });
    } finally {
      setMe(null);
      setCsrfToken(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ me, loading, refresh, switchClient, logout }),
    [me, loading, refresh, switchClient, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
