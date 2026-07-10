// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useState } from 'react';

import { Button, Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { useScope } from '../scope-context';

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
  const { scope, setScope } = useScope();

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
      {items.length > 1 && (
        <Card title="Consolidated view">
          <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
            When enabled, your Invoices, Tax payments, Engagements, and Activity pages show entries
            from <em>every</em> client you have access to. Toggling this does not change which
            client is &quot;active&quot; for actions like making a payment — switch below to do
            that.
          </p>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={scope === 'all_accessible'}
              onChange={(e) => setScope(e.target.checked ? 'all_accessible' : 'active')}
            />
            <span>
              Show entries across all my clients
              {scope === 'all_accessible' && (
                <span style={{ marginLeft: 8 }}>
                  <Pill tone="success">on</Pill>
                </span>
              )}
            </span>
          </label>
        </Card>
      )}
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
