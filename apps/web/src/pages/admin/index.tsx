// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Admin layout (v2 Sprint E). The flat 26-tab sidebar collapses into
// 7 semantic groups: Firm / People / Catalog / Billing / Messaging /
// AI & Integrations / Operations. Collapsed state is persisted per
// user in localStorage.

import { useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { tokens } from '@vibe/ui';

import { AiUsagePage } from './AiUsage';
import { ApiTokensPage } from './ApiTokens';
import { BackupPage } from './Backup';
import { CompliancePage } from './Compliance';
import { ApprovalRulesPage } from './ApprovalRules';
import { EngagementLettersPage } from './EngagementLetters';
import { EngagementStatusesPage } from './EngagementStatuses';
import { FirmSettingsPage } from './FirmSettings';
import { HolidaysPage } from './Holidays';
import { HourBanksPage } from './HourBanks';
import { HourBankTxPage } from './HourBankTx';
import { JobsPage } from './Jobs';
import { MilestonesPage } from './Milestones';
import { MessagingPage } from './Messaging';
import { NotificationsPage } from './Notifications';
import { NotificationTemplatesPage } from './NotificationTemplates';
import { OfficesPage } from './Offices';
import { PermissionMatrixPage } from './PermissionMatrix';
import { RateCodesPage } from './RateCodes';
import { RatesPage } from './Rates';
import { RecurringPlansPage } from './RecurringPlans';
import { RetainerDashboardPage } from './RetainerDashboard';
import { RetainerDetailPage } from './RetainerDetail';
import { RetainerTierSettingsPage } from './RetainerTierSettings';
import { RequiredFieldRulesPage } from './RequiredFieldRules';
import { RolesPage } from './Roles';
import { SavedReportsPage } from './SavedReports';
import { StorageOnboardingPage } from './StorageOnboarding';
import { TaxonomyPage } from './Taxonomy';
import { TemplatesPage } from './Templates';
import { UsersPage } from './Users';
import { UserDetailPage } from './UserDetail';
import { WebhooksPage } from './Webhooks';

interface Tab {
  key: string;
  label: string;
  href: string;
}

interface Group {
  key: string;
  label: string;
  tabs: Tab[];
  defaultOpen?: boolean;
}

const GROUPS: Group[] = [
  {
    key: 'firm',
    label: 'Firm',
    defaultOpen: true,
    tabs: [
      { key: 'firm', label: 'Settings', href: '/admin/firm' },
      { key: 'offices', label: 'Offices', href: '/admin/offices' },
      { key: 'holidays', label: 'Holidays', href: '/admin/holidays' },
    ],
  },
  {
    key: 'people',
    label: 'People',
    tabs: [
      { key: 'users', label: 'Users', href: '/admin/users' },
      { key: 'roles', label: 'Roles', href: '/admin/roles' },
      { key: 'perms', label: 'Permissions', href: '/admin/permissions' },
    ],
  },
  {
    key: 'catalog',
    label: 'Catalog',
    tabs: [
      { key: 'taxonomy', label: 'Taxonomy', href: '/admin/taxonomy' },
      { key: 'statuses', label: 'Engagement statuses', href: '/admin/engagement-statuses' },
      { key: 'tpl', label: 'Templates', href: '/admin/templates' },
      { key: 'milestones', label: 'Milestones', href: '/admin/milestones' },
      { key: 'letters', label: 'Engagement letters', href: '/admin/letters' },
    ],
  },
  {
    key: 'billing',
    label: 'Billing',
    defaultOpen: true,
    tabs: [
      { key: 'rate-codes', label: 'Rate codes', href: '/admin/rate-codes' },
      { key: 'rates', label: 'Rates', href: '/admin/rates' },
      { key: 'plans', label: 'Recurring plans', href: '/admin/recurring-plans' },
      { key: 'banks', label: 'Hour banks', href: '/admin/hour-banks' },
      { key: 'banks-tx', label: 'Hour-bank tx', href: '/admin/hour-bank-tx' },
      { key: 'retainer-tiers', label: 'Retainer tiers', href: '/admin/retainer-tiers' },
      { key: 'retainers', label: 'Retainers', href: '/admin/retainers' },
      { key: 'rules', label: 'Approval rules', href: '/admin/approval-rules' },
      { key: 'rfr', label: 'Required fields', href: '/admin/required-fields' },
    ],
  },
  {
    key: 'messaging',
    label: 'Messaging',
    tabs: [
      { key: 'messaging', label: 'Email + SMS providers', href: '/admin/messaging' },
      { key: 'notif-tpl', label: 'Notification templates', href: '/admin/notification-templates' },
      { key: 'notifs', label: 'Notifications log', href: '/admin/notifications' },
      { key: 'webhooks', label: 'Webhooks', href: '/admin/webhooks' },
    ],
  },
  {
    key: 'ai',
    label: 'AI & Integrations',
    tabs: [
      { key: 'ai', label: 'AI usage', href: '/admin/ai-usage' },
      { key: 'mcp-tokens', label: 'API tokens', href: '/admin/api-tokens' },
      { key: 'saved', label: 'Saved reports', href: '/admin/saved-reports' },
    ],
  },
  {
    key: 'ops',
    label: 'Operations',
    tabs: [
      { key: 'jobs', label: 'Jobs', href: '/admin/jobs' },
      { key: 'backup', label: 'Backup', href: '/admin/backup' },
      { key: 'compliance', label: 'Compliance', href: '/admin/compliance' },
      { key: 'storage', label: 'Storage onboarding', href: '/admin/storage' },
    ],
  },
];

const COLLAPSED_KEY = '__vibe_admin_collapsed';

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function saveCollapsed(collapsed: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(collapsed)));
  } catch {
    // Non-fatal.
  }
}

export function AdminLayout(): JSX.Element {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const initial = loadCollapsed();
    // Start with non-default-open groups collapsed if no preference saved.
    if (initial.size === 0 && !localStorage.getItem(COLLAPSED_KEY)) {
      for (const g of GROUPS) {
        if (!g.defaultOpen) initial.add(g.key);
      }
    }
    return initial;
  });

  function toggle(key: string): void {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(next);
    saveCollapsed(next);
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: tokens.space.xl }}>
      <nav aria-label="Admin" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {GROUPS.map((g) => {
          const isCollapsed = collapsed.has(g.key);
          const hasActive = g.tabs.some((t) => location.pathname.startsWith(t.href));
          return (
            <div key={g.key}>
              <button
                type="button"
                onClick={() => toggle(g.key)}
                aria-expanded={!isCollapsed}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  background: 'transparent',
                  border: 'none',
                  color: tokens.color.textMuted,
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  padding: '6px 10px',
                  cursor: 'pointer',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontWeight: hasActive ? 600 : 400,
                }}
              >
                <span>{g.label}</span>
                <span style={{ fontSize: 14 }}>{isCollapsed ? '▸' : '▾'}</span>
              </button>
              {!isCollapsed && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {g.tabs.map((t) => {
                    const active = location.pathname.startsWith(t.href);
                    return (
                      <a
                        key={t.key}
                        href={t.href}
                        style={{
                          fontSize: 13,
                          padding: '6px 14px',
                          borderRadius: tokens.radius.sm,
                          background: active ? tokens.color.accentMuted : 'transparent',
                          color: active ? tokens.color.accent : tokens.color.text,
                          textDecoration: 'none',
                        }}
                      >
                        {t.label}
                      </a>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <Routes>
        <Route path="/" element={<Navigate to="/admin/firm" replace />} />
        <Route path="firm" element={<FirmSettingsPage />} />
        <Route path="offices" element={<OfficesPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="users/:id" element={<UserDetailPage />} />
        <Route path="taxonomy/*" element={<TaxonomyPage />} />
        <Route path="engagement-statuses" element={<EngagementStatusesPage />} />
        <Route path="templates" element={<TemplatesPage />} />
        <Route path="rate-codes" element={<RateCodesPage />} />
        <Route path="rates" element={<RatesPage />} />
        <Route path="recurring-plans" element={<RecurringPlansPage />} />
        <Route path="hour-banks" element={<HourBanksPage />} />
        <Route path="hour-bank-tx" element={<HourBankTxPage />} />
        <Route path="retainer-tiers" element={<RetainerTierSettingsPage />} />
        <Route path="retainers" element={<RetainerDashboardPage />} />
        <Route path="retainers/:id" element={<RetainerDetailPage />} />
        <Route path="holidays" element={<HolidaysPage />} />
        <Route path="letters" element={<EngagementLettersPage />} />
        <Route path="approval-rules" element={<ApprovalRulesPage />} />
        <Route path="required-fields" element={<RequiredFieldRulesPage />} />
        <Route path="milestones" element={<MilestonesPage />} />
        <Route path="ai-usage" element={<AiUsagePage />} />
        <Route path="saved-reports" element={<SavedReportsPage />} />
        <Route path="webhooks" element={<WebhooksPage />} />
        <Route path="permissions" element={<PermissionMatrixPage />} />
        <Route path="roles" element={<RolesPage />} />
        <Route path="messaging" element={<MessagingPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="notification-templates" element={<NotificationTemplatesPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="backup" element={<BackupPage />} />
        <Route path="compliance" element={<CompliancePage />} />
        <Route path="api-tokens" element={<ApiTokensPage />} />
        <Route path="storage" element={<StorageOnboardingPage />} />
      </Routes>
    </div>
  );
}
