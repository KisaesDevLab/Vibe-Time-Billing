// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { AppShell, Button, Pill } from '@vibe/ui';

import { AccountPage } from './pages/Account';
import { AuthProvider, useAuth } from './auth-context';
import { DashboardPage } from './pages/Dashboard';
import { LoginPage } from './pages/Login';
import { TotpEnrollPage } from './pages/TotpEnroll';

export function App(): JSX.Element {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/auth/login" element={<LoginPage />} />
        <Route
          path="/auth/totp"
          element={
            <RequireAuth>
              <TotpEnrollPage />
            </RequireAuth>
          }
        />
        <Route
          path="*"
          element={
            <RequireAuth>
              <Shell>
                <Routes>
                  <Route path="/" element={<DashboardPage />} />
                  <Route path="/account" element={<AccountPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Shell>
            </RequireAuth>
          }
        />
      </Routes>
    </AuthProvider>
  );
}

function RequireAuth({ children }: { children: JSX.Element }): JSX.Element {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <FullPageMsg>Loading…</FullPageMsg>;
  if (!me) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/auth/login?next=${next}`} replace />;
  }
  return children;
}

function Shell({ children }: { children: ReactNode }): JSX.Element {
  const { logout } = useAuth();
  const location = useLocation();
  return (
    <AppShell
      brand="Vibe Time & Billing"
      realmBadge={<Pill tone="accent">staff</Pill>}
      nav={[
        { label: 'Dashboard', href: '/', active: location.pathname === '/' },
        { label: 'Clients', href: '/clients', active: location.pathname.startsWith('/clients') },
        { label: 'Time', href: '/time', active: location.pathname.startsWith('/time') },
        { label: 'Billing', href: '/billing', active: location.pathname.startsWith('/billing') },
        { label: 'Reports', href: '/reports', active: location.pathname.startsWith('/reports') },
        { label: 'Admin', href: '/admin', active: location.pathname.startsWith('/admin') },
        { label: 'Account', href: '/account', active: location.pathname.startsWith('/account') },
      ]}
      trailing={
        <Button variant="secondary" size="sm" onClick={() => void logout()}>
          Sign out
        </Button>
      }
    >
      {children}
    </AppShell>
  );
}

function FullPageMsg({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#8b97a6',
        fontFamily: '-apple-system, system-ui, sans-serif',
      }}
    >
      {children}
    </div>
  );
}
