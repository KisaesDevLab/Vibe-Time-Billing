// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Holiday {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  kind: 'HOLIDAY' | 'PTO';
  appUserId: string | null;
}

export function HolidaysPage(): JSX.Element {
  const [items, setItems] = useState<Holiday[]>([]);
  const [name, setName] = useState('');
  const [startDate, setStart] = useState('');
  const [endDate, setEnd] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: Holiday[] }>('/api/staff/holidays');
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
    try {
      await api('/api/staff/holidays', {
        method: 'POST',
        body: JSON.stringify({ name, startDate, endDate, kind: 'HOLIDAY' }),
      });
      setName('');
      setStart('');
      setEnd('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await api(`/api/staff/holidays/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900 }}>
      <Card title="Add holiday">
        <form
          onSubmit={create}
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr 1fr auto',
            gap: 12,
            alignItems: 'end',
          }}
        >
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <Input
            label="Start date"
            type="date"
            value={startDate}
            onChange={(e) => setStart(e.target.value)}
            required
          />
          <Input
            label="End date"
            type="date"
            value={endDate}
            onChange={(e) => setEnd(e.target.value)}
            required
          />
          <Button type="submit">Add</Button>
        </form>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>

      <Card title="Holidays + PTO">
        <Table<Holiday>
          columns={[
            { key: 'name', header: 'Name', render: (h) => h.name },
            { key: 'start', header: 'Start', render: (h) => h.startDate },
            { key: 'end', header: 'End', render: (h) => h.endDate },
            {
              key: 'kind',
              header: 'Kind',
              render: (h) => (
                <Pill tone={h.kind === 'HOLIDAY' ? 'accent' : 'neutral'}>{h.kind}</Pill>
              ),
            },
            {
              key: 'actions',
              header: '',
              render: (h) => (
                <Button size="sm" variant="secondary" onClick={() => void remove(h.id)}>
                  Delete
                </Button>
              ),
            },
          ]}
          rows={items}
          rowKey={(h) => h.id}
          empty="No entries yet."
        />
      </Card>
    </div>
  );
}
