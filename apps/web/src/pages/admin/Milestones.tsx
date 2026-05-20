// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Button, Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Engagement {
  id: string;
  name: string;
  clientName: string | null;
  feeStructure: string;
}

interface Milestone {
  id: string;
  name: string;
  sequence: number;
  amountCents: number;
  status: 'PENDING' | 'TRIGGERED' | 'INVOICED' | 'CANCELLED';
  triggerType: 'DATE' | 'EVENT' | 'MANUAL';
  triggerDate: string | null;
}

const formatCents = (c: number): string => `$${(c / 100).toFixed(2)}`;

export function MilestonesPage(): JSX.Element {
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [plan, setPlan] = useState<{ totalFeeCents: number } | null>(null);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: Engagement[] }>(
          '/api/staff/engagements?feeStructure=FIXED_FEE_WITH_MILESTONES&limit=200',
        );
        setEngagements(r.items ?? []);
      } catch {
        // ignore
      }
    })();
  }, []);

  useEffect(() => {
    if (!selected) {
      setPlan(null);
      setMilestones([]);
      return;
    }
    void (async () => {
      try {
        const r = await api<{
          plan: { totalFeeCents: number } | null;
          milestones: Milestone[];
        }>(`/api/staff/milestones/by-engagement/${selected}`);
        setPlan(r.plan);
        setMilestones(r.milestones ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      }
    })();
  }, [selected]);

  async function trigger(id: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/milestones/${id}/trigger`, { method: 'POST' });
      const r = await api<{ milestones: Milestone[] }>(
        `/api/staff/milestones/by-engagement/${selected}`,
      );
      setMilestones(r.milestones ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1000 }}>
      <Card title="Engagement milestones">
        <label style={{ fontSize: 13, display: 'block', marginBottom: 12 }}>
          Engagement (FIXED_FEE_WITH_MILESTONES):
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            style={{
              marginLeft: 8,
              padding: '4px 8px',
              borderRadius: tokens.radius.sm,
              border: `1px solid ${tokens.color.border}`,
              minWidth: 320,
            }}
          >
            <option value="">— Pick one —</option>
            {engagements.map((e) => (
              <option key={e.id} value={e.id}>
                {e.clientName ?? '?'} · {e.name}
              </option>
            ))}
          </select>
        </label>
        {plan && (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>
            Total fee: <strong>{formatCents(plan.totalFeeCents)}</strong>
          </p>
        )}
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
      </Card>

      {selected && (
        <Card title="Milestones">
          <Table<Milestone>
            columns={[
              { key: 'seq', header: '#', render: (m) => String(m.sequence) },
              { key: 'name', header: 'Name', render: (m) => m.name },
              {
                key: 'amt',
                header: 'Amount',
                align: 'right',
                render: (m) => formatCents(m.amountCents),
              },
              {
                key: 'trig',
                header: 'Trigger',
                render: (m) =>
                  m.triggerType === 'DATE' ? `DATE · ${m.triggerDate ?? '?'}` : m.triggerType,
              },
              {
                key: 'status',
                header: 'Status',
                render: (m) => (
                  <Pill
                    tone={
                      m.status === 'INVOICED'
                        ? 'success'
                        : m.status === 'TRIGGERED'
                          ? 'accent'
                          : m.status === 'CANCELLED'
                            ? 'danger'
                            : 'neutral'
                    }
                  >
                    {m.status}
                  </Pill>
                ),
              },
              {
                key: 'actions',
                header: '',
                render: (m) =>
                  m.status === 'PENDING' ? (
                    <Button size="sm" disabled={busy} onClick={() => void trigger(m.id)}>
                      Trigger
                    </Button>
                  ) : null,
              },
            ]}
            rows={milestones}
            rowKey={(m) => m.id}
            empty="No milestones for this engagement (or no plan created yet)."
          />
        </Card>
      )}
    </div>
  );
}
