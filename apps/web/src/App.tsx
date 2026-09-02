// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

import { AppShell, Button, FontSizeControl, Pill, ThemeToggle, tokens } from '@vibe/ui';
import {
  BadgeCheck,
  Banknote,
  Bell,
  Briefcase,
  Calculator,
  CalendarCheck,
  CalendarDays,
  ChartColumn,
  CircleHelp,
  CircleUser,
  Clock,
  CreditCard,
  FileQuestion,
  FileText,
  FolderInput,
  Hourglass,
  Inbox,
  Landmark,
  Layers,
  LayoutDashboard,
  ListTodo,
  MessageSquare,
  Receipt,
  Repeat,
  ScrollText,
  Settings,
  Signature,
  TriangleAlert,
  Users,
  Wallet,
} from 'lucide-react';

import { BRAND } from './brand';
import { api } from './api-client';
import { isDesktop, notifyDesktop } from './lib/desktop';
import { shouldNotifyInbound } from './lib/sms-notify';
import { SmsStreamProvider, useSmsStream } from './lib/sms-stream';

// Firm logo + product name in the shell header. The logo comes from the public
// branding endpoint (same one the portal/PDFs use); it renders nothing when no
// logo is uploaded, leaving just the product name.
function BrandMark(): JSX.Element {
  const [hasLogo, setHasLogo] = useState(true);
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {hasLogo && (
        <img
          src="/api/portal/branding/logo"
          alt=""
          onError={() => setHasLogo(false)}
          style={{ height: 24, maxWidth: 140, objectFit: 'contain' }}
        />
      )}
      <span>{BRAND}</span>
    </span>
  );
}

import { QuickFind } from './QuickFind';
import { TimerProvider } from './timer-context';
import { TimerChip } from './timer/TimerChip';

import { AuthProvider, useAuth, usePermission } from './auth-context';

// Route components are code-split: each page loads as its own async chunk
// on first navigation, keeping the initial (entry) bundle to the shell +
// router only. Heavy page-only deps (tiptap editor, dnd-kit, Stripe,
// pdf.js, charts) ride along in their route's chunk instead of the entry.
// `lazyPage` adapts a named page export to the default-export shape
// React.lazy expects.
// reason: dynamic-import modules expose many exports of varying types;
// pick the page by name and adapt it to a props-less component.
function lazyPage(
  loader: () => Promise<Record<string, unknown>>,
  exportName: string,
): LazyExoticComponent<ComponentType> {
  return lazy(() => loader().then((m) => ({ default: m[exportName] as ComponentType })));
}

const AccountPage = lazyPage(() => import('./pages/Account'), 'AccountPage');
const AdminLayout = lazyPage(() => import('./pages/admin'), 'AdminLayout');
const AlertsPage = lazyPage(() => import('./pages/Alerts'), 'AlertsPage');
const ApprovalsPage = lazyPage(() => import('./pages/Approvals'), 'ApprovalsPage');
const ArPage = lazyPage(() => import('./pages/Ar'), 'ArPage');
const ArByServiceLinePage = lazyPage(
  () => import('./pages/ArByServiceLine'),
  'ArByServiceLinePage',
);
const ArSnapshotsPage = lazyPage(() => import('./pages/ArSnapshots'), 'ArSnapshotsPage');
const AuditPage = lazyPage(() => import('./pages/Audit'), 'AuditPage');
const BillingBatchesPage = lazyPage(() => import('./pages/Billing'), 'BillingBatchesPage');
const ClientDetailPage = lazyPage(() => import('./pages/ClientDetail'), 'ClientDetailPage');
const ClientsPage = lazyPage(() => import('./pages/Clients'), 'ClientsPage');
const PeopleDirectoryPage = lazyPage(() => import('./pages/People'), 'PeopleDirectoryPage');
const PersonDetailPage = lazyPage(() => import('./pages/PersonDetail'), 'PersonDetailPage');
const DashboardPage = lazyPage(() => import('./pages/Dashboard'), 'DashboardPage');
const EngagementCreatePage = lazyPage(
  () => import('./pages/EngagementCreate'),
  'EngagementCreatePage',
);
const EngagementDetailPage = lazyPage(
  () => import('./pages/EngagementDetail'),
  'EngagementDetailPage',
);
const EngagementsPage = lazyPage(() => import('./pages/Engagements'), 'EngagementsPage');
const FilerPage = lazyPage(() => import('./pages/Filer'), 'FilerPage');
const ProposalsListPage = lazyPage(() => import('./pages/Proposals'), 'ProposalsListPage');
const ProposalCreatePage = lazyPage(() => import('./pages/ProposalCreate'), 'ProposalCreatePage');
const ProposalEditorPage = lazyPage(() => import('./pages/ProposalEditor'), 'ProposalEditorPage');
const ProposalPreviewPage = lazyPage(
  () => import('./pages/ProposalPreview'),
  'ProposalPreviewPage',
);
const SignaturesPage = lazyPage(() => import('./pages/Signatures'), 'SignaturesPage');
const SignatureDetailPage = lazyPage(
  () => import('./pages/SignatureDetail'),
  'SignatureDetailPage',
);
const MyCalendarPage = lazyPage(() => import('./pages/MyCalendar'), 'MyCalendarPage');
const TimeOffPage = lazyPage(() => import('./pages/TimeOff'), 'TimeOffPage');
const PayrollReviewPage = lazyPage(
  () => import('./pages/payroll/PayrollReview'),
  'PayrollReviewPage',
);
// FilesPage v1 removed (Phase 0 of file-manager rebuild); v2 ships in Phase 10.
const InvoiceDetailPage = lazyPage(() => import('./pages/InvoiceDetail'), 'InvoiceDetailPage');
const InvoicesPage = lazyPage(() => import('./pages/Invoices'), 'InvoicesPage');
const PaymentsPage = lazyPage(() => import('./pages/Payments'), 'PaymentsPage');
const LoginPage = lazyPage(() => import('./pages/Login'), 'LoginPage');
const MessagesPage = lazyPage(() => import('./pages/Messages'), 'MessagesPage');
const OnboardingPage = lazyPage(() => import('./pages/Onboarding'), 'OnboardingPage');
const HelpPage = lazyPage(() => import('./pages/Help'), 'HelpPage');
const IntakeInboxPage = lazyPage(() => import('./pages/IntakeInbox'), 'IntakeInboxPage');
const PaymentReceivePage = lazyPage(() => import('./pages/PaymentReceive'), 'PaymentReceivePage');
const ProfitabilityPage = lazyPage(() => import('./pages/Profitability'), 'ProfitabilityPage');
const ReportsPage = lazyPage(() => import('./pages/Reports'), 'ReportsPage');
const BillingRealizationReportPage = lazyPage(
  () => import('./pages/reports/BillingRealizationReport'),
  'BillingRealizationReportPage',
);
const PaymentsReceivedReportPage = lazyPage(
  () => import('./pages/reports/PaymentsReceivedReport'),
  'PaymentsReceivedReportPage',
);
const SignedFormsReportPage = lazyPage(
  () => import('./pages/reports/SignedFormsReport'),
  'SignedFormsReportPage',
);
const ReportViewerPage = lazyPage(() => import('./pages/reports/ReportViewer'), 'ReportViewerPage');
const EngagementLettersPage = lazyPage(
  () => import('./pages/admin/EngagementLetters'),
  'EngagementLettersPage',
);
const RecurringPlansPage = lazyPage(
  () => import('./pages/admin/RecurringPlans'),
  'RecurringPlansPage',
);
const RetainerDashboardPage = lazyPage(
  () => import('./pages/admin/RetainerDashboard'),
  'RetainerDashboardPage',
);
const RetainerDetailPage = lazyPage(
  () => import('./pages/admin/RetainerDetail'),
  'RetainerDetailPage',
);
const StaffRetainerDashboardPage = lazyPage(
  () => import('./pages/StaffRetainerDashboard'),
  'StaffRetainerDashboardPage',
);
const RequestsPage = lazyPage(() => import('./pages/Requests'), 'RequestsPage');
const RequestDetailPage = lazyPage(() => import('./pages/RequestDetail'), 'RequestDetailPage');
const TaxReturnDetailPage = lazyPage(
  () => import('./pages/TaxReturnDetail'),
  'TaxReturnDetailPage',
);
const TaxReturnsStaffPage = lazyPage(() => import('./pages/TaxReturns'), 'TaxReturnsStaffPage');
const AppointmentsPage = lazyPage(() => import('./pages/Appointments'), 'AppointmentsPage');
const StaffNotificationsPage = lazyPage(() => import('./pages/Notifications'), 'NotificationsPage');
const TasksPage = lazyPage(() => import('./pages/Tasks'), 'TasksPage');
const TimeEntryPage = lazyPage(() => import('./pages/TimeEntry'), 'TimeEntryPage');
const TotpEnrollPage = lazyPage(() => import('./pages/TotpEnroll'), 'TotpEnrollPage');
const WipDashboardPage = lazyPage(() => import('./pages/Wip'), 'WipDashboardPage');

export function App(): JSX.Element {
  return (
    <AuthProvider>
      <Suspense fallback={<FullPageMsg>Loading…</FullPageMsg>}>
        <Routes>
          <Route path="/auth/login" element={<LoginPage />} />
          <Route path="/auth/verify" element={<LoginPage />} />
          <Route path="/auth/reset-password" element={<LoginPage />} />
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
                    <Route path="/time-off" element={<TimeOffPage />} />
                    <Route path="/payroll/review" element={<PayrollReviewPage />} />
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
                    <Route
                      path="/reports/billing-realization"
                      element={<BillingRealizationReportPage />}
                    />
                    <Route path="/reports/view/:kind" element={<ReportViewerPage />} />
                    <Route path="/engagement-letters" element={<EngagementLettersPage />} />
                    <Route path="/recurring-plans" element={<RecurringPlansPage />} />
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
      </Suspense>
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
  const { me } = useAuth();
  const navigate = useNavigate();
  const canSmsStream = usePermission('messaging:read');
  const meId = me?.appUserId ?? null;
  const seenRef = useRef(new Set<string>());
  // 0234 / D13a — desktop or browser notification for an inbound text that
  // is assigned to me (or unassigned), unless that thread is open right now.
  const onInbound = useCallback(
    (
      evt: { conversationId: string; messageId?: string },
      ctx: { activeConversationId: string | null },
      enabled: boolean,
    ): void => {
      if (!enabled || !meId) return;
      if (ctx.activeConversationId === evt.conversationId && document.visibilityState === 'visible')
        return;
      void api<{
        assignedUser: { id: string } | null;
        contact: { name: string } | null;
        externalNumberE164: string;
        lastMessagePreview: string;
      }>(`/api/staff/sms/conversations/${evt.conversationId}`)
        .then((d) => {
          if (
            !shouldNotifyInbound(
              {
                conversationId: evt.conversationId,
                messageId: evt.messageId,
                assignedUserId: d.assignedUser?.id ?? null,
              },
              meId,
              seenRef.current,
            )
          ) {
            return;
          }
          const who = d.contact?.name ?? d.externalNumberE164;
          void notifyDesktop(`Text from ${who}`, d.lastMessagePreview || '(attachment)', {
            tag: `sms-${evt.conversationId}`,
            onClick: () => navigate(`/messages?tab=sms&c=${evt.conversationId}`),
          });
        })
        .catch(() => undefined);
    },
    [meId, navigate],
  );
  return (
    <SmsStreamProvider
      enabled={canSmsStream}
      meId={meId}
      defaultNotify={isDesktop()}
      onInbound={(evt, ctx, enabled) => onInbound(evt, ctx, enabled)}
    >
      <ShellInner>{children}</ShellInner>
    </SmsStreamProvider>
  );
}

function ShellInner({ children }: { children: ReactNode }): JSX.Element {
  const { logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
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
    timeOff: usePermission('time_off:request:own'),
    payroll: usePermission('payroll:period:read'),
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
    // 0234 — SMS inbox rides on the messaging keys until Phase 11 adds sms:*.
    sms: usePermission('messaging:read'),
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
  const smsUnread = useSmsStream().unread;
  const [notifUnread, setNotifUnread] = useState(0);
  // New/unhandled counts that drive the orange nav highlight for Requests
  // (open) and Intake (received but not yet processed).
  const [requestsNew, setRequestsNew] = useState(0);
  const [intakeNew, setIntakeNew] = useState(0);
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
      if (can.requests) {
        void api<{ count: number }>('/api/staff/requests/client-responses/unread-count')
          .then((r) => {
            if (alive) setRequestsNew(r.count ?? 0);
          })
          .catch(() => undefined);
      }
      if (can.intake) {
        // Unread received submissions — the lightweight count endpoint
        // (the old poll fetched + decrypted the whole session list).
        void api<{ received: number; unread: number }>('/api/staff/intake/count')
          .then((r) => {
            if (alive) setIntakeNew(r.unread ?? r.received ?? 0);
          })
          .catch(() => undefined);
      }
    };
    poll();
    const t = setInterval(poll, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [location.pathname, can.appointments, can.requests, can.intake]);
  return (
    <TimerProvider>
      <AppShell
        brand={<BrandMark />}
        collapseStorageKey="__vibe_staff_sidebar_collapsed"
        collapsibleSections
        onNavigate={(href) => navigate(href)}
        realmBadge={<Pill tone="accent">staff</Pill>}
        nav={[
          {
            label: 'Dashboard',
            href: '/',
            icon: <LayoutDashboard size={16} />,
            active: location.pathname === '/',
            show: true,
          },

          // ---- Work: who you serve, the work, your time + schedule ----
          {
            section: 'Work',
            label: 'Clients',
            href: '/clients',
            icon: <Briefcase size={16} />,
            active: location.pathname.startsWith('/clients'),
            show: can.clients,
          },
          {
            section: 'Work',
            label: 'People',
            href: '/people',
            icon: <Users size={16} />,
            active: location.pathname.startsWith('/people'),
            show: can.clients,
          },
          {
            section: 'Work',
            label: 'Engagements',
            href: '/engagements',
            icon: <Layers size={16} />,
            active: location.pathname.startsWith('/engagements'),
            show: can.engagements,
          },
          {
            section: 'Work',
            label: 'Time',
            href: '/time',
            icon: <Clock size={16} />,
            active: location.pathname === '/time',
            show: can.time,
          },
          {
            section: 'Work',
            label: 'Time off',
            href: '/time-off',
            icon: <CalendarDays size={16} />,
            active: location.pathname.startsWith('/time-off'),
            show: can.timeOff,
          },
          {
            section: 'Work',
            label: 'Tasks',
            href: '/tasks',
            icon: <ListTodo size={16} />,
            active: location.pathname.startsWith('/tasks'),
            show: can.tasks,
          },
          {
            section: 'Work',
            label: 'Appointments',
            href: '/appointments',
            icon: <CalendarCheck size={16} />,
            active: location.pathname.startsWith('/appointments'),
            show: can.appointments,
          },
          {
            section: 'Work',
            label: 'My calendar',
            href: '/calendar/mine',
            icon: <CalendarDays size={16} />,
            active: location.pathname.startsWith('/calendar/mine'),
            show: can.appointments,
          },
          {
            section: 'Work',
            label: teamUnread + smsUnread > 0 ? `Messages (${teamUnread + smsUnread})` : 'Messages',
            href: '/messages',
            icon: <MessageSquare size={16} />,
            active:
              location.pathname.startsWith('/messages') || location.pathname.startsWith('/team'),
            show: can.messages,
            hasUnread: teamUnread + smsUnread > 0,
          },

          // ---- Documents: outbound (proposals/e-sign) + inbound ----
          {
            section: 'Documents',
            label: 'Proposals',
            href: '/proposals',
            icon: <FileText size={16} />,
            active: location.pathname.startsWith('/proposals'),
            show: can.proposals,
          },
          {
            section: 'Documents',
            label: 'Signatures',
            href: '/signatures',
            icon: <Signature size={16} />,
            active: location.pathname.startsWith('/signatures'),
            show: can.signatures,
          },
          {
            section: 'Documents',
            label: 'Requests',
            href: '/requests',
            icon: <FileQuestion size={16} />,
            active: location.pathname.startsWith('/requests'),
            show: can.requests,
            hasUnread: requestsNew > 0,
          },
          {
            section: 'Documents',
            label: 'Intake',
            href: '/intake',
            icon: <Inbox size={16} />,
            active: location.pathname.startsWith('/intake'),
            show: can.intake,
            hasUnread: intakeNew > 0,
          },
          {
            section: 'Documents',
            label: 'Document Inbox',
            href: '/filer',
            icon: <FolderInput size={16} />,
            active: location.pathname.startsWith('/filer'),
            show: can.filer,
          },
          {
            section: 'Documents',
            label: 'Tax returns',
            href: '/tax/returns',
            icon: <Landmark size={16} />,
            active: location.pathname.startsWith('/tax/returns'),
            show: can.tax,
          },

          // ---- Billing: WIP → pre-bills → invoices → retainers → A/R ----
          {
            section: 'Billing',
            label: 'WIP',
            href: '/wip',
            icon: <Hourglass size={16} />,
            active: location.pathname.startsWith('/wip'),
            show: can.wip,
          },
          {
            section: 'Billing',
            label: 'Billing',
            href: '/billing',
            icon: <Calculator size={16} />,
            active: location.pathname.startsWith('/billing'),
            show: can.billing,
          },
          {
            section: 'Billing',
            label: 'Invoices',
            href: '/invoices',
            icon: <Receipt size={16} />,
            active: location.pathname.startsWith('/invoices'),
            show: can.invoices,
          },
          {
            section: 'Billing',
            label: 'Payments',
            href: '/payments',
            icon: <CreditCard size={16} />,
            active: location.pathname === '/payments',
            show: can.payments,
          },
          {
            section: 'Billing',
            label: 'Retainers',
            href: '/retainers',
            icon: <Wallet size={16} />,
            active:
              location.pathname === '/retainers' || location.pathname.startsWith('/retainers/'),
            show: canViewRetainers,
          },
          {
            section: 'Billing',
            label: 'A / R',
            href: '/ar',
            icon: <Banknote size={16} />,
            active: location.pathname.startsWith('/ar'),
            show: can.ar,
          },
          {
            section: 'Billing',
            label: 'Recurring plans',
            href: '/recurring-plans',
            icon: <Repeat size={16} />,
            active: location.pathname.startsWith('/recurring-plans'),
            show: can.engagements,
          },

          // ---- Oversight: review + insight ----
          {
            section: 'Oversight',
            label: 'Approvals',
            href: '/approvals',
            icon: <BadgeCheck size={16} />,
            active: location.pathname.startsWith('/approvals'),
            show: can.approvals,
          },
          {
            section: 'Oversight',
            label: 'Reports',
            href: '/reports',
            icon: <ChartColumn size={16} />,
            active: location.pathname.startsWith('/reports'),
            show: can.reports,
          },
          {
            section: 'Oversight',
            label: 'Payroll review',
            href: '/payroll/review',
            icon: <Clock size={16} />,
            active: location.pathname.startsWith('/payroll'),
            show: can.payroll,
          },
          {
            section: 'Oversight',
            label: 'Alerts',
            href: '/alerts',
            icon: <TriangleAlert size={16} />,
            active: location.pathname.startsWith('/alerts'),
            show: can.audit,
          },
          {
            section: 'Oversight',
            label: 'Audit',
            href: '/audit',
            icon: <ScrollText size={16} />,
            active: location.pathname.startsWith('/audit'),
            show: can.audit,
          },
          {
            section: 'Oversight',
            label: 'Engagement letters',
            href: '/engagement-letters',
            icon: <FileText size={16} />,
            active: location.pathname.startsWith('/engagement-letters'),
            show: can.engagements,
          },

          // ---- Utility footer (divider, no header) ----
          {
            section: '',
            label: notifUnread > 0 ? `Notifications (${notifUnread})` : 'Notifications',
            href: '/notifications',
            icon: <Bell size={16} />,
            active: location.pathname.startsWith('/notifications'),
            show: true,
          },
          {
            section: '',
            label: 'Admin',
            href: '/admin',
            icon: <Settings size={16} />,
            active: location.pathname.startsWith('/admin'),
            show: can.admin,
          },
          {
            section: '',
            label: 'Help',
            href: '/help',
            icon: <CircleHelp size={16} />,
            active: location.pathname.startsWith('/help'),
            show: true,
          },
          {
            section: '',
            label: 'Account',
            href: '/account',
            icon: <CircleUser size={16} />,
            active: location.pathname.startsWith('/account'),
            show: true,
          },
        ]
          .filter((i) => i.show)
          .map((i) => ({
            label: i.label,
            href: i.href,
            icon: i.icon,
            active: i.active,
            section: i.section,
            hasUnread: (i as { hasUnread?: boolean }).hasUnread,
          }))}
        navExtra={(collapsed: boolean) => <TimerChip collapsed={collapsed} />}
        mobileBarExtra={<TimerChip bar />}
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
        <Suspense fallback={<RouteFallback />}>{children}</Suspense>
        <QuickFind />
      </AppShell>
    </TimerProvider>
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
