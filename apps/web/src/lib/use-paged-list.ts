// SPDX-License-Identifier: Elastic-2.0
//
// Server-side paginated list hook. Owns page/pageSize/total/rows and
// refetches from a `{ rows|items, total }` endpoint whenever page, pageSize,
// or the caller's filter `query` changes. Pairs with the shared <Table>'s
// controlled `pagination` prop:
//
//   const list = usePagedList<Row>('/api/staff/clients', { query });
//   <Table rows={list.rows} pagination={list.pagination} ... />
//
// Changing any filter (a new `query` object identity) resets to page 1.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../api-client';

export interface PagedListResult<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
  error: string | null;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  reload: () => void;
  /** Ready to spread onto <Table pagination={...}>. */
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    onPageChange: (page: number) => void;
    onPageSizeChange: (size: number) => void;
  };
}

interface Options {
  /** Initial rows-per-page (must be one of the dropdown options). Default 50. */
  pageSize?: number;
  /** Extra filter/sort query params. A NEW object identity resets to page 1. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Set false to not fetch yet (e.g. waiting on a prerequisite). Default true. */
  enabled?: boolean;
}

function buildQuery(page: number, pageSize: number, query: Options['query']): string {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    }
  }
  return params.toString();
}

/**
 * Client-side pagination for pages that already hold the full (filtered/
 * sorted) array in memory — e.g. the `useColumnView`-backed list pages.
 * Slices locally and produces a `pagination` object for the shared <Table>.
 * Snaps back a page when filtering shrinks the set below the current page.
 */
export function useClientPage<T>(
  rows: T[],
  initialPageSize = 50,
): {
  paged: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    onPageChange: (page: number) => void;
    onPageSizeChange: (size: number) => void;
  };
} {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(rows.length / pageSize));
    if (page > maxPage) setPage(maxPage);
  }, [rows.length, pageSize, page]);
  const paged = useMemo(
    () => rows.slice((page - 1) * pageSize, page * pageSize),
    [rows, page, pageSize],
  );
  return {
    paged,
    pagination: {
      page,
      pageSize,
      total: rows.length,
      onPageChange: setPage,
      onPageSizeChange: (s: number) => {
        setPageSize(s);
        setPage(1);
      },
    },
  };
}

export function usePagedList<T>(path: string, opts: Options = {}): PagedListResult<T> {
  const enabled = opts.enabled ?? true;
  const [page, setPageRaw] = useState(1);
  const [pageSize, setPageSizeRaw] = useState(opts.pageSize ?? 50);
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Serialize the filter query so a value change (not just object identity)
  // is what triggers a reset+refetch.
  const queryKey = useMemo(() => JSON.stringify(opts.query ?? {}), [opts.query]);

  // Reset to page 1 whenever the filters change (but not on first mount).
  const firstFilter = useRef(true);
  useEffect(() => {
    if (firstFilter.current) {
      firstFilter.current = false;
      return;
    }
    setPageRaw(1);
  }, [queryKey]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = buildQuery(page, pageSize, JSON.parse(queryKey) as Options['query']);
    api<{ rows?: T[]; items?: T[]; total?: number }>(`${path}?${qs}`)
      .then((r) => {
        if (cancelled) return;
        setRows(r.rows ?? r.items ?? []);
        setTotal(Number(r.total ?? (r.rows ?? r.items ?? []).length));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'load_failed');
        setRows([]);
        setTotal(0);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, page, pageSize, queryKey, enabled, nonce]);

  const setPage = useCallback((p: number) => setPageRaw(Math.max(1, p)), []);
  const setPageSize = useCallback((s: number) => {
    setPageSizeRaw(s);
    setPageRaw(1); // a resize changes the row window — restart at page 1
  }, []);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return {
    rows,
    total,
    page,
    pageSize,
    loading,
    error,
    setPage,
    setPageSize,
    reload,
    pagination: { page, pageSize, total, onPageChange: setPage, onPageSizeChange: setPageSize },
  };
}
