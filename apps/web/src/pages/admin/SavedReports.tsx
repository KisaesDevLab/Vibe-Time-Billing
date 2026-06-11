// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface SavedReport {
  id: string;
  name: string;
  reportKind: string;
  paramsJson: Record<string, unknown>;
  sharedFlag: boolean;
  ownerId: string;
  createdAt: string;
}

const KINDS = [
  'realization',
  'profitability',
  'utilization',
  'effective-rate',
  'dso',
  'mrr',
  'book-of-business',
  'clv',
  'scope-creep',
  'revenue-period-over-period',
];

export function SavedReportsPage(): JSX.Element {
  const [items, setItems] = useState<SavedReport[]>([]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState(KINDS[0]!);
  const [shared, setShared] = useState(false);
  const [params, setParams] = useState('{}');
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: SavedReport[] }>('/api/staff/saved-reports');
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(params) as Record<string, unknown>;
    } catch {
      setError('Params JSON is invalid');
      return;
    }
    try {
      await api('/api/staff/saved-reports', {
        method: 'POST',
        body: JSON.stringify({ name, reportKind: kind, paramsJson: parsed, shared }),
      });
      setName('');
      setParams('{}');
      setShared(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await api(`/api/staff/saved-reports/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Save a report definition">
        <form onSubmit={create} style={{ display: 'grid', gap: 12, maxWidth: 600 }}>
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <label style={{ fontSize: 13 }}>
            Report kind
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              style={{
                marginTop: 4,
                padding: '6px 8px',
                width: '100%',
                borderRadius: tokens.radius.sm,
                border: `1px solid ${tokens.color.border}`,
              }}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 13 }}>
            Params JSON
            <textarea
              value={params}
              onChange={(e) => setParams(e.target.value)}
              rows={4}
              style={{
                marginTop: 4,
                width: '100%',
                fontFamily: tokens.font.mono,
                fontSize: 12,
                padding: 8,
                borderRadius: tokens.radius.sm,
                border: `1px solid ${tokens.color.border}`,
              }}
              placeholder='{"dimension":"timekeeper"} or {"days":30}'
            />
          </label>
          <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            Shared firm-wide
          </label>
          <div>
            <Button type="submit">Save</Button>
          </div>
        </form>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>

      <Card title="Saved reports">
        <Table<SavedReport>
          columns={[
            { key: 'name', header: 'Name', render: (r) => r.name },
            { key: 'kind', header: 'Kind', render: (r) => r.reportKind },
            {
              key: 'params',
              header: 'Params',
              render: (r) => <code style={{ fontSize: 11 }}>{JSON.stringify(r.paramsJson)}</code>,
            },
            {
              key: 'shared',
              header: 'Shared',
              render: (r) => (
                <Pill tone={r.sharedFlag ? 'accent' : 'neutral'}>
                  {r.sharedFlag ? 'firm-wide' : 'private'}
                </Pill>
              ),
            },
            {
              key: 'actions',
              header: '',
              render: (r) => (
                <Button size="sm" variant="secondary" onClick={() => void remove(r.id)}>
                  Delete
                </Button>
              ),
            },
          ]}
          rows={items}
          rowKey={(r) => r.id}
          empty="No saved reports yet."
        />
      </Card>
    </div>
  );
}
