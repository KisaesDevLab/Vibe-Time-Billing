// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { api } from './api-client';

import { AppShell, Button, FontSizeControl, Pill, ThemeToggle, tokens } from '@vibe/ui';

import { AuthProvider, useAuth } from './auth-context';
import { ScopeProvider, useScope } from './scope-context';
import { StepUpModal } from './components/StepUpModal';
import { ActivityPage } from './pages/Activity';
import { AltContactsPage } from './pages/AltContacts';
import { AppointmentsPage } from './pages/Appointments';
import { EngagementsPage } from './pages/Engagements';
import { FilePreviewPage } from './pages/FilePreview';
import { FilesPage } from './pages/Files';
import { AcceptInvitationPage } from './pages/AcceptInvitation';
import { HelpPage } from './pages/Help';
import { HomePage } from './pages/Home';
import { ImpersonatePage } from './pages/Impersonate';
import { PortalInvoicesPage } from './pages/Invoices';
import { LettersPage } from './pages/Letters';
import { LoginPage } from './pages/Login';
import { MessagesPage } from './pages/Messages';
import { NotificationPrefsPage } from './pages/NotificationPrefs';
import { PaymentMethodsPage } from './pages/PaymentMethods';
import { ProfilePage } from './pages/Profile';
import { ProposalPage } from './pages/Proposal';
import { RequestsPage } from './pages/Requests';
import { RequestDetailPage } from './pages/RequestDetail';
import { PortalRetainersPage } from './pages/Retainers';
import { RetainerOfferPage } from './pages/RetainerOffer';
import { StatementPage } from './pages/Statement';
import { SwitchEntityPage } from './pages/Switch';
import { TaxPaymentsPage } from './pages/TaxPayments';
import { TaxReturnsPage } from './pages/TaxReturns';
import { TaxReturnViewPage } from './pages/TaxReturnView';
import { SharedTaxReturnPage } from './pages/SharedTaxReturn';

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
      <ScopeProvider>
        <StepUpModal />
        <PortalRoutes />
      </ScopeProvider>
    </AuthProvider>
  );
}

function PortalRoutes(): JSX.Element {
  return (
    <>
      <Routes>
        <Route path="/auth/login" element={<LoginPage />} />
        <Route path="/auth/verify" element={<LoginPage />} />
        <Route path="/auth/impersonate" element={<ImpersonatePage />} />
        <Route path="/auth/accept" element={<AcceptInvitationPage />} />
        <Route path="/p/:token" element={<ProposalPage />} />
        {/* Public 3rd-party recipient view of a shared tax return (token = cred). */}
        <Route path="/shared/tax/:token" element={<SharedTaxReturnPage />} />
        <Route
          path="*"
          element={
            <RequireAuth>
              <Shell>
                <Routes>
                  <Route path="/" element={<HomePage />} />
                  <Route path="/engagements" element={<EngagementsPage />} />
                  <Route path="/appointments" element={<AppointmentsPage />} />
                  <Route path="/invoices/*" element={<PortalInvoicesPage />} />
                  <Route path="/messages" element={<MessagesPage />} />
                  <Route path="/requests" element={<RequestsPage />} />
                  <Route path="/requests/:id" element={<RequestDetailPage />} />
                  <Route path="/letters" element={<LettersPage />} />
                  <Route path="/files" element={<FilesPage />} />
                  <Route path="/files/:id" element={<FilePreviewPage />} />
                  <Route path="/statement" element={<StatementPage />} />
                  <Route path="/payment-methods" element={<PaymentMethodsPage />} />
                  <Route path="/alt-contacts" element={<AltContactsPage />} />
                  <Route path="/profile" element={<ProfilePage />} />
                  <Route path="/activity" element={<ActivityPage />} />
                  <Route path="/help" element={<HelpPage />} />
                  <Route path="/switch" element={<SwitchEntityPage />} />
                  <Route path="/notifications" element={<NotificationPrefsPage />} />
                  <Route path="/retainer-offers/:id" element={<RetainerOfferPage />} />
                  <Route path="/retainers" element={<PortalRetainersPage />} />
                  <Route path="/tax-payments" element={<TaxPaymentsPage />} />
                  <Route path="/tax/returns" element={<TaxReturnsPage />} />
                  <Route path="/tax/returns/:returnId" element={<TaxReturnViewPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Shell>
            </RequireAuth>
          }
        />
      </Routes>
    </>
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
  const { clientNames } = useScope();
  const location = useLocation();
  const [branding, setBranding] = useState<Branding | null>(null);

  // Name of the account currently in view, so clients with access to more
  // than one entity always know which they're looking at. Falls back to a
  // neutral label until the accessible-clients list resolves.
  const activeClientName = me ? (clientNames[me.activeClientId] ?? 'Your account') : null;

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
        // Quick access, pinned at top.
        { label: 'Overview', href: '/', icon: '⌂', active: location.pathname === '/' },
        {
          label: 'Messages',
          href: '/messages',
          icon: '💬',
          active: location.pathname.startsWith('/messages'),
        },

        // ---- Billing & payments ----
        {
          section: 'Billing & payments',
          label: 'Invoices',
          href: '/invoices',
          icon: '⎙',
          active: location.pathname.startsWith('/invoices'),
        },
        {
          section: 'Billing & payments',
          label: 'Statement',
          href: '/statement',
          icon: '▦',
          active: location.pathname.startsWith('/statement'),
        },
        {
          section: 'Billing & payments',
          label: 'Payment methods',
          href: '/payment-methods',
          icon: '$',
          active: location.pathname.startsWith('/payment-methods'),
        },
        {
          section: 'Billing & payments',
          label: 'Tax payments',
          href: '/tax-payments',
          icon: '📅',
          active: location.pathname.startsWith('/tax-payments'),
        },

        // ---- Documents ----
        {
          section: 'Documents',
          label: 'Requests',
          href: '/requests',
          icon: '☑',
          active: location.pathname.startsWith('/requests'),
        },
        {
          section: 'Documents',
          label: 'Files',
          href: '/files',
          icon: '▥',
          active: location.pathname.startsWith('/files'),
        },
        {
          section: 'Documents',
          label: 'Letters',
          href: '/letters',
          icon: '✉',
          active: location.pathname.startsWith('/letters'),
        },

        // ---- Your work ----
        {
          section: 'Your work',
          label: 'Engagements',
          href: '/engagements',
          icon: '◉',
          active: location.pathname.startsWith('/engagements'),
        },
        {
          section: 'Your work',
          label: 'Appointments',
          href: '/appointments',
          icon: '📅',
          active: location.pathname.startsWith('/appointments'),
        },
        {
          section: 'Your work',
          label: 'Tax returns',
          href: '/tax/returns',
          icon: '⎚',
          active: location.pathname.startsWith('/tax/returns'),
        },

        // ---- Account (divider, no header) ----
        {
          section: '',
          label: 'Profile',
          href: '/profile',
          icon: '☏',
          active:
            location.pathname.startsWith('/profile') ||
            location.pathname.startsWith('/alt-contacts'),
        },
        {
          section: '',
          label: 'Notifications',
          href: '/notifications',
          icon: '⚠︎',
          active: location.pathname.startsWith('/notifications'),
        },
        {
          section: '',
          label: 'Activity',
          href: '/activity',
          icon: '📜',
          active: location.pathname.startsWith('/activity'),
        },
        {
          section: '',
          label: 'Help',
          href: '/help',
          icon: '❔',
          active: location.pathname.startsWith('/help'),
        },
        {
          section: '',
          label: 'Switch client',
          href: '/switch',
          icon: '⇄',
          active: location.pathname.startsWith('/switch'),
        },
      ]}
      trailing={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {me?.isImpersonation && <Pill tone="warning">view-as · read-only</Pill>}
          {activeClientName && (
            <span style={{ fontSize: 13, color: tokens.color.text }}>
              <span style={{ color: tokens.color.textMuted }}>Account: </span>
              <strong>{activeClientName}</strong>
            </span>
          )}
          <FontSizeControl />
          <ThemeToggle />
          <Button variant="secondary" size="sm" onClick={() => void logout()}>
            {me?.isImpersonation ? 'End session' : 'Sign out'}
          </Button>
        </div>
      }
    >
      {me?.isImpersonation && <ImpersonationBanner email={me.impersonatedByEmail} />}
      {children}
    </AppShell>
  );
}

function ImpersonationBanner({ email }: { email: string | null | undefined }): JSX.Element {
  return (
    <div
      role="status"
      style={{
        marginBottom: 12,
        padding: '10px 14px',
        background: 'rgba(245, 158, 11, 0.12)',
        border: `1px solid ${tokens.color.warning}`,
        borderRadius: tokens.radius.sm,
        color: tokens.color.text,
        fontSize: 13,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <span style={{ fontWeight: 600 }}>Viewing as client</span>
      <span style={{ color: tokens.color.textMuted }}>
        Staff session{email ? ` (${email})` : ''} · read-only · expires within an hour.
      </span>
    </div>
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
