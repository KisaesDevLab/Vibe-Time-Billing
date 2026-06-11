// SPDX-License-Identifier: Elastic-2.0
//
// 0054 — rate-code catalog. Firm-scoped codes referenced by engagement
// defaultRateCodeId and by per-staff snapshot entries. StandardRate is
// system-seeded; its code is immutable and it cannot be deactivated or
// deleted (the resolver fallback path needs it).

import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface RateCode {
  id: string;
  code: string;
  description: string | null;
  active: boolean;
  sortOrder: number;
  isSystem: boolean;
}

export function RateCodesPage(): JSX.Element {
  const [items, setItems] = useState<RateCode[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newSort, setNewSort] = useState('10');
  const [editing, setEditing] = useState<Record<string, Partial<RateCode>>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: RateCode[] }>('/api/staff/admin/rate-codes');
      setItems(r.items ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    setCreating(true);
    try {
      await api('/api/staff/admin/rate-codes', {
        method: 'POST',
        body: JSON.stringify({
          code: newCode.trim(),
          description: newDescription.trim() || null,
          sortOrder: Number(newSort) || 0,
        }),
      });
      setNewCode('');
      setNewDescription('');
      setNewSort('10');
      await load();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'create_failed');
    } finally {
      setCreating(false);
    }
  }

  function patch(id: string, change: Partial<RateCode>): void {
    setEditing((prev) => ({ ...prev, [id]: { ...prev[id], ...change } }));
  }

  function dirty(id: string): boolean {
    return Boolean(editing[id] && Object.keys(editing[id]!).length > 0);
  }

  async function save(id: string): Promise<void> {
    const body = editing[id];
    if (!body) return;
    setErr(null);
    setSavingId(id);
    try {
      await api(`/api/staff/admin/rate-codes/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setEditing((prev) => {
        const { [id]: _omit, ...rest } = prev;
        return rest;
      });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'save_failed');
    } finally {
      setSavingId(null);
    }
  }

  async function remove(row: RateCode): Promise<void> {
    if (row.isSystem) return;
    if (!confirm(`Delete rate code "${row.code}"? This fails if any staff snapshot uses it.`))
      return;
    setErr(null);
    try {
      await api(`/api/staff/admin/rate-codes/${row.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'delete_failed');
    }
  }

  function effective(row: RateCode): RateCode {
    return { ...row, ...editing[row.id] };
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1000 }}>
      <Card title="Add rate code">
        <p
          style={{
            fontSize: 13,
            color: tokens.color.textMuted,
            margin: 0,
            marginBottom: 12,
          }}
        >
          Rate codes are referenced by engagements and by each staff member&apos;s effective-dated
          rate snapshots. The seeded <code>StandardRate</code> code is the resolver fallback — every
          snapshot must include an entry for it.
        </p>
        <form
          onSubmit={create}
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 2fr 100px auto',
            gap: 12,
            alignItems: 'end',
          }}
        >
          <Input
            label="Code"
            value={newCode}
            onChange={(e) => setNewCode(e.target.value)}
            placeholder="PayrollServices"
            required
          />
          <Input
            label="Description"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            placeholder="Payroll engagements"
          />
          <Input
            label="Sort"
            type="number"
            value={newSort}
            onChange={(e) => setNewSort(e.target.value)}
          />
          <Button type="submit" disabled={creating || !newCode.trim()}>
            {creating ? 'Adding…' : 'Add'}
          </Button>
        </form>
        {err && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{err}</p>}
      </Card>

      <Card title={`Rate codes (${items.length})`}>
        <Table<RateCode>
          columns={[
            {
              key: 'code',
              header: 'Code',
              render: (r) => {
                const e = effective(r);
                if (r.isSystem)
                  return (
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <code>{r.code}</code>
                      <Pill tone="neutral">system</Pill>
                    </span>
                  );
                return (
                  <Input value={e.code} onChange={(ev) => patch(r.id, { code: ev.target.value })} />
                );
              },
            },
            {
              key: 'description',
              header: 'Description',
              render: (r) => {
                const e = effective(r);
                return (
                  <Input
                    value={e.description ?? ''}
                    onChange={(ev) => patch(r.id, { description: ev.target.value || null })}
                    placeholder="—"
                  />
                );
              },
            },
            {
              key: 'sort',
              header: 'Sort',
              align: 'right',
              render: (r) => {
                const e = effective(r);
                return (
                  <Input
                    type="number"
                    value={String(e.sortOrder)}
                    onChange={(ev) => patch(r.id, { sortOrder: Number(ev.target.value) || 0 })}
                    style={{ width: 70 }}
                  />
                );
              },
            },
            {
              key: 'active',
              header: 'Active',
              render: (r) => {
                const e = effective(r);
                return (
                  <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={e.active}
                      disabled={r.isSystem}
                      onChange={(ev) => patch(r.id, { active: ev.target.checked })}
                    />
                    <span style={{ fontSize: 12 }}>{e.active ? 'Active' : 'Archived'}</span>
                  </label>
                );
              },
            },
            {
              key: 'actions',
              header: '',
              render: (r) => (
                <div style={{ display: 'inline-flex', gap: 6 }}>
                  <Button
                    size="sm"
                    onClick={() => void save(r.id)}
                    disabled={!dirty(r.id) || savingId === r.id}
                  >
                    {savingId === r.id ? 'Saving…' : 'Save'}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => void remove(r)}
                    disabled={r.isSystem}
                  >
                    Delete
                  </Button>
                </div>
              ),
            },
          ]}
          rows={items}
          rowKey={(r) => r.id}
          empty="No rate codes yet."
        />
      </Card>
    </div>
  );
}
