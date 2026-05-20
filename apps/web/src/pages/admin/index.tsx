// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { tokens } from '@vibe/ui';

import { AiUsagePage } from './AiUsage';
import { ApprovalRulesPage } from './ApprovalRules';
import { EngagementLettersPage } from './EngagementLetters';
import { FirmSettingsPage } from './FirmSettings';
import { HolidaysPage } from './Holidays';
import { HourBanksPage } from './HourBanks';
import { JobsPage } from './Jobs';
import { MilestonesPage } from './Milestones';
import { OfficesPage } from './Offices';
import { RecurringPlansPage } from './RecurringPlans';
import { RequiredFieldRulesPage } from './RequiredFieldRules';
import { TaxonomyPage } from './Taxonomy';
import { UsersPage } from './Users';

const TABS = [
  { key: 'firm', label: 'Firm settings', href: '/admin/firm' },
  { key: 'offices', label: 'Offices', href: '/admin/offices' },
  { key: 'users', label: 'Users', href: '/admin/users' },
  { key: 'taxonomy', label: 'Taxonomy', href: '/admin/taxonomy' },
  { key: 'plans', label: 'Recurring plans', href: '/admin/recurring-plans' },
  { key: 'banks', label: 'Hour banks', href: '/admin/hour-banks' },
  { key: 'holidays', label: 'Holidays', href: '/admin/holidays' },
  { key: 'letters', label: 'Engagement letters', href: '/admin/letters' },
  { key: 'rules', label: 'Approval rules', href: '/admin/approval-rules' },
  { key: 'rfr', label: 'Required fields', href: '/admin/required-fields' },
  { key: 'milestones', label: 'Milestones', href: '/admin/milestones' },
  { key: 'ai', label: 'AI usage', href: '/admin/ai-usage' },
  { key: 'jobs', label: 'Jobs', href: '/admin/jobs' },
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
        <Route path="recurring-plans" element={<RecurringPlansPage />} />
        <Route path="hour-banks" element={<HourBanksPage />} />
        <Route path="holidays" element={<HolidaysPage />} />
        <Route path="letters" element={<EngagementLettersPage />} />
        <Route path="approval-rules" element={<ApprovalRulesPage />} />
        <Route path="required-fields" element={<RequiredFieldRulesPage />} />
        <Route path="milestones" element={<MilestonesPage />} />
        <Route path="ai-usage" element={<AiUsagePage />} />
        <Route path="jobs" element={<JobsPage />} />
      </Routes>
    </div>
  );
}
