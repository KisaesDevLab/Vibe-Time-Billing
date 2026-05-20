// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Margin {
  appUserId: string;
  fullName: string | null;
  billCents: number;
  costCents: number | null;
  marginPct: number | null;
  effectiveStart: string;
}

interface User {
  id: string;
  fullName: string;
  email: string;
}

const formatCents = (c: number): string => `$${(c / 100).toFixed(2)}`;

export function RatesPage(): JSX.Element {
  const [margins, setMargins] = useState<Margin[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [userId, setUserId] = useState('');
  const [bill, setBill] = useState('');
  const [cost, setCost] = useState('');
  const [effective, setEffective] = useState('');
  const [bulkPct, setBulkPct] = useState('5');
  const [bulkEffective, setBulkEffective] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const [m, u] = await Promise.all([
        api<{ items: Margin[] }>('/api/staff/rates/loaded-margin'),
        api<{ users: User[] }>('/api/staff/admin/users'),
      ]);
      setMargins(m.items ?? []);
      setUsers(u.users ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function addRate(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setStatus(null);
    try {
      await api('/api/staff/rates/timekeeper', {
        method: 'POST',
        body: JSON.stringify({
          appUserId: userId,
          billRateCents: Math.round(parseFloat(bill) * 100),
          costRateCents: cost ? Math.round(parseFloat(cost) * 100) : undefined,
          effectiveStart: effective,
        }),
      });
      setBill('');
      setCost('');
      setUserId('');
      setEffective('');
      setStatus('Rate added.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function bulkApply(): Promise<void> {
    setError(null);
    setStatus(null);
    try {
      const r = await api<{ updated: number }>('/api/staff/rates/bulk-update/commit', {
        method: 'POST',
        body: JSON.stringify({
          pctChange: parseFloat(bulkPct),
          effectiveStart: bulkEffective,
        }),
      });
      setStatus(`Bulk update committed (${r.updated} rates updated).`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Add timekeeper rate">
        <form
          onSubmit={addRate}
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr 1fr 1fr auto',
            gap: 12,
            alignItems: 'end',
          }}
        >
          <label style={{ fontSize: 13 }}>
            Timekeeper
            <select
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              required
              style={{
                marginTop: 4,
                padding: '6px 8px',
                width: '100%',
                borderRadius: tokens.radius.sm,
                border: `1px solid ${tokens.color.border}`,
              }}
            >
              <option value="">— Pick one —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName} ({u.email})
                </option>
              ))}
            </select>
          </label>
          <Input
            label="Bill / hr"
            type="number"
            step="0.01"
            value={bill}
            onChange={(e) => setBill(e.target.value)}
            required
          />
          <Input
            label="Cost / hr"
            type="number"
            step="0.01"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
          <Input
            label="Effective"
            type="date"
            value={effective}
            onChange={(e) => setEffective(e.target.value)}
            required
          />
          <Button type="submit">Add</Button>
        </form>
        {status && (
          <p style={{ color: tokens.color.success, fontSize: 12, marginTop: 8 }}>{status}</p>
        )}
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>

      <Card title="Bulk rate update (current open-ended timekeeper rates)">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr auto',
            gap: 12,
            alignItems: 'end',
          }}
        >
          <Input
            label="Pct change"
            type="number"
            step="0.5"
            value={bulkPct}
            onChange={(e) => setBulkPct(e.target.value)}
          />
          <Input
            label="Effective"
            type="date"
            value={bulkEffective}
            onChange={(e) => setBulkEffective(e.target.value)}
          />
          <Button onClick={() => void bulkApply()}>Apply</Button>
        </div>
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 8 }}>
          Closes each current rate the day before the new effective date and opens a fresh row at
          the multiplied amount. Cost rates carry forward.
        </p>
      </Card>

      <Card title="Loaded margin (current open-ended rates)">
        <Table<Margin>
          columns={[
            { key: 'name', header: 'Name', render: (m) => m.fullName ?? m.appUserId.slice(0, 8) },
            {
              key: 'bill',
              header: 'Bill',
              align: 'right',
              render: (m) => formatCents(m.billCents),
            },
            {
              key: 'cost',
              header: 'Cost',
              align: 'right',
              render: (m) => (m.costCents == null ? '—' : formatCents(m.costCents)),
            },
            {
              key: 'margin',
              header: 'Margin',
              align: 'right',
              render: (m) => (m.marginPct == null ? '—' : `${(m.marginPct * 100).toFixed(1)}%`),
            },
            {
              key: 'eff',
              header: 'Effective',
              render: (m) => m.effectiveStart,
            },
            {
              key: 'status',
              header: '',
              render: (m) =>
                m.costCents == null ? (
                  <Pill tone="warning">cost missing</Pill>
                ) : (m.marginPct ?? 0) < 0.4 ? (
                  <Pill tone="danger">low margin</Pill>
                ) : null,
            },
          ]}
          rows={margins}
          rowKey={(m) => m.appUserId}
          empty="No open-ended timekeeper rates yet."
        />
      </Card>
    </div>
  );
}
