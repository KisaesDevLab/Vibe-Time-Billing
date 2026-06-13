// SPDX-License-Identifier: Elastic-2.0
//
// Tax → Signatures tab. A firm-wide log of client signature activity (every
// non-draft signature request), with the same per-column filter/sort + session
// persistence as the Returns tab. Each row whose return is linked to an
// engagement gets an inline status selector that drives the engagement's
// workflow state through the canonical audited path (which also stages the
// client notification), so completing a signing can advance the engagement
// without leaving this screen.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Card, ColumnFilter, EmptyState, Pill, tokens, type SortDir } from '@vibe/ui';

import { api } from '../../api-client';
import { TableSearch } from '../../components/TableSearch';
import type { ColumnView } from '../../lib/column-view';
import { statusLabel, statusTone } from '../Signatures';

interface CompletionRow {
  id: string;
  title: string;
  status: string;
  signingMode: string;
  formType: string | null;
  signerCount: number;
  signedCount: number;
  sentAt: string | null;
  completedAt: string | null;
  createdAt: string;
  clientId: string | null;
  clientName: string | null;
  taxReturnId: string | null;
  taxReturnTitle: string | null;
  engagementId: string | null;
  engagementName: string | null;
  engagementWorkflowState: string | null;
}

interface StatusOption {
  workflowState: string;
  label: string;
}

type SortCol = 'client' | 'title' | 'form' | 'signers' | 'status' | 'completed';

const MODE_VALUES = [
  { value: 'in_person', label: 'In office' },
  { value: 'remote', label: 'Remote' },
];

const STATUS_VALUES = [
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'partially_signed', label: 'Partially signed' },
  { value: 'completed', label: 'Completed' },
  { value: 'declined', label: 'Declined' },
  { value: 'expired', label: 'Expired' },
  { value: 'voided', label: 'Voided' },
];

// Rows in a terminal state can't start/show an in-office QR (the sheet route
// 409s for these); only in-progress (sent / partially signed) rows can.
const SIG_TERMINAL = new Set(['completed', 'declined', 'expired', 'voided']);

const STORAGE_KEY = 'vibe.tax-signatures.view.v2';

interface PersistedView {
  sortCol: SortCol | '';
  sortDir: SortDir;
  client: string[];
  form: string[];
  mode: string[];
  status: string[];
}

// Show all signature activity by default (drafts included), newest first, so a
// just-collected package is visible and actionable here.
const DEFAULT_VIEW: PersistedView = {
  sortCol: 'completed',
  sortDir: 'desc',
  client: [],
  form: [],
  mode: [],
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

export function TaxSignatureCompletionsTab(): JSX.Element {
  const [items, setItems] = useState<CompletionRow[]>([]);
  const [statusOptions, setStatusOptions] = useState<StatusOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingEng, setSavingEng] = useState<string | null>(null);

  const initial = useMemo(() => loadView(), []);
  const [sortBy, setSortBy] = useState<{ col: SortCol | ''; dir: SortDir }>({
    col: initial.sortCol,
    dir: initial.sortDir,
  });
  const [clientFilter, setClientFilter] = useState<Set<string>>(new Set(initial.client));
  const [formFilter, setFormFilter] = useState<Set<string>>(new Set(initial.form));
  const [modeFilter, setModeFilter] = useState<Set<string>>(new Set(initial.mode));
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set(initial.status));
  const [search, setSearch] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const [c, s] = await Promise.all([
          api<{ items: CompletionRow[] }>('/api/staff/tax/returns/signature-completions'),
          api<{ items: StatusOption[] }>('/api/staff/engagement-statuses').catch(() => ({
            items: [],
          })),
        ]);
        setItems(c.items ?? []);
        setStatusOptions(s.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    const view: PersistedView = {
      sortCol: sortBy.col,
      sortDir: sortBy.dir,
      client: Array.from(clientFilter),
      form: Array.from(formFilter),
      mode: Array.from(modeFilter),
      status: Array.from(statusFilter),
    };
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(view));
    } catch {
      /* storage unavailable — in-memory only */
    }
  }, [sortBy, clientFilter, formFilter, modeFilter, statusFilter]);

  const statusOptionLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of statusOptions) m.set(o.workflowState, o.label);
    return m;
  }, [statusOptions]);

  const clientValues = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of items) if (r.clientId) map.set(r.clientId, r.clientName ?? r.clientId);
    return Array.from(map.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [items]);
  const formValues = useMemo(
    () =>
      Array.from(new Set(items.map((r) => r.formType ?? '—')))
        .sort((a, b) => a.localeCompare(b))
        .map((f) => ({ value: f, label: f })),
    [items],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let r = items.filter((row) => {
      if (clientFilter.size > 0 && !(row.clientId && clientFilter.has(row.clientId))) return false;
      if (formFilter.size > 0 && !formFilter.has(row.formType ?? '—')) return false;
      if (modeFilter.size > 0 && !modeFilter.has(row.signingMode)) return false;
      if (statusFilter.size > 0 && !statusFilter.has(row.status)) return false;
      if (
        q &&
        !`${row.clientName ?? ''} ${row.title} ${row.formType ?? ''} ${row.taxReturnTitle ?? ''} ${row.engagementName ?? ''}`
          .toLowerCase()
          .includes(q)
      )
        return false;
      return true;
    });
    if (sortBy.col && sortBy.dir) {
      const sign = sortBy.dir === 'asc' ? 1 : -1;
      const col = sortBy.col;
      const numeric = col === 'signers' || col === 'completed';
      const num = (row: CompletionRow): number =>
        col === 'signers'
          ? row.signedCount
          : col === 'completed'
            ? row.completedAt
              ? Date.parse(row.completedAt)
              : 0
            : NaN;
      const str = (row: CompletionRow): string => {
        switch (col) {
          case 'client':
            return (row.clientName ?? '').toLowerCase();
          case 'title':
            return row.title.toLowerCase();
          case 'form':
            return (row.formType ?? '').toLowerCase();
          case 'status':
            return row.status;
          default:
            return '';
        }
      };
      r = [...r].sort((a, b) => {
        const cmp = numeric ? num(a) - num(b) : str(a) < str(b) ? -1 : str(a) > str(b) ? 1 : 0;
        if (cmp !== 0) return cmp * sign;
        return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      });
    }
    return r;
  }, [items, clientFilter, formFilter, modeFilter, statusFilter, sortBy, search]);

  const sortFor = (col: SortCol): SortDir => (sortBy.col === col ? sortBy.dir : null);
  const filtersActive =
    clientFilter.size + formFilter.size + modeFilter.size + statusFilter.size > 0 ||
    search.trim().length > 0;

  function clearAll(): void {
    setClientFilter(new Set());
    setFormFilter(new Set());
    setModeFilter(new Set());
    setStatusFilter(new Set());
    setSearch('');
  }

  async function changeEngagementStatus(row: CompletionRow, ws: string): Promise<void> {
    if (!row.engagementId || !ws || ws === row.engagementWorkflowState) return;
    setSavingEng(row.engagementId);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/staff/engagements/${row.engagementId}/workflow-state`, {
        method: 'PATCH',
        body: JSON.stringify({ workflowState: ws }),
      });
      // Reflect on every row sharing this engagement.
      setItems((prev) =>
        prev.map((x) =>
          x.engagementId === row.engagementId ? { ...x, engagementWorkflowState: ws } : x,
        ),
      );
      setNotice(`Engagement status updated to ${statusOptionLabel.get(ws) ?? ws}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change engagement status.');
    } finally {
      setSavingEng(null);
    }
  }

  return (
    <Card
      title={
        <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span>Signatures</span>
          {items.length > 0 && (
            <span style={{ fontSize: 13, color: tokens.color.textMuted, fontWeight: 400 }}>
              {visible.length === items.length
                ? `${items.length}`
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
      {notice && (
        <p style={{ color: tokens.color.success, fontSize: 12, marginBottom: 8 }}>{notice}</p>
      )}

      {loading ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
      ) : items.length === 0 ? (
        <EmptyState
          title="No signature activity yet"
          body="When a signature request is sent or signed it appears here. Completed ones can advance the linked engagement's status from this tab."
        />
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <TableSearch
              view={{ search, setSearch } as unknown as ColumnView}
              placeholder="Search signatures…"
            />
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 13,
                fontFamily: tokens.font.body,
              }}
            >
              <thead>
                <tr style={{ background: tokens.color.surface }}>
                  <th style={th()}>
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
                  </th>
                  <th style={th()}>
                    Document{' '}
                    <ColumnFilter
                      ariaLabel="Sort by document"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={sortFor('title')}
                      onApply={(_, dir) => {
                        if (dir) setSortBy({ col: 'title', dir });
                      }}
                    />
                  </th>
                  <th style={th()}>
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
                  </th>
                  <th style={th()}>Tax return</th>
                  <th style={th('right')}>
                    Signers{' '}
                    <ColumnFilter
                      ariaLabel="Sort by signers"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={sortFor('signers')}
                      onApply={(_, dir) => {
                        if (dir) setSortBy({ col: 'signers', dir });
                      }}
                    />
                  </th>
                  <th style={th()}>
                    Mode{' '}
                    <ColumnFilter
                      ariaLabel="Filter mode"
                      values={MODE_VALUES}
                      selected={modeFilter}
                      searchable={false}
                      sort={null}
                      onApply={(sel) => setModeFilter(sel)}
                    />
                  </th>
                  <th style={th()}>
                    Status{' '}
                    <ColumnFilter
                      ariaLabel="Filter / sort status"
                      values={STATUS_VALUES}
                      selected={statusFilter}
                      searchable={false}
                      sort={sortFor('status')}
                      onApply={(sel, dir) => {
                        setStatusFilter(sel);
                        if (dir) setSortBy({ col: 'status', dir });
                      }}
                    />
                  </th>
                  <th style={th()}>
                    Completed{' '}
                    <ColumnFilter
                      ariaLabel="Sort by completed date"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={sortFor('completed')}
                      onApply={(_, dir) => {
                        if (dir) setSortBy({ col: 'completed', dir });
                      }}
                    />
                  </th>
                  <th style={th()}>Engagement</th>
                  <th style={th()}>Engagement status</th>
                  <th style={th('right')}>In-office</th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td
                      colSpan={11}
                      style={{
                        textAlign: 'center',
                        padding: 40,
                        color: tokens.color.textMuted,
                        fontSize: 13,
                      }}
                    >
                      <div style={{ fontSize: 32, marginBottom: 8 }}>▽</div>
                      <strong>No results</strong>
                      <div>Please refine your filters.</div>
                    </td>
                  </tr>
                ) : (
                  visible.map((r) => (
                    <tr key={r.id} style={{ borderTop: `1px solid ${tokens.color.border}` }}>
                      <td style={td()}>{r.clientName ?? '—'}</td>
                      <td style={td()}>
                        <Link
                          to={`/signatures/${r.id}`}
                          style={{ color: tokens.color.accent, textDecoration: 'none' }}
                        >
                          {r.title}
                        </Link>
                      </td>
                      <td style={td()}>{r.formType ?? '—'}</td>
                      <td style={td()}>
                        {r.taxReturnId ? (
                          <Link
                            to={`/tax/returns/${r.taxReturnId}`}
                            style={{ color: tokens.color.accent, textDecoration: 'none' }}
                          >
                            {r.taxReturnTitle ?? 'Return'}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td
                        style={{ ...td(), textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                      >
                        {r.signedCount}/{r.signerCount}
                      </td>
                      <td style={td()}>{r.signingMode === 'in_person' ? 'In office' : 'Remote'}</td>
                      <td style={td()}>
                        <Pill tone={statusTone(r.status)}>{statusLabel(r.status)}</Pill>
                      </td>
                      <td style={td()}>
                        {r.completedAt ? new Date(r.completedAt).toLocaleDateString() : '—'}
                      </td>
                      <td style={td()}>{r.engagementName ?? '—'}</td>
                      <td style={td()}>
                        {r.engagementId ? (
                          <select
                            aria-label={`Engagement status for ${r.title}`}
                            value={r.engagementWorkflowState ?? ''}
                            disabled={savingEng === r.engagementId}
                            onChange={(e) => void changeEngagementStatus(r, e.target.value)}
                            style={{
                              fontSize: 13,
                              padding: '4px 6px',
                              borderRadius: tokens.radius.sm,
                              border: `1px solid ${tokens.color.border}`,
                              background: tokens.color.bg,
                              color: tokens.color.text,
                              maxWidth: 200,
                            }}
                          >
                            {r.engagementWorkflowState &&
                              !statusOptions.some(
                                (o) => o.workflowState === r.engagementWorkflowState,
                              ) && (
                                <option value={r.engagementWorkflowState}>
                                  {r.engagementWorkflowState}
                                </option>
                              )}
                            {statusOptions.map((o) => (
                              <option key={o.workflowState} value={o.workflowState}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                            Link an engagement on the return
                          </span>
                        )}
                      </td>
                      <td style={{ ...td(), textAlign: 'right' }}>
                        {SIG_TERMINAL.has(r.status) ? (
                          <span style={{ color: tokens.color.textMuted }}>—</span>
                        ) : (
                          <span
                            style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}
                          >
                            <Link
                              to={`/signatures/${r.id}`}
                              title="Collect in-office signature — set up / sign on this device"
                              aria-label={`Collect in-office signature for ${r.title}`}
                              style={iconBtn}
                            >
                              <PenGlyph />
                            </Link>
                            <button
                              type="button"
                              title="View / print the in-office QR sheet"
                              aria-label={`Show in-office QR sheet for ${r.title}`}
                              onClick={() =>
                                window.open(`/api/staff/signatures/${r.id}/qr-sheet.pdf`, '_blank')
                              }
                              style={{ ...iconBtn, cursor: 'pointer' }}
                            >
                              <QrGlyph />
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

function th(align: 'left' | 'right' = 'left'): React.CSSProperties {
  return {
    textAlign: align,
    padding: '10px 8px',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: tokens.color.textMuted,
    fontWeight: 600,
    borderBottom: `1px solid ${tokens.color.border}`,
    whiteSpace: 'nowrap',
  };
}

function td(): React.CSSProperties {
  return { padding: '8px', fontSize: 13, verticalAlign: 'middle' };
}

const iconBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.surface,
  color: tokens.color.accent,
  textDecoration: 'none',
};

// Pen / signature glyph for "collect in-office signature".
function PenGlyph(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M11.5 1.5l3 3L6 13l-3.5.5L3 10l8.5-8.5zm0 2.1L4.3 10.8l-.2 1.1 1.1-.2 7.2-7.2-.9-.9z" />
    </svg>
  );
}

// Minimal QR-code glyph.
function QrGlyph(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M1 1h5v5H1V1zm1 1v3h3V2H2zm8-1h5v5h-5V1zm1 1v3h3V2h-3zM1 10h5v5H1v-5zm1 1v3h3v-3H2z" />
      <path d="M3 3h1v1H3V3zm9 0h1v1h-1V3zM3 12h1v1H3v-1zm5-9h2v2H8V3zm3 5h2v2h-2V8zm-3 0h2v2H8V8zm0 3h2v2H8v-2zm3 0h2v2h-2v-2zm2-3h1v1h-1V8z" />
    </svg>
  );
}
