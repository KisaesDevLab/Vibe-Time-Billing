/* eslint-disable jsx-a11y/label-has-associated-control -- date-range labels and inputs are siblings inside grid containers; matches PaymentsReceivedReport */
// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Signed forms report. A date-ranged, sortable/searchable list of
// completed (or partially-signed) e-signature requests with direct
// links to the signed PDFs + completion certificates. Backed by
// GET /api/staff/reports/signed-forms (+ ?format=csv for export).
//
// Reuses the shared column-view filter/sort/search wiring (FilterHeader +
// useColumnView/selectRows) from the Signatures list, and the date-range
// header pattern from the Payments Received report.

import { useEffect, useMemo, useState } from 'react';

import { Button, Card, ColumnFilter, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { downloadReportPdf } from '../../lib/report-pdf';
import { TableSearch } from '../../components/TableSearch';
import { selectRows, useColumnView } from '../../lib/column-view';
import { useClientPage } from '../../lib/use-paged-list';

interface SignedFormRow {
  id: string;
  title: string;
  clientName: string | null;
  formType: string | null;
  signingMode: string;
  taxReturnId: string | null;
  taxReturnTitle: string | null;
  signerCount: number;
  signedCount: number;
  sentAt: string | null;
  completedAt: string | null;
  hasSigned: boolean;
  hasCertificate: boolean;
}

interface Report {
  from: string;
  to: string;
  rows: SignedFormRow[];
}

function defaultRange(): { from: string; to: string } {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  return {
    from: monthStart.toISOString().slice(0, 10),
    to: today.toISOString().slice(0, 10),
  };
}

// Backend supports both; the page used to hard-code 'completed', leaving
// partially-signed requests unreachable from the UI.
type ReportStatus = 'completed' | 'partially_signed';

function modeLabel(m: string): string {
  return m === 'in_person' ? 'In office' : 'Remote';
}

// Header cell: label + the shared ColumnFilter popover (sort + optional
// value filter). Mirrors the Signatures list helper.
function FilterHeader({
  label,
  col,
  view,
  values,
  searchable,
}: {
  label: string;
  col: string;
  view: ReturnType<typeof useColumnView>;
  values?: { value: string; label: string }[];
  searchable?: boolean;
}): JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {label}{' '}
      <ColumnFilter
        ariaLabel={values ? `Filter / sort ${label}` : `Sort by ${label}`}
        values={values ?? []}
        selected={values ? view.filterFor(col) : new Set()}
        searchable={searchable ?? Boolean(values)}
        sort={view.sortFor(col)}
        onApply={(sel, dir) => view.apply(col, values ? sel : new Set(), dir)}
      />
    </span>
  );
}

export function SignedFormsReportPage(): JSX.Element {
  const init = defaultRange();
  const [from, setFrom] = useState(init.from);
  const [to, setTo] = useState(init.to);
  const [status, setStatus] = useState<ReportStatus>('completed');
  const [rows, setRows] = useState<SignedFormRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const view = useColumnView('vibe.signed-forms.view', { sortCol: 'completed', sortDir: 'desc' });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ from, to, status });
    api<Report>(`/api/staff/reports/signed-forms?${qs.toString()}`)
      .then((r) => {
        if (!cancelled) setRows(r.rows ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'load_failed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, status]);

  const clientValues = useMemo(() => {
    const names = Array.from(new Set(rows.map((r) => r.clientName ?? '(no client)')));
    return names.sort((a, b) => a.localeCompare(b)).map((n) => ({ value: n, label: n }));
  }, [rows]);

  const formValues = useMemo(() => {
    const forms = Array.from(new Set(rows.map((r) => r.formType ?? 'Generic')));
    return forms.sort((a, b) => a.localeCompare(b)).map((f) => ({ value: f, label: f }));
  }, [rows]);

  const modeValues = useMemo(() => {
    const modes = Array.from(new Set(rows.map((r) => r.signingMode)));
    return modes.sort((a, b) => a.localeCompare(b)).map((m) => ({ value: m, label: modeLabel(m) }));
  }, [rows]);

  const visible = useMemo(
    () =>
      selectRows(rows, view, {
        filters: {
          client: (r) => r.clientName ?? '(no client)',
          formType: (r) => r.formType ?? 'Generic',
          mode: (r) => r.signingMode,
        },
        sortValues: {
          title: (r) => r.title,
          client: (r) => r.clientName ?? '',
          formType: (r) => r.formType ?? '',
          completed: (r) => r.completedAt ?? '',
        },
        searchText: (r) => `${r.title} ${r.clientName ?? ''} ${r.formType ?? ''}`,
        tieBreak: (a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''),
      }),
    [rows, view],
  );

  const { paged, pagination } = useClientPage(visible);

  // 0224 — native PDF of the rows as currently filtered/sorted.
  const [pdfBusy, setPdfBusy] = useState(false);
  async function downloadPdf(): Promise<void> {
    setPdfBusy(true);
    try {
      await downloadReportPdf({
        title: 'Signed Forms',
        subtitle: `${from} to ${to} · ${status}`,
        columns: [
          { label: 'Title', align: 'left' },
          { label: 'Client', align: 'left' },
          { label: 'Form type', align: 'left' },
          { label: 'Mode', align: 'left' },
          { label: 'Tax return', align: 'left' },
          { label: 'Signed', align: 'right' },
          { label: 'Sent', align: 'left' },
          { label: 'Completed', align: 'left' },
        ],
        rows: rows.map((r) => [
          r.title,
          r.clientName ?? '',
          r.formType ?? '',
          r.signingMode,
          r.taxReturnTitle ?? '',
          `${r.signedCount}/${r.signerCount}`,
          r.sentAt ? new Date(r.sentAt).toLocaleDateString() : '',
          r.completedAt ? new Date(r.completedAt).toLocaleDateString() : '',
        ]),
      });
    } finally {
      setPdfBusy(false);
    }
  }

  function downloadCsv(): void {
    const qs = new URLSearchParams({ from, to, status, format: 'csv' });
    window.open(`/api/staff/reports/signed-forms?${qs.toString()}`, '_blank');
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1280 }}>
      <a
        href="/reports"
        style={{ color: tokens.color.accent, fontSize: 12, textDecoration: 'none' }}
      >
        ← All reports
      </a>

      <Card
        title={
          <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8 }}>
            <span>Signed forms</span>
            {rows.length > 0 && (
              <span style={{ fontSize: 13, color: tokens.color.textMuted, fontWeight: 400 }}>
                {visible.length === rows.length
                  ? `${rows.length} form${rows.length === 1 ? '' : 's'}`
                  : `${visible.length} of ${rows.length}`}
              </span>
            )}
          </span>
        }
        action={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {view.anyFilterActive && (
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
            )}
            <Button
              size="sm"
              onClick={() => void downloadPdf()}
              disabled={pdfBusy || rows.length === 0}
            >
              {pdfBusy ? 'Rendering…' : '↓ PDF'}
            </Button>
            <Button size="sm" variant="ghost" onClick={downloadCsv} disabled={rows.length === 0}>
              ↓ Download CSV
            </Button>
          </div>
        }
      >
        {/* Date range */}
        <div
          style={{
            display: 'grid',
            gap: 12,
            padding: 12,
            marginBottom: 12,
            gridTemplateColumns: 'minmax(180px, 1fr) minmax(180px, 1fr) minmax(160px, auto) auto',
            alignItems: 'end',
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            background: tokens.color.surface,
          }}
        >
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={lblStyle()}>From</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              style={inputStyle()}
            />
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={lblStyle()}>To</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              style={inputStyle()}
            />
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={lblStyle()}>Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as ReportStatus)}
              style={inputStyle()}
            >
              <option value="completed">Completed</option>
              <option value="partially_signed">Partially signed</option>
            </select>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const d = defaultRange();
              setFrom(d.from);
              setTo(d.to);
            }}
          >
            Reset range
          </Button>
        </div>

        <div style={{ marginBottom: tokens.space.md, maxWidth: 360 }}>
          <TableSearch view={view} placeholder="Search title, client, form…" />
        </div>

        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }}>{error}</p>
        )}

        {loading ? (
          <div style={{ color: tokens.color.textMuted, fontSize: 13, padding: tokens.space.md }}>
            Loading…
          </div>
        ) : (
          <Table<SignedFormRow>
            columns={[
              {
                key: 'title',
                header: (
                  <FilterHeader label="Title" col="title" view={view} />
                ) as unknown as string,
                render: (r) => (
                  <a
                    href={`/signatures/${r.id}`}
                    style={{ color: tokens.color.accent, textDecoration: 'none' }}
                  >
                    {r.title}
                  </a>
                ),
              },
              {
                key: 'client',
                header: (
                  <FilterHeader label="Client" col="client" view={view} values={clientValues} />
                ) as unknown as string,
                render: (r) =>
                  r.clientName ?? <span style={{ color: tokens.color.textMuted }}>—</span>,
              },
              {
                key: 'formType',
                header: (
                  <FilterHeader label="Form" col="formType" view={view} values={formValues} />
                ) as unknown as string,
                render: (r) => r.formType ?? 'Generic',
              },
              {
                key: 'taxReturn',
                header: 'Tax return',
                render: (r) =>
                  r.taxReturnId ? (
                    <a
                      href={`/tax/returns/${r.taxReturnId}`}
                      style={{ color: tokens.color.accent, textDecoration: 'none' }}
                    >
                      {r.taxReturnTitle ?? 'Return'}
                    </a>
                  ) : (
                    <span style={{ color: tokens.color.textMuted }}>—</span>
                  ),
              },
              {
                key: 'mode',
                header: (
                  <FilterHeader
                    label="Mode"
                    col="mode"
                    view={view}
                    values={modeValues}
                    searchable={false}
                  />
                ) as unknown as string,
                render: (r) => (
                  <Pill tone={r.signingMode === 'in_person' ? 'accent' : 'neutral'}>
                    {modeLabel(r.signingMode)}
                  </Pill>
                ),
              },
              {
                key: 'signers',
                header: 'Signers',
                align: 'center',
                render: (r) => `${r.signedCount}/${r.signerCount}`,
              },
              {
                key: 'completed',
                header: (
                  <FilterHeader label="Completed" col="completed" view={view} />
                ) as unknown as string,
                render: (r) => (r.completedAt ? new Date(r.completedAt).toLocaleDateString() : '—'),
              },
              {
                key: 'actions',
                header: 'Actions',
                render: (r) => (
                  <div style={{ display: 'flex', gap: 6 }}>
                    {r.hasSigned && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          window.open(`/api/staff/signatures/${r.id}/signed?inline=1`, '_blank')
                        }
                      >
                        View
                      </Button>
                    )}
                    {r.hasSigned && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => window.open(`/api/staff/signatures/${r.id}/signed`)}
                      >
                        Download
                      </Button>
                    )}
                    {r.hasCertificate && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => window.open(`/api/staff/signatures/${r.id}/certificate`)}
                      >
                        Certificate
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
            rows={paged}
            pagination={pagination}
            rowKey={(r) => r.id}
            empty={
              rows.length === 0
                ? 'No completed signature requests in this window.'
                : 'No forms match the current filters.'
            }
          />
        )}
      </Card>
    </div>
  );
}

function lblStyle(): React.CSSProperties {
  return { fontSize: 11, color: tokens.color.textMuted };
}
function inputStyle(): React.CSSProperties {
  return {
    padding: '8px 10px',
    fontSize: 13,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    background: tokens.color.bg,
    color: tokens.color.text,
    boxSizing: 'border-box',
    width: '100%',
  };
}
