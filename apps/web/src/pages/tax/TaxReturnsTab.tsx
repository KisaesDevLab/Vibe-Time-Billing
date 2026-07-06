// SPDX-License-Identifier: Elastic-2.0
//
// Tax Returns tab body. Extracted from TaxReturns.tsx so the parent
// page can host both the Returns tab and the firm-wide Payments tab.
//
// Filtering + sorting use per-column header dropdowns (the shared
// @vibe/ui ColumnFilter), exactly like the Engagements table: each
// column's ▾ opens Sort A→Z / Z→A plus a checkbox value filter. The
// endpoint returns the firm's returns in one call (≤500), so filter +
// sort run client-side for instant response. The user's selections
// persist for the browser session via sessionStorage, so navigating
// away (e.g. to the Payments tab, which unmounts this one) and back
// keeps the view they set up.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  Card,
  ColumnFilter,
  EmptyState,
  Pill,
  Table,
  type TableColumn,
  tokens,
  type SortDir,
} from '@vibe/ui';
import { useClientPage } from '../../lib/use-paged-list';

import { api } from '../../api-client';
import { TableSearch } from '../../components/TableSearch';
import type { ColumnView } from '../../lib/column-view';

interface ReturnRow {
  id: string;
  clientId: string;
  clientName: string;
  taxYear: number;
  formCode: string;
  jurisdiction: string;
  title: string;
  status: string;
  releaseKind: 'ORIGINAL' | 'AMENDED' | 'SUPERSEDED';
  totalPages: number | null;
  releasedAt: string | null;
  createdAt: string;
}

// Sortable column keys.
type SortCol = 'client' | 'year' | 'form' | 'title' | 'kind' | 'status' | 'pages' | 'released';

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  PARSED: 'Parsed',
  REVIEW: 'Review',
  APPROVED: 'Approved',
  RELEASED: 'Released',
  SUPERSEDED: 'Superseded',
};

const TYPE_VALUES = [
  { value: 'ORIGINAL', label: 'Original' },
  { value: 'AMENDED', label: 'Amended' },
  { value: 'SUPERSEDED', label: 'Superseded' },
];

function statusTone(s: string): 'success' | 'warning' | 'neutral' | 'accent' {
  switch (s) {
    case 'RELEASED':
      return 'success';
    case 'APPROVED':
      return 'accent';
    case 'REVIEW':
      return 'warning';
    case 'SUPERSEDED':
    case 'DRAFT':
    case 'PARSED':
    default:
      return 'neutral';
  }
}

// ── Session-persisted view state ────────────────────────────────────
// Survives navigation + reload within the browser session (cleared when
// the session ends). Sets are serialized as arrays.
const STORAGE_KEY = 'vibe.tax-returns.view';

interface PersistedView {
  sortCol: SortCol | '';
  sortDir: SortDir;
  client: string[];
  year: string[];
  form: string[];
  type: string[];
  status: string[];
}

const DEFAULT_VIEW: PersistedView = {
  sortCol: 'year',
  sortDir: 'desc',
  client: [],
  year: [],
  form: [],
  type: [],
  status: [],
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

export function TaxReturnsTab(): JSX.Element {
  const [items, setItems] = useState<ReturnRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const initial = useMemo(() => loadView(), []);
  const [sortBy, setSortBy] = useState<{ col: SortCol | ''; dir: SortDir }>({
    col: initial.sortCol,
    dir: initial.sortDir,
  });
  const [clientFilter, setClientFilter] = useState<Set<string>>(new Set(initial.client));
  const [yearFilter, setYearFilter] = useState<Set<string>>(new Set(initial.year));
  const [formFilter, setFormFilter] = useState<Set<string>>(new Set(initial.form));
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set(initial.type));
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set(initial.status));
  const [search, setSearch] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: ReturnRow[] }>('/api/staff/tax/returns');
        setItems(r.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Persist selections for the session whenever any change.
  useEffect(() => {
    const view: PersistedView = {
      sortCol: sortBy.col,
      sortDir: sortBy.dir,
      client: Array.from(clientFilter),
      year: Array.from(yearFilter),
      form: Array.from(formFilter),
      type: Array.from(typeFilter),
      status: Array.from(statusFilter),
    };
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(view));
    } catch {
      /* storage unavailable (private mode) — in-memory only */
    }
  }, [sortBy, clientFilter, yearFilter, formFilter, typeFilter, statusFilter]);

  // Distinct value lists for the per-column dropdowns.
  const clientValues = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of items) map.set(r.clientId, r.clientName);
    return Array.from(map.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [items]);
  const yearValues = useMemo(
    () =>
      Array.from(new Set(items.map((r) => r.taxYear)))
        .sort((a, b) => b - a)
        .map((y) => ({ value: String(y), label: String(y) })),
    [items],
  );
  const formValues = useMemo(
    () =>
      Array.from(new Set(items.map((r) => r.formCode)))
        .sort((a, b) => a.localeCompare(b))
        .map((f) => ({ value: f, label: f })),
    [items],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let r = items.filter((row) => {
      if (clientFilter.size > 0 && !clientFilter.has(row.clientId)) return false;
      if (yearFilter.size > 0 && !yearFilter.has(String(row.taxYear))) return false;
      if (formFilter.size > 0 && !formFilter.has(row.formCode)) return false;
      if (typeFilter.size > 0 && !typeFilter.has(row.releaseKind)) return false;
      if (statusFilter.size > 0 && !statusFilter.has(row.status)) return false;
      if (
        q &&
        !`${row.clientName} ${row.title} ${row.formCode} ${row.jurisdiction} ${row.taxYear}`
          .toLowerCase()
          .includes(q)
      )
        return false;
      return true;
    });
    if (sortBy.col && sortBy.dir) {
      const sign = sortBy.dir === 'asc' ? 1 : -1;
      const col = sortBy.col;
      const num = (r: ReturnRow): number => {
        switch (col) {
          case 'year':
            return r.taxYear;
          case 'pages':
            return r.totalPages ?? 0;
          case 'released':
            return r.releasedAt ? Date.parse(r.releasedAt) : 0;
          default:
            return NaN;
        }
      };
      const str = (r: ReturnRow): string => {
        switch (col) {
          case 'client':
            return r.clientName.toLowerCase();
          case 'form':
            return r.formCode.toLowerCase();
          case 'title':
            return (r.title || '').toLowerCase();
          case 'kind':
            return r.releaseKind;
          case 'status':
            return r.status;
          default:
            return '';
        }
      };
      const numeric = col === 'year' || col === 'pages' || col === 'released';
      r = [...r].sort((a, b) => {
        const cmp = numeric ? num(a) - num(b) : str(a) < str(b) ? -1 : str(a) > str(b) ? 1 : 0;
        if (cmp !== 0) return cmp * sign;
        // Deterministic tie-break: newest first.
        return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      });
    }
    return r;
  }, [items, clientFilter, yearFilter, formFilter, typeFilter, statusFilter, sortBy, search]);

  const sortFor = (col: SortCol): SortDir => (sortBy.col === col ? sortBy.dir : null);
  const filtersActive =
    clientFilter.size + yearFilter.size + formFilter.size + typeFilter.size + statusFilter.size >
      0 || search.trim().length > 0;

  function clearAll(): void {
    setClientFilter(new Set());
    setYearFilter(new Set());
    setFormFilter(new Set());
    setTypeFilter(new Set());
    setStatusFilter(new Set());
    setSearch('');
  }

  const { paged, pagination } = useClientPage(visible);

  const columns: TableColumn<ReturnRow>[] = [
    {
      key: 'client',
      header: (
        <>
          Client{' '}
          <ColumnFilter
            ariaLabel="Filter / sort client"
            values={clientValues}
            selected={clientFilter}
            sort={sortFor('client')}
            onApply={(sel, dir) => {
              setClientFilter(sel);
              if (dir) setSortBy({ col: 'client', dir });
            }}
          />
        </>
      ),
      render: (r) => (
        <Link
          to={`/tax/returns/${r.id}`}
          style={{ color: tokens.color.accent, textDecoration: 'none', fontWeight: 500 }}
        >
          {r.clientName}
        </Link>
      ),
    },
    {
      key: 'year',
      header: (
        <>
          Year{' '}
          <ColumnFilter
            ariaLabel="Filter / sort tax year"
            values={yearValues}
            selected={yearFilter}
            sort={sortFor('year')}
            onApply={(sel, dir) => {
              setYearFilter(sel);
              if (dir) setSortBy({ col: 'year', dir });
            }}
          />
        </>
      ),
      render: (r) => r.taxYear,
    },
    {
      key: 'form',
      header: (
        <>
          Form{' '}
          <ColumnFilter
            ariaLabel="Filter / sort form"
            values={formValues}
            selected={formFilter}
            sort={sortFor('form')}
            onApply={(sel, dir) => {
              setFormFilter(sel);
              if (dir) setSortBy({ col: 'form', dir });
            }}
          />
        </>
      ),
      render: (r) => `${r.formCode} · ${r.jurisdiction}`,
    },
    {
      key: 'title',
      header: (
        <>
          Title{' '}
          <ColumnFilter
            ariaLabel="Sort by title"
            values={[]}
            selected={new Set()}
            searchable={false}
            sort={sortFor('title')}
            onApply={(_, dir) => {
              if (dir) setSortBy({ col: 'title', dir });
            }}
          />
        </>
      ),
      render: (r) => r.title || '—',
    },
    {
      key: 'kind',
      header: (
        <>
          Type{' '}
          <ColumnFilter
            ariaLabel="Filter / sort type"
            values={TYPE_VALUES}
            selected={typeFilter}
            searchable={false}
            sort={sortFor('kind')}
            onApply={(sel, dir) => {
              setTypeFilter(sel);
              if (dir) setSortBy({ col: 'kind', dir });
            }}
          />
        </>
      ),
      render: (r) => (
        <Pill tone={r.releaseKind === 'AMENDED' ? 'warning' : 'accent'}>{r.releaseKind}</Pill>
      ),
    },
    {
      key: 'status',
      header: (
        <>
          Status{' '}
          <ColumnFilter
            ariaLabel="Filter / sort status"
            values={Object.keys(STATUS_LABELS).map((s) => ({ value: s, label: STATUS_LABELS[s]! }))}
            selected={statusFilter}
            searchable={false}
            sort={sortFor('status')}
            onApply={(sel, dir) => {
              setStatusFilter(sel);
              if (dir) setSortBy({ col: 'status', dir });
            }}
          />
        </>
      ),
      render: (r) => <Pill tone={statusTone(r.status)}>{r.status}</Pill>,
    },
    {
      key: 'pages',
      align: 'right',
      header: (
        <>
          Pages{' '}
          <ColumnFilter
            ariaLabel="Sort by pages"
            values={[]}
            selected={new Set()}
            searchable={false}
            sort={sortFor('pages')}
            onApply={(_, dir) => {
              if (dir) setSortBy({ col: 'pages', dir });
            }}
          />
        </>
      ),
      render: (r) => (r.totalPages != null ? r.totalPages : '—'),
    },
    {
      key: 'released',
      header: (
        <>
          Released{' '}
          <ColumnFilter
            ariaLabel="Sort by released date"
            values={[]}
            selected={new Set()}
            searchable={false}
            sort={sortFor('released')}
            onApply={(_, dir) => {
              if (dir) setSortBy({ col: 'released', dir });
            }}
          />
        </>
      ),
      render: (r) => (r.releasedAt ? new Date(r.releasedAt).toLocaleDateString() : '—'),
    },
  ];

  return (
    <Card
      title={
        <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span>Tax returns</span>
          {items.length > 0 && (
            <span style={{ fontSize: 13, color: tokens.color.textMuted, fontWeight: 400 }}>
              {visible.length === items.length
                ? `${items.length} return${items.length === 1 ? '' : 's'}`
                : `${visible.length} of ${items.length}`}
            </span>
          )}
        </span>
      }
      action={
        filtersActive ? (
          <button
            type="button"
            onClick={clearAll}
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
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }}>{error}</p>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
      ) : items.length === 0 ? (
        <EmptyState
          title="No tax returns yet"
          body="When a return is parsed into the system it appears here, ready for review and release."
        />
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <TableSearch
              view={{ search, setSearch } as unknown as ColumnView}
              placeholder="Search returns…"
            />
          </div>
          <div style={{ overflowX: 'auto' }}>
            <Table<ReturnRow>
              columns={columns}
              rows={paged}
              rowKey={(r) => r.id}
              empty={
                <div style={{ padding: 40, textAlign: 'center' }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>▽</div>
                  <strong>No results</strong>
                  <div>Please refine your filters.</div>
                </div>
              }
              pagination={pagination}
            />
          </div>
        </>
      )}
    </Card>
  );
}
