// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { AppShell, Button, FontSizeControl, Pill, ThemeToggle, tokens } from '@vibe/ui';

import { BRAND } from './brand';

import { QuickFind } from './QuickFind';

import { AccountPage } from './pages/Account';
import { AdminLayout } from './pages/admin';
import { AlertsPage } from './pages/Alerts';
import { ApprovalsPage } from './pages/Approvals';
import { ArPage } from './pages/Ar';
import { ArByServiceLinePage } from './pages/ArByServiceLine';
import { ArSnapshotsPage } from './pages/ArSnapshots';
import { AuditPage } from './pages/Audit';
import { AuthProvider, useAuth, usePermission } from './auth-context';
import { BillingBatchesPage } from './pages/Billing';
import { ClientDetailPage } from './pages/ClientDetail';
import { ClientsPage } from './pages/Clients';
import { DashboardPage } from './pages/Dashboard';
import { EngagementCreatePage } from './pages/EngagementCreate';
import { EngagementDetailPage } from './pages/EngagementDetail';
import { EngagementsPage } from './pages/Engagements';
import { ProposalsListPage } from './pages/Proposals';
import { ProposalCreatePage } from './pages/ProposalCreate';
import { ProposalEditorPage } from './pages/ProposalEditor';
// FilesPage v1 removed (Phase 0 of file-manager rebuild); v2 ships in Phase 10.
import { InvoiceDetailPage } from './pages/InvoiceDetail';
import { InvoicesPage } from './pages/Invoices';
import { LoginPage } from './pages/Login';
import { MessagesPage } from './pages/Messages';
import { OnboardingPage } from './pages/Onboarding';
import { HelpPage } from './pages/Help';
import { PaymentReceivePage } from './pages/PaymentReceive';
import { ProfitabilityPage } from './pages/Profitability';
import { ReportsPage } from './pages/Reports';
import { PaymentsReceivedReportPage } from './pages/reports/PaymentsReceivedReport';
import { RetainerDashboardPage } from './pages/admin/RetainerDashboard';
import { RetainerDetailPage } from './pages/admin/RetainerDetail';
import { StaffRetainerDashboardPage } from './pages/StaffRetainerDashboard';
import { RequestsPage } from './pages/Requests';
import { RequestDetailPage } from './pages/RequestDetail';
import { TaxReturnDetailPage } from './pages/TaxReturnDetail';
import { TaxReturnsStaffPage } from './pages/TaxReturns';
import { TimeEntryPage } from './pages/TimeEntry';
import { TotpEnrollPage } from './pages/TotpEnroll';
import { WipDashboardPage } from './pages/Wip';

export function App(): JSX.Element {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/auth/login" element={<LoginPage />} />
        <Route path="/auth/verify" element={<LoginPage />} />
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
                  <Route path="/clients" element={<ClientsPage />} />
                  <Route path="/clients/:id" element={<ClientDetailPage />} />
                  <Route path="/engagements" element={<EngagementsPage />} />
                  <Route path="/engagements/new" element={<EngagementCreatePage />} />
                  <Route path="/engagements/:id" element={<EngagementDetailPage />} />
                  <Route path="/proposals" element={<ProposalsListPage />} />
                  <Route path="/proposals/new" element={<ProposalCreatePage />} />
                  <Route path="/proposals/:id/edit" element={<ProposalEditorPage />} />
                  <Route path="/time" element={<TimeEntryPage />} />
                  <Route path="/billing/*" element={<BillingBatchesPage />} />
                  <Route path="/wip" element={<WipDashboardPage />} />
                  <Route path="/invoices" element={<InvoicesPage />} />
                  <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
                  <Route path="/ar" element={<ArPage />} />
                  <Route path="/ar/by-service-line" element={<ArByServiceLinePage />} />
                  <Route path="/ar/snapshots" element={<ArSnapshotsPage />} />
                  <Route path="/payments/new" element={<PaymentReceivePage />} />
                  <Route path="/approvals" element={<ApprovalsPage />} />
                  <Route path="/requests" element={<RequestsPage />} />
                  <Route path="/requests/:id" element={<RequestDetailPage />} />
                  <Route path="/messages" element={<MessagesPage />} />
                  <Route path="/audit" element={<AuditPage />} />
                  <Route path="/alerts" element={<AlertsPage />} />
                  <Route path="/reports" element={<ReportsPage />} />
                  <Route
                    path="/reports/payments-received"
                    element={<PaymentsReceivedReportPage />}
                  />
                  <Route path="/reports/profitability" element={<ProfitabilityPage />} />
                  <Route path="/retainers" element={<RetainersGate />} />
                  <Route path="/retainers/:id" element={<RetainerDetailPage />} />
                  <Route path="/my/retainers" element={<StaffRetainerDashboardPage />} />
                  <Route path="/tax/returns" element={<TaxReturnsStaffPage />} />
                  <Route path="/tax/returns/:returnId" element={<TaxReturnDetailPage />} />
                  {/* /files removed in Phase 0; v2 lands as a per-client tab in Phase 10. */}
                  <Route path="/account" element={<AccountPage />} />
                  <Route path="/help" element={<HelpPage />} />
                  <Route path="/onboarding" element={<OnboardingPage />} />
                  <Route path="/admin/*" element={<AdminLayout />} />
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
  // RBAC-gated nav items. retainer:read covers partner + manager today
  // and surfaces firm-wide retainer dashboards. Staff without it still
  // get the personal /my/retainers view but no top-level entry.
  const canViewRetainers = usePermission('retainer:read');
  return (
    <AppShell
      brand={BRAND}
      collapseStorageKey="__vibe_staff_sidebar_collapsed"
      realmBadge={<Pill tone="accent">staff</Pill>}
      nav={[
        { label: 'Dashboard', href: '/', icon: '⌂', active: location.pathname === '/' },
        {
          label: 'Clients',
          href: '/clients',
          icon: '◯',
          active: location.pathname.startsWith('/clients'),
        },
        {
          label: 'Time',
          href: '/time',
          icon: '◷',
          active: location.pathname.startsWith('/time'),
        },
        {
          label: 'Engagements',
          href: '/engagements',
          icon: '❖',
          active: location.pathname.startsWith('/engagements'),
        },
        {
          label: 'Proposals',
          href: '/proposals',
          icon: '✎',
          active: location.pathname.startsWith('/proposals'),
        },
        {
          label: 'Billing',
          href: '/billing',
          icon: '▤',
          active: location.pathname.startsWith('/billing'),
        },
        { label: 'WIP', href: '/wip', icon: '⊞', active: location.pathname.startsWith('/wip') },
        {
          label: 'Invoices',
          href: '/invoices',
          icon: '⎙',
          active: location.pathname.startsWith('/invoices'),
        },
        { label: 'AR', href: '/ar', icon: '$', active: location.pathname.startsWith('/ar') },
        ...(canViewRetainers
          ? [
              {
                label: 'Retainers',
                href: '/retainers',
                icon: '◈',
                active:
                  location.pathname === '/retainers' || location.pathname.startsWith('/retainers/'),
              },
            ]
          : []),
        {
          label: 'Approvals',
          href: '/approvals',
          icon: '✓',
          active: location.pathname.startsWith('/approvals'),
        },
        {
          label: 'Requests',
          href: '/requests',
          icon: '☑',
          active: location.pathname.startsWith('/requests'),
        },
        {
          label: 'Messages',
          href: '/messages',
          icon: '💬',
          active: location.pathname.startsWith('/messages'),
        },
        {
          label: 'Reports',
          href: '/reports',
          icon: '▦',
          active: location.pathname.startsWith('/reports'),
        },
        {
          label: 'Tax returns',
          href: '/tax/returns',
          icon: '⎚',
          active: location.pathname.startsWith('/tax/returns'),
        },
        // Top-level Files nav removed in Phase 0; the v2 file manager lives on the client-detail Files tab.
        {
          label: 'Alerts',
          href: '/alerts',
          icon: '⚠︎',
          active: location.pathname.startsWith('/alerts'),
        },
        {
          label: 'Audit',
          href: '/audit',
          icon: '⊙',
          active: location.pathname.startsWith('/audit'),
        },
        {
          label: 'Admin',
          href: '/admin',
          icon: '⚙︎',
          active: location.pathname.startsWith('/admin'),
        },
        {
          label: 'Help',
          href: '/help',
          icon: '❓',
          active: location.pathname.startsWith('/help'),
        },
        {
          label: 'Account',
          href: '/account',
          icon: '◐',
          active: location.pathname.startsWith('/account'),
        },
      ]}
      trailing={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <FontSizeControl />
          <ThemeToggle />
          <Button variant="secondary" size="sm" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      }
    >
      {children}
      <QuickFind />
    </AppShell>
  );
}

/**
 * Route-level gate for the firm-wide Retainers dashboard. Partners
 * and managers see the full dashboard; staff without retainer:read get
 * redirected to their personal /my/retainers view (which is scoped to
 * their assigned engagements only). Keeps the URL meaningful for
 * everyone without leaking firm-wide data.
 */
function RetainersGate(): JSX.Element {
  const canViewFirmwide = usePermission('retainer:read');
  if (!canViewFirmwide) {
    return <Navigate to="/my/retainers" replace />;
  }
  return <RetainerDashboardPage />;
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
