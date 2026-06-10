// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { AppShell, Button, FontSizeControl, Pill, ThemeToggle, tokens } from '@vibe/ui';

import { BRAND } from './brand';
import { api } from './api-client';

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
import { PeopleDirectoryPage } from './pages/People';
import { PersonDetailPage } from './pages/PersonDetail';
import { DashboardPage } from './pages/Dashboard';
import { EngagementCreatePage } from './pages/EngagementCreate';
import { EngagementDetailPage } from './pages/EngagementDetail';
import { EngagementsPage } from './pages/Engagements';
import { FilerPage } from './pages/Filer';
import { ProposalsListPage } from './pages/Proposals';
import { ProposalCreatePage } from './pages/ProposalCreate';
import { ProposalEditorPage } from './pages/ProposalEditor';
import { ProposalPreviewPage } from './pages/ProposalPreview';
import { SignaturesPage } from './pages/Signatures';
import { SignatureDetailPage } from './pages/SignatureDetail';
import { MyCalendarPage } from './pages/MyCalendar';
// FilesPage v1 removed (Phase 0 of file-manager rebuild); v2 ships in Phase 10.
import { InvoiceDetailPage } from './pages/InvoiceDetail';
import { InvoicesPage } from './pages/Invoices';
import { PaymentsPage } from './pages/Payments';
import { LoginPage } from './pages/Login';
import { MessagesPage } from './pages/Messages';
import { OnboardingPage } from './pages/Onboarding';
import { HelpPage } from './pages/Help';
import { IntakeInboxPage } from './pages/IntakeInbox';
import { PaymentReceivePage } from './pages/PaymentReceive';
import { ProfitabilityPage } from './pages/Profitability';
import { ReportsPage } from './pages/Reports';
import { PaymentsReceivedReportPage } from './pages/reports/PaymentsReceivedReport';
import { SignedFormsReportPage } from './pages/reports/SignedFormsReport';
import { RetainerDashboardPage } from './pages/admin/RetainerDashboard';
import { RetainerDetailPage } from './pages/admin/RetainerDetail';
import { StaffRetainerDashboardPage } from './pages/StaffRetainerDashboard';
import { RequestsPage } from './pages/Requests';
import { RequestDetailPage } from './pages/RequestDetail';
import { TaxReturnDetailPage } from './pages/TaxReturnDetail';
import { TaxReturnsStaffPage } from './pages/TaxReturns';
import { AppointmentsPage } from './pages/Appointments';
import { NotificationsPage as StaffNotificationsPage } from './pages/Notifications';
import { TasksPage } from './pages/Tasks';
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
        {/* Chrome-less client preview (popout) — authed staff, no AppShell nav. */}
        <Route
          path="/proposals/:id/preview"
          element={
            <RequireAuth>
              <ProposalPreviewPage />
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
                  <Route path="/people" element={<PeopleDirectoryPage />} />
                  <Route path="/people/:id" element={<PersonDetailPage />} />
                  <Route path="/engagements" element={<EngagementsPage />} />
                  <Route path="/engagements/new" element={<EngagementCreatePage />} />
                  <Route path="/engagements/:id" element={<EngagementDetailPage />} />
                  <Route path="/proposals" element={<ProposalsListPage />} />
                  <Route path="/proposals/new" element={<ProposalCreatePage />} />
                  <Route path="/proposals/:id/edit" element={<ProposalEditorPage />} />
                  <Route path="/signatures" element={<SignaturesPage />} />
                  <Route path="/signatures/:id" element={<SignatureDetailPage />} />
                  <Route path="/calendar/mine" element={<MyCalendarPage />} />
                  <Route
                    path="/calendar/unmatched"
                    element={<Navigate to="/appointments#review" replace />}
                  />
                  <Route path="/time" element={<TimeEntryPage />} />
                  <Route path="/tasks" element={<TasksPage />} />
                  <Route path="/billing/*" element={<BillingBatchesPage />} />
                  <Route path="/wip" element={<WipDashboardPage />} />
                  <Route path="/invoices" element={<InvoicesPage />} />
                  <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
                  <Route path="/ar" element={<ArPage />} />
                  <Route path="/ar/by-service-line" element={<ArByServiceLinePage />} />
                  <Route path="/ar/snapshots" element={<ArSnapshotsPage />} />
                  <Route path="/payments" element={<PaymentsPage />} />
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
                  <Route path="/reports/signed-forms" element={<SignedFormsReportPage />} />
                  <Route path="/reports/profitability" element={<ProfitabilityPage />} />
                  <Route path="/retainers" element={<RetainersGate />} />
                  <Route path="/retainers/:id" element={<RetainerDetailPage />} />
                  <Route path="/my/retainers" element={<StaffRetainerDashboardPage />} />
                  <Route path="/tax/returns" element={<TaxReturnsStaffPage />} />
                  <Route path="/tax/returns/:returnId" element={<TaxReturnDetailPage />} />
                  <Route path="/appointments" element={<AppointmentsPage />} />
                  <Route path="/notifications" element={<StaffNotificationsPage />} />
                  <Route path="/intake" element={<IntakeInboxPage />} />
                  <Route path="/filer" element={<FilerPage />} />
                  {/* Team chat is now the "Team" tab of /messages; keep the
                      old path (and notification email links) working. */}
                  <Route path="/team" element={<Navigate to="/messages?tab=team" replace />} />
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
  // Admin hub is visible to anyone who can administer *something* there.
  // Hooks must run unconditionally, so resolve each then combine.
  const adminFirmSettings = usePermission('firm:settings:read');
  const adminUsersRead = usePermission('app_user:read');
  const adminServiceWrite = usePermission('service:write');
  const adminTaxonomyWrite = usePermission('taxonomy:write');
  const adminRateRead = usePermission('rate:read');
  // Per-area permission gates — a nav item is hidden when the signed-in
  // staff user lacks the relevant permission (no role → nothing shows).
  const can = {
    clients: usePermission('client:read'),
    // Tasks are client:read-gated server-side; keep nav + route in agreement.
    tasks: usePermission('client:read'),
    time: usePermission('time_entry:read:own'),
    engagements: usePermission('engagement:read'),
    proposals: usePermission('proposal:read'),
    signatures: usePermission('proposal:read'),
    billing: usePermission('billing_batch:read'),
    // WIP is engagement-scoped on the API (engagement:read); match it so the
    // nav and the route agree.
    wip: usePermission('engagement:read'),
    invoices: usePermission('invoice:read'),
    payments: usePermission('payment:read'),
    ar: usePermission('report:ar:read'),
    approvals: usePermission('approval:queue:read'),
    requests: usePermission('requests:read'),
    messages: usePermission('messaging:read'),
    appointments: usePermission('appointment:read'),
    intake: usePermission('storage:folder:view'),
    filer: usePermission('storage:folder:view'),
    reports: usePermission('report:realization:read'),
    tax: usePermission('engagement:read'),
    audit: usePermission('admin:audit:read'),
    // The Admin hub spans firm settings, users, rates, offices, catalog,
    // etc. Show it to anyone who can administer *something* there (e.g. a
    // manager has app_user:read + service:write), not just firm-settings.
    admin:
      adminFirmSettings ||
      adminUsersRead ||
      adminServiceWrite ||
      adminTaxonomyWrite ||
      adminRateRead,
  };
  const [teamUnread, setTeamUnread] = useState(0);
  const [notifUnread, setNotifUnread] = useState(0);
  useEffect(() => {
    let alive = true;
    const poll = (): void => {
      void api<{ unread: number }>('/api/staff/internal-messaging/unread-count')
        .then((r) => {
          if (alive) setTeamUnread(r.unread);
        })
        .catch(() => undefined);
      void api<{ count: number }>('/api/staff/notifications/unread-count')
        .then((r) => {
          if (alive) setNotifUnread(r.count);
        })
        .catch(() => undefined);
    };
    poll();
    const t = setInterval(poll, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [location.pathname]);
  return (
    <AppShell
      brand={BRAND}
      collapseStorageKey="__vibe_staff_sidebar_collapsed"
      collapsibleSections
      realmBadge={<Pill tone="accent">staff</Pill>}
      nav={[
        { label: 'Dashboard', href: '/', icon: '⌂', active: location.pathname === '/', show: true },

        // ---- Work: who you serve, the work, your time + schedule ----
        {
          section: 'Work',
          label: 'Clients',
          href: '/clients',
          icon: '◯',
          active: location.pathname.startsWith('/clients'),
          show: can.clients,
        },
        {
          section: 'Work',
          label: 'People',
          href: '/people',
          icon: '👤',
          active: location.pathname.startsWith('/people'),
          show: can.clients,
        },
        {
          section: 'Work',
          label: 'Engagements',
          href: '/engagements',
          icon: '❖',
          active: location.pathname.startsWith('/engagements'),
          show: can.engagements,
        },
        {
          section: 'Work',
          label: 'Time',
          href: '/time',
          icon: '◷',
          active: location.pathname.startsWith('/time'),
          show: can.time,
        },
        {
          section: 'Work',
          label: 'Tasks',
          href: '/tasks',
          icon: '☐',
          active: location.pathname.startsWith('/tasks'),
          show: can.tasks,
        },
        {
          section: 'Work',
          label: 'Appointments',
          href: '/appointments',
          icon: '📅',
          active: location.pathname.startsWith('/appointments'),
          show: can.appointments,
        },
        {
          section: 'Work',
          label: 'My calendar',
          href: '/calendar/mine',
          icon: '📆',
          active: location.pathname.startsWith('/calendar/mine'),
          show: can.appointments,
        },
        {
          section: 'Work',
          label: teamUnread > 0 ? `Messages (${teamUnread})` : 'Messages',
          href: '/messages',
          icon: '💬',
          active:
            location.pathname.startsWith('/messages') || location.pathname.startsWith('/team'),
          show: can.messages,
        },

        // ---- Documents: outbound (proposals/e-sign) + inbound ----
        {
          section: 'Documents',
          label: 'Proposals',
          href: '/proposals',
          icon: '✎',
          active: location.pathname.startsWith('/proposals'),
          show: can.proposals,
        },
        {
          section: 'Documents',
          label: 'Signatures',
          href: '/signatures',
          icon: '✒',
          active: location.pathname.startsWith('/signatures'),
          show: can.signatures,
        },
        {
          section: 'Documents',
          label: 'Requests',
          href: '/requests',
          icon: '☑',
          active: location.pathname.startsWith('/requests'),
          show: can.requests,
        },
        {
          section: 'Documents',
          label: 'Intake',
          href: '/intake',
          icon: '📥',
          active: location.pathname.startsWith('/intake'),
          show: can.intake,
        },
        {
          section: 'Documents',
          label: 'Document Inbox',
          href: '/filer',
          icon: '🗂',
          active: location.pathname.startsWith('/filer'),
          show: can.filer,
        },
        {
          section: 'Documents',
          label: 'Tax returns',
          href: '/tax/returns',
          icon: '⎚',
          active: location.pathname.startsWith('/tax/returns'),
          show: can.tax,
        },

        // ---- Billing: WIP → pre-bills → invoices → retainers → A/R ----
        {
          section: 'Billing',
          label: 'WIP',
          href: '/wip',
          icon: '⊞',
          active: location.pathname.startsWith('/wip'),
          show: can.wip,
        },
        {
          section: 'Billing',
          label: 'Billing',
          href: '/billing',
          icon: '▤',
          active: location.pathname.startsWith('/billing'),
          show: can.billing,
        },
        {
          section: 'Billing',
          label: 'Invoices',
          href: '/invoices',
          icon: '⎙',
          active: location.pathname.startsWith('/invoices'),
          show: can.invoices,
        },
        {
          section: 'Billing',
          label: 'Payments',
          href: '/payments',
          icon: '💳',
          active: location.pathname === '/payments',
          show: can.payments,
        },
        {
          section: 'Billing',
          label: 'Retainers',
          href: '/retainers',
          icon: '◈',
          active: location.pathname === '/retainers' || location.pathname.startsWith('/retainers/'),
          show: canViewRetainers,
        },
        {
          section: 'Billing',
          label: 'A / R',
          href: '/ar',
          icon: '$',
          active: location.pathname.startsWith('/ar'),
          show: can.ar,
        },

        // ---- Oversight: review + insight ----
        {
          section: 'Oversight',
          label: 'Approvals',
          href: '/approvals',
          icon: '✓',
          active: location.pathname.startsWith('/approvals'),
          show: can.approvals,
        },
        {
          section: 'Oversight',
          label: 'Reports',
          href: '/reports',
          icon: '▦',
          active: location.pathname.startsWith('/reports'),
          show: can.reports,
        },
        {
          section: 'Oversight',
          label: 'Alerts',
          href: '/alerts',
          icon: '⚠︎',
          active: location.pathname.startsWith('/alerts'),
          show: can.audit,
        },
        {
          section: 'Oversight',
          label: 'Audit',
          href: '/audit',
          icon: '⊙',
          active: location.pathname.startsWith('/audit'),
          show: can.audit,
        },

        // ---- Utility footer (divider, no header) ----
        {
          section: '',
          label: notifUnread > 0 ? `Notifications (${notifUnread})` : 'Notifications',
          href: '/notifications',
          icon: '🔔',
          active: location.pathname.startsWith('/notifications'),
          show: true,
        },
        {
          section: '',
          label: 'Admin',
          href: '/admin',
          icon: '⚙︎',
          active: location.pathname.startsWith('/admin'),
          show: can.admin,
        },
        {
          section: '',
          label: 'Help',
          href: '/help',
          icon: '❓',
          active: location.pathname.startsWith('/help'),
          show: true,
        },
        {
          section: '',
          label: 'Account',
          href: '/account',
          icon: '◐',
          active: location.pathname.startsWith('/account'),
          show: true,
        },
      ]
        .filter((i) => i.show)
        .map(({ label, href, icon, active, section }) => ({ label, href, icon, active, section }))}
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
