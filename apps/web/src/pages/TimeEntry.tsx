// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface Engagement {
  id: string;
  name: string;
  clientId: string;
}

interface WorkCode {
  id: string;
  name: string;
}

interface TimeEntry {
  id: string;
  engagementId: string;
  entryDate: string;
  hours: string;
  standardAmountCents: number;
  billableFlag: boolean;
  inScopeFlag: boolean;
  description: string;
}

const today = (): string => new Date().toISOString().slice(0, 10);

export function TimeEntryPage(): JSX.Element {
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [workCodes, setWorkCodes] = useState<WorkCode[]>([]);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [engagementId, setEngagementId] = useState('');
  const [workCodeId, setWorkCodeId] = useState('');
  const [entryDate, setEntryDate] = useState(today());
  const [hours, setHours] = useState('1.00');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [e, w, t] = await Promise.all([
        api<{ items: Engagement[] }>('/api/staff/engagements'),
        api<{ items: WorkCode[] }>('/api/staff/taxonomy/work-codes'),
        api<{ items: TimeEntry[] }>('/api/staff/time-entries/mine'),
      ]);
      setEngagements(e.items ?? []);
      setWorkCodes(w.items ?? []);
      setEntries(t.items ?? []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api('/api/staff/time-entries', {
        method: 'POST',
        body: JSON.stringify({
          engagementId,
          workCodeId: workCodeId || undefined,
          entryDate,
          hours: Number(hours),
          description,
        }),
      });
      setHours('1.00');
      setDescription('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setSubmitting(false);
    }
  }

  const totalHours = entries.reduce((s, e) => s + Number(e.hours), 0);
  const totalAmount = entries.reduce((s, e) => s + e.standardAmountCents, 0);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Log time">
        <form
          onSubmit={submit}
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 2fr 1fr 1fr',
            gap: 12,
            alignItems: 'end',
          }}
        >
          <label style={{ display: 'block' }}>
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
          <label style={{ display: 'block' }}>
            <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
              Work code
            </div>
            <select
              value={workCodeId}
              onChange={(e) => setWorkCodeId(e.target.value)}
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
              <option value="">— none —</option>
              {workCodes.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <Input
            type="date"
            label="Date"
            value={entryDate}
            onChange={(e) => setEntryDate(e.target.value)}
          />
          <Input
            type="number"
            step={0.25}
            min={0.25}
            max={24}
            label="Hours"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
          <Input
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What you worked on"
            style={{ gridColumn: 'span 3' }}
          />
          <Button type="submit" disabled={submitting || !engagementId}>
            {submitting ? 'Saving…' : 'Log'}
          </Button>
        </form>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>

      <Card
        title="My entries"
        action={
          <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
            {totalHours.toFixed(2)}h • ${(totalAmount / 100).toLocaleString()}
          </span>
        }
      >
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table<TimeEntry>
            columns={[
              { key: 'date', header: 'Date', render: (e) => e.entryDate },
              {
                key: 'hours',
                header: 'Hours',
                align: 'right',
                render: (e) => Number(e.hours).toFixed(2),
              },
              {
                key: 'amount',
                header: 'Amount',
                align: 'right',
                render: (e) => `$${(e.standardAmountCents / 100).toLocaleString()}`,
              },
              {
                key: 'flags',
                header: 'Flags',
                render: (e) => (
                  <span style={{ display: 'flex', gap: 4 }}>
                    {e.billableFlag ? (
                      <Pill tone="success">billable</Pill>
                    ) : (
                      <Pill tone="neutral">non-bill</Pill>
                    )}
                    {!e.inScopeFlag && <Pill tone="warning">OOS</Pill>}
                  </span>
                ),
              },
              { key: 'desc', header: 'Description', render: (e) => e.description },
            ]}
            rows={entries}
            rowKey={(e) => e.id}
            empty="No time logged yet."
          />
        )}
      </Card>
    </div>
  );
}
