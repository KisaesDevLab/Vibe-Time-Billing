// SPDX-License-Identifier: Elastic-2.0
//
// Firm-wide People directory (0115 follow-up). One table of every human in
// the firm — directory contacts plus standalone portal logins — with a
// Portal column showing whether they have any active portal access. Click
// through to a person to edit them and manage their per-client portal
// access.
//
// Standard table view: loads the full firm set once, then filter / sort /
// search run client-side via useColumnView + ColumnFilter headers +
// TableSearch (see apps/web/src/lib/column-view.ts). Backed by
// GET /api/staff/people.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Card, ColumnFilter, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { usePermission } from '../auth-context';
import { TableSearch } from '../components/TableSearch';
import { useColumnView, viewToPagedQuery } from '../lib/column-view';
import { usePagedList } from '../lib/use-paged-list';

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

const PORTAL_VALUES = [
  { value: 'yes', label: 'Enabled' },
  { value: 'no', label: 'None' },
];
const KIND_VALUES = [
  { value: 'person', label: 'Directory contact' },
  { value: 'portal_identity', label: 'Portal-only' },
];

export function PeopleDirectoryPage(): JSX.Element {
  const navigate = useNavigate();
  const [viewAsBusy, setViewAsBusy] = useState<string | null>(null);
  // Mirrors the impersonate endpoint's gate (engagement:read).
  const canViewAs = usePermission('engagement:read');

  // Filter/sort/search state (sessionStorage-persisted); filtering, sorting,
  // and paging run SERVER-side. `.v2` drops stale pre-migration state.
  const view = useColumnView('vibe.people.view.v2', { sortCol: 'name', sortDir: 'asc' });
  const query = useMemo(
    () => viewToPagedQuery(view, { filterMap: { portal: 'portal', kind: 'kind' } }),
    [view],
  );
  const list = usePagedList<PersonRow>('/api/staff/people', { query });
  const loading = list.loading;

  // The list row doesn't carry access ids, so resolve them on demand:
  // exactly one ACTIVE access → open the portal directly; several →
  // land on the person page where each client has its own button.
  async function viewAs(p: PersonRow): Promise<void> {
    setViewAsBusy(p.key);
    try {
      const detail = await api<{
        clients: Array<{ clientId: string; accessId: string | null; accessStatus: string | null }>;
      }>(`/api/staff/people/${p.id}`);
      const active = (detail.clients ?? []).filter(
        (c) => c.accessStatus === 'ACTIVE' && c.accessId,
      );
      if (active.length === 1) {
        const r = await api<{ portalUrl: string }>(
          `/api/staff/clients/${active[0]!.clientId}/impersonate`,
          { method: 'POST', body: JSON.stringify({ accessId: active[0]!.accessId }) },
        );
        window.open(r.portalUrl, '_blank', 'noopener,noreferrer');
      } else {
        navigate(`/people/${p.id}`);
      }
    } catch {
      navigate(`/people/${p.id}`);
    } finally {
      setViewAsBusy(null);
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <Card
        title={
          <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span>People</span>
            {list.total > 0 && (
              <span style={{ fontSize: 13, color: tokens.color.textMuted, fontWeight: 400 }}>
                {view.anyFilterActive
                  ? `${list.total} match${list.total === 1 ? '' : 'es'}`
                  : `${list.total} ${list.total === 1 ? 'person' : 'people'}`}
              </span>
            )}
          </span>
        }
        action={
          view.anyFilterActive ? (
            <button
              type="button"
              onClick={view.clearFilters}
              style={{
                background: 'none',
                border: 'none',
                color: tokens.color.accent,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Clear filters
            </button>
          ) : undefined
        }
      >
        <div style={{ marginBottom: 12 }}>
          <TableSearch view={view} placeholder="Search by name, email or phone…" />
        </div>
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table<PersonRow>
            columns={[
              {
                key: 'name',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Name{' '}
                    <ColumnFilter
                      ariaLabel="Sort by name"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('name')}
                      onApply={(_, dir) => view.apply('name', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
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
              {
                key: 'email',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Email{' '}
                    <ColumnFilter
                      ariaLabel="Sort by email"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('email')}
                      onApply={(_, dir) => view.apply('email', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (p) => p.email ?? '—',
              },
              {
                key: 'phone',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Phone{' '}
                    <ColumnFilter
                      ariaLabel="Sort by phone"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('phone')}
                      onApply={(_, dir) => view.apply('phone', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (p) => p.phone ?? '—',
              },
              {
                key: 'clients',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Clients{' '}
                    <ColumnFilter
                      ariaLabel="Sort by client count"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('clients')}
                      onApply={(_, dir) => view.apply('clients', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                align: 'right',
                render: (p) => p.clientCount,
              },
              {
                key: 'portal',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Portal{' '}
                    <ColumnFilter
                      ariaLabel="Filter by portal access"
                      values={PORTAL_VALUES}
                      selected={view.filterFor('portal')}
                      searchable={false}
                      sort={null}
                      onApply={(sel) => view.apply('portal', sel, view.sortFor('portal'))}
                    />
                  </span>
                ) as unknown as string,
                render: (p) =>
                  p.hasPortalAccess ? (
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <Pill tone="success">Enabled</Pill>
                      {canViewAs && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={viewAsBusy === p.key}
                          title="Open the portal as this person (read-only impersonation, 5-min token)"
                          onClick={() => void viewAs(p)}
                        >
                          {viewAsBusy === p.key ? 'Opening…' : 'View as'}
                        </Button>
                      )}
                    </span>
                  ) : (
                    <Pill tone="neutral">—</Pill>
                  ),
              },
              {
                key: 'kind',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Kind{' '}
                    <ColumnFilter
                      ariaLabel="Filter by kind"
                      values={KIND_VALUES}
                      selected={view.filterFor('kind')}
                      searchable={false}
                      sort={null}
                      onApply={(sel) => view.apply('kind', sel, view.sortFor('kind'))}
                    />
                  </span>
                ) as unknown as string,
                render: (p) =>
                  p.kind === 'portal_identity' ? <Pill tone="warning">Portal-only</Pill> : null,
              },
            ]}
            rows={list.rows}
            pagination={list.pagination}
            rowKey={(p) => p.key}
            empty="No people match the current filters."
          />
        )}
      </Card>
    </div>
  );
}
