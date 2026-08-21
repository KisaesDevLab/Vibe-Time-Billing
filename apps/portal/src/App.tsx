// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

import { api } from './api-client';

import { AppShell, Button, FontSizeControl, Pill, ThemeToggle, tokens } from '@vibe/ui';
import {
  ArrowLeftRight,
  Bell,
  BellRing,
  CalendarCheck,
  CircleHelp,
  CircleUser,
  Coins,
  CreditCard,
  FileQuestion,
  FileText,
  Files,
  History,
  Landmark,
  Layers,
  LayoutDashboard,
  Mail,
  MessageSquare,
  Receipt,
} from 'lucide-react';

import { AuthProvider, useAuth } from './auth-context';
import { ScopeProvider, useScope } from './scope-context';
import { StepUpModal } from './components/StepUpModal';
import { InstallBanner } from './components/InstallBanner';

// Route components are code-split: each page loads as its own async chunk
// on first navigation, keeping the initial (entry) bundle to the shell +
// router only. Clients on 4G need a fast first paint (CLAUDE.md), so the
// portal entry stays especially tight. `lazyPage` adapts a named page
// export to the default-export shape React.lazy expects.
// reason: dynamic-import modules expose many exports of varying types;
// pick the page by name and adapt it to a props-less component.
function lazyPage(
  loader: () => Promise<Record<string, unknown>>,
  exportName: string,
): LazyExoticComponent<ComponentType> {
  return lazy(() => loader().then((m) => ({ default: m[exportName] as ComponentType })));
}

const ActivityPage = lazyPage(() => import('./pages/Activity'), 'ActivityPage');
const AltContactsPage = lazyPage(() => import('./pages/AltContacts'), 'AltContactsPage');
const AppointmentsPage = lazyPage(() => import('./pages/Appointments'), 'AppointmentsPage');
const EngagementsPage = lazyPage(() => import('./pages/Engagements'), 'EngagementsPage');
const FilePreviewPage = lazyPage(() => import('./pages/FilePreview'), 'FilePreviewPage');
const FilesPage = lazyPage(() => import('./pages/Files'), 'FilesPage');
const AcceptInvitationPage = lazyPage(
  () => import('./pages/AcceptInvitation'),
  'AcceptInvitationPage',
);
const HelpPage = lazyPage(() => import('./pages/Help'), 'HelpPage');
const HomePage = lazyPage(() => import('./pages/Home'), 'HomePage');
const ImpersonatePage = lazyPage(() => import('./pages/Impersonate'), 'ImpersonatePage');
const PortalInvoicesPage = lazyPage(() => import('./pages/Invoices'), 'PortalInvoicesPage');
const LettersPage = lazyPage(() => import('./pages/Letters'), 'LettersPage');
const LoginPage = lazyPage(() => import('./pages/Login'), 'LoginPage');
const RequestAccessPage = lazyPage(() => import('./pages/RequestAccess'), 'RequestAccessPage');
const MessagesPage = lazyPage(() => import('./pages/Messages'), 'MessagesPage');
const NotificationPrefsPage = lazyPage(
  () => import('./pages/NotificationPrefs'),
  'NotificationPrefsPage',
);
const UpdatesPage = lazyPage(() => import('./pages/Updates'), 'UpdatesPage');
const PaymentMethodsPage = lazyPage(() => import('./pages/PaymentMethods'), 'PaymentMethodsPage');
const ProfilePage = lazyPage(() => import('./pages/Profile'), 'ProfilePage');
const ProposalPage = lazyPage(() => import('./pages/Proposal'), 'ProposalPage');
const RequestsPage = lazyPage(() => import('./pages/Requests'), 'RequestsPage');
const RequestDetailPage = lazyPage(() => import('./pages/RequestDetail'), 'RequestDetailPage');
const PortalRetainersPage = lazyPage(() => import('./pages/Retainers'), 'PortalRetainersPage');
const RetainerOfferPage = lazyPage(() => import('./pages/RetainerOffer'), 'RetainerOfferPage');
const StatementPage = lazyPage(() => import('./pages/Statement'), 'StatementPage');
const SwitchEntityPage = lazyPage(() => import('./pages/Switch'), 'SwitchEntityPage');
const TaxPaymentsPage = lazyPage(() => import('./pages/TaxPayments'), 'TaxPaymentsPage');
const TaxReturnsPage = lazyPage(() => import('./pages/TaxReturns'), 'TaxReturnsPage');
const TaxReturnViewPage = lazyPage(() => import('./pages/TaxReturnView'), 'TaxReturnViewPage');
const SharedTaxReturnPage = lazyPage(
  () => import('./pages/SharedTaxReturn'),
  'SharedTaxReturnPage',
);
const SharedFilePage = lazyPage(() => import('./pages/SharedFile'), 'SharedFilePage');
const PayPage = lazyPage(() => import('./pages/PayPage'), 'PayPage');
const VerifyBankPage = lazyPage(() => import('./pages/VerifyBank'), 'VerifyBankPage');
const InOfficeSignPage = lazyPage(() => import('./pages/InOfficeSign'), 'InOfficeSignPage');

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
    <Suspense fallback={<FullPageMsg>Loading…</FullPageMsg>}>
      <Routes>
        <Route path="/auth/login" element={<LoginPage />} />
        <Route path="/auth/verify" element={<LoginPage />} />
        <Route path="/auth/request-access" element={<RequestAccessPage />} />
        <Route path="/auth/impersonate" element={<ImpersonatePage />} />
        <Route path="/auth/accept" element={<AcceptInvitationPage />} />
        <Route path="/p/:token" element={<ProposalPage />} />
        {/* Public 3rd-party recipient view of a shared tax return (token = cred). */}
        <Route path="/shared/tax/:token" element={<SharedTaxReturnPage />} />
        {/* 0150 — gated file-share landing page (public; token + access code). */}
        <Route path="/shared/file/:token" element={<SharedFilePage />} />
        {/* Public in-office signing landing — per-signer QR target. */}
        <Route path="/in-office/:token" element={<InOfficeSignPage />} />
        {/* 0181 — no-login pay-by-link landing + post-checkout return page. */}
        <Route path="/pay/:token" element={<PayPage />} />
        <Route path="/pay/:token/done" element={<PayPage />} />
        {/* 0218 — no-login ACH micro-deposit verification landing. */}
        <Route path="/verify-bank/:token" element={<VerifyBankPage />} />
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
                  <Route path="/updates" element={<UpdatesPage />} />
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
    </Suspense>
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
  const navigate = useNavigate();
  const [branding, setBranding] = useState<Branding | null>(null);
  // 0146 — unread in-app notification count for the Updates nav badge.
  // Polled every 60s; also refreshed on route change so reading items
  // updates the count without a full minute's lag.
  const [unreadUpdates, setUnreadUpdates] = useState(0);
  // 0222 — unread staff-message count for the Messages nav badge.
  const [unreadMessages, setUnreadMessages] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function poll(): Promise<void> {
      try {
        const r = await api<{ count: number }>('/api/portal/notifications/unread-count');
        if (!cancelled) setUnreadUpdates(r.count ?? 0);
        const a = await api<{ unreadMessages: number }>('/api/portal/notifications/attention');
        if (!cancelled) setUnreadMessages(a.unreadMessages ?? 0);
      } catch {
        // ignore; badge is best-effort
      }
    }
    void poll();
    const t = setInterval(() => void poll(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [location.pathname]);

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
      onNavigate={(href) => navigate(href)}
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
        {
          label: 'Overview',
          href: '/',
          icon: <LayoutDashboard size={16} />,
          active: location.pathname === '/',
        },
        {
          label: unreadMessages > 0 ? `Messages (${unreadMessages})` : 'Messages',
          href: '/messages',
          icon: <MessageSquare size={16} />,
          active: location.pathname.startsWith('/messages'),
        },
        {
          label: unreadUpdates > 0 ? `Updates (${unreadUpdates})` : 'Updates',
          href: '/updates',
          icon: <Bell size={16} />,
          active: location.pathname.startsWith('/updates'),
        },

        // ---- Billing & payments ----
        {
          section: 'Billing & payments',
          label: 'Invoices',
          href: '/invoices',
          icon: <Receipt size={16} />,
          active: location.pathname.startsWith('/invoices'),
        },
        {
          section: 'Billing & payments',
          label: 'Statement',
          href: '/statement',
          icon: <FileText size={16} />,
          active: location.pathname.startsWith('/statement'),
        },
        {
          section: 'Billing & payments',
          label: 'Payment methods',
          href: '/payment-methods',
          icon: <CreditCard size={16} />,
          active: location.pathname.startsWith('/payment-methods'),
        },
        {
          section: 'Billing & payments',
          label: 'Tax payments',
          href: '/tax-payments',
          icon: <Coins size={16} />,
          active: location.pathname.startsWith('/tax-payments'),
        },

        // ---- Documents ----
        {
          section: 'Documents',
          label: 'Requests',
          href: '/requests',
          icon: <FileQuestion size={16} />,
          active: location.pathname.startsWith('/requests'),
        },
        {
          section: 'Documents',
          label: 'Files',
          href: '/files',
          icon: <Files size={16} />,
          active: location.pathname.startsWith('/files'),
        },
        {
          section: 'Documents',
          label: 'Letters',
          href: '/letters',
          icon: <Mail size={16} />,
          active: location.pathname.startsWith('/letters'),
        },

        // ---- Your work ----
        {
          section: 'Your work',
          label: 'Engagements',
          href: '/engagements',
          icon: <Layers size={16} />,
          active: location.pathname.startsWith('/engagements'),
        },
        {
          section: 'Your work',
          label: 'Appointments',
          href: '/appointments',
          icon: <CalendarCheck size={16} />,
          active: location.pathname.startsWith('/appointments'),
        },
        {
          section: 'Your work',
          label: 'Tax returns',
          href: '/tax/returns',
          icon: <Landmark size={16} />,
          active: location.pathname.startsWith('/tax/returns'),
        },

        // ---- Account (divider, no header) ----
        {
          section: '',
          label: 'Profile',
          href: '/profile',
          icon: <CircleUser size={16} />,
          active:
            location.pathname.startsWith('/profile') ||
            location.pathname.startsWith('/alt-contacts'),
        },
        {
          section: '',
          label: 'Notifications',
          href: '/notifications',
          icon: <BellRing size={16} />,
          active: location.pathname.startsWith('/notifications'),
        },
        {
          section: '',
          label: 'Activity',
          href: '/activity',
          icon: <History size={16} />,
          active: location.pathname.startsWith('/activity'),
        },
        {
          section: '',
          label: 'Help',
          href: '/help',
          icon: <CircleHelp size={16} />,
          active: location.pathname.startsWith('/help'),
        },
        {
          section: '',
          label: 'Switch client',
          href: '/switch',
          icon: <ArrowLeftRight size={16} />,
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
      <InstallBanner />
      <Suspense fallback={<RouteFallback />}>{children}</Suspense>
    </AppShell>
  );
}

function RouteFallback(): JSX.Element {
  return (
    <div
      style={{
        padding: tokens.space.xl,
        color: tokens.color.textMuted,
        fontFamily: tokens.font.body,
        fontSize: 13,
      }}
    >
      Loading…
    </div>
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
