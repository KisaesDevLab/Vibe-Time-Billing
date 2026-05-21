// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { api } from './api-client';

import { AppShell, Button, Pill } from '@vibe/ui';

import { AuthProvider, useAuth } from './auth-context';
import { AltContactsPage } from './pages/AltContacts';
import { HomePage } from './pages/Home';
import { PortalInvoicesPage } from './pages/Invoices';
import { LettersPage } from './pages/Letters';
import { LoginPage } from './pages/Login';
import { NotificationPrefsPage } from './pages/NotificationPrefs';
import { PaymentMethodsPage } from './pages/PaymentMethods';
import { StatementPage } from './pages/Statement';
import { SwitchEntityPage } from './pages/Switch';

export function App(): JSX.Element {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/auth/login" element={<LoginPage />} />
        <Route
          path="*"
          element={
            <RequireAuth>
              <Shell>
                <Routes>
                  <Route path="/" element={<HomePage />} />
                  <Route path="/invoices/*" element={<PortalInvoicesPage />} />
                  <Route path="/letters" element={<LettersPage />} />
                  <Route path="/statement" element={<StatementPage />} />
                  <Route path="/payment-methods" element={<PaymentMethodsPage />} />
                  <Route path="/alt-contacts" element={<AltContactsPage />} />
                  <Route path="/switch" element={<SwitchEntityPage />} />
                  <Route path="/notifications" element={<NotificationPrefsPage />} />
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

interface Branding {
  displayName: string | null;
  logoUrl: string | null;
  accentColor: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
}

function Shell({ children }: { children: ReactNode }): JSX.Element {
  const { me, logout } = useAuth();
  const location = useLocation();
  const [branding, setBranding] = useState<Branding | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ branding: Branding | null }>('/api/portal/profile/branding');
        setBranding(r.branding);
      } catch {
        // ignore; branding is optional
      }
    })();
  }, []);

  const brandLabel = branding?.displayName ?? 'Client Portal';

  return (
    <AppShell
      brand={
        branding?.logoUrl ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <img src={branding.logoUrl} alt="" style={{ height: 24, maxWidth: 120 }} />
            <span>{brandLabel}</span>
          </span>
        ) : (
          brandLabel
        )
      }
      realmBadge={<Pill tone="success">portal</Pill>}
      nav={[
        { label: 'Overview', href: '/', active: location.pathname === '/' },
        { label: 'Invoices', href: '/invoices', active: location.pathname.startsWith('/invoices') },
        { label: 'Letters', href: '/letters', active: location.pathname.startsWith('/letters') },
        {
          label: 'Statement',
          href: '/statement',
          active: location.pathname.startsWith('/statement'),
        },
        {
          label: 'Payment methods',
          href: '/payment-methods',
          active: location.pathname.startsWith('/payment-methods'),
        },
        {
          label: 'Contacts',
          href: '/alt-contacts',
          active: location.pathname.startsWith('/alt-contacts'),
        },
        {
          label: 'Switch client',
          href: '/switch',
          active: location.pathname.startsWith('/switch'),
        },
        {
          label: 'Notifications',
          href: '/notifications',
          active: location.pathname.startsWith('/notifications'),
        },
      ]}
      trailing={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {me && (
            <span style={{ fontSize: 12, color: '#8b97a6' }}>
              Client: <code>{me.activeClientId.slice(0, 8)}…</code>
            </span>
          )}
          <Button variant="secondary" size="sm" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
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
