// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { tokens } from '@vibe/ui';

import { FirmSettingsPage } from './FirmSettings';
import { OfficesPage } from './Offices';
import { TaxonomyPage } from './Taxonomy';
import { UsersPage } from './Users';

const TABS = [
  { key: 'firm', label: 'Firm settings', href: '/admin/firm' },
  { key: 'offices', label: 'Offices', href: '/admin/offices' },
  { key: 'users', label: 'Users', href: '/admin/users' },
  { key: 'taxonomy', label: 'Taxonomy', href: '/admin/taxonomy' },
];

export function AdminLayout(): JSX.Element {
  const location = useLocation();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: tokens.space.xl }}>
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
      </Routes>
    </div>
  );
}
