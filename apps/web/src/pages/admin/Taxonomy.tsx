// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Combobox, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface ServiceLine {
  id: string;
  name: string;
  category: 'tax' | 'audit' | 'advisory' | 'bookkeeping' | 'payroll';
  color: string | null;
  status: string;
}

interface WorkCode {
  id: string;
  key: string;
  name: string;
  billableDefault: boolean;
  status: string;
}

interface ReasonCode {
  id: string;
  category: 'WRITE_DOWN' | 'WRITE_UP' | 'TRANSFER';
  label: string;
  status: string;
}

export function TaxonomyPage(): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <ServiceLinesPanel />
      <WorkCodesPanel />
      <ReasonCodesPanel />
    </div>
  );
}

function ServiceLinesPanel(): JSX.Element {
  const [items, setItems] = useState<ServiceLine[]>([]);
  const [name, setName] = useState('');
  const [cat, setCat] = useState<ServiceLine['category']>('tax');
  const [err, setErr] = useState<string | null>(null);

  async function load(): Promise<void> {
    const r = await api<{ items: ServiceLine[] }>('/api/staff/taxonomy/service-lines');
    setItems(r.items ?? []);
  }
  useEffect(() => {
    void load();
  }, []);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await api('/api/staff/taxonomy/service-lines', {
        method: 'POST',
        body: JSON.stringify({ name, category: cat }),
      });
      setName('');
      await load();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'failed');
    }
  }

  return (
    <Card title="Service lines">
      <form onSubmit={create} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" required />
        <div style={{ width: 180 }}>
          <Combobox
            ariaLabel="Category"
            value={cat}
            onChange={(v) => setCat(v as ServiceLine['category'])}
            options={[
              { value: 'tax', label: 'Tax' },
              { value: 'audit', label: 'Audit' },
              { value: 'advisory', label: 'Advisory' },
              { value: 'bookkeeping', label: 'Bookkeeping' },
              { value: 'payroll', label: 'Payroll' },
            ]}
          />
        </div>
        <Button type="submit">Add</Button>
      </form>
      {err && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{err}</p>}
      <Table<ServiceLine>
        columns={[
          { key: 'name', header: 'Name', render: (r) => r.name },
          { key: 'cat', header: 'Category', render: (r) => <Pill>{r.category}</Pill> },
          {
            key: 'edit',
            header: '',
            align: 'right',
            render: (r) => (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const next = prompt(`Rename service line "${r.name}":`, r.name);
                  if (!next || next.trim() === r.name) return;
                  void api(`/api/staff/taxonomy/service-lines/${r.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ name: next.trim(), category: r.category }),
                  })
                    .then(load)
                    .catch((e) => setErr(e instanceof Error ? e.message : 'rename_failed'));
                }}
              >
                Rename
              </Button>
            ),
          },
        ]}
        rows={items}
        rowKey={(r) => r.id}
      />
    </Card>
  );
}

function WorkCodesPanel(): JSX.Element {
  const [items, setItems] = useState<WorkCode[]>([]);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');

  async function load(): Promise<void> {
    const r = await api<{ items: WorkCode[] }>('/api/staff/taxonomy/work-codes');
    setItems(r.items ?? []);
  }
  useEffect(() => {
    void load();
  }, []);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    await api('/api/staff/taxonomy/work-codes', {
      method: 'POST',
      body: JSON.stringify({ key, name }),
    });
    setKey('');
    setName('');
    await load();
  }

  return (
    <Card title="Work codes">
      <form onSubmit={create} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <Input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="key (snake_case)"
          required
        />
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Display name"
          required
        />
        <Button type="submit">Add</Button>
      </form>
      <Table<WorkCode>
        columns={[
          { key: 'key', header: 'Key', render: (r) => <code>{r.key}</code> },
          { key: 'name', header: 'Name', render: (r) => r.name },
          {
            key: 'billable',
            header: 'Billable default',
            render: (r) => (r.billableDefault ? '✓' : '—'),
          },
          {
            key: 'edit',
            header: '',
            align: 'right',
            render: (r) => (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const next = prompt(`Rename work code "${r.name}":`, r.name);
                  if (!next || next.trim() === r.name) return;
                  void api(`/api/staff/taxonomy/work-codes/${r.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ name: next.trim() }),
                  }).then(load);
                }}
              >
                Rename
              </Button>
            ),
          },
        ]}
        rows={items}
        rowKey={(r) => r.id}
      />
    </Card>
  );
}

function ReasonCodesPanel(): JSX.Element {
  const [items, setItems] = useState<ReasonCode[]>([]);
  const [cat, setCat] = useState<ReasonCode['category']>('WRITE_DOWN');
  const [label, setLabel] = useState('');

  async function load(): Promise<void> {
    const r = await api<{ items: ReasonCode[] }>('/api/staff/taxonomy/reason-codes');
    setItems(r.items ?? []);
  }
  useEffect(() => {
    void load();
  }, []);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    await api('/api/staff/taxonomy/reason-codes', {
      method: 'POST',
      body: JSON.stringify({ category: cat, label }),
    });
    setLabel('');
    await load();
  }

  return (
    <Card title="Reason codes">
      <form onSubmit={create} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <div style={{ width: 180 }}>
          <Combobox
            ariaLabel="Category"
            value={cat}
            onChange={(v) => setCat(v as ReasonCode['category'])}
            options={[
              { value: 'WRITE_DOWN', label: 'Write-down' },
              { value: 'WRITE_UP', label: 'Write-up' },
              { value: 'TRANSFER', label: 'Transfer' },
            ]}
          />
        </div>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label"
          required
        />
        <Button type="submit">Add</Button>
      </form>
      <Table<ReasonCode>
        columns={[
          { key: 'cat', header: 'Category', render: (r) => <Pill>{r.category}</Pill> },
          { key: 'label', header: 'Label', render: (r) => r.label },
          {
            key: 'edit',
            header: '',
            align: 'right',
            render: (r) => (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const next = prompt(`Rename reason code "${r.label}":`, r.label);
                  if (!next || next.trim() === r.label) return;
                  void api(`/api/staff/taxonomy/reason-codes/${r.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ label: next.trim(), category: r.category }),
                  }).then(load);
                }}
              >
                Rename
              </Button>
            ),
          },
        ]}
        rows={items}
        rowKey={(r) => r.id}
      />
    </Card>
  );
}
