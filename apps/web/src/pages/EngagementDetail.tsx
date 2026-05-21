// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface Engagement {
  id: string;
  clientId: string;
  name: string;
  status: string;
  feeStructure: string;
  feeAmountCents: number | null;
  budgetHours: string | null;
  budgetAmountCents: number | null;
  mixedModeEnabled: boolean;
  inScopeWorkCodeIds: string[];
  nteCapCents: number | null;
  feePassthroughEnabled: boolean;
  partnerId: string | null;
  managerId: string | null;
  startDate: string | null;
  endDate: string | null;
}

interface Summary {
  engagementId: string;
  timeEntries: {
    total: number;
    totalHours: number;
    totalAmountCents: number;
    submittedCount: number;
    billedCount: number;
  };
  invoicing: {
    invoicedCents: number;
    paidCents: number;
    openCount: number;
  };
}

interface Milestone {
  id: string;
  name: string;
  sequence: number;
  amountCents: number;
  status: string;
  triggerType: string;
  triggerDate: string | null;
}

interface HourBank {
  id: string;
  openingHours: string;
  openingAmountCents: number;
  expirationDate: string | null;
  forfeitedAt: string | null;
}

const formatCents = (c: number): string => `$${(c / 100).toLocaleString()}`;

export function EngagementDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [engagement, setEngagement] = useState<Engagement | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [banks, setBanks] = useState<HourBank[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    void (async () => {
      try {
        const [e, s, m, b] = await Promise.all([
          api<{ engagement: Engagement }>(`/api/staff/engagements/${id}`),
          api<{ summary: Summary | null }>(`/api/staff/stats/engagement/${id}`),
          api<{ milestones: Milestone[] }>(`/api/staff/milestones/by-engagement/${id}`),
          api<{ bank: HourBank | null }>(`/api/staff/hour-banks/by-engagement/${id}`).catch(() => ({
            bank: null,
          })),
        ]);
        setEngagement(e.engagement);
        setSummary(s.summary);
        setMilestones(m.milestones ?? []);
        setBanks(b.bank ? [b.bank] : []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      }
    })();
  }, [id]);

  if (error) {
    return (
      <Card title="Error">
        <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>
      </Card>
    );
  }
  if (!engagement) {
    return (
      <Card title="Engagement">
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
      </Card>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <Card
        title={engagement.name}
        action={
          <span style={{ display: 'flex', gap: 8 }}>
            <Pill tone={engagement.status === 'ACTIVE' ? 'success' : 'neutral'}>
              {engagement.status}
            </Pill>
            <Pill tone="accent">{engagement.feeStructure}</Pill>
          </span>
        }
      >
        <dl
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr auto 1fr',
            gap: '6px 16px',
            fontSize: 13,
            margin: 0,
          }}
        >
          <dt style={{ color: tokens.color.textMuted }}>Client</dt>
          <dd style={{ margin: 0 }}>
            <a href={`/clients/${engagement.clientId}`}>open</a>
          </dd>
          <dt style={{ color: tokens.color.textMuted }}>Fee</dt>
          <dd style={{ margin: 0 }}>
            {engagement.feeAmountCents == null ? '—' : formatCents(engagement.feeAmountCents)}
          </dd>
          <dt style={{ color: tokens.color.textMuted }}>Budget hours</dt>
          <dd style={{ margin: 0 }}>{engagement.budgetHours ?? '—'}</dd>
          <dt style={{ color: tokens.color.textMuted }}>Budget $</dt>
          <dd style={{ margin: 0 }}>
            {engagement.budgetAmountCents == null ? '—' : formatCents(engagement.budgetAmountCents)}
          </dd>
          <dt style={{ color: tokens.color.textMuted }}>NTE cap</dt>
          <dd style={{ margin: 0 }}>
            {engagement.nteCapCents == null ? '—' : formatCents(engagement.nteCapCents)}
          </dd>
          <dt style={{ color: tokens.color.textMuted }}>Mixed mode</dt>
          <dd style={{ margin: 0 }}>{engagement.mixedModeEnabled ? 'yes' : 'no'}</dd>
          <dt style={{ color: tokens.color.textMuted }}>Fee passthrough</dt>
          <dd style={{ margin: 0 }}>{engagement.feePassthroughEnabled ? 'yes' : 'no'}</dd>
          <dt style={{ color: tokens.color.textMuted }}>Start</dt>
          <dd style={{ margin: 0 }}>{engagement.startDate ?? '—'}</dd>
          <dt style={{ color: tokens.color.textMuted }}>End</dt>
          <dd style={{ margin: 0 }}>{engagement.endDate ?? '—'}</dd>
        </dl>
      </Card>

      {summary && (
        <Card title="Activity">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(5, 1fr)',
              gap: 16,
            }}
          >
            <Stat label="Time entries" value={summary.timeEntries.total.toLocaleString()} />
            <Stat label="Hours" value={summary.timeEntries.totalHours.toFixed(2)} />
            <Stat label="WIP" value={formatCents(summary.timeEntries.totalAmountCents)} />
            <Stat label="Invoiced" value={formatCents(summary.invoicing.invoicedCents)} />
            <Stat label="Paid" value={formatCents(summary.invoicing.paidCents)} />
          </div>
        </Card>
      )}

      {milestones.length > 0 && (
        <Card title={`Milestones (${milestones.length})`}>
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
                  m.triggerType === 'DATE' ? `DATE · ${m.triggerDate ?? ''}` : m.triggerType,
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
                          : 'neutral'
                    }
                  >
                    {m.status}
                  </Pill>
                ),
              },
            ]}
            rows={milestones}
            rowKey={(m) => m.id}
            empty="—"
          />
        </Card>
      )}

      {banks.length > 0 && (
        <Card title={`Hour banks (${banks.length})`}>
          <Table<HourBank>
            columns={[
              {
                key: 'open-h',
                header: 'Opening hours',
                render: (b) => b.openingHours,
              },
              {
                key: 'open-a',
                header: 'Opening $',
                align: 'right',
                render: (b) => formatCents(b.openingAmountCents),
              },
              { key: 'exp', header: 'Expires', render: (b) => b.expirationDate ?? '—' },
              {
                key: 'status',
                header: 'Status',
                render: (b) =>
                  b.forfeitedAt ? (
                    <Pill tone="warning">FORFEITED</Pill>
                  ) : (
                    <Pill tone="success">ACTIVE</Pill>
                  ),
              },
            ]}
            rows={banks}
            rowKey={(b) => b.id}
            empty="—"
          />
        </Card>
      )}

      <EngagementNotes engagementId={id ?? ''} />
    </div>
  );
}

interface Note {
  id: string;
  authorId: string;
  body: string;
  pinned: boolean;
  createdAt: string;
}

function EngagementNotes({ engagementId }: { engagementId: string }): JSX.Element {
  const [notes, setNotes] = useState<Note[]>([]);
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    if (!engagementId) return;
    try {
      const r = await api<{ items: Note[] }>(`/api/staff/engagements/${engagementId}/notes`);
      setNotes(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engagementId]);

  async function add(): Promise<void> {
    if (!body.trim()) return;
    try {
      await api(`/api/staff/engagements/${engagementId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body, pinned }),
      });
      setBody('');
      setPinned(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function remove(noteId: string): Promise<void> {
    try {
      await api(`/api/staff/engagements/${engagementId}/notes/${noteId}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <Card title={`Notes (${notes.length})`}>
      <div style={{ display: 'grid', gap: 12 }}>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          placeholder="Add a note…"
          style={{
            width: '100%',
            padding: 8,
            borderRadius: tokens.radius.sm,
            border: `1px solid ${tokens.color.border}`,
            background: tokens.color.surface,
            color: tokens.color.text,
            fontFamily: 'inherit',
            fontSize: 13,
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
            Pin
          </label>
          <button
            type="button"
            onClick={() => void add()}
            style={{
              padding: '6px 12px',
              borderRadius: tokens.radius.sm,
              border: 'none',
              background: tokens.color.accent,
              color: '#fff',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Add
          </button>
        </div>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
      </div>
      <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
        {notes.map((n) => (
          <div
            key={n.id}
            style={{
              padding: 12,
              borderRadius: tokens.radius.sm,
              border: `1px solid ${tokens.color.border}`,
              fontSize: 13,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginBottom: 6,
                color: tokens.color.textMuted,
                fontSize: 11,
              }}
            >
              <span>{new Date(n.createdAt).toLocaleString()}</span>
              <span>
                {n.pinned && <Pill tone="accent">pinned</Pill>}{' '}
                <button
                  type="button"
                  onClick={() => void remove(n.id)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: tokens.color.textMuted,
                    cursor: 'pointer',
                    fontSize: 11,
                  }}
                >
                  delete
                </button>
              </span>
            </div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
          </div>
        ))}
        {notes.length === 0 && (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>No notes yet.</p>
        )}
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 11, color: tokens.color.textMuted }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
