// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Endpoint {
  id: string;
  url: string;
  events: string[];
  status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  createdAt: string;
}

interface Delivery {
  id: string;
  eventType: string;
  status: string;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  responseStatus: number | null;
  createdAt: string;
}

export function WebhooksPage(): JSX.Element {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [knownEvents, setKnownEvents] = useState<string[]>([]);
  const [url, setUrl] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const [e, k] = await Promise.all([
        api<{ items: Endpoint[] }>('/api/staff/webhooks'),
        api<{ events: string[] }>('/api/staff/webhooks/known-events'),
      ]);
      setEndpoints(e.items ?? []);
      setKnownEvents(k.events ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  function toggle(ev: string): void {
    const next = new Set(selected);
    if (next.has(ev)) next.delete(ev);
    else next.add(ev);
    setSelected(next);
  }

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setCreatedSecret(null);
    if (selected.size === 0) {
      setError('Pick at least one event');
      return;
    }
    try {
      const r = await api<{ id: string; secret: string }>('/api/staff/webhooks', {
        method: 'POST',
        body: JSON.stringify({ url, events: Array.from(selected) }),
      });
      setCreatedSecret(r.secret);
      setUrl('');
      setSelected(new Set());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function testFire(id: string): Promise<void> {
    try {
      await api(`/api/staff/webhooks/${id}/test-fire`, { method: 'POST' });
      // Refresh the deliveries view if it's open on this endpoint.
      if (expandedId === id) {
        const r = await api<{ items: Delivery[] }>(`/api/staff/webhooks/${id}/deliveries`);
        setDeliveries(r.items ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function rotate(id: string): Promise<void> {
    if (!confirm('Rotate this endpoint secret? The old secret will stop working.')) return;
    try {
      const r = await api<{ secret: string }>(`/api/staff/webhooks/${id}/rotate-secret`, {
        method: 'POST',
      });
      setCreatedSecret(r.secret);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function archive(id: string): Promise<void> {
    if (!confirm('Archive this endpoint? No more events will be sent.')) return;
    try {
      await api(`/api/staff/webhooks/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function loadDeliveries(id: string): Promise<void> {
    setExpandedId(id);
    try {
      const r = await api<{ items: Delivery[] }>(`/api/staff/webhooks/${id}/deliveries`);
      setDeliveries(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Add webhook endpoint">
        <form onSubmit={create} style={{ display: 'grid', gap: 12 }}>
          <Input
            label="HTTPS URL"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/webhooks/vibe"
            required
          />
          <div>
            <div style={{ fontSize: 13, color: tokens.color.textMuted, marginBottom: 6 }}>
              Events
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {knownEvents.map((ev) => (
                <label
                  key={ev}
                  style={{
                    fontSize: 12,
                    padding: '4px 8px',
                    borderRadius: tokens.radius.pill,
                    border: `1px solid ${selected.has(ev) ? tokens.color.accent : tokens.color.border}`,
                    cursor: 'pointer',
                    background: selected.has(ev) ? tokens.color.accent + '20' : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(ev)}
                    onChange={() => toggle(ev)}
                    style={{ marginRight: 6 }}
                  />
                  {ev}
                </label>
              ))}
            </div>
          </div>
          <div>
            <Button type="submit">Create</Button>
          </div>
        </form>
        {createdSecret && (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              background: tokens.color.warning + '20',
              border: `1px solid ${tokens.color.warning}`,
              borderRadius: tokens.radius.sm,
              fontSize: 12,
            }}
          >
            <strong>Secret (copy now — shown only once):</strong>
            <code
              style={{
                display: 'block',
                marginTop: 6,
                wordBreak: 'break-all',
                fontFamily: tokens.font.mono,
              }}
            >
              {createdSecret}
            </code>
          </div>
        )}
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>

      <Card title="Endpoints">
        <Table<Endpoint>
          columns={[
            {
              key: 'url',
              header: 'URL',
              render: (e) => <code style={{ fontSize: 11 }}>{e.url.slice(0, 60)}</code>,
            },
            {
              key: 'events',
              header: 'Events',
              render: (e) => (
                <span style={{ fontSize: 11 }}>
                  {e.events.length} event{e.events.length === 1 ? '' : 's'}
                </span>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              render: (e) => (
                <Pill
                  tone={
                    e.status === 'ACTIVE'
                      ? 'success'
                      : e.status === 'ARCHIVED'
                        ? 'danger'
                        : 'neutral'
                  }
                >
                  {e.status}
                </Pill>
              ),
            },
            {
              key: 'actions',
              header: '',
              render: (e) => (
                <span style={{ display: 'flex', gap: 6 }}>
                  <Button size="sm" variant="secondary" onClick={() => void loadDeliveries(e.id)}>
                    Deliveries
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void testFire(e.id)}>
                    Test
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void rotate(e.id)}>
                    Rotate
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void archive(e.id)}>
                    Archive
                  </Button>
                </span>
              ),
            },
          ]}
          rows={endpoints}
          rowKey={(e) => e.id}
          empty="No webhook endpoints configured."
        />
      </Card>

      {expandedId && (
        <Card title={`Recent deliveries · ${expandedId.slice(0, 8)}…`}>
          <Table<Delivery>
            columns={[
              {
                key: 'when',
                header: 'Created',
                render: (d) => new Date(d.createdAt).toLocaleString(),
              },
              { key: 'event', header: 'Event', render: (d) => d.eventType },
              {
                key: 'status',
                header: 'Status',
                render: (d) => (
                  <Pill
                    tone={
                      d.status === 'DELIVERED'
                        ? 'success'
                        : d.status === 'FAILED'
                          ? 'danger'
                          : 'warning'
                    }
                  >
                    {d.status}
                  </Pill>
                ),
              },
              {
                key: 'attempts',
                header: 'Attempts',
                align: 'right',
                render: (d) => String(d.attemptCount),
              },
              {
                key: 'resp',
                header: 'Last HTTP',
                align: 'right',
                render: (d) => (d.responseStatus == null ? '—' : String(d.responseStatus)),
              },
            ]}
            rows={deliveries}
            rowKey={(d) => d.id}
            empty="No deliveries logged."
          />
        </Card>
      )}
    </div>
  );
}
