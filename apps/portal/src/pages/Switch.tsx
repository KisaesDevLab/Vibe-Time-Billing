// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Button, Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface ClientRow {
  id: string;
  name: string;
  role: string;
  accessId: string;
}

export function SwitchEntityPage(): JSX.Element {
  const [items, setItems] = useState<ClientRow[]>([]);
  const [active, setActive] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: ClientRow[]; activeClientId: string }>(
        '/api/portal/profile/clients',
      );
      setItems(r.items ?? []);
      setActive(r.activeClientId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function switchTo(id: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api('/api/portal/profile/clients/switch', {
        method: 'POST',
        body: JSON.stringify({ clientId: id }),
      });
      // Hard refresh so all pages re-fetch under the new active client.
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900 }}>
      <Card title="Switch active client">
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          If you have portal access to more than one client account, pick the one you want to view.
        </p>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        <Table<ClientRow>
          columns={[
            { key: 'name', header: 'Client', render: (c) => c.name },
            { key: 'role', header: 'Your role', render: (c) => c.role },
            {
              key: 'active',
              header: 'Active',
              render: (c) => (c.id === active ? <Pill tone="success">active</Pill> : null),
            },
            {
              key: 'actions',
              header: '',
              render: (c) =>
                c.id === active ? null : (
                  <Button size="sm" disabled={busy} onClick={() => void switchTo(c.id)}>
                    Switch
                  </Button>
                ),
            },
          ]}
          rows={items}
          rowKey={(c) => c.id}
          empty="You have access to only one client."
        />
      </Card>
    </div>
  );
}
