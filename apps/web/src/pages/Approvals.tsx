// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface PendingRequest {
  id: string;
  entityType: 'ADJUSTMENT' | 'PRE_BILL' | 'INVOICE' | 'ENGAGEMENT_LETTER' | 'RATE_CHANGE';
  entityId: string;
  requesterId: string;
  requesterName: string;
  status: string;
  requestedAt: string;
  comments: string | null;
}

export function ApprovalsPage(): JSX.Element {
  const [items, setItems] = useState<PendingRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [comments, setComments] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const r = await api<{ items: PendingRequest[] }>('/api/staff/approvals/pending');
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function decide(id: string, decision: 'APPROVED' | 'REJECTED'): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      await api(`/api/staff/approvals/${id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision, comments: comments || undefined }),
      });
      setActiveId(null);
      setComments('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title={`Pending approvals (${items.length})`}>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table<PendingRequest>
            columns={[
              {
                key: 'type',
                header: 'Type',
                render: (r) => <Pill>{r.entityType.replace('_', ' ').toLowerCase()}</Pill>,
              },
              { key: 'req', header: 'Requested by', render: (r) => r.requesterName },
              {
                key: 'when',
                header: 'When',
                render: (r) => new Date(r.requestedAt).toLocaleString(),
              },
              {
                key: 'entity',
                header: 'Entity',
                render: (r) => <code style={{ fontSize: 11 }}>{r.entityId.slice(0, 8)}…</code>,
              },
              {
                key: 'actions',
                header: '',
                render: (r) =>
                  activeId === r.id ? (
                    <div style={{ display: 'grid', gap: 6 }}>
                      <Input
                        placeholder="Optional comments"
                        value={comments}
                        onChange={(e) => setComments(e.target.value)}
                      />
                      <div style={{ display: 'flex', gap: 6 }}>
                        <Button
                          size="sm"
                          onClick={() => void decide(r.id, 'APPROVED')}
                          disabled={submitting}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => void decide(r.id, 'REJECTED')}
                          disabled={submitting}
                        >
                          Reject
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setActiveId(null);
                            setComments('');
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button size="sm" onClick={() => setActiveId(r.id)}>
                      Review
                    </Button>
                  ),
              },
            ]}
            rows={items}
            rowKey={(r) => r.id}
            empty="No pending approvals."
          />
        )}
      </Card>
    </div>
  );
}
