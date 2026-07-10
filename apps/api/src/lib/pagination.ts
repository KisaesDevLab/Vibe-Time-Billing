// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Shared server-side pagination for list endpoints. Replaces the
// copy-pasted `page`/`pageSize` clamp idiom scattered across routers so
// every paginated list uses one convention:
//
//   const { page, pageSize, limit, offset } = parsePageParams(req.query);
//   ... .limit(limit).offset(offset)
//   res.json(pageEnvelope(rows, total, page, pageSize));
//
// The envelope is `{ rows, total, page, pageSize }`; `items` is aliased to
// `rows` so frontends that historically read `r.items` keep working.

/** The row-count options surfaced in the table page-size dropdown. */
export const PAGE_SIZE_OPTIONS = [50, 100, 250] as const;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 250;

export interface PageParams {
  page: number;
  pageSize: number;
  /** = pageSize (for `.limit()`). */
  limit: number;
  /** = (page - 1) * pageSize (for `.offset()`). */
  offset: number;
}

function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Parse + clamp `page` (>= 1) and `pageSize` (1..maxPageSize) from a query
 * object. Junk / missing values fall back to defaults. `pageSize` is
 * clamped, not rejected, so a client asking for 1000 gets `maxPageSize`.
 */
export function parsePageParams(
  query: Record<string, unknown> | undefined,
  opts: { defaultPageSize?: number; maxPageSize?: number } = {},
): PageParams {
  const defaultPageSize = opts.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  const maxPageSize = opts.maxPageSize ?? MAX_PAGE_SIZE;
  const page = Math.max(1, toInt(query?.['page']) ?? 1);
  const rawSize = toInt(query?.['pageSize']) ?? defaultPageSize;
  const pageSize = Math.min(maxPageSize, Math.max(1, rawSize));
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

export interface PageEnvelope<T> {
  rows: T[];
  /** Legacy alias of `rows` — some frontends read `r.items`. */
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Build the standard paginated response envelope. */
export function pageEnvelope<T>(
  rows: T[],
  total: number,
  page: number,
  pageSize: number,
): PageEnvelope<T> {
  return { rows, items: rows, total, page, pageSize };
}
