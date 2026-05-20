// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface AuditRow {
  id: string;
  occurredAt: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorAppUserId: string | null;
  actorPortalIdentityId: string | null;
  ip: string | null;
}

export function AuditPage(): JSX.Element {
  const [items, setItems] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (entityType) params.set('entityType', entityType);
      if (entityId) params.set('entityId', entityId);
      if (start) params.set('start', start);
      if (end) params.set('end', end);
      params.set('limit', '200');
      const r = await api<{ items: AuditRow[] }>(`/api/staff/audit?${params.toString()}`);
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submit(e: FormEvent): void {
    e.preventDefault();
    void load();
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Filter audit log">
        <form
          onSubmit={submit}
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr 1fr auto',
            gap: 8,
            alignItems: 'end',
          }}
        >
          <Input
            label="Entity type"
            placeholder="e.g. invoice"
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
          />
          <Input
            label="Entity ID"
            placeholder="UUID"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
          />
          <Input
            type="date"
            label="Start"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
          <Input type="date" label="End" value={end} onChange={(e) => setEnd(e.target.value)} />
          <Button type="submit" disabled={loading}>
            {loading ? 'Loading…' : 'Apply'}
          </Button>
        </form>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>

      <Card title={`Events (${items.length})`}>
        <Table<AuditRow>
          columns={[
            {
              key: 'when',
              header: 'When',
              render: (r) => new Date(r.occurredAt).toLocaleString(),
            },
            { key: 'action', header: 'Action', render: (r) => <Pill>{r.action}</Pill> },
            { key: 'entity', header: 'Entity', render: (r) => r.entityType },
            {
              key: 'eid',
              header: 'Entity ID',
              render: (r) =>
                r.entityId ? <code style={{ fontSize: 11 }}>{r.entityId.slice(0, 8)}…</code> : '—',
            },
            {
              key: 'actor',
              header: 'Actor',
              render: (r) =>
                r.actorAppUserId ? (
                  <span>
                    <Pill tone="accent">staff</Pill>{' '}
                    <code style={{ fontSize: 11 }}>{r.actorAppUserId.slice(0, 8)}…</code>
                  </span>
                ) : r.actorPortalIdentityId ? (
                  <span>
                    <Pill tone="success">portal</Pill>{' '}
                    <code style={{ fontSize: 11 }}>{r.actorPortalIdentityId.slice(0, 8)}…</code>
                  </span>
                ) : (
                  '—'
                ),
            },
            { key: 'ip', header: 'IP', render: (r) => r.ip ?? '—' },
          ]}
          rows={items}
          rowKey={(r) => r.id}
          empty="No events match these filters."
        />
      </Card>
    </div>
  );
}
