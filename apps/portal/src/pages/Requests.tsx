// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Portal Requests page — 0084 update. Row click navigates to detail;
// open / closed buckets honor the new NEEDS_INFO status.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface RequestRow {
  id: string;
  engagementId: string;
  title: string;
  body: string;
  kind?: string;
  status: string;
  dueDate: string | null;
  fulfilledAt: string | null;
  createdAt: string;
}

function statusTone(status: string): 'success' | 'warning' | 'neutral' | 'accent' {
  switch (status) {
    case 'OPEN':
      return 'warning';
    case 'FULFILLED':
      return 'success';
    case 'NEEDS_INFO':
      return 'accent';
    case 'DISMISSED':
    case 'EXPIRED':
      return 'neutral';
    default:
      return 'neutral';
  }
}

const OPEN_STATUSES = new Set(['OPEN', 'NEEDS_INFO']);

export function RequestsPage(): JSX.Element {
  const [items, setItems] = useState<RequestRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

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

  const open = items.filter((r) => OPEN_STATUSES.has(r.status));
  const closed = items.filter((r) => !OPEN_STATUSES.has(r.status));

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
                  <div
                    role="button"
                    tabIndex={0}
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/requests/${r.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') navigate(`/requests/${r.id}`);
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 500,
                        fontSize: 13,
                        display: 'flex',
                        gap: 6,
                        alignItems: 'center',
                      }}
                    >
                      {r.title}
                      {r.kind === 'DROP_OFF' && <Pill tone="accent">Drop-off</Pill>}
                    </div>
                    {r.body && (
                      <div
                        style={{
                          fontSize: 12,
                          color: tokens.color.textMuted,
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {r.body.slice(0, 160)}
                        {r.body.length > 160 ? '…' : ''}
                      </div>
                    )}
                  </div>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                render: (r) => <Pill tone={statusTone(r.status)}>{r.status}</Pill>,
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
                  <Button size="sm" variant="ghost" onClick={() => navigate(`/requests/${r.id}`)}>
                    Open
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
              {
                key: 'title',
                header: 'Request',
                render: (r) => (
                  <span
                    role="button"
                    tabIndex={0}
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/requests/${r.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') navigate(`/requests/${r.id}`);
                    }}
                  >
                    {r.title}
                  </span>
                ),
              },
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
