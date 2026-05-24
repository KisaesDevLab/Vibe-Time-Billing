// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Stage 4 — portal Requests page. Lists document/info requests that
// staff have created for the active client, with a single-click
// fulfill action.

import { useEffect, useState } from 'react';

import { Button, Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface RequestRow {
  id: string;
  engagementId: string;
  title: string;
  body: string;
  status: string;
  dueDate: string | null;
  fulfilledAt: string | null;
  createdAt: string;
}

function statusTone(status: string): 'success' | 'warning' | 'neutral' | 'danger' {
  switch (status) {
    case 'OPEN':
      return 'warning';
    case 'FULFILLED':
      return 'success';
    case 'DISMISSED':
    case 'EXPIRED':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function RequestsPage(): JSX.Element {
  const [items, setItems] = useState<RequestRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load(): Promise<void> {
    setError(null);
    try {
      const r = await api<{ items: RequestRow[] }>('/api/portal/requests');
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function fulfill(req: RequestRow): Promise<void> {
    setBusy(req.id);
    setError(null);
    try {
      await api(`/api/portal/requests/${req.id}/fulfill`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fulfill_failed');
    } finally {
      setBusy(null);
    }
  }

  const open = items.filter((r) => r.status === 'OPEN');
  const closed = items.filter((r) => r.status !== 'OPEN');

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      {error && (
        <Card>
          <p style={{ color: tokens.color.danger, fontSize: 13, margin: 0 }}>{error}</p>
        </Card>
      )}

      <Card title={`Open requests (${open.length})`}>
        {open.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            No outstanding requests right now.
          </p>
        ) : (
          <Table<RequestRow>
            rows={open}
            rowKey={(r) => r.id}
            empty="No open requests."
            columns={[
              {
                key: 'title',
                header: 'Request',
                render: (r) => (
                  <div>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>{r.title}</div>
                    {r.body && (
                      <div
                        style={{
                          fontSize: 12,
                          color: tokens.color.textMuted,
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {r.body}
                      </div>
                    )}
                  </div>
                ),
              },
              {
                key: 'due',
                header: 'Due',
                render: (r) => (r.dueDate ? <span>{r.dueDate}</span> : <span>—</span>),
              },
              {
                key: 'action',
                header: '',
                render: (r) => (
                  <Button size="sm" onClick={() => void fulfill(r)} disabled={busy === r.id}>
                    {busy === r.id ? 'Working…' : 'Mark complete'}
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Card title={`History (${closed.length})`}>
        {closed.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>No history yet.</p>
        ) : (
          <Table<RequestRow>
            rows={closed}
            rowKey={(r) => r.id}
            empty="—"
            columns={[
              { key: 'title', header: 'Request', render: (r) => <span>{r.title}</span> },
              {
                key: 'status',
                header: 'Status',
                render: (r) => <Pill tone={statusTone(r.status)}>{r.status}</Pill>,
              },
              {
                key: 'when',
                header: 'When',
                render: (r) => new Date(r.fulfilledAt ?? r.createdAt).toLocaleString(),
              },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
