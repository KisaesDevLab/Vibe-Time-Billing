// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CAL-5 — the unmatched calendar review queue. Each pending event shows its
// suggested client (with confidence) and one-click Confirm / Pick client /
// Dismiss / Create client actions.

import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Input, Pill, Table, tokens, type TableColumn } from '@vibe/ui';

import { api } from '../api-client';

interface UnmatchedRow {
  matchId: string;
  eventId: string;
  subject: string | null;
  startAt: string | null;
  organizerEmail: string | null;
  attendees: Array<{ email?: string }> | null;
  tier: string;
  score: number | null;
  suggestedClientId: string | null;
  suggestedClientName: string | null;
}

interface ClientHit {
  id: string;
  name: string;
}

export function CalendarUnmatchedPage(): JSX.Element {
  const [rows, setRows] = useState<UnmatchedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [picking, setPicking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ items: UnmatchedRow[] }>('/api/staff/calendar/unmatched');
      setRows(r.items ?? []);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function confirm(matchId: string, clientId: string): Promise<void> {
    await api(`/api/staff/calendar/matches/${matchId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ clientId }),
    });
    await load();
  }
  async function dismiss(matchId: string): Promise<void> {
    await api(`/api/staff/calendar/matches/${matchId}/dismiss`, { method: 'POST', body: '{}' });
    await load();
  }
  async function newClient(matchId: string): Promise<void> {
    await api(`/api/staff/calendar/matches/${matchId}/new-client`, { method: 'POST' });
    await load();
  }

  const columns: TableColumn<UnmatchedRow>[] = [
    {
      key: 'subject',
      header: 'Event',
      render: (r) => (
        <div>
          <div style={{ fontWeight: 500 }}>{r.subject ?? '(no subject)'}</div>
          <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
            {r.startAt ? new Date(r.startAt).toLocaleString() : ''} · {r.organizerEmail ?? ''}
          </div>
        </div>
      ),
    },
    {
      key: 'suggested',
      header: 'Suggested client',
      render: (r) =>
        r.suggestedClientId ? (
          <span>
            {r.suggestedClientName} <Pill tone="warning">{Math.round((r.score ?? 0) * 100)}%</Pill>
          </span>
        ) : (
          <span style={{ color: tokens.color.textMuted }}>—</span>
        ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {r.suggestedClientId && (
            <Button onClick={() => void confirm(r.matchId, r.suggestedClientId!)}>Confirm</Button>
          )}
          <Button
            variant="secondary"
            onClick={() => setPicking(picking === r.matchId ? null : r.matchId)}
          >
            Pick client
          </Button>
          <Button variant="ghost" onClick={() => void dismiss(r.matchId)}>
            Dismiss
          </Button>
          <Button variant="ghost" onClick={() => void newClient(r.matchId)}>
            Create client
          </Button>
          {picking === r.matchId && (
            <ClientPicker
              onPick={(cid) => void confirm(r.matchId, cid).then(() => setPicking(null))}
            />
          )}
        </div>
      ),
    },
  ];

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Unmatched appointments">
        {loading ? (
          <div style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</div>
        ) : (
          <Table
            columns={columns}
            rows={rows}
            rowKey={(r) => r.matchId}
            empty="Nothing to review — all appointments are matched."
          />
        )}
      </Card>
    </div>
  );
}

function ClientPicker({ onPick }: { onPick: (clientId: string) => void }): JSX.Element {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<ClientHit[]>([]);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      void api<{ rows: ClientHit[] }>(
        `/api/staff/clients?q=${encodeURIComponent(q.trim())}&pageSize=8`,
      )
        .then((r) => setHits(r.rows ?? []))
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div style={{ flexBasis: '100%', marginTop: 6 }}>
      <Input placeholder="Search clients…" value={q} onChange={(e) => setQ(e.target.value)} />
      {hits.length > 0 && (
        <div
          style={{
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            marginTop: 4,
          }}
        >
          {hits.map((h) => (
            <div
              key={h.id}
              role="button"
              tabIndex={0}
              onClick={() => onPick(h.id)}
              onKeyDown={(e) => e.key === 'Enter' && onPick(h.id)}
              style={{ padding: '6px 8px', cursor: 'pointer', fontSize: 13 }}
            >
              {h.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
