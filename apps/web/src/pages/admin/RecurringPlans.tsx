// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Button, Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Plan {
  id: string;
  engagementName: string;
  clientName: string;
  frequency: string;
  amountCents: number;
  nextRunDate: string;
  status: 'ACTIVE' | 'PAUSED' | 'CANCELLED';
  autoPayFlag: boolean;
}

interface Health {
  counts: { ACTIVE: number; PAUSED: number; CANCELLED: number };
  dueSoonWithin7Days: number;
}

export function RecurringPlansPage(): JSX.Element {
  const [items, setItems] = useState<Plan[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prorationFor, setProrationFor] = useState<Plan | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: Plan[] }>('/api/staff/recurring-plans');
      setItems(r.items ?? []);
      const h = await api<Health>('/api/staff/recurring-plans/health');
      setHealth(h);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function act(id: string, action: 'pause' | 'resume' | 'cancel' | 'run-now'): Promise<void> {
    setError(null);
    try {
      const body = action === 'pause' ? { reason: 'manual pause' } : {};
      await api(`/api/staff/recurring-plans/${id}/${action}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      {health && (
        <Card title="Plan health">
          <div style={{ display: 'flex', gap: 24, fontSize: 13 }}>
            <span>
              ACTIVE: <strong>{health.counts.ACTIVE}</strong>
            </span>
            <span>
              PAUSED: <strong>{health.counts.PAUSED}</strong>
            </span>
            <span>
              CANCELLED: <strong>{health.counts.CANCELLED}</strong>
            </span>
            <span>
              Due in 7d: <strong>{health.dueSoonWithin7Days}</strong>
            </span>
          </div>
        </Card>
      )}
      <Card title="Recurring billing plans">
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table<Plan>
            columns={[
              { key: 'client', header: 'Client', render: (p) => p.clientName },
              { key: 'eng', header: 'Engagement', render: (p) => p.engagementName },
              { key: 'freq', header: 'Frequency', render: (p) => p.frequency },
              {
                key: 'amount',
                header: 'Amount',
                render: (p) => `$${(p.amountCents / 100).toFixed(2)}`,
              },
              { key: 'next', header: 'Next run', render: (p) => p.nextRunDate },
              {
                key: 'status',
                header: 'Status',
                render: (p) => (
                  <Pill tone={p.status === 'ACTIVE' ? 'accent' : 'neutral'}>{p.status}</Pill>
                ),
              },
              {
                key: 'actions',
                header: '',
                render: (p) => (
                  <div style={{ display: 'flex', gap: 6 }}>
                    {p.status === 'ACTIVE' && (
                      <Button size="sm" variant="secondary" onClick={() => void act(p.id, 'pause')}>
                        Pause
                      </Button>
                    )}
                    {p.status === 'PAUSED' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void act(p.id, 'resume')}
                      >
                        Resume
                      </Button>
                    )}
                    {p.status === 'ACTIVE' && (
                      <Button size="sm" onClick={() => void act(p.id, 'run-now')}>
                        Run now
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setProrationFor(p)}>
                      Proration…
                    </Button>
                  </div>
                ),
              },
            ]}
            rows={items}
            rowKey={(p) => p.id}
            empty="No plans yet."
          />
        )}
      </Card>
      {prorationFor && (
        <ProrationDialog plan={prorationFor} onClose={() => setProrationFor(null)} />
      )}
    </div>
  );
}

function ProrationDialog({ plan, onClose }: { plan: Plan; onClose: () => void }): JSX.Element {
  const [newAmount, setNewAmount] = useState(String(plan.amountCents / 100));
  const [changeDate, setChangeDate] = useState(new Date().toISOString().slice(0, 10));
  const [result, setResult] = useState<{
    prorationCents: number;
    oldUnusedCents: number;
    newUnusedCents: number;
    daysRemaining: number;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function preview(): Promise<void> {
    setErr(null);
    try {
      const r = await api<typeof result>(
        `/api/staff/recurring-plans/${plan.id}/proration-preview`,
        {
          method: 'POST',
          body: JSON.stringify({
            newAmountCents: Math.round(Number(newAmount) * 100),
            changeDate,
          }),
        },
      );
      setResult(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div style={{ minWidth: 480 }}>
        <Card title={`Proration preview · ${plan.clientName}`}>
          <div style={{ display: 'grid', gap: 12 }}>
            <label style={{ fontSize: 12, color: tokens.color.textMuted }}>
              Current amount: ${(plan.amountCents / 100).toFixed(2)} · {plan.frequency}
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: tokens.color.textMuted }}>New amount ($)</span>
              <input
                type="number"
                step="0.01"
                value={newAmount}
                onChange={(e) => setNewAmount(e.target.value)}
                style={{
                  padding: '8px 10px',
                  background: tokens.color.surface,
                  color: tokens.color.text,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.md,
                }}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: tokens.color.textMuted }}>Change date</span>
              <input
                type="date"
                value={changeDate}
                onChange={(e) => setChangeDate(e.target.value)}
                style={{
                  padding: '8px 10px',
                  background: tokens.color.surface,
                  color: tokens.color.text,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.md,
                }}
              />
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button onClick={() => void preview()}>Compute</Button>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
            </div>
            {err && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{err}</p>}
            {result && (
              <div
                style={{
                  background: tokens.color.surface,
                  padding: 12,
                  borderRadius: tokens.radius.md,
                  fontSize: 13,
                  display: 'grid',
                  gap: 6,
                }}
              >
                <div>Days remaining in period: {result.daysRemaining}</div>
                <div>Old unused (credit): ${(result.oldUnusedCents / 100).toFixed(2)}</div>
                <div>New unused (charge): ${(result.newUnusedCents / 100).toFixed(2)}</div>
                <div style={{ fontWeight: 600 }}>
                  Net proration:{' '}
                  <span style={{ color: tokens.color.accent }}>
                    ${(result.prorationCents / 100).toFixed(2)}
                  </span>
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
