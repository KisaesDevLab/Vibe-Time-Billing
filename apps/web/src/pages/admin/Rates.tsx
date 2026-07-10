// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Margin {
  appUserId: string;
  fullName: string | null;
  billCents: number;
  costCents: number | null;
  marginPct: number | null;
  effectiveStart: string;
}

interface User {
  id: string;
  fullName: string;
  email: string;
}

interface HistoryRow {
  id?: string;
  billRateCents: number;
  costRateCents?: number | null;
  effectiveStart?: string;
  effectiveDate?: string;
  effectiveEnd?: string | null;
  clientName?: string | null;
  code?: string;
}

interface HistoryResponse {
  // 0054 — staff_rate_snapshot rows replace the old timekeeper rate
  // history. One row per (snapshot, rate code) so partners can see how
  // each code's rate moved across effective periods.
  snapshots: HistoryRow[];
  client: HistoryRow[];
  engagement: HistoryRow[];
  serviceLine: HistoryRow[];
}

interface Engagement {
  id: string;
  name: string;
}

interface ResolveDebug {
  resolved: {
    level: string;
    billRateCents: number;
    costRateCents: number | null;
    rateCodeId?: string | null;
    trace: { level: string; status: 'win' | 'no-match' | 'fallback' }[];
  } | null;
  engagement: {
    id: string;
    name: string;
    rateMultiplierBps: number;
    defaultRateCodeId?: string | null;
  } | null;
  effectiveRateCents?: number;
  candidates: {
    level: string;
    billRateCents: number;
    effectiveStart: string;
    effectiveEnd?: string | null;
    rateCodeId?: string | null;
  }[];
}

const formatCents = (c: number): string => `$${(c / 100).toFixed(2)}`;

export function RatesPage(): JSX.Element {
  const [margins, setMargins] = useState<Margin[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [bulkPct, setBulkPct] = useState('5');
  const [bulkEffective, setBulkEffective] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [historyUserId, setHistoryUserId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);

  // Resolve-debug panel state
  const [debugUserId, setDebugUserId] = useState('');
  const [debugEngagements, setDebugEngagements] = useState<Engagement[]>([]);
  const [debugEngagementId, setDebugEngagementId] = useState('');
  const [debugDate, setDebugDate] = useState(new Date().toISOString().slice(0, 10));
  const [debugResult, setDebugResult] = useState<ResolveDebug | null>(null);
  const [debugErr, setDebugErr] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const [m, u] = await Promise.all([
        api<{ items: Margin[] }>('/api/staff/rates/loaded-margin'),
        api<{ users: User[] }>('/api/staff/admin/users'),
      ]);
      setMargins(m.items ?? []);
      setUsers(u.users ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  // Load engagements once for the debug panel.
  useEffect(() => {
    void api<{ items: Engagement[] }>('/api/staff/engagements')
      .then((r) => setDebugEngagements(r.items ?? []))
      .catch(() => undefined);
  }, []);

  async function openHistory(targetUserId: string): Promise<void> {
    setHistoryUserId(targetUserId);
    setHistory(null);
    try {
      const r = await api<HistoryResponse>(
        `/api/staff/rates/history?appUserId=${encodeURIComponent(targetUserId)}`,
      );
      setHistory(r);
    } catch (e) {
      setHistory({ snapshots: [], client: [], engagement: [], serviceLine: [] });
      setError(e instanceof Error ? e.message : 'history failed');
    }
  }

  async function runResolveDebug(e: FormEvent): Promise<void> {
    e.preventDefault();
    setDebugErr(null);
    setDebugResult(null);
    try {
      const r = await api<ResolveDebug>(
        `/api/staff/rates/resolve-debug?appUserId=${encodeURIComponent(debugUserId)}&engagementId=${encodeURIComponent(debugEngagementId)}&serviceDate=${encodeURIComponent(debugDate)}`,
      );
      setDebugResult(r);
    } catch (err) {
      setDebugErr(err instanceof Error ? err.message : 'failed');
    }
  }

  async function bulkApply(): Promise<void> {
    setError(null);
    setStatus(null);
    try {
      const r = await api<{ updated: number }>('/api/staff/rates/bulk-update/commit', {
        method: 'POST',
        body: JSON.stringify({
          pctChange: parseFloat(bulkPct),
          effectiveStart: bulkEffective,
        }),
      });
      setStatus(`Bulk update committed (${r.updated} rates updated).`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Per-staff rate management">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          Individual staff rates (one snapshot per effective date, with a billing rate per rate
          code) live on each user&apos;s detail page — open a user from{' '}
          <a href="/admin/users">Users</a>. The catalog of rate codes is managed at{' '}
          <a href="/admin/rate-codes">Rate codes</a>.
        </p>
        {status && (
          <p style={{ color: tokens.color.success, fontSize: 12, marginTop: 8 }}>{status}</p>
        )}
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>

      <Card title="Bulk update (StandardRate, all staff)">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr auto',
            gap: 12,
            alignItems: 'end',
          }}
        >
          <Input
            label="Pct change"
            type="number"
            step="0.5"
            value={bulkPct}
            onChange={(e) => setBulkPct(e.target.value)}
          />
          <Input
            label="Effective"
            type="date"
            value={bulkEffective}
            onChange={(e) => setBulkEffective(e.target.value)}
          />
          <Button onClick={() => void bulkApply()}>Apply</Button>
        </div>
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 8 }}>
          Opens a new effective-dated snapshot for each staff member where the StandardRate billing
          rate is multiplied by the percent change. Non-StandardRate codes and the cost rate copy
          forward unchanged.
        </p>
      </Card>

      <Card title="Loaded margin (current StandardRate vs cost)">
        <Table<Margin>
          columns={[
            { key: 'name', header: 'Name', render: (m) => m.fullName ?? m.appUserId.slice(0, 8) },
            {
              key: 'bill',
              header: 'Bill',
              align: 'right',
              render: (m) => formatCents(m.billCents),
            },
            {
              key: 'cost',
              header: 'Cost',
              align: 'right',
              render: (m) => (m.costCents == null ? '—' : formatCents(m.costCents)),
            },
            {
              key: 'margin',
              header: 'Margin',
              align: 'right',
              render: (m) => (m.marginPct == null ? '—' : `${(m.marginPct * 100).toFixed(1)}%`),
            },
            {
              key: 'eff',
              header: 'Effective',
              render: (m) => m.effectiveStart,
            },
            {
              key: 'status',
              header: '',
              render: (m) =>
                m.costCents == null ? (
                  <Pill tone="warning">cost missing</Pill>
                ) : (m.marginPct ?? 0) < 0.4 ? (
                  <Pill tone="danger">low margin</Pill>
                ) : null,
            },
            {
              key: 'history',
              header: '',
              render: (m) => (
                <Button size="sm" variant="secondary" onClick={() => void openHistory(m.appUserId)}>
                  History
                </Button>
              ),
            },
          ]}
          rows={margins}
          rowKey={(m) => m.appUserId}
          empty="No staff snapshots yet."
        />
      </Card>

      <Card title="Resolve-debug — why is this rate $X">
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 12 }}>
          Reproduces the rate-resolution logic for a specific (staff, engagement, service date).
          Shows which level (engagement override → client override → service-line → staff rate for
          the engagement&apos;s code → StandardRate fallback → firm) won and what the
          engagement&apos;s premium/discount multiplier did to the final stored rate.
        </p>
        <form
          onSubmit={runResolveDebug}
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 2fr 1fr auto',
            gap: 12,
            alignItems: 'end',
          }}
        >
          <label style={{ fontSize: 13 }}>
            Timekeeper
            <select
              value={debugUserId}
              onChange={(e) => setDebugUserId(e.target.value)}
              required
              style={{
                marginTop: 4,
                padding: '6px 8px',
                width: '100%',
                borderRadius: tokens.radius.sm,
                border: `1px solid ${tokens.color.border}`,
                background: tokens.color.surface,
                color: tokens.color.text,
              }}
            >
              <option value="">— Pick one —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 13 }}>
            Engagement
            <select
              value={debugEngagementId}
              onChange={(e) => setDebugEngagementId(e.target.value)}
              required
              style={{
                marginTop: 4,
                padding: '6px 8px',
                width: '100%',
                borderRadius: tokens.radius.sm,
                border: `1px solid ${tokens.color.border}`,
                background: tokens.color.surface,
                color: tokens.color.text,
              }}
            >
              <option value="">— Pick one —</option>
              {debugEngagements.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          <Input
            label="Service date"
            type="date"
            value={debugDate}
            onChange={(e) => setDebugDate(e.target.value)}
            required
          />
          <Button type="submit">Resolve</Button>
        </form>
        {debugErr && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{debugErr}</p>
        )}
        {debugResult?.resolved && (
          <div
            style={{
              marginTop: 16,
              padding: 12,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
            }}
          >
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
              <Stat
                label="Won at level"
                value={<Pill tone="accent">{debugResult.resolved.level}</Pill>}
              />
              <Stat label="Resolved rate" value={formatCents(debugResult.resolved.billRateCents)} />
              {debugResult.engagement && (
                <Stat
                  label="Engagement multiplier"
                  value={`${(debugResult.engagement.rateMultiplierBps / 100).toFixed(2)}%`}
                />
              )}
              {debugResult.effectiveRateCents != null && (
                <Stat
                  label="Effective (multiplied)"
                  value={<strong>{formatCents(debugResult.effectiveRateCents)}</strong>}
                />
              )}
            </div>
            <div style={{ fontSize: 12, marginBottom: 8, color: tokens.color.textMuted }}>
              Trace
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {debugResult.resolved.trace.map((t, i) => (
                <Pill key={i} tone={t.status === 'win' ? 'success' : 'neutral'}>
                  {t.level}: {t.status}
                </Pill>
              ))}
            </div>
            {debugResult.candidates.length > 0 && (
              <details style={{ marginTop: 12, fontSize: 13 }}>
                <summary>{debugResult.candidates.length} candidate(s) considered</summary>
                <Table<ResolveDebug['candidates'][number]>
                  columns={[
                    { key: 'level', header: 'Level', render: (c) => c.level },
                    {
                      key: 'rate',
                      header: 'Rate',
                      align: 'right',
                      render: (c) => formatCents(c.billRateCents),
                    },
                    { key: 'start', header: 'Effective start', render: (c) => c.effectiveStart },
                    { key: 'end', header: 'End', render: (c) => c.effectiveEnd ?? '—' },
                  ]}
                  rows={debugResult.candidates}
                  rowKey={(c) => `${c.level}-${c.effectiveStart}-${c.billRateCents}`}
                  empty="No candidates."
                />
              </details>
            )}
          </div>
        )}
      </Card>

      {historyUserId && (
        <HistoryModal
          userId={historyUserId}
          users={users}
          history={history}
          onClose={() => {
            setHistoryUserId(null);
            setHistory(null);
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 11, color: tokens.color.textMuted, textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ marginTop: 2, fontSize: 14 }}>{value}</div>
    </div>
  );
}

function HistoryModal({
  userId,
  users,
  history,
  onClose,
}: {
  userId: string;
  users: User[];
  history: HistoryResponse | null;
  onClose: () => void;
}): JSX.Element {
  const u = users.find((x) => x.id === userId);
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: 20,
      }}
    >
      {/* Backdrop rendered as a button for a11y; Escape also closes. */}
      <button
        type="button"
        aria-label="Close history dialog"
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.45)',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
        }}
      />
      <div
        style={{
          position: 'relative',
          maxWidth: 900,
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: tokens.color.bg,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          padding: 20,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 18 }}>Rate history — {u?.fullName ?? userId}</h2>
          <Button size="sm" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
        {!history ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <>
            <HistorySection
              title="Staff snapshots (per rate code)"
              rows={history.snapshots}
              showCode
            />
            <HistorySection title="Client overrides" rows={history.client} showClient />
            <HistorySection title="Engagement overrides" rows={history.engagement} />
            <HistorySection title="Service line rates" rows={history.serviceLine} />
          </>
        )}
      </div>
    </div>
  );
}

function HistorySection({
  title,
  rows,
  showClient,
  showCode,
}: {
  title: string;
  rows: HistoryRow[];
  showClient?: boolean;
  showCode?: boolean;
}): JSX.Element {
  return (
    <Card title={title}>
      <Table<HistoryRow>
        columns={[
          ...(showClient
            ? [
                {
                  key: 'client',
                  header: 'Client',
                  render: (r: HistoryRow) => r.clientName ?? '—',
                },
              ]
            : []),
          ...(showCode
            ? [
                {
                  key: 'code',
                  header: 'Code',
                  render: (r: HistoryRow) => r.code ?? '—',
                },
              ]
            : []),
          {
            key: 'bill',
            header: 'Bill',
            align: 'right' as const,
            render: (r: HistoryRow) => formatCents(r.billRateCents),
          },
          {
            key: 'cost',
            header: 'Cost',
            align: 'right' as const,
            render: (r: HistoryRow) =>
              r.costRateCents == null ? '—' : formatCents(r.costRateCents),
          },
          {
            key: 'start',
            header: 'Effective',
            render: (r: HistoryRow) => r.effectiveDate ?? r.effectiveStart ?? '—',
          },
          ...(showCode
            ? []
            : [
                {
                  key: 'end',
                  header: 'Ended',
                  render: (r: HistoryRow) => r.effectiveEnd ?? <Pill tone="success">current</Pill>,
                },
              ]),
        ]}
        rows={rows}
        rowKey={(r) =>
          r.id ?? `${r.effectiveDate ?? r.effectiveStart}-${r.code ?? ''}-${r.billRateCents}`
        }
        empty="No rows."
      />
    </Card>
  );
}
