// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface AltContact {
  id: string;
  channel: 'EMAIL' | 'SMS';
  value: string;
  verifiedAt: string | null;
  createdAt: string;
}

export function AltContactsPage(): JSX.Element {
  const [items, setItems] = useState<AltContact[]>([]);
  const [channel, setChannel] = useState<'EMAIL' | 'SMS'>('EMAIL');
  const [value, setValue] = useState('');
  const [pendingVerifyId, setPendingVerifyId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: AltContact[] }>('/api/portal/profile/alt-contacts');
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function add(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setStatus(null);
    try {
      const r = await api<{ id: string; sent: boolean }>('/api/portal/profile/alt-contacts', {
        method: 'POST',
        body: JSON.stringify({ channel, value }),
      });
      setStatus('Verification code sent.');
      setValue('');
      setPendingVerifyId(r.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function verify(id: string): Promise<void> {
    setError(null);
    try {
      await api(`/api/portal/profile/alt-contacts/${id}/verify`, {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      setStatus('Contact verified.');
      setCode('');
      setPendingVerifyId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'invalid code');
    }
  }

  async function remove(id: string): Promise<void> {
    if (!confirm('Remove this contact?')) return;
    try {
      await api(`/api/portal/profile/alt-contacts/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 800 }}>
      <Card title="Add an alternate contact">
        <form
          onSubmit={add}
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr auto',
            gap: 12,
            alignItems: 'end',
          }}
        >
          <label style={{ display: 'block', fontFamily: tokens.font.body }}>
            <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
              Channel
            </div>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as 'EMAIL' | 'SMS')}
              style={{
                padding: '10px 12px',
                background: tokens.color.surface,
                color: tokens.color.text,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                fontSize: 14,
              }}
            >
              <option value="EMAIL">Email</option>
              <option value="SMS">SMS</option>
            </select>
          </label>
          <Input
            label={channel === 'EMAIL' ? 'Email address' : 'Phone (E.164)'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={channel === 'EMAIL' ? 'name@example.com' : '+13125550148'}
          />
          <Button type="submit" disabled={!value}>
            Send code
          </Button>
        </form>
        {status && (
          <p style={{ color: tokens.color.success, fontSize: 12, marginTop: 8 }}>{status}</p>
        )}
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>

      {pendingVerifyId && (
        <Card title="Enter verification code">
          <div style={{ display: 'flex', gap: 12, alignItems: 'end' }}>
            <Input
              label="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={6}
            />
            <Button onClick={() => void verify(pendingVerifyId)} disabled={code.length < 4}>
              Verify
            </Button>
          </div>
        </Card>
      )}

      <Card title="Saved alternate contacts">
        <Table<AltContact>
          columns={[
            { key: 'channel', header: 'Channel', render: (c) => c.channel },
            { key: 'value', header: 'Address', render: (c) => c.value },
            {
              key: 'status',
              header: 'Status',
              render: (c) =>
                c.verifiedAt ? (
                  <Pill tone="success">verified</Pill>
                ) : (
                  <Pill tone="warning">unverified</Pill>
                ),
            },
            {
              key: 'actions',
              header: '',
              render: (c) => (
                <span style={{ display: 'flex', gap: 6 }}>
                  {!c.verifiedAt && (
                    <Button size="sm" variant="secondary" onClick={() => setPendingVerifyId(c.id)}>
                      Enter code
                    </Button>
                  )}
                  <Button size="sm" variant="secondary" onClick={() => void remove(c.id)}>
                    Remove
                  </Button>
                </span>
              ),
            },
          ]}
          rows={items}
          rowKey={(c) => c.id}
          empty="No alternate contacts yet."
        />
      </Card>
    </div>
  );
}
