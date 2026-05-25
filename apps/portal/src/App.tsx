// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { api } from './api-client';

import { AppShell, Button, FontSizeControl, Pill, ThemeToggle, tokens } from '@vibe/ui';

import { AuthProvider, useAuth } from './auth-context';
import { StepUpModal } from './components/StepUpModal';
import { AltContactsPage } from './pages/AltContacts';
import { FilesPage } from './pages/Files';
import { HomePage } from './pages/Home';
import { PortalInvoicesPage } from './pages/Invoices';
import { LettersPage } from './pages/Letters';
import { LoginPage } from './pages/Login';
import { MessagesPage } from './pages/Messages';
import { NotificationPrefsPage } from './pages/NotificationPrefs';
import { PaymentMethodsPage } from './pages/PaymentMethods';
import { RequestsPage } from './pages/Requests';
import { StatementPage } from './pages/Statement';
import { SwitchEntityPage } from './pages/Switch';

export function App(): JSX.Element {
  // Phase 16 #27 — license + firm-toggle gate. Block all routes (login
  // included) when the portal is disabled at either layer, so the
  // client sees a single clear message instead of a broken login form.
  const status = usePortalStatus();
  if (status === null) {
    return <FullPageMsg>Loading…</FullPageMsg>;
  }
  if (!status.enabled) {
    return (
      <FullPageMsg>
        <div style={{ textAlign: 'center', maxWidth: 420 }}>
          <h1 style={{ fontSize: 20, color: tokens.color.text }}>Portal unavailable</h1>
          <p style={{ color: tokens.color.textMuted, fontSize: 14 }}>
            {!status.licensed
              ? 'This appliance does not have a commercial license token configured.'
              : 'Your firm has disabled the client portal.'}
          </p>
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>
            Contact your firm administrator for help.
          </p>
        </div>
      </FullPageMsg>
    );
  }
  return (
    <AuthProvider>
      <StepUpModal />
      <Routes>
        <Route path="/auth/login" element={<LoginPage />} />
        <Route path="/auth/verify" element={<LoginPage />} />
        <Route
          path="*"
          element={
            <RequireAuth>
              <Shell>
                <Routes>
                  <Route path="/" element={<HomePage />} />
                  <Route path="/invoices/*" element={<PortalInvoicesPage />} />
                  <Route path="/messages" element={<MessagesPage />} />
                  <Route path="/requests" element={<RequestsPage />} />
                  <Route path="/letters" element={<LettersPage />} />
                  <Route path="/files" element={<FilesPage />} />
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

interface PortalStatus {
  licensed: boolean;
  firmEnabled: boolean;
  enabled: boolean;
}

function usePortalStatus(): PortalStatus | null {
  const [s, setS] = useState<PortalStatus | null>(null);
  useEffect(() => {
    void api<PortalStatus>('/api/portal/status')
      .then(setS)
      .catch(() => setS({ licensed: false, firmEnabled: false, enabled: false }));
  }, []);
  return s;
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
      collapseStorageKey="__vibe_portal_sidebar_collapsed"
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
        { label: 'Overview', href: '/', icon: '⌂', active: location.pathname === '/' },
        {
          label: 'Invoices',
          href: '/invoices',
          icon: '⎙',
          active: location.pathname.startsWith('/invoices'),
        },
        {
          label: 'Messages',
          href: '/messages',
          icon: '💬',
          active: location.pathname.startsWith('/messages'),
        },
        {
          label: 'Requests',
          href: '/requests',
          icon: '☑',
          active: location.pathname.startsWith('/requests'),
        },
        {
          label: 'Letters',
          href: '/letters',
          icon: '✉',
          active: location.pathname.startsWith('/letters'),
        },
        {
          label: 'Files',
          href: '/files',
          icon: '▥',
          active: location.pathname.startsWith('/files'),
        },
        {
          label: 'Statement',
          href: '/statement',
          icon: '▦',
          active: location.pathname.startsWith('/statement'),
        },
        {
          label: 'Payment methods',
          href: '/payment-methods',
          icon: '$',
          active: location.pathname.startsWith('/payment-methods'),
        },
        {
          label: 'Contacts',
          href: '/alt-contacts',
          icon: '☏',
          active: location.pathname.startsWith('/alt-contacts'),
        },
        {
          label: 'Switch client',
          href: '/switch',
          icon: '⇄',
          active: location.pathname.startsWith('/switch'),
        },
        {
          label: 'Notifications',
          href: '/notifications',
          icon: '⚠︎',
          active: location.pathname.startsWith('/notifications'),
        },
      ]}
      trailing={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {me && (
            <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
              Client: <code>{me.activeClientId.slice(0, 8)}…</code>
            </span>
          )}
          <FontSizeControl />
          <ThemeToggle />
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
        color: tokens.color.textMuted,
        fontFamily: tokens.font.body,
      }}
    >
      {children}
    </div>
  );
}
