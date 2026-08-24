// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Time Off (0226): my PTO/Sick/Comp balances, request form with editable
// per-day hours and a live overdraw warning, my request history, and an
// Approvals tab (time_off:approve) for pending requests.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Stat, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { usePermission } from '../auth-context';

interface BankBalance {
  bank: 'PTO' | 'SICK' | 'COMP';
  accruedHours: number;
  usedHours: number;
  balanceHours: number;
}

interface RequestDay {
  id: string;
  day: string;
  hours: string;
}

interface TimeOffRequest {
  id: string;
  appUserId: string;
  fullName: string;
  kind: 'PTO' | 'SICK' | 'COMP' | 'UNPAID';
  startDate: string;
  endDate: string;
  totalHours: string;
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'CANCELLED';
  note: string;
  decisionNote: string;
  createdAt: string;
  days: RequestDay[];
}

const BANK_LABELS: Record<string, string> = {
  PTO: 'PTO / Vacation',
  SICK: 'Sick',
  COMP: 'Comp time',
};

const KIND_OPTIONS = [
  { value: 'PTO', label: 'PTO / Vacation' },
  { value: 'SICK', label: 'Sick' },
  { value: 'COMP', label: 'Comp time' },
  { value: 'UNPAID', label: 'Unpaid leave' },
] as const;

const STATUS_TONE: Record<TimeOffRequest['status'], 'accent' | 'neutral' | 'danger' | 'success'> = {
  PENDING: 'accent',
  APPROVED: 'success',
  DENIED: 'danger',
  CANCELLED: 'neutral',
};

const selectStyle = {
  padding: '8px 10px',
  fontSize: 13,
  borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.bg,
  color: tokens.color.text,
} as const;

function weekdayRows(
  startDate: string,
  endDate: string,
  perDay: number,
): Array<{ day: string; hours: number }> {
  const out: Array<{ day: string; hours: number }> = [];
  if (!startDate || !endDate || endDate < startDate) return out;
  let t = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  for (; t <= end && out.length < 62; t += 86_400_000) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) out.push({ day: d.toISOString().slice(0, 10), hours: perDay });
  }
  return out;
}

export function TimeOffPage(): JSX.Element {
  const canApprove = usePermission('time_off:approve');
  const [tab, setTab] = useState<'mine' | 'approvals'>('mine');
  const [banks, setBanks] = useState<BankBalance[]>([]);
  const [standardHoursPerWeek, setStandardHoursPerWeek] = useState(40);
  const [mine, setMine] = useState<TimeOffRequest[]>([]);
  const [pending, setPending] = useState<TimeOffRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Request form.
  const [kind, setKind] = useState<'PTO' | 'SICK' | 'COMP' | 'UNPAID'>('PTO');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [note, setNote] = useState('');
  const [dayRows, setDayRows] = useState<Array<{ day: string; hours: number }>>([]);
  const [daysDirty, setDaysDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [bal, reqs] = await Promise.all([
        api<{ banks: BankBalance[]; standardHoursPerWeek?: number }>(
          '/api/staff/payroll/balances/me',
        ),
        api<{ items: TimeOffRequest[] }>('/api/staff/time-off/requests?scope=mine'),
      ]);
      setBanks(bal.banks ?? []);
      setStandardHoursPerWeek(bal.standardHoursPerWeek || 40);
      setMine(reqs.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }, []);

  const loadPending = useCallback(async (): Promise<void> => {
    if (!canApprove) return;
    try {
      const r = await api<{ items: TimeOffRequest[] }>(
        '/api/staff/time-off/requests?scope=pending',
      );
      setPending(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }, [canApprove]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  // Regenerate default day rows when the range changes (unless edited).
  // Prefill matches the server default: standard weekly hours ÷ 5.
  useEffect(() => {
    if (!daysDirty) {
      setDayRows(
        weekdayRows(startDate, endDate, Math.round((standardHoursPerWeek / 5) * 100) / 100 || 8),
      );
    }
  }, [startDate, endDate, daysDirty, standardHoursPerWeek]);

  const totalHours = useMemo(() => dayRows.reduce((s, d) => s + (d.hours || 0), 0), [dayRows]);
  const projected = useMemo(() => {
    const bank = kind === 'UNPAID' ? null : banks.find((b) => b.bank === kind);
    return bank ? bank.balanceHours - totalHours : null;
  }, [banks, kind, totalHours]);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setSaving(true);
    try {
      const r = await api<{ warning?: string }>('/api/staff/time-off/requests', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          startDate,
          endDate,
          note: note || undefined,
          days: dayRows.filter((d) => d.hours > 0),
        }),
      });
      setNotice(r.warning ? `Request submitted. ${r.warning}` : 'Request submitted.');
      setStartDate('');
      setEndDate('');
      setNote('');
      setDayRows([]);
      setDaysDirty(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setSaving(false);
    }
  }

  async function cancel(id: string): Promise<void> {
    try {
      await api(`/api/staff/time-off/requests/${id}/cancel`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function decide(id: string, action: 'approve' | 'deny'): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      const r = await api<{ warning?: string }>(`/api/staff/time-off/requests/${id}/${action}`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setNotice(
        action === 'approve'
          ? r.warning
            ? `Approved. ${r.warning}`
            : 'Approved — time entries created.'
          : 'Denied.',
      );
      await Promise.all([loadPending(), load()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1000 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Time off</h1>
        {canApprove && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <Button
              size="sm"
              variant={tab === 'mine' ? 'primary' : 'secondary'}
              onClick={() => setTab('mine')}
            >
              My time off
            </Button>
            <Button
              size="sm"
              variant={tab === 'approvals' ? 'primary' : 'secondary'}
              onClick={() => setTab('approvals')}
            >
              Approvals{pending.length > 0 ? ` (${pending.length})` : ''}
            </Button>
          </div>
        )}
      </div>

      {error && <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>}
      {notice && <p style={{ color: tokens.color.accent, fontSize: 13 }}>{notice}</p>}

      {tab === 'mine' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            {banks.map((b) => (
              <Stat
                key={b.bank}
                label={BANK_LABELS[b.bank] ?? b.bank}
                value={`${b.balanceHours.toFixed(2)}h`}
                caption={`accrued ${b.accruedHours.toFixed(2)} · used ${b.usedHours.toFixed(2)}`}
                tone={b.balanceHours < 0 ? 'danger' : 'neutral'}
              />
            ))}
          </div>

          <Card title="Request time off">
            <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr 1fr',
                  gap: 12,
                  alignItems: 'end',
                }}
              >
                <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                  Type
                  <select
                    value={kind}
                    onChange={(e) => setKind(e.target.value as typeof kind)}
                    style={selectStyle}
                  >
                    {KIND_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <Input
                  label="First day"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  required
                />
                <Input
                  label="Last day"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  required
                />
              </div>

              {dayRows.length > 0 && (
                <div style={{ display: 'grid', gap: 6 }}>
                  <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                    Hours per day (weekdays prefilled — edit as needed)
                  </span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {dayRows.map((d, i) => (
                      <label
                        key={d.day}
                        style={{ display: 'grid', gap: 2, fontSize: 11, width: 96 }}
                      >
                        {d.day.slice(5)}
                        <input
                          type="number"
                          step={0.25}
                          min={0}
                          max={24}
                          value={d.hours}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            setDaysDirty(true);
                            setDayRows((rows) =>
                              rows.map((r, j) => (j === i ? { ...r, hours: v } : r)),
                            );
                          }}
                          style={{ ...selectStyle, width: '100%' }}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <Input
                label="Note (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />

              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <Button type="submit" disabled={saving || dayRows.length === 0}>
                  {saving ? 'Submitting…' : `Request ${totalHours.toFixed(2)}h`}
                </Button>
                {projected != null && (
                  <span
                    style={{
                      fontSize: 12,
                      color: projected < 0 ? tokens.color.danger : tokens.color.textMuted,
                    }}
                  >
                    Balance after: {projected.toFixed(2)}h
                    {projected < 0 ? ' — this will overdraw your balance' : ''}
                  </span>
                )}
              </div>
            </form>
          </Card>

          <Card title="My requests">
            <Table<TimeOffRequest>
              columns={[
                { key: 'kind', header: 'Type', render: (r) => BANK_LABELS[r.kind] ?? r.kind },
                {
                  key: 'range',
                  header: 'Dates',
                  render: (r) =>
                    r.startDate === r.endDate ? r.startDate : `${r.startDate} → ${r.endDate}`,
                },
                { key: 'hours', header: 'Hours', render: (r) => Number(r.totalHours).toFixed(2) },
                {
                  key: 'status',
                  header: 'Status',
                  render: (r) => <Pill tone={STATUS_TONE[r.status]}>{r.status}</Pill>,
                },
                { key: 'note', header: 'Note', render: (r) => r.decisionNote || r.note || '—' },
                {
                  key: 'actions',
                  header: '',
                  render: (r) =>
                    r.status === 'PENDING' ? (
                      <Button size="sm" variant="secondary" onClick={() => void cancel(r.id)}>
                        Cancel
                      </Button>
                    ) : null,
                },
              ]}
              rows={mine}
              rowKey={(r) => r.id}
              empty="No requests yet."
            />
          </Card>
        </>
      )}

      {tab === 'approvals' && canApprove && (
        <Card title="Pending requests">
          <Table<TimeOffRequest>
            columns={[
              { key: 'who', header: 'Staff', render: (r) => r.fullName },
              { key: 'kind', header: 'Type', render: (r) => BANK_LABELS[r.kind] ?? r.kind },
              {
                key: 'range',
                header: 'Dates',
                render: (r) =>
                  r.startDate === r.endDate ? r.startDate : `${r.startDate} → ${r.endDate}`,
              },
              { key: 'hours', header: 'Hours', render: (r) => Number(r.totalHours).toFixed(2) },
              { key: 'note', header: 'Note', render: (r) => r.note || '—' },
              {
                key: 'actions',
                header: '',
                render: (r) => (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Button size="sm" onClick={() => void decide(r.id, 'approve')}>
                      Approve
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => void decide(r.id, 'deny')}>
                      Deny
                    </Button>
                  </div>
                ),
              },
            ]}
            rows={pending}
            rowKey={(r) => r.id}
            empty="Nothing waiting for approval."
          />
        </Card>
      )}
    </div>
  );
}
