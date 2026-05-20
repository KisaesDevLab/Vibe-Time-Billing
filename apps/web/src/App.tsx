// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { AppShell, Button, Pill } from '@vibe/ui';

import { AccountPage } from './pages/Account';
import { AdminLayout } from './pages/admin';
import { ApprovalsPage } from './pages/Approvals';
import { ArPage } from './pages/Ar';
import { AuditPage } from './pages/Audit';
import { AuthProvider, useAuth } from './auth-context';
import { BillingBatchesPage } from './pages/Billing';
import { ClientDetailPage } from './pages/ClientDetail';
import { ClientsPage } from './pages/Clients';
import { DashboardPage } from './pages/Dashboard';
import { EngagementDetailPage } from './pages/EngagementDetail';
import { InvoicesPage } from './pages/Invoices';
import { LoginPage } from './pages/Login';
import { ReportsPage } from './pages/Reports';
import { TimeEntryPage } from './pages/TimeEntry';
import { TotpEnrollPage } from './pages/TotpEnroll';
import { WipDashboardPage } from './pages/Wip';

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
                  <Route path="/clients" element={<ClientsPage />} />
                  <Route path="/clients/:id" element={<ClientDetailPage />} />
                  <Route path="/engagements/:id" element={<EngagementDetailPage />} />
                  <Route path="/time" element={<TimeEntryPage />} />
                  <Route path="/billing/*" element={<BillingBatchesPage />} />
                  <Route path="/wip" element={<WipDashboardPage />} />
                  <Route path="/invoices" element={<InvoicesPage />} />
                  <Route path="/ar" element={<ArPage />} />
                  <Route path="/approvals" element={<ApprovalsPage />} />
                  <Route path="/audit" element={<AuditPage />} />
                  <Route path="/reports" element={<ReportsPage />} />
                  <Route path="/account" element={<AccountPage />} />
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
  return (
    <AppShell
      brand="Vibe Time & Billing"
      realmBadge={<Pill tone="accent">staff</Pill>}
      nav={[
        { label: 'Dashboard', href: '/', active: location.pathname === '/' },
        { label: 'Clients', href: '/clients', active: location.pathname.startsWith('/clients') },
        { label: 'Time', href: '/time', active: location.pathname.startsWith('/time') },
        { label: 'Billing', href: '/billing', active: location.pathname.startsWith('/billing') },
        { label: 'WIP', href: '/wip', active: location.pathname.startsWith('/wip') },
        {
          label: 'Invoices',
          href: '/invoices',
          active: location.pathname.startsWith('/invoices'),
        },
        { label: 'AR', href: '/ar', active: location.pathname.startsWith('/ar') },
        {
          label: 'Approvals',
          href: '/approvals',
          active: location.pathname.startsWith('/approvals'),
        },
        { label: 'Reports', href: '/reports', active: location.pathname.startsWith('/reports') },
        { label: 'Audit', href: '/audit', active: location.pathname.startsWith('/audit') },
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
