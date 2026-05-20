// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Office {
  id: string;
  name: string;
  timezone: string;
  address: string | null;
  isDefault: boolean;
}

export function OfficesPage(): JSX.Element {
  const [offices, setOffices] = useState<Office[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [tz, setTz] = useState('America/Chicago');
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ offices: Office[] }>('/api/staff/admin/offices');
      setOffices(r.offices ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/staff/admin/offices', {
        method: 'POST',
        body: JSON.stringify({ name, timezone: tz }),
      });
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900 }}>
      <Card title="Add office">
        <form
          onSubmit={create}
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr auto',
            gap: 12,
            alignItems: 'end',
          }}
        >
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <Input label="Timezone" value={tz} onChange={(e) => setTz(e.target.value)} required />
          <Button type="submit">Add</Button>
        </form>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>

      <Card title="Offices">
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table<Office>
            columns={[
              { key: 'name', header: 'Name', render: (o) => o.name },
              { key: 'tz', header: 'Timezone', render: (o) => o.timezone },
              {
                key: 'default',
                header: 'Default',
                render: (o) => (o.isDefault ? <Pill tone="accent">default</Pill> : null),
              },
            ]}
            rows={offices}
            rowKey={(o) => o.id}
            empty="No offices yet."
          />
        )}
      </Card>
    </div>
  );
}
