// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Payroll review (0226): pick a pay period, see every employee's
// Regular / OT / PTO / Sick / Comp / Holiday / Unpaid totals with
// missing-day flags, approve each employee, convert OT to comp, then
// lock the period (freezes its time entries). Gated payroll:period:read;
// the manage actions need payroll:period:manage.

import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button, Card, Modal, Pill, ScrollX, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { usePermission } from '../../auth-context';

interface PayPeriod {
  id: string;
  startDate: string;
  endDate: string;
  status: 'OPEN' | 'LOCKED';
  lockedAt: string | null;
}

interface EmployeeRow {
  appUserId: string;
  fullName: string;
  overtimeExempt: boolean;
  isFullTime: boolean;
  regularHours: number;
  otHours: number;
  compConvertedHours: number;
  actualWorkedHours: number;
  ptoHours: number;
  sickHours: number;
  compUsedHours: number;
  holidayHours: number;
  unpaidHours: number;
  missingDays: string[];
  approvedAt: string | null;
}

interface DetailEntry {
  entryDate: string;
  hours: string;
  category: string;
  clientName: string | null;
  engagementName: string | null;
  workCodeName: string | null;
  description: string;
}

const selectStyle = {
  padding: '8px 10px',
  fontSize: 13,
  borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.bg,
  color: tokens.color.text,
} as const;

function fmt(n: number): string {
  return n === 0 ? '—' : n.toFixed(2);
}

export function PayrollReviewPage(): JSX.Element {
  const canManage = usePermission('payroll:period:manage');
  const [periods, setPeriods] = useState<PayPeriod[]>([]);
  const [periodId, setPeriodId] = useState<string>('');
  const [period, setPeriod] = useState<PayPeriod | null>(null);
  const [rows, setRows] = useState<EmployeeRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [convertFor, setConvertFor] = useState<EmployeeRow | null>(null);
  const [convertHours, setConvertHours] = useState('');
  const [detailFor, setDetailFor] = useState<EmployeeRow | null>(null);
  const [detail, setDetail] = useState<DetailEntry[]>([]);

  const loadPeriods = useCallback(async (): Promise<void> => {
    try {
      const r = await api<{ items: PayPeriod[] }>('/api/staff/payroll/periods');
      setPeriods(r.items ?? []);
      // Default to the most recent COMPLETED period (first whose end is
      // in the past), else the newest.
      if (r.items?.length && !periodId) {
        const today = new Date().toISOString().slice(0, 10);
        const done = r.items.find((p) => p.endDate < today);
        setPeriodId((done ?? r.items[0]!).id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }, [periodId]);

  const loadReview = useCallback(async (): Promise<void> => {
    if (!periodId) return;
    try {
      const r = await api<{ period: PayPeriod; employees: EmployeeRow[] }>(
        `/api/staff/payroll/periods/${periodId}/review`,
      );
      setPeriod(r.period);
      setRows(r.employees ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }, [periodId]);

  useEffect(() => {
    void loadPeriods();
  }, [loadPeriods]);
  useEffect(() => {
    void loadReview();
  }, [loadReview]);

  const allApproved = useMemo(() => rows.length > 0 && rows.every((r) => r.approvedAt), [rows]);
  const locked = period?.status === 'LOCKED';

  async function act(path: string, body?: unknown): Promise<void> {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await api(`/api/staff/payroll/${path}`, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      });
      await Promise.all([loadReview(), loadPeriods()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  async function openDetail(row: EmployeeRow): Promise<void> {
    setDetailFor(row);
    setDetail([]);
    try {
      const r = await api<{ rows: DetailEntry[] }>(
        `/api/staff/reports/payroll-employee-detail?periodId=${periodId}&appUserId=${row.appUserId}`,
      );
      setDetail(r.rows ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  const exportCsvUrl = periodId
    ? `/api/staff/reports/payroll-period.csv?periodId=${periodId}`
    : null;

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Payroll review</h1>
        <select
          value={periodId}
          onChange={(e) => setPeriodId(e.target.value)}
          style={selectStyle}
          aria-label="Pay period"
        >
          {periods.map((p) => (
            <option key={p.id} value={p.id}>
              {p.startDate} → {p.endDate}
              {p.status === 'LOCKED' ? ' 🔒' : ''}
            </option>
          ))}
        </select>
        {period && <Pill tone={locked ? 'neutral' : 'accent'}>{locked ? 'LOCKED' : 'OPEN'}</Pill>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {exportCsvUrl && (
            <Button size="sm" variant="secondary" onClick={() => window.open(exportCsvUrl)}>
              Export CSV
            </Button>
          )}
          {canManage && period && !locked && (
            <Button
              size="sm"
              disabled={busy || !allApproved}
              onClick={() => void act(`periods/${periodId}/lock`)}
              title={allApproved ? 'Lock this period' : 'Approve all employees first'}
            >
              Lock period
            </Button>
          )}
          {canManage && period && locked && (
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm('Unlock this pay period? Its time entries become editable again.')
                )
                  void act(`periods/${periodId}/unlock`);
              }}
            >
              Unlock
            </Button>
          )}
        </div>
      </div>

      {error && <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>}
      {notice && <p style={{ color: tokens.color.accent, fontSize: 13 }}>{notice}</p>}

      <Card title={period ? `Employees · ${period.startDate} → ${period.endDate}` : 'Employees'}>
        <ScrollX>
          <Table<EmployeeRow>
            columns={[
              {
                key: 'name',
                header: 'Employee',
                render: (r) => (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <button
                      onClick={() => void openDetail(r)}
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        color: tokens.color.accent,
                        cursor: 'pointer',
                        fontSize: 13,
                        textAlign: 'left',
                      }}
                    >
                      {r.fullName}
                    </button>
                    {r.overtimeExempt && <Pill tone="neutral">exempt</Pill>}
                    {!r.isFullTime && <Pill tone="neutral">PT</Pill>}
                  </div>
                ),
              },
              { key: 'reg', header: 'Regular', render: (r) => fmt(r.regularHours) },
              {
                key: 'ot',
                header: 'OT',
                render: (r) =>
                  r.otHours > 0 ? (
                    <span style={{ color: tokens.color.danger }}>{r.otHours.toFixed(2)}</span>
                  ) : (
                    '—'
                  ),
              },
              { key: 'pto', header: 'PTO', render: (r) => fmt(r.ptoHours) },
              { key: 'sick', header: 'Sick', render: (r) => fmt(r.sickHours) },
              { key: 'comp', header: 'Comp used', render: (r) => fmt(r.compUsedHours) },
              { key: 'hol', header: 'Holiday', render: (r) => fmt(r.holidayHours) },
              { key: 'unpaid', header: 'Unpaid', render: (r) => fmt(r.unpaidHours) },
              {
                key: 'actual',
                header: 'Actual logged',
                render: (r) => r.actualWorkedHours.toFixed(2),
              },
              {
                key: 'flags',
                header: 'Flags',
                render: (r) =>
                  r.missingDays.length > 0 ? (
                    <span title={r.missingDays.join(', ')}>
                      <Pill tone="warning">{r.missingDays.length} missing day(s)</Pill>
                    </span>
                  ) : (
                    '—'
                  ),
              },
              {
                key: 'approve',
                header: 'Approval',
                render: (r) =>
                  r.approvedAt ? (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <Pill tone="success">approved</Pill>
                      {canManage && !locked && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void act(`periods/${periodId}/employees/${r.appUserId}/unapprove`)
                          }
                        >
                          Undo
                        </Button>
                      )}
                    </div>
                  ) : canManage && !locked ? (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void act(`periods/${periodId}/employees/${r.appUserId}/approve`)
                        }
                      >
                        Approve
                      </Button>
                      {!r.overtimeExempt && r.otHours > 0 && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => {
                            setConvertFor(r);
                            setConvertHours(r.otHours.toFixed(2));
                          }}
                        >
                          OT→comp
                        </Button>
                      )}
                    </div>
                  ) : (
                    <Pill tone="neutral">pending</Pill>
                  ),
              },
            ]}
            rows={rows}
            rowKey={(r) => r.appUserId}
            empty="No active employees."
          />
        </ScrollX>
      </Card>

      {convertFor && (
        <Modal
          title={`Convert OT to comp — ${convertFor.fullName}`}
          onClose={() => setConvertFor(null)}
        >
          <div style={{ display: 'grid', gap: 12 }}>
            <p style={{ fontSize: 13, margin: 0 }}>
              {convertFor.otHours.toFixed(2)} OT hours available. Converted hours are removed from
              reported OT and credited to the comp bank at the firm multiplier.
            </p>
            <input
              type="number"
              step={0.25}
              min={0.25}
              max={convertFor.otHours}
              value={convertHours}
              onChange={(e) => setConvertHours(e.target.value)}
              style={selectStyle}
              aria-label="OT hours to convert"
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="secondary" onClick={() => setConvertFor(null)}>
                Cancel
              </Button>
              <Button
                disabled={busy || !(Number(convertHours) > 0)}
                onClick={() => {
                  const target = convertFor;
                  setConvertFor(null);
                  void act(`periods/${periodId}/employees/${target.appUserId}/convert-comp`, {
                    otHours: Number(convertHours),
                  });
                }}
              >
                Convert
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {detailFor && (
        <Modal title={`Daily detail — ${detailFor.fullName}`} onClose={() => setDetailFor(null)}>
          <ScrollX>
            <Table<DetailEntry>
              columns={[
                { key: 'date', header: 'Date', render: (e) => e.entryDate },
                { key: 'cat', header: 'Category', render: (e) => e.category },
                { key: 'hours', header: 'Hours', render: (e) => Number(e.hours).toFixed(2) },
                {
                  key: 'what',
                  header: 'Client / engagement',
                  render: (e) =>
                    [e.clientName, e.engagementName].filter(Boolean).join(' · ') || '—',
                },
                { key: 'code', header: 'Work code', render: (e) => e.workCodeName ?? '—' },
                { key: 'desc', header: 'Description', render: (e) => e.description || '—' },
              ]}
              rows={detail.map((e, i) => ({ ...e, _k: `${e.entryDate}-${i}` }))}
              rowKey={(e) => (e as DetailEntry & { _k: string })._k}
              empty="No entries in this period."
            />
          </ScrollX>
        </Modal>
      )}
    </div>
  );
}
