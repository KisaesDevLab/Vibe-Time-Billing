// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Stage 3 — staff Requests page. Firm-wide queue with status filter,
// engagement filter, create + fulfill + dismiss actions.

import { useEffect, useMemo, useState } from 'react';

import { Button, Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface RequestRow {
  id: string;
  firmId: string;
  engagementId: string;
  assignedAppUserId: string | null;
  title: string;
  body: string;
  status: string;
  dueDate: string | null;
  fulfilledAt: string | null;
  createdAt: string;
}

const STATUS_OPTIONS = ['ALL', 'OPEN', 'FULFILLED', 'DISMISSED', 'EXPIRED'] as const;
type StatusFilter = (typeof STATUS_OPTIONS)[number];

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
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('OPEN');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [createEngagementId, setCreateEngagementId] = useState('');
  const [createTitle, setCreateTitle] = useState('');
  const [createBody, setCreateBody] = useState('');
  const [createDue, setCreateDue] = useState('');

  async function load(): Promise<void> {
    setError(null);
    try {
      const qs = statusFilter === 'ALL' ? '' : `?status=${statusFilter}`;
      const r = await api<{ items: RequestRow[] }>(`/api/staff/requests${qs}`);
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  async function fulfill(req: RequestRow): Promise<void> {
    setBusy(req.id);
    try {
      await api(`/api/staff/requests/${req.id}/fulfill`, {
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

  async function dismiss(req: RequestRow): Promise<void> {
    const reason = window.prompt('Reason for dismissing this request?');
    if (reason == null) return;
    setBusy(req.id);
    try {
      await api(`/api/staff/requests/${req.id}/dismiss`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'dismiss_failed');
    } finally {
      setBusy(null);
    }
  }

  async function create(): Promise<void> {
    if (!createEngagementId || !createTitle) return;
    try {
      await api('/api/staff/requests', {
        method: 'POST',
        body: JSON.stringify({
          engagementId: createEngagementId,
          title: createTitle,
          body: createBody,
          dueDate: createDue || null,
        }),
      });
      setShowCreate(false);
      setCreateEngagementId('');
      setCreateTitle('');
      setCreateBody('');
      setCreateDue('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'create_failed');
    }
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = { OPEN: 0, FULFILLED: 0, DISMISSED: 0, EXPIRED: 0 };
    for (const r of items) {
      if (c[r.status] != null) c[r.status]! += 1;
    }
    return c;
  }, [items]);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      {error && (
        <Card>
          <p style={{ color: tokens.color.danger, fontSize: 13, margin: 0 }}>{error}</p>
        </Card>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: tokens.space.sm }}>
          {STATUS_OPTIONS.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={statusFilter === s ? 'primary' : 'secondary'}
              onClick={() => setStatusFilter(s)}
            >
              {s} {s !== 'ALL' && counts[s] != null ? `(${counts[s]})` : ''}
            </Button>
          ))}
        </div>
        <Button onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? 'Cancel' : 'New request'}
        </Button>
      </div>

      {showCreate && (
        <Card title="Create request">
          <div style={{ display: 'grid', gap: tokens.space.sm }}>
            <label style={{ fontSize: 12 }}>
              Engagement ID
              <input
                type="text"
                value={createEngagementId}
                onChange={(e) => setCreateEngagementId(e.target.value)}
                style={{ width: '100%', padding: tokens.space.sm }}
              />
            </label>
            <label style={{ fontSize: 12 }}>
              Title
              <input
                type="text"
                value={createTitle}
                onChange={(e) => setCreateTitle(e.target.value)}
                style={{ width: '100%', padding: tokens.space.sm }}
              />
            </label>
            <label style={{ fontSize: 12 }}>
              Body (optional)
              <textarea
                value={createBody}
                onChange={(e) => setCreateBody(e.target.value)}
                rows={3}
                style={{ width: '100%', padding: tokens.space.sm }}
              />
            </label>
            <label style={{ fontSize: 12 }}>
              Due date (optional)
              <input
                type="date"
                value={createDue}
                onChange={(e) => setCreateDue(e.target.value)}
                style={{ padding: tokens.space.sm }}
              />
            </label>
            <div>
              <Button onClick={() => void create()} disabled={!createEngagementId || !createTitle}>
                Create
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Card title={`Requests (${items.length})`}>
        <Table<RequestRow>
          rows={items}
          rowKey={(r) => r.id}
          empty="No requests match the filter."
          columns={[
            {
              key: 'title',
              header: 'Title',
              render: (r) => (
                <div>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{r.title}</div>
                  {r.body && (
                    <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                      {r.body.slice(0, 120)}
                      {r.body.length > 120 ? '…' : ''}
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
            { key: 'due', header: 'Due', render: (r) => r.dueDate ?? '—' },
            {
              key: 'created',
              header: 'Created',
              render: (r) => new Date(r.createdAt).toLocaleDateString(),
            },
            {
              key: 'actions',
              header: '',
              render: (r) =>
                r.status === 'OPEN' ? (
                  <div style={{ display: 'flex', gap: tokens.space.xs }}>
                    <Button size="sm" onClick={() => void fulfill(r)} disabled={busy === r.id}>
                      Fulfill
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void dismiss(r)}
                      disabled={busy === r.id}
                    >
                      Dismiss
                    </Button>
                  </div>
                ) : (
                  <span>—</span>
                ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
