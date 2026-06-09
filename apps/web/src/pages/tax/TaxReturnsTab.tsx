// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Tax Returns tab body. Extracted from TaxReturns.tsx so the parent
// page can host both the Returns tab and the firm-wide Payments tab.
//
// Filtering + sorting mirror the Clients table (search + dropdown
// filters, click-to-sort column headers). The endpoint returns the
// firm's returns in one call (≤500), so filter/sort run client-side for
// instant response. The user's filter + sort selections persist for the
// browser session via sessionStorage, so navigating away and back keeps
// the view they set up.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button, Card, Combobox, EmptyState, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

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

type SortCol = 'client' | 'year' | 'form' | 'title' | 'kind' | 'status' | 'pages' | 'released';

interface ViewState {
  q: string;
  status: string; // '' = any
  type: string; // '' = any  (releaseKind)
  year: string; // '' = any  (stringified tax year)
  sortCol: SortCol;
  sortDir: 'asc' | 'desc';
}

const DEFAULT_VIEW: ViewState = {
  q: '',
  status: '',
  type: '',
  year: '',
  sortCol: 'year',
  sortDir: 'desc',
};

const STATUS_OPTIONS = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PARSED', label: 'Parsed' },
  { value: 'REVIEW', label: 'Review' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'RELEASED', label: 'Released' },
  { value: 'SUPERSEDED', label: 'Superseded' },
];

const TYPE_OPTIONS = [
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

// Session-persisted state — survives navigation + reload within the tab,
// cleared when the browser session ends. Keyed so it can't collide with
// other pages.
function useSessionState<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [val, setVal] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      return raw != null ? ({ ...initial, ...(JSON.parse(raw) as Partial<T>) } as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(val));
    } catch {
      /* storage unavailable (private mode) — fall back to in-memory only */
    }
  }, [key, val]);
  return [val, setVal];
}

const headerBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  fontFamily: 'inherit',
  fontWeight: 'inherit',
  fontSize: 'inherit',
  color: 'inherit',
  cursor: 'pointer',
};

export function TaxReturnsTab(): JSX.Element {
  const [items, setItems] = useState<ReturnRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [view, setView] = useSessionState<ViewState>('vibe.tax-returns.view', DEFAULT_VIEW);

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

  // Distinct tax years present, for the Year filter dropdown.
  const yearOptions = useMemo(() => {
    const years = Array.from(new Set(items.map((r) => r.taxYear))).sort((a, b) => b - a);
    return years.map((y) => ({ value: String(y), label: String(y) }));
  }, [items]);

  const visible = useMemo(() => {
    const q = view.q.trim().toLowerCase();
    const filtered = items.filter((r) => {
      if (view.status && r.status !== view.status) return false;
      if (view.type && r.releaseKind !== view.type) return false;
      if (view.year && String(r.taxYear) !== view.year) return false;
      if (q) {
        const hay = `${r.clientName} ${r.title} ${r.formCode} ${r.jurisdiction}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const dir = view.sortDir === 'asc' ? 1 : -1;
    const cmp = (a: ReturnRow, b: ReturnRow): number => {
      switch (view.sortCol) {
        case 'client':
          return a.clientName.localeCompare(b.clientName);
        case 'year':
          return a.taxYear - b.taxYear;
        case 'form':
          return a.formCode.localeCompare(b.formCode);
        case 'title':
          return (a.title || '').localeCompare(b.title || '');
        case 'kind':
          return a.releaseKind.localeCompare(b.releaseKind);
        case 'status':
          return a.status.localeCompare(b.status);
        case 'pages':
          return (a.totalPages ?? 0) - (b.totalPages ?? 0);
        case 'released':
          return (
            (a.releasedAt ? Date.parse(a.releasedAt) : 0) -
            (b.releasedAt ? Date.parse(b.releasedAt) : 0)
          );
        default:
          return 0;
      }
    };
    // Stable-ish secondary sort by createdAt desc keeps ties deterministic.
    return [...filtered].sort((a, b) => {
      const primary = cmp(a, b);
      if (primary !== 0) return primary * dir;
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    });
  }, [items, view]);

  function toggleSort(col: SortCol): void {
    setView((prev) =>
      prev.sortCol === col
        ? { ...prev, sortDir: prev.sortDir === 'asc' ? 'desc' : 'asc' }
        : { ...prev, sortCol: col, sortDir: 'asc' },
    );
  }
  const sortIcon = (col: SortCol): string =>
    view.sortCol === col ? (view.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
  const sortHeader = (col: SortCol, label: string): JSX.Element => (
    <button type="button" onClick={() => toggleSort(col)} style={headerBtn}>
      {label}
      {sortIcon(col)}
    </button>
  );

  const filtersActive = Boolean(view.q || view.status || view.type || view.year);

  return (
    <Card title={`Tax returns${items.length ? ` (${visible.length} of ${items.length})` : ''}`}>
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
          <form
            onSubmit={(e) => e.preventDefault()}
            style={{
              display: 'grid',
              gap: 8,
              gridTemplateColumns: '2fr 1fr 1fr 1fr auto',
              alignItems: 'center',
              marginBottom: tokens.space.md,
            }}
          >
            <Input
              value={view.q}
              onChange={(e) => setView((p) => ({ ...p, q: e.target.value }))}
              placeholder="Search client, title, form, jurisdiction"
            />
            <Combobox
              ariaLabel="Status"
              clearable
              value={view.status}
              onChange={(v) => setView((p) => ({ ...p, status: v }))}
              options={STATUS_OPTIONS}
              placeholder="Any status"
            />
            <Combobox
              ariaLabel="Type"
              clearable
              value={view.type}
              onChange={(v) => setView((p) => ({ ...p, type: v }))}
              options={TYPE_OPTIONS}
              placeholder="Any type"
            />
            <Combobox
              ariaLabel="Tax year"
              clearable
              value={view.year}
              onChange={(v) => setView((p) => ({ ...p, year: v }))}
              options={yearOptions}
              placeholder="Any year"
            />
            <Button
              type="button"
              variant="ghost"
              disabled={!filtersActive}
              onClick={() => setView((p) => ({ ...p, q: '', status: '', type: '', year: '' }))}
            >
              Clear
            </Button>
          </form>

          <Table<ReturnRow>
            columns={[
              {
                key: 'client',
                header: sortHeader('client', 'Client') as unknown as string,
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
                header: sortHeader('year', 'Year') as unknown as string,
                render: (r) => String(r.taxYear),
              },
              {
                key: 'form',
                header: sortHeader('form', 'Form') as unknown as string,
                render: (r) => `${r.formCode} · ${r.jurisdiction}`,
              },
              {
                key: 'title',
                header: sortHeader('title', 'Title') as unknown as string,
                render: (r) => r.title || '—',
              },
              {
                key: 'kind',
                header: sortHeader('kind', 'Type') as unknown as string,
                render: (r) => (
                  <Pill tone={r.releaseKind === 'AMENDED' ? 'warning' : 'accent'}>
                    {r.releaseKind}
                  </Pill>
                ),
              },
              {
                key: 'status',
                header: sortHeader('status', 'Status') as unknown as string,
                render: (r) => <Pill tone={statusTone(r.status)}>{r.status}</Pill>,
              },
              {
                key: 'pages',
                header: sortHeader('pages', 'Pages') as unknown as string,
                align: 'right',
                render: (r) => (r.totalPages != null ? String(r.totalPages) : '—'),
              },
              {
                key: 'released',
                header: sortHeader('released', 'Released') as unknown as string,
                render: (r) => (r.releasedAt ? new Date(r.releasedAt).toLocaleDateString() : '—'),
              },
            ]}
            rows={visible}
            rowKey={(r) => r.id}
            empty="No returns match the current filters."
          />
        </>
      )}
    </Card>
  );
}
