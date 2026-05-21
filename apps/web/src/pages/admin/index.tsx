// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { tokens } from '@vibe/ui';

import { AiUsagePage } from './AiUsage';
import { ApiTokensPage } from './ApiTokens';
import { BackupPage } from './Backup';
import { CompliancePage } from './Compliance';
import { ApprovalRulesPage } from './ApprovalRules';
import { EngagementLettersPage } from './EngagementLetters';
import { FirmSettingsPage } from './FirmSettings';
import { HolidaysPage } from './Holidays';
import { HourBanksPage } from './HourBanks';
import { HourBankTxPage } from './HourBankTx';
import { JobsPage } from './Jobs';
import { MilestonesPage } from './Milestones';
import { NotificationsPage } from './Notifications';
import { OfficesPage } from './Offices';
import { PermissionMatrixPage } from './PermissionMatrix';
import { RatesPage } from './Rates';
import { RecurringPlansPage } from './RecurringPlans';
import { RequiredFieldRulesPage } from './RequiredFieldRules';
import { RolesPage } from './Roles';
import { SavedReportsPage } from './SavedReports';
import { TaxonomyPage } from './Taxonomy';
import { TemplatesPage } from './Templates';
import { UsersPage } from './Users';
import { WebhooksPage } from './Webhooks';

const TABS = [
  { key: 'firm', label: 'Firm settings', href: '/admin/firm' },
  { key: 'offices', label: 'Offices', href: '/admin/offices' },
  { key: 'users', label: 'Users', href: '/admin/users' },
  { key: 'taxonomy', label: 'Taxonomy', href: '/admin/taxonomy' },
  { key: 'tpl', label: 'Templates', href: '/admin/templates' },
  { key: 'rates', label: 'Rates', href: '/admin/rates' },
  { key: 'plans', label: 'Recurring plans', href: '/admin/recurring-plans' },
  { key: 'banks', label: 'Hour banks', href: '/admin/hour-banks' },
  { key: 'banks-tx', label: 'Hour-bank tx', href: '/admin/hour-bank-tx' },
  { key: 'holidays', label: 'Holidays', href: '/admin/holidays' },
  { key: 'letters', label: 'Engagement letters', href: '/admin/letters' },
  { key: 'rules', label: 'Approval rules', href: '/admin/approval-rules' },
  { key: 'rfr', label: 'Required fields', href: '/admin/required-fields' },
  { key: 'milestones', label: 'Milestones', href: '/admin/milestones' },
  { key: 'ai', label: 'AI usage', href: '/admin/ai-usage' },
  { key: 'saved', label: 'Saved reports', href: '/admin/saved-reports' },
  { key: 'webhooks', label: 'Webhooks', href: '/admin/webhooks' },
  { key: 'perms', label: 'Permissions', href: '/admin/permissions' },
  { key: 'roles', label: 'Roles', href: '/admin/roles' },
  { key: 'notifs', label: 'Notifications', href: '/admin/notifications' },
  { key: 'jobs', label: 'Jobs', href: '/admin/jobs' },
  { key: 'backup', label: 'Backup', href: '/admin/backup' },
  { key: 'compliance', label: 'Compliance', href: '/admin/compliance' },
  { key: 'mcp-tokens', label: 'API tokens', href: '/admin/api-tokens' },
];

export function AdminLayout(): JSX.Element {
  const location = useLocation();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: tokens.space.xl }}>
      <nav style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {TABS.map((t) => {
          const active = location.pathname.startsWith(t.href);
          return (
            <a
              key={t.key}
              href={t.href}
              style={{
                fontSize: 13,
                padding: '8px 10px',
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
      </nav>
      <Routes>
        <Route path="/" element={<Navigate to="/admin/firm" replace />} />
        <Route path="firm" element={<FirmSettingsPage />} />
        <Route path="offices" element={<OfficesPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="taxonomy/*" element={<TaxonomyPage />} />
        <Route path="templates" element={<TemplatesPage />} />
        <Route path="rates" element={<RatesPage />} />
        <Route path="recurring-plans" element={<RecurringPlansPage />} />
        <Route path="hour-banks" element={<HourBanksPage />} />
        <Route path="hour-bank-tx" element={<HourBankTxPage />} />
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
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="backup" element={<BackupPage />} />
        <Route path="compliance" element={<CompliancePage />} />
        <Route path="api-tokens" element={<ApiTokensPage />} />
      </Routes>
    </div>
  );
}
