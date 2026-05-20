// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState, type FormEvent } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { AdjustmentDialog } from './AdjustmentDialog';

interface BatchRow {
  id: string;
  engagementId: string;
  engagementName: string;
  clientName: string | null;
  periodStart: string;
  periodEnd: string;
  status: 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'INVOICED' | 'CANCELLED';
}

interface Engagement {
  id: string;
  name: string;
}

interface BatchEntry {
  timeEntryId: string;
  entryDate: string;
  hours: string;
  standardAmountCents: number;
  action: 'INCLUDE' | 'DEFER' | 'WRITE_OFF';
}

interface BatchDetail {
  batch: BatchRow;
  entries: BatchEntry[];
  aging: Record<string, number>;
}

export function BillingBatchesPage(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<BatchListPage />} />
      <Route path="/:id" element={<BatchDetailPage />} />
    </Routes>
  );
}

function BatchListPage(): JSX.Element {
  const [items, setItems] = useState<BatchRow[]>([]);
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [engagementId, setEngagementId] = useState('');
  const [periodStart, setPeriodStart] = useState('2026-05-01');
  const [periodEnd, setPeriodEnd] = useState('2026-05-31');
  const navigate = useNavigate();

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [b, e] = await Promise.all([
        api<{ items: BatchRow[] }>('/api/staff/billing-batches'),
        api<{ items: Engagement[] }>('/api/staff/engagements'),
      ]);
      setItems(b.items ?? []);
      setEngagements(e.items ?? []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ id: string }>('/api/staff/billing-batches', {
        method: 'POST',
        body: JSON.stringify({ engagementId, periodStart, periodEnd }),
      });
      navigate(`/billing/${r.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Open a billing batch">
        <form
          onSubmit={create}
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr 1fr auto',
            gap: 12,
            alignItems: 'end',
          }}
        >
          <label style={{ display: 'block', fontFamily: tokens.font.body }}>
            <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
              Engagement
            </div>
            <select
              value={engagementId}
              onChange={(e) => setEngagementId(e.target.value)}
              required
              style={{
                width: '100%',
                padding: '10px 12px',
                background: tokens.color.surface,
                color: tokens.color.text,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                fontSize: 14,
              }}
            >
              <option value="">— select —</option>
              {engagements.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          <Input
            type="date"
            label="Period start"
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
          />
          <Input
            type="date"
            label="Period end"
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
          />
          <Button type="submit" disabled={!engagementId}>
            Create
          </Button>
        </form>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>

      <Card title="Billing batches">
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table<BatchRow>
            columns={[
              {
                key: 'name',
                header: 'Engagement',
                render: (b) => (
                  <Link to={`/billing/${b.id}`} style={{ color: tokens.color.accent }}>
                    {b.engagementName}
                  </Link>
                ),
              },
              { key: 'client', header: 'Client', render: (b) => b.clientName ?? '—' },
              {
                key: 'period',
                header: 'Period',
                render: (b) => `${b.periodStart} → ${b.periodEnd}`,
              },
              {
                key: 'status',
                header: 'Status',
                render: (b) => (
                  <Pill
                    tone={
                      b.status === 'APPROVED' || b.status === 'INVOICED' ? 'success' : 'neutral'
                    }
                  >
                    {b.status}
                  </Pill>
                ),
              },
            ]}
            rows={items}
            rowKey={(b) => b.id}
            empty="No billing batches yet."
          />
        )}
      </Card>
    </div>
  );
}

function BatchDetailPage(): JSX.Element {
  const { id } = useParams();
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [actions, setActions] = useState<Map<string, BatchEntry['action']>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [showAdjustDialog, setShowAdjustDialog] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const d = await api<BatchDetail>(`/api/staff/billing-batches/${id}`);
      setDetail(d);
      const m = new Map<string, BatchEntry['action']>();
      for (const e of d.entries) m.set(e.timeEntryId, e.action);
      setActions(m);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function finalize(): Promise<void> {
    if (!detail) return;
    setFinalizing(true);
    setError(null);
    try {
      await api(`/api/staff/billing-batches/${id}/finalize`, {
        method: 'PATCH',
        body: JSON.stringify({
          actions: detail.entries.map((e) => ({
            timeEntryId: e.timeEntryId,
            action: actions.get(e.timeEntryId) ?? e.action,
          })),
        }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'finalize failed');
    } finally {
      setFinalizing(false);
    }
  }

  if (loading || !detail) {
    return <p style={{ color: tokens.color.textMuted }}>Loading…</p>;
  }

  const totals = detail.entries.reduce(
    (acc, e) => {
      const a = actions.get(e.timeEntryId) ?? e.action;
      if (a === 'INCLUDE') acc.included += e.standardAmountCents;
      else if (a === 'DEFER') acc.deferred += e.standardAmountCents;
      else acc.writtenOff += e.standardAmountCents;
      return acc;
    },
    { included: 0, deferred: 0, writtenOff: 0 },
  );

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card
        title={`Batch ${detail.batch.id.slice(0, 8)} — ${detail.batch.periodStart} → ${detail.batch.periodEnd}`}
        action={
          <Pill tone={detail.batch.status === 'APPROVED' ? 'success' : 'neutral'}>
            {detail.batch.status}
          </Pill>
        }
      >
        <div style={{ display: 'flex', gap: 24, fontSize: 13 }}>
          <div>
            <div style={{ color: tokens.color.textMuted, fontSize: 11 }}>Include</div>
            <strong>${(totals.included / 100).toLocaleString()}</strong>
          </div>
          <div>
            <div style={{ color: tokens.color.textMuted, fontSize: 11 }}>Defer (carry-forward)</div>
            <strong>${(totals.deferred / 100).toLocaleString()}</strong>
          </div>
          <div>
            <div style={{ color: tokens.color.textMuted, fontSize: 11 }}>Write off</div>
            <strong>${(totals.writtenOff / 100).toLocaleString()}</strong>
          </div>
        </div>
      </Card>

      <Card title="WIP aging">
        <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
          {(['0-30', '31-60', '61-90', '90+'] as const).map((b) => (
            <div key={b}>
              <div style={{ color: tokens.color.textMuted, fontSize: 11 }}>{b} days</div>
              <strong>${((detail.aging[b] ?? 0) / 100).toLocaleString()}</strong>
            </div>
          ))}
        </div>
      </Card>

      <Card
        title="Entries"
        action={
          detail.batch.status === 'DRAFT' || detail.batch.status === 'IN_REVIEW' ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="secondary" size="sm" onClick={() => setShowAdjustDialog(true)}>
                Create adjustment
              </Button>
              <Button onClick={() => void finalize()} disabled={finalizing}>
                {finalizing ? 'Finalizing…' : 'Finalize'}
              </Button>
            </div>
          ) : detail.batch.status === 'APPROVED' ? (
            <Button
              onClick={async () => {
                try {
                  const r = await api<{ id: string }>('/api/staff/invoices/generate-from-batch', {
                    method: 'POST',
                    body: JSON.stringify({ billingBatchId: detail.batch.id }),
                  });
                  window.location.href = `/invoices`;
                  void r;
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'invoice gen failed');
                }
              }}
            >
              Generate invoice
            </Button>
          ) : null
        }
      >
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        <Table<BatchEntry>
          columns={[
            { key: 'date', header: 'Date', render: (e) => e.entryDate },
            {
              key: 'hours',
              header: 'Hours',
              align: 'right',
              render: (e) => Number(e.hours).toFixed(2),
            },
            {
              key: 'amt',
              header: 'Standard',
              align: 'right',
              render: (e) => `$${(e.standardAmountCents / 100).toLocaleString()}`,
            },
            {
              key: 'action',
              header: 'Action',
              render: (e) => (
                <ActionPicker
                  value={actions.get(e.timeEntryId) ?? e.action}
                  onChange={(v) => {
                    const m = new Map(actions);
                    m.set(e.timeEntryId, v);
                    setActions(m);
                  }}
                />
              ),
            },
          ]}
          rows={detail.entries}
          rowKey={(e) => e.timeEntryId}
          empty="No entries in this batch."
        />
      </Card>

      {showAdjustDialog && (
        <AdjustmentDialog
          billingBatchId={detail.batch.id}
          includedTotalCents={totals.included}
          onClose={() => setShowAdjustDialog(false)}
          onCreated={() => {
            setShowAdjustDialog(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function ActionPicker({
  value,
  onChange,
}: {
  value: BatchEntry['action'];
  onChange: (v: BatchEntry['action']) => void;
}): JSX.Element {
  const choices: BatchEntry['action'][] = ['INCLUDE', 'DEFER', 'WRITE_OFF'];
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {choices.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          style={{
            padding: '2px 8px',
            fontSize: 11,
            borderRadius: tokens.radius.sm,
            border: `1px solid ${value === c ? tokens.color.accent : tokens.color.border}`,
            background: value === c ? tokens.color.accentMuted : 'transparent',
            color: tokens.color.text,
            cursor: 'pointer',
          }}
        >
          {c.replace('_', ' ').toLowerCase()}
        </button>
      ))}
    </div>
  );
}
