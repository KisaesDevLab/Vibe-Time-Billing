// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { useClientPage } from '../lib/use-paged-list';

interface AuditRow {
  id: string;
  occurredAt: string;
  action: string;
  entityType: string;
  entityId: string | null;
  entityName: string | null;
  actorAppUserId: string | null;
  actorMcpTokenId: string | null;
  actorPortalIdentityId: string | null;
  actorName: string | null;
  ip: string | null;
}

const FILTER_KEY = '__vibe_audit_filters';

export function AuditPage(): JSX.Element {
  const [items, setItems] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Full-text search (matches entity_type / entity_id / ip / user-agent).
  const [searchQ, setSearchQ] = useState('');

  // Filters — persisted to localStorage so the page survives reloads.
  const saved = ((): {
    entityType?: string;
    entityId?: string;
    start?: string;
    end?: string;
  } => {
    try {
      const raw = localStorage.getItem(FILTER_KEY);
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      return {};
    }
  })();
  const [entityType, setEntityType] = useState(saved.entityType ?? '');
  const [entityId, setEntityId] = useState(saved.entityId ?? '');
  const [start, setStart] = useState(saved.start ?? '');
  const [end, setEnd] = useState(saved.end ?? '');

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
      try {
        localStorage.setItem(FILTER_KEY, JSON.stringify({ entityType, entityId, start, end }));
      } catch {
        // ignore localStorage failures
      }
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

  async function fullText(): Promise<void> {
    if (searchQ.length < 2) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ items: AuditRow[] }>(
        `/api/staff/audit/search?q=${encodeURIComponent(searchQ)}`,
      );
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }

  const { paged, pagination } = useClientPage(items);

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

      <Card title="Full-text search">
        <div style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
          <Input
            label="Search audit text"
            placeholder="entity id, action, IP, user-agent…"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
          />
          <Button
            type="button"
            disabled={loading || searchQ.length < 2}
            onClick={() => void fullText()}
          >
            Search
          </Button>
        </div>
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
            { key: 'entity', header: 'Type', render: (r) => r.entityType },
            {
              key: 'eid',
              header: 'Entity',
              render: (r) =>
                r.entityId ? (
                  <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
                    {r.entityName && <span>{r.entityName}</span>}
                    <code style={{ fontSize: 11, color: tokens.color.textMuted }}>
                      {r.entityId}
                    </code>
                  </span>
                ) : (
                  '—'
                ),
            },
            {
              key: 'actor',
              header: 'Actor',
              render: (r) => {
                const actorId =
                  r.actorAppUserId ?? r.actorMcpTokenId ?? r.actorPortalIdentityId ?? null;
                if (!actorId) return '—';
                const pill = r.actorAppUserId ? (
                  <Pill tone="accent">staff</Pill>
                ) : r.actorMcpTokenId ? (
                  <Pill tone="warning">MCP</Pill>
                ) : (
                  <Pill tone="success">portal</Pill>
                );
                return (
                  <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
                    <span>
                      {pill} {r.actorName ?? ''}
                    </span>
                    <code style={{ fontSize: 11, color: tokens.color.textMuted }}>{actorId}</code>
                  </span>
                );
              },
            },
            { key: 'ip', header: 'IP', render: (r) => r.ip ?? '—' },
          ]}
          rows={paged}
          pagination={pagination}
          rowKey={(r) => r.id}
          empty="No events match these filters."
        />
      </Card>
    </div>
  );
}
