// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Button, Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface Letter {
  id: string;
  version: number;
  status: string;
  sentAt: string | null;
  engagementId: string;
  engagementName: string;
}

export function LettersPage(): JSX.Element {
  const [items, setItems] = useState<Letter[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: Letter[] }>('/api/portal/letters/awaiting');
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function accept(id: string): Promise<void> {
    if (
      !confirm('Accept this engagement letter? Your acceptance will be recorded with date and IP.')
    )
      return;
    setBusy(id);
    try {
      await api(`/api/portal/letters/${id}/accept`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900 }}>
      <Card title="Engagement letters awaiting your acceptance">
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        <Table<Letter>
          columns={[
            { key: 'eng', header: 'Engagement', render: (l) => l.engagementName },
            { key: 'v', header: 'Version', align: 'right', render: (l) => `v${l.version}` },
            {
              key: 'sent',
              header: 'Sent',
              render: (l) => (l.sentAt ? new Date(l.sentAt).toLocaleString() : '—'),
            },
            {
              key: 'status',
              header: 'Status',
              render: (l) => <Pill tone="warning">{l.status}</Pill>,
            },
            {
              key: 'actions',
              header: '',
              render: (l) => (
                <span style={{ display: 'flex', gap: 6 }}>
                  <a
                    href={`/api/portal/letters/${l.id}/render.html`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Button size="sm" variant="secondary">
                      Read
                    </Button>
                  </a>
                  <Button size="sm" disabled={busy === l.id} onClick={() => void accept(l.id)}>
                    {busy === l.id ? 'Accepting…' : 'Accept'}
                  </Button>
                </span>
              ),
            },
          ]}
          rows={items}
          rowKey={(l) => l.id}
          empty="No letters awaiting your acceptance."
        />
      </Card>
    </div>
  );
}
