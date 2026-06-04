// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Firm-wide engagement progress-status change report (who / when / old → new),
// across all engagements. Backed by GET /api/staff/engagement-status-history.
import { useEffect, useState } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Row {
  occurredAt: string;
  actorName: string | null;
  engagementId: string;
  engagementName: string | null;
  fromKey: string | null;
  fromLabel: string | null;
  toKey: string | null;
  toLabel: string | null;
}

export function StatusHistoryPage(): JSX.Element {
  const [rows, setRows] = useState<Row[]>([]);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [nameFilter, setNameFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const qs = new URLSearchParams();
      if (start) qs.set('start', `${start}T00:00:00Z`);
      if (end) qs.set('end', `${end}T23:59:59Z`);
      qs.set('limit', '1000');
      const r = await api<{ items: Row[] }>(
        `/api/staff/engagement-status-history?${qs.toString()}`,
      );
      setRows(r.items ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'load_failed');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = nameFilter.trim()
    ? rows.filter((r) =>
        (r.actorName ?? '').toLowerCase().includes(nameFilter.trim().toLowerCase()),
      )
    : rows;

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Status change history">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0, marginBottom: 12 }}>
          Every engagement progress-status change across the firm — who made it, when, and what
          changed.
        </p>
        <div
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'flex-end',
            marginBottom: 12,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <span style={{ display: 'block', fontSize: 12, color: tokens.color.textMuted }}>
              From
            </span>
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div>
            <span style={{ display: 'block', fontSize: 12, color: tokens.color.textMuted }}>
              To
            </span>
            <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
          <Button variant="secondary" disabled={busy} onClick={() => void load()}>
            {busy ? 'Loading…' : 'Apply'}
          </Button>
          <div style={{ flex: 1, minWidth: 160 }}>
            <span style={{ display: 'block', fontSize: 12, color: tokens.color.textMuted }}>
              Filter by person
            </span>
            <Input
              value={nameFilter}
              placeholder="name contains…"
              onChange={(e) => setNameFilter(e.target.value)}
            />
          </div>
        </div>
        {err && <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }}>{err}</p>}

        <Table<Row>
          columns={[
            {
              key: 'when',
              header: 'When',
              render: (r) => (
                <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                  {new Date(r.occurredAt).toLocaleString()}
                </span>
              ),
            },
            {
              key: 'engagement',
              header: 'Engagement',
              render: (r) => r.engagementName ?? r.engagementId.slice(0, 8),
            },
            { key: 'who', header: 'Who', render: (r) => r.actorName ?? 'System' },
            {
              key: 'change',
              header: 'Change',
              render: (r) => (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Pill tone="neutral">{r.fromLabel ?? r.fromKey ?? '—'}</Pill>
                  <span style={{ color: tokens.color.textMuted }}>→</span>
                  <Pill tone="success">{r.toLabel ?? r.toKey ?? '—'}</Pill>
                </div>
              ),
            },
          ]}
          rows={filtered}
          rowKey={(r) => `${r.engagementId}:${r.occurredAt}`}
        />
      </Card>
    </div>
  );
}
