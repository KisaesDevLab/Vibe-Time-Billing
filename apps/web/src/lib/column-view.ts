// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Shared per-column filter + sort state for staff table views, with
// session persistence. Pairs with the @vibe/ui ColumnFilter header
// dropdown (Sort A→Z / Z→A + checkbox value filter). Filtering + sorting
// run client-side over the already-loaded rows; selections persist for
// the browser session (sessionStorage) so navigating away and back keeps
// the view the user set up.
//
// Usage:
//   const view = useColumnView('vibe.invoices.view', { sortCol: 'issueDate', sortDir: 'desc' });
//   const visible = useMemo(
//     () => selectRows(rows, view, {
//       filters: { status: (r) => r.status, client: (r) => r.clientId },
//       sortValues: { issueDate: (r) => r.issueDate, total: (r) => r.totalCents },
//       tieBreak: (a, b) => b.createdAt.localeCompare(a.createdAt),
//     }),
//     [rows, view],
//   );
//   // header: <ColumnFilter selected={view.filterFor('status')} sort={view.sortFor('status')}
//   //                       onApply={(sel, dir) => view.apply('status', sel, dir)} … />

import { useEffect, useMemo, useState } from 'react';

import type { SortDir } from '@vibe/ui';

interface ColumnViewState {
  sortCol: string;
  sortDir: SortDir;
  filters: Record<string, string[]>;
  search: string;
}

export interface ColumnView {
  sortCol: string;
  sortDir: SortDir;
  /** Active sort direction for a column, or null when it isn't the sort. */
  sortFor: (col: string) => SortDir;
  /** Selected filter values for a column (empty Set = no filter). */
  filterFor: (col: string) => Set<string>;
  /** Wire to ColumnFilter.onApply: set the column's selection + (if dir given) the active sort. */
  apply: (col: string, selected: Set<string>, dir: SortDir) => void;
  /** Free-text search box value (see the `searchText` accessor in selectRows). */
  search: string;
  setSearch: (q: string) => void;
  /** Clear every column's value filter AND the search box (leaves the active sort intact). */
  clearFilters: () => void;
  /** True when any column filter or the search box is active. */
  anyFilterActive: boolean;
}

export function useColumnView(
  storageKey: string,
  defaults: { sortCol?: string; sortDir?: SortDir } = {},
): ColumnView {
  const [state, setState] = useState<ColumnViewState>(() => {
    const base: ColumnViewState = {
      sortCol: defaults.sortCol ?? '',
      sortDir: defaults.sortDir ?? null,
      filters: {},
      search: '',
    };
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return base;
      const parsed = JSON.parse(raw) as Partial<ColumnViewState>;
      return {
        sortCol: parsed.sortCol ?? base.sortCol,
        sortDir: parsed.sortDir ?? base.sortDir,
        filters: parsed.filters ?? {},
        search: parsed.search ?? '',
      };
    } catch {
      return base;
    }
  });

  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      /* storage unavailable (private mode) — in-memory only */
    }
  }, [storageKey, state]);

  return useMemo<ColumnView>(
    () => ({
      sortCol: state.sortCol,
      sortDir: state.sortDir,
      sortFor: (col) => (state.sortCol === col ? state.sortDir : null),
      filterFor: (col) => new Set(state.filters[col] ?? []),
      apply: (col, selected, dir) =>
        setState((prev) => {
          const filters = { ...prev.filters };
          if (selected.size > 0) filters[col] = Array.from(selected);
          else delete filters[col];
          return {
            ...prev,
            sortCol: dir ? col : prev.sortCol,
            sortDir: dir ?? prev.sortDir,
            filters,
          };
        }),
      search: state.search,
      setSearch: (q) => setState((prev) => ({ ...prev, search: q })),
      clearFilters: () => setState((prev) => ({ ...prev, filters: {}, search: '' })),
      anyFilterActive:
        Object.values(state.filters).some((v) => v.length > 0) || state.search.trim().length > 0,
    }),
    [state],
  );
}

/**
 * Distinct, sorted {value,label} options for a ColumnFilter's checkbox list,
 * derived from the raw row values of a column. Stable module-level helper so
 * callers can wrap it in useMemo without an exhaustive-deps warning.
 */
export function distinctOptions(values: string[]): { value: string; label: string }[] {
  return Array.from(new Set(values))
    .sort((a, b) => a.localeCompare(b))
    .map((v) => ({ value: v, label: v }));
}

/**
 * Serialize a ColumnView's search + active sort + column filters into query
 * params for a server-side paginated endpoint (see usePagedList). Use this
 * when the row count outgrows a single capped fetch and filtering/sorting must
 * run in SQL rather than in-memory (selectRows). The returned object is fed as
 * usePagedList's `query`; a value change resets to page 1.
 *
 *   const query = useMemo(
 *     () => viewToPagedQuery(view, {
 *       sortMap: { owner: 'partnerName', type: 'clientType' },   // column → server sort key
 *       filterMap: { owner: 'clientOwnerId', type: 'clientType' }, // column → server filter param
 *     }),
 *     [view],
 *   );
 *   const list = usePagedList<Row>('/api/staff/clients', { query });
 *
 * Multi-select filters are joined with commas — the endpoint splits and treats
 * them as an IN(...) set. Filter values must be whatever the server matches on
 * (e.g. owner/office by id, type/status by enum value), so wire the matching
 * ColumnFilter `values` to use those as the option `value`.
 */
export function viewToPagedQuery(
  view: ColumnView,
  cfg: { sortMap?: Record<string, string>; filterMap?: Record<string, string> } = {},
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const q = view.search.trim();
  if (q) out['q'] = q;
  if (view.sortCol && view.sortDir) {
    out['sort'] = cfg.sortMap?.[view.sortCol] ?? view.sortCol;
    out['dir'] = view.sortDir;
  }
  for (const [col, param] of Object.entries(cfg.filterMap ?? {})) {
    const sel = view.filterFor(col);
    if (sel.size > 0) out[param] = Array.from(sel).join(',');
  }
  return out;
}

export interface SelectRowsConfig<T> {
  /** col key → the row value matched against that column's selected filter set. */
  filters?: Record<string, (row: T) => string>;
  /** col key → the value used to sort when that column is the active sort. */
  sortValues?: Record<string, (row: T) => string | number>;
  /** Free-text searchable text for a row (matched, case-insensitive, against view.search). */
  searchText?: (row: T) => string;
  /** Deterministic tie-break when the sort value is equal. */
  tieBreak?: (a: T, b: T) => number;
}

/** Apply a ColumnView's search + filters + active sort to a row list, client-side. */
export function selectRows<T>(rows: T[], view: ColumnView, cfg: SelectRowsConfig<T>): T[] {
  let out = rows;

  const q = view.search.trim().toLowerCase();
  if (q && cfg.searchText) {
    out = out.filter((row) => cfg.searchText!(row).toLowerCase().includes(q));
  }

  if (cfg.filters) {
    const active = Object.entries(cfg.filters)
      .map(([col, accessor]) => ({ sel: view.filterFor(col), accessor }))
      .filter((f) => f.sel.size > 0);
    if (active.length > 0) {
      out = out.filter((row) => active.every((f) => f.sel.has(f.accessor(row))));
    }
  }

  const accessor = view.sortCol && view.sortDir ? cfg.sortValues?.[view.sortCol] : undefined;
  if (accessor && view.sortDir) {
    const sign = view.sortDir === 'asc' ? 1 : -1;
    out = [...out].sort((a, b) => {
      const av = accessor(a);
      const bv = accessor(b);
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv));
      if (cmp !== 0) return cmp * sign;
      return cfg.tieBreak ? cfg.tieBreak(a, b) : 0;
    });
  }

  return out;
}
