// SPDX-License-Identifier: Elastic-2.0
//
// PP4a — Proposals list page (top-level /proposals route).
//
// Lists every proposal for the firm. Mirrors the Engagements table UX:
// per-column header filters + sort (via <ColumnFilter>), plus a free-text
// search box. "New proposal" starts the create flow; non-accepted proposals
// can be deleted inline.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  Button,
  Card,
  ColumnFilter,
  Input,
  Pill,
  SectionHeading,
  Table,
  type TableColumn,
  tokens,
  type SortDir,
} from '@vibe/ui';
import { useClientPage } from '../lib/use-paged-list';

import { api } from '../api-client';

type Status =
  | 'DRAFT'
  | 'SENT'
  | 'VIEWED'
  | 'IN_PROGRESS'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'COUNTERED';

const STATUSES: Status[] = [
  'DRAFT',
  'SENT',
  'VIEWED',
  'IN_PROGRESS',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'CANCELLED',
  'COUNTERED',
];

interface ProposalRow {
  id: string;
  clientId: string;
  clientName: string | null;
  status: Status;
  title: string;
  totalOneTimeCents: number;
  totalRecurringCents: number;
  recurringInterval: string | null;
  sentAt: string | null;
  expiresAt: string | null;
  acceptedAt: string | null;
  draftRevision: number;
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
}

function dollars(c: number): string {
  return (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

const STATUS_TONE: Record<Status, 'accent' | 'success' | 'warning' | 'danger' | 'neutral'> = {
  DRAFT: 'neutral',
  SENT: 'accent',
  VIEWED: 'accent',
  IN_PROGRESS: 'warning',
  ACCEPTED: 'success',
  DECLINED: 'danger',
  EXPIRED: 'warning',
  CANCELLED: 'neutral',
  COUNTERED: 'warning',
};

// ── Session-persisted view state ────────────────────────────────────
// Survives navigation + reload within the browser session. Sets are
// serialized as arrays.
const STORAGE_KEY = 'vibe.proposals.view';

interface PersistedView {
  sortCol: string;
  sortDir: SortDir;
  status: string[];
  client: string[];
  creator: string[];
}

const DEFAULT_VIEW: PersistedView = {
  sortCol: 'updated',
  sortDir: 'desc',
  status: [],
  client: [],
  creator: [],
};

function loadView(): PersistedView {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_VIEW;
    return { ...DEFAULT_VIEW, ...(JSON.parse(raw) as Partial<PersistedView>) };
  } catch {
    return DEFAULT_VIEW;
  }
}

export function ProposalsListPage(): JSX.Element {
  const [items, setItems] = useState<ProposalRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [q, setQ] = useState('');

  // Engagements-style: per-column filter sets + a single active sort.
  // Hydrated from sessionStorage so the view survives reload/navigation.
  const initial = useMemo(() => loadView(), []);
  const [sortBy, setSortBy] = useState<{ col: string; dir: SortDir }>({
    col: initial.sortCol,
    dir: initial.sortDir,
  });
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set(initial.status));
  const [clientFilter, setClientFilter] = useState<Set<string>>(new Set(initial.client));
  const [creatorFilter, setCreatorFilter] = useState<Set<string>>(new Set(initial.creator));

  // Persist selections for the session whenever any change.
  useEffect(() => {
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          sortCol: sortBy.col,
          sortDir: sortBy.dir,
          status: Array.from(statusFilter),
          client: Array.from(clientFilter),
          creator: Array.from(creatorFilter),
        } satisfies PersistedView),
      );
    } catch {
      /* storage unavailable (private mode) — in-memory only */
    }
  }, [sortBy, statusFilter, clientFilter, creatorFilter]);

  async function load(): Promise<void> {
    // Load all proposals; filtering/sorting happens client-side (≤500 rows).
    const r = await api<{ items: ProposalRow[] }>('/api/staff/proposals');
    setItems(r.items ?? []);
    setLoaded(true);
  }

  async function remove(r: ProposalRow): Promise<void> {
    if (!confirm(`Delete proposal “${r.title}”? This cannot be undone.`)) return;
    setBusyId(r.id);
    setErr(null);
    try {
      await api(`/api/staff/proposals/${r.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'delete_failed');
    } finally {
      setBusyId(null);
    }
  }

  useEffect(() => {
    void load().catch((e) => setErr(e instanceof Error ? e.message : 'load_failed'));
  }, []);

  const counts = useMemo(() => {
    const c: Partial<Record<Status, number>> = {};
    for (const i of items) c[i.status] = (c[i.status] ?? 0) + 1;
    return c;
  }, [items]);

  const clientOptions = useMemo(
    () =>
      Array.from(new Set(items.map((i) => i.clientName).filter((n): n is string => Boolean(n))))
        .sort((a, b) => a.localeCompare(b))
        .map((n) => ({ value: n, label: n })),
    [items],
  );
  const creatorOptions = useMemo(
    () =>
      Array.from(new Set(items.map((i) => i.createdByName).filter((n): n is string => Boolean(n))))
        .sort((a, b) => a.localeCompare(b))
        .map((n) => ({ value: n, label: n })),
    [items],
  );
  const statusOptions = useMemo(
    () => STATUSES.map((s) => ({ value: s, label: `${s} (${counts[s] ?? 0})` })),
    [counts],
  );

  const view = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let rows = items.filter((r) => {
      if (statusFilter.size > 0 && !statusFilter.has(r.status)) return false;
      if (clientFilter.size > 0 && !(r.clientName && clientFilter.has(r.clientName))) return false;
      if (creatorFilter.size > 0 && !(r.createdByName && creatorFilter.has(r.createdByName)))
        return false;
      if (needle) {
        const hay =
          `${r.title} ${r.clientName ?? ''} ${r.createdByName ?? ''} ${r.status}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    if (sortBy.dir) {
      const sign = sortBy.dir === 'asc' ? 1 : -1;
      const val = (r: ProposalRow): string | number => {
        switch (sortBy.col) {
          case 'title':
            return r.title.toLowerCase();
          case 'client':
            return (r.clientName ?? '').toLowerCase();
          case 'createdBy':
            return (r.createdByName ?? '').toLowerCase();
          case 'status':
            return r.status;
          case 'fees':
            return Number(r.totalOneTimeCents) + Number(r.totalRecurringCents);
          case 'updated':
          default:
            return new Date(r.updatedAt).getTime();
        }
      };
      rows = [...rows].sort((a, b) => {
        const av = val(a);
        const bv = val(b);
        if (av < bv) return -1 * sign;
        if (av > bv) return 1 * sign;
        return 0;
      });
    }
    return rows;
  }, [items, q, sortBy, statusFilter, clientFilter, creatorFilter]);

  const sortOnly = (col: string, label: string): JSX.Element => (
    <>
      {label}{' '}
      <ColumnFilter
        ariaLabel={`Sort by ${label}`}
        values={[]}
        selected={new Set()}
        searchable={false}
        sort={sortBy.col === col ? sortBy.dir : null}
        onApply={(_, dir) => {
          if (dir) setSortBy({ col, dir });
        }}
      />
    </>
  );

  const { paged, pagination } = useClientPage(view);

  const columns: TableColumn<ProposalRow>[] = [
    {
      key: 'title',
      header: sortOnly('title', 'Title'),
      render: (r) => (
        <Link
          to={`/proposals/${r.id}/edit`}
          style={{ color: tokens.color.accent, textDecoration: 'none' }}
        >
          {r.title}
        </Link>
      ),
    },
    {
      key: 'client',
      header: (
        <>
          Client{' '}
          <ColumnFilter
            ariaLabel="Filter client"
            values={clientOptions}
            selected={clientFilter}
            sort={sortBy.col === 'client' ? sortBy.dir : null}
            onApply={(sel, dir) => {
              setClientFilter(sel);
              if (dir) setSortBy({ col: 'client', dir });
            }}
          />
        </>
      ),
      render: (r) => (r.clientName ? <a href={`/clients/${r.clientId}`}>{r.clientName}</a> : '—'),
    },
    {
      key: 'createdBy',
      header: (
        <>
          Created by{' '}
          <ColumnFilter
            ariaLabel="Filter creator"
            values={creatorOptions}
            selected={creatorFilter}
            sort={sortBy.col === 'createdBy' ? sortBy.dir : null}
            onApply={(sel, dir) => {
              setCreatorFilter(sel);
              if (dir) setSortBy({ col: 'createdBy', dir });
            }}
          />
        </>
      ),
      render: (r) => r.createdByName ?? '—',
    },
    {
      key: 'status',
      header: (
        <>
          Status{' '}
          <ColumnFilter
            ariaLabel="Filter status"
            values={statusOptions}
            selected={statusFilter}
            sort={sortBy.col === 'status' ? sortBy.dir : null}
            onApply={(sel, dir) => {
              setStatusFilter(sel);
              if (dir) setSortBy({ col: 'status', dir });
            }}
          />
        </>
      ),
      render: (r) => <Pill tone={STATUS_TONE[r.status]}>{r.status}</Pill>,
    },
    {
      key: 'fees',
      header: sortOnly('fees', 'Fees'),
      align: 'right',
      render: (r) => (
        <div style={{ fontSize: 12 }}>
          {Number(r.totalOneTimeCents) > 0 && (
            <div>{dollars(Number(r.totalOneTimeCents))} one-time</div>
          )}
          {Number(r.totalRecurringCents) > 0 && (
            <div style={{ color: tokens.color.textMuted }}>
              {dollars(Number(r.totalRecurringCents))} / {r.recurringInterval}
            </div>
          )}
          {Number(r.totalOneTimeCents) === 0 && Number(r.totalRecurringCents) === 0 && (
            <span style={{ color: tokens.color.textMuted }}>—</span>
          )}
        </div>
      ),
    },
    {
      key: 'rev',
      header: 'Rev',
      align: 'right',
      render: (r) => `v${r.draftRevision}`,
    },
    {
      key: 'updated',
      header: sortOnly('updated', 'Last update'),
      render: (r) => new Date(r.updatedAt).toLocaleString(),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) =>
        r.status === 'ACCEPTED' ? (
          <span style={{ fontSize: 11, color: tokens.color.textMuted }}>—</span>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={busyId === r.id}
            onClick={() => void remove(r)}
          >
            {busyId === r.id ? 'Deleting…' : 'Delete'}
          </Button>
        ),
    },
  ];

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <SectionHeading
        title="Proposals"
        description="Draft, send, and track engagement proposals."
      />
      <Card>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 260, flex: 1 }}>
            <Input
              aria-label="Search proposals"
              placeholder="Search title, client, or creator…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          {(statusFilter.size > 0 || clientFilter.size > 0 || creatorFilter.size > 0 || q) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setStatusFilter(new Set());
                setClientFilter(new Set());
                setCreatorFilter(new Set());
                setQ('');
              }}
            >
              Clear filters
            </Button>
          )}
          <Link to="/proposals/new" style={{ textDecoration: 'none' }}>
            <Button size="sm">New proposal</Button>
          </Link>
        </div>
        {err && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{err}</p>}
      </Card>

      <Card>
        {!loaded ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
        ) : items.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            No proposals yet. Click “New proposal” to start the first one.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <Table<ProposalRow>
              columns={columns}
              rows={paged}
              rowKey={(r) => r.id}
              empty={
                <div style={{ padding: 40, textAlign: 'center' }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>▽</div>
                  <strong>No Results</strong>
                  <div>Please refine your filters.</div>
                </div>
              }
              pagination={pagination}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
