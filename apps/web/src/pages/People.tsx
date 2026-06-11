// SPDX-License-Identifier: Elastic-2.0
//
// Firm-wide People directory (0115 follow-up). One searchable table of
// every human in the firm — directory contacts plus standalone portal
// logins — with a Portal column showing whether they have any active
// portal access. Click through to a person to edit them and manage their
// per-client portal access.
//
// Backed by GET /api/staff/people.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface PersonRow {
  key: string;
  kind: 'person' | 'portal_identity';
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  status: string;
  hasPortalAccess: boolean;
  clientCount: number;
}

export function PeopleDirectoryPage(): JSX.Element {
  const navigate = useNavigate();
  const [rows, setRows] = useState<PersonRow[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(true);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      const r = await api<{ rows: PersonRow[]; total: number }>(
        `/api/staff/people?${params.toString()}`,
      );
      setRows(r.rows ?? []);
      setTotal(r.total ?? 0);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <Card title="People">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            void load();
          }}
          style={{ display: 'grid', gap: 8, gridTemplateColumns: '1fr auto' }}
        >
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, email or phone"
          />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
      </Card>

      <Card
        title={`Results — ${total.toLocaleString()} ${total === 1 ? 'person' : 'people'}`}
        action={
          <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              Page size
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                aria-label="Page size"
                style={{ padding: '4px 6px', borderRadius: tokens.radius.sm }}
              >
                <option value={50}>50</option>
                <option value={100}>100</option>
                <option value={200}>200</option>
              </select>
            </label>
            <Button
              size="sm"
              variant="ghost"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ← Prev
            </Button>
            <span style={{ color: tokens.color.textMuted }}>
              Page {page} / {pageCount}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={page >= pageCount}
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            >
              Next →
            </Button>
          </span>
        }
      >
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table<PersonRow>
            columns={[
              {
                key: 'name',
                header: 'Name',
                render: (p) => (
                  <a
                    href={`/people/${p.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/people/${p.id}`);
                    }}
                  >
                    {p.fullName}
                  </a>
                ),
              },
              { key: 'email', header: 'Email', render: (p) => p.email ?? '—' },
              { key: 'phone', header: 'Phone', render: (p) => p.phone ?? '—' },
              {
                key: 'clients',
                header: 'Clients',
                align: 'right',
                render: (p) => p.clientCount,
              },
              {
                key: 'portal',
                header: 'Portal',
                render: (p) =>
                  p.hasPortalAccess ? (
                    <Pill tone="success">Enabled</Pill>
                  ) : (
                    <Pill tone="neutral">—</Pill>
                  ),
              },
              {
                key: 'kind',
                header: '',
                render: (p) =>
                  p.kind === 'portal_identity' ? <Pill tone="warning">Portal-only</Pill> : null,
              },
            ]}
            rows={rows}
            rowKey={(p) => p.key}
            empty="No people match the current search."
          />
        )}
      </Card>
    </div>
  );
}
