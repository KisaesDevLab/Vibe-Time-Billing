// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// M0 — on narrow viewports the Table renders as a card list (one card
// per row) instead of a <table>: a 12-column grid squeezed into 390px
// is a peephole, not a table. Columns opt into card roles via
// `mobile` hints; with no hints the first column becomes the card
// title and the rest render as label·value fields. Pages that truly
// need a grid (weekly time matrix) pass `mobileLayout="scroll"` to
// keep the horizontal-scroll behavior. Desktop output is unchanged.

import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from 'react';

import { tokens } from './tokens';
import { useIsNarrow } from './useIsNarrow';

export interface TableColumn<T> {
  key: string;
  /** Header content — plain text, or a node (e.g. a clickable sort button). */
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Card-mode role on phones (default: first column 'title', rest
   *  'field'). 'title' = bold first line · 'badge' = pill next to the
   *  title · 'meta' = muted second line · 'field' = label·value pair ·
   *  'actions' = pinned top-right (menus/buttons) · 'hidden' = omitted. */
  mobile?: 'title' | 'badge' | 'meta' | 'field' | 'actions' | 'hidden';
  /** Card-mode field label. Defaults to `header` when it's a string
   *  (sortable-header nodes aren't reusable as labels), else `key`. */
  mobileLabel?: string;
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
   *  in a bold <tfoot>, honoring each column's alignment. In card mode it
   *  becomes a summary card of label·value pairs. */
  footer?: ReactNode[];
  /** When set, renders a page-size dropdown + prev/next below the table. */
  pagination?: TablePagination;
  /** Optional per-row <tr> style — e.g. highlight the selected row.
   *  Applied to the card in card mode. */
  rowStyle?: (row: T) => CSSProperties | undefined;
  /** Phone layout: 'cards' (default) or 'scroll' to keep the <table>
   *  inside a horizontal scroller (grids that only make sense as grids). */
  mobileLayout?: 'cards' | 'scroll';
  /** Full custom card renderer — overrides the hint-driven card. */
  mobileRenderRow?: (row: T) => ReactNode;
  /** Tap/click handler for the whole row (card in card mode, <tr> on
   *  desktop). Clicks on interactive elements inside are ignored. */
  onRowClick?: (row: T) => void;
}

const DEFAULT_PAGE_SIZE_OPTIONS = [50, 100, 250];

/**
 * Standalone pagination controls. `Table` renders this itself when given a
 * `pagination` prop, but it's exported for the raw `<table>` views that can't
 * adopt the column model (stateful row components, ColumnFilter headers) yet
 * still want the same pager — pair it with `useClientPage`.
 */
export function PaginationBar({
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
              {/* 0221 — sentinel size ≥ 99999 reads as "All" (server caps apply). */}
              {o >= 99_999 ? 'All' : o}
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

/** Clicks on interactive descendants must not fire the row handler. */
function isInteractiveTarget(e: ReactMouseEvent): boolean {
  return !!(e.target as HTMLElement).closest(
    'a, button, input, select, textarea, label, [role="button"], [role="menu"]',
  );
}

function cardLabel<T>(c: TableColumn<T>): string {
  return c.mobileLabel ?? (typeof c.header === 'string' ? c.header : c.key);
}

/** null / undefined / '' cells are skipped in card mode. */
function isEmptyCell(v: ReactNode): boolean {
  return v === null || v === undefined || v === '' || v === false;
}

function TableCardList<T>({
  columns,
  rows,
  rowKey,
  footer,
  rowStyle,
  mobileRenderRow,
  onRowClick,
}: Pick<
  TableProps<T>,
  'columns' | 'rows' | 'rowKey' | 'footer' | 'rowStyle' | 'mobileRenderRow' | 'onRowClick'
>): JSX.Element {
  // Hint defaults: first non-hidden column is the title, the rest fields.
  const hinted = columns.some((c) => c.mobile !== undefined);
  const roleOf = (c: TableColumn<T>, i: number): NonNullable<TableColumn<T>['mobile']> => {
    if (c.mobile) return c.mobile;
    if (!hinted && i === 0) return 'title';
    return 'field';
  };
  const title = columns.filter((c, i) => roleOf(c, i) === 'title');
  const badges = columns.filter((c, i) => roleOf(c, i) === 'badge');
  const metas = columns.filter((c, i) => roleOf(c, i) === 'meta');
  const fields = columns.filter((c, i) => roleOf(c, i) === 'field');
  const actions = columns.filter((c, i) => roleOf(c, i) === 'actions');

  const cardBase: CSSProperties = {
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.md,
    background: tokens.color.surface,
    padding: tokens.space.md,
    fontFamily: tokens.font.body,
    fontSize: 13,
    color: tokens.color.text,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.sm }}>
      {rows.map((row) => {
        const clickable = !!onRowClick;
        const custom = mobileRenderRow?.(row);
        const inner = custom ?? (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: tokens.space.sm,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 6,
                    fontWeight: 600,
                    overflowWrap: 'anywhere',
                  }}
                >
                  {title.map((c) => {
                    const v = c.render(row);
                    return isEmptyCell(v) ? null : <span key={c.key}>{v}</span>;
                  })}
                  {badges.map((c) => {
                    const v = c.render(row);
                    return isEmptyCell(v) ? null : (
                      <span key={c.key} style={{ fontWeight: 400 }}>
                        {v}
                      </span>
                    );
                  })}
                </div>
                {metas.some((c) => !isEmptyCell(c.render(row))) && (
                  <div
                    style={{
                      marginTop: 2,
                      fontSize: 12,
                      color: tokens.color.textMuted,
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '2px 10px',
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {metas.map((c) => {
                      const v = c.render(row);
                      return isEmptyCell(v) ? null : <span key={c.key}>{v}</span>;
                    })}
                  </div>
                )}
              </div>
              {actions.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    flexShrink: 0,
                  }}
                >
                  {actions.map((c) => {
                    const v = c.render(row);
                    return isEmptyCell(v) ? null : <span key={c.key}>{v}</span>;
                  })}
                </div>
              )}
            </div>
            {fields.some((c) => !isEmptyCell(c.render(row))) && (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '4px 16px',
                  marginTop: title.length + badges.length + metas.length > 0 ? 8 : 0,
                }}
              >
                {fields.map((c) => {
                  const v = c.render(row);
                  if (isEmptyCell(v)) return null;
                  return (
                    <div key={c.key} style={{ minWidth: 0, maxWidth: '100%' }}>
                      <div
                        style={{
                          fontSize: 10,
                          textTransform: 'uppercase',
                          letterSpacing: '0.08em',
                          color: tokens.color.textMuted,
                        }}
                      >
                        {cardLabel(c)}
                      </div>
                      <div
                        style={{
                          fontVariantNumeric: c.align === 'right' ? 'tabular-nums' : 'normal',
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {v}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        );
        const style: CSSProperties = {
          ...cardBase,
          ...(clickable ? { cursor: 'pointer' } : {}),
          ...rowStyle?.(row),
        };
        return clickable ? (
          <div
            key={rowKey(row)}
            role="button"
            tabIndex={0}
            onClick={(e) => {
              if (!isInteractiveTarget(e)) onRowClick!(row);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onRowClick!(row);
              }
            }}
            style={style}
          >
            {inner}
          </div>
        ) : (
          <div key={rowKey(row)} style={style}>
            {inner}
          </div>
        );
      })}
      {footer && (
        <div style={{ ...cardBase, background: tokens.color.bg }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
            {columns.map((c, i) => {
              const v = footer[i];
              if (isEmptyCell(v ?? null)) return null;
              return (
                <div key={c.key} style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 10,
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                      color: tokens.color.textMuted,
                    }}
                  >
                    {cardLabel(c)}
                  </div>
                  <div
                    style={{
                      fontWeight: 700,
                      fontVariantNumeric: c.align === 'right' ? 'tabular-nums' : 'normal',
                    }}
                  >
                    {v}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
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
  mobileLayout = 'cards',
  mobileRenderRow,
  onRowClick,
}: TableProps<T>): JSX.Element {
  const narrow = useIsNarrow();
  const cardMode = narrow && mobileLayout === 'cards';

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

  if (cardMode) {
    const cards = (
      <TableCardList
        columns={columns}
        rows={rows}
        rowKey={rowKey}
        footer={footer}
        rowStyle={rowStyle}
        mobileRenderRow={mobileRenderRow}
        onRowClick={onRowClick}
      />
    );
    if (!pagination) return cards;
    return (
      <div>
        {cards}
        <PaginationBar {...pagination} />
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
          <tr
            key={rowKey(row)}
            style={{
              ...(onRowClick ? { cursor: 'pointer' } : {}),
              ...rowStyle?.(row),
            }}
            onClick={
              onRowClick
                ? (e) => {
                    if (!isInteractiveTarget(e)) onRowClick(row);
                  }
                : undefined
            }
          >
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

  // The scroll container keeps a wide table from horizontal-scrolling the
  // WHOLE page on phones — overflow stays inside the card. Interactive
  // cell content is safe: Combobox/ColumnFilter portal their popovers to
  // <body>, so nothing gets clipped.
  const scrollable = (
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', maxWidth: '100%' }}>
      {table}
    </div>
  );
  if (!pagination) return scrollable;
  return (
    <div>
      {scrollable}
      <PaginationBar {...pagination} />
    </div>
  );
}
