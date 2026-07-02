// SPDX-License-Identifier: Elastic-2.0
import type { CSSProperties, ReactNode } from 'react';

import { tokens } from './tokens';

export interface TableColumn<T> {
  key: string;
  /** Header content — plain text, or a node (e.g. a clickable sort button). */
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
}

/**
 * Controlled pagination. The PARENT owns the data: `rows` is the current
 * page's rows, `total` is the full row count, and `page`/`pageSize` reflect
 * what's shown. The Table only renders the controls bar and emits changes —
 * the parent decides whether that means a server refetch (server-side
 * pagination) or a local slice (client-side, e.g. report aggregations).
 */
export interface TablePagination {
  page: number;
  pageSize: number;
  total: number;
  /** Defaults to [50, 100, 250]. */
  pageSizeOptions?: number[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

export interface TableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
  /** Optional totals/footer row — one cell per column (by index). Rendered
   *  in a bold <tfoot>, honoring each column's alignment. */
  footer?: ReactNode[];
  /** When set, renders a page-size dropdown + prev/next below the table. */
  pagination?: TablePagination;
  /** Optional per-row <tr> style — e.g. highlight the selected row. */
  rowStyle?: (row: T) => CSSProperties | undefined;
}

const DEFAULT_PAGE_SIZE_OPTIONS = [50, 100, 250];

function PaginationBar({
  page,
  pageSize,
  total,
  pageSizeOptions,
  onPageChange,
  onPageSizeChange,
}: TablePagination): JSX.Element {
  const options = pageSizeOptions ?? DEFAULT_PAGE_SIZE_OPTIONS;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const clampedPage = Math.min(page, pageCount);
  const first = total === 0 ? 0 : (clampedPage - 1) * pageSize + 1;
  const last = Math.min(clampedPage * pageSize, total);
  const btnStyle = (disabled: boolean): CSSProperties => ({
    padding: '4px 10px',
    fontSize: 12,
    fontFamily: tokens.font.body,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    background: 'transparent',
    color: disabled ? tokens.color.textMuted : tokens.color.text,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  });
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: tokens.space.md,
        padding: '8px 6px',
        fontFamily: tokens.font.body,
        fontSize: 12,
        color: tokens.color.textMuted,
        flexWrap: 'wrap',
      }}
    >
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        Rows per page:
        <select
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          style={{
            fontSize: 12,
            padding: '3px 6px',
            borderRadius: tokens.radius.sm,
            border: `1px solid ${tokens.color.border}`,
            background: tokens.color.surface,
            color: tokens.color.text,
          }}
          aria-label="Rows per page"
        >
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span aria-live="polite">
          {first}–{last} of {total}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(clampedPage - 1)}
          disabled={clampedPage <= 1}
          style={btnStyle(clampedPage <= 1)}
        >
          Prev
        </button>
        <button
          type="button"
          onClick={() => onPageChange(clampedPage + 1)}
          disabled={clampedPage >= pageCount}
          style={btnStyle(clampedPage >= pageCount)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  empty,
  footer,
  pagination,
  rowStyle,
}: TableProps<T>): JSX.Element {
  if (rows.length === 0) {
    return (
      <div>
        <div
          style={{
            padding: tokens.space.lg,
            textAlign: 'center',
            color: tokens.color.textMuted,
            fontFamily: tokens.font.body,
            fontSize: 13,
          }}
        >
          {empty ?? 'No data.'}
        </div>
        {pagination && pagination.total > 0 && <PaginationBar {...pagination} />}
      </div>
    );
  }

  const table = (
    <table
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontFamily: tokens.font.body,
        fontSize: 13,
        color: tokens.color.text,
      }}
    >
      <thead>
        <tr>
          {columns.map((c) => (
            <th
              key={c.key}
              style={{
                textAlign: c.align ?? 'left',
                padding: '8px 6px',
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: tokens.color.textMuted,
                borderBottom: `1px solid ${tokens.color.border}`,
              }}
            >
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)} style={rowStyle?.(row)}>
            {columns.map((c) => (
              <td
                key={c.key}
                style={{
                  textAlign: c.align ?? 'left',
                  padding: '10px 6px',
                  borderBottom: `1px solid ${tokens.color.border}`,
                  fontVariantNumeric: c.align === 'right' ? 'tabular-nums' : 'normal',
                }}
              >
                {c.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
      {footer && (
        <tfoot>
          <tr>
            {columns.map((c, i) => (
              <td
                key={c.key}
                style={{
                  textAlign: c.align ?? 'left',
                  padding: '10px 6px',
                  borderTop: `2px solid ${tokens.color.border}`,
                  fontWeight: 700,
                  fontVariantNumeric: c.align === 'right' ? 'tabular-nums' : 'normal',
                }}
              >
                {footer[i] ?? null}
              </td>
            ))}
          </tr>
        </tfoot>
      )}
    </table>
  );

  if (!pagination) return table;
  return (
    <div>
      {table}
      <PaginationBar {...pagination} />
    </div>
  );
}
