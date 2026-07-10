// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Combobox, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface ServiceLine {
  id: string;
  name: string;
  // 0148 — firm-managed text, not a fixed enum.
  category: string;
  color: string | null;
  status: string;
}

interface WorkCode {
  id: string;
  key: string;
  name: string;
  serviceLineId: string | null;
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
  const [cat, setCat] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const existingCategories = [...new Set(items.map((i) => i.category))].sort();

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
        body: JSON.stringify({ name, category: cat.trim() || name.trim() }),
      });
      setName('');
      setCat('');
      await load();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'failed');
    }
  }

  return (
    <Card title="Service lines">
      <form onSubmit={create} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" required />
        <div style={{ width: 200 }}>
          <Input
            value={cat}
            onChange={(e) => setCat(e.target.value)}
            placeholder="Category (defaults to name)"
            list="service-line-categories"
            aria-label="Category"
          />
          <datalist id="service-line-categories">
            {existingCategories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
        <Button type="submit">Add</Button>
      </form>
      <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
        Category groups service lines on reports (profitability, engagement filters). It&apos;s free
        text — reuse an existing one to roll lines up together, or leave it blank to use the service
        line&apos;s own name. Click a category pill to change it.
      </p>
      {err && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{err}</p>}
      <Table<ServiceLine>
        columns={[
          { key: 'name', header: 'Name', render: (r) => r.name },
          {
            key: 'cat',
            header: 'Category',
            render: (r) => (
              <button
                type="button"
                title="Change category"
                onClick={() => {
                  const next = prompt(`Category for "${r.name}":`, r.category);
                  if (!next || next.trim().toLowerCase() === r.category) return;
                  void api(`/api/staff/taxonomy/service-lines/${r.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ category: next.trim() }),
                  })
                    .then(load)
                    .catch((e) => setErr(e instanceof Error ? e.message : 'category_failed'));
                }}
                style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
              >
                <Pill>{r.category}</Pill>
              </button>
            ),
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
  const [serviceLines, setServiceLines] = useState<ServiceLine[]>([]);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [newServiceLineId, setNewServiceLineId] = useState('');

  async function load(): Promise<void> {
    const [r, sl] = await Promise.all([
      api<{ items: WorkCode[] }>('/api/staff/taxonomy/work-codes'),
      api<{ items: ServiceLine[] }>('/api/staff/taxonomy/service-lines'),
    ]);
    setItems(r.items ?? []);
    setServiceLines(sl.items ?? []);
  }
  useEffect(() => {
    void load();
  }, []);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    await api('/api/staff/taxonomy/work-codes', {
      method: 'POST',
      body: JSON.stringify({
        key,
        name,
        ...(newServiceLineId ? { serviceLineId: newServiceLineId } : {}),
      }),
    });
    setKey('');
    setName('');
    setNewServiceLineId('');
    await load();
  }

  async function setWorkCodeServiceLine(id: string, serviceLineId: string | null): Promise<void> {
    await api(`/api/staff/taxonomy/work-codes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ serviceLineId }),
    });
    await load();
  }

  const slOptions = serviceLines.map((sl) => ({ value: sl.id, label: sl.name }));

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
        <div style={{ width: 200 }}>
          <Combobox
            ariaLabel="Service line"
            clearable
            value={newServiceLineId}
            onChange={setNewServiceLineId}
            options={slOptions}
            placeholder="Any service line"
          />
        </div>
        <Button type="submit">Add</Button>
      </form>
      <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
        Assigning a service line narrows where the code appears: time entry only offers codes
        matching the engagement&apos;s service line (codes with no service line stay available
        everywhere).
      </p>
      <Table<WorkCode>
        columns={[
          { key: 'key', header: 'Key', render: (r) => <code>{r.key}</code> },
          { key: 'name', header: 'Name', render: (r) => r.name },
          {
            key: 'serviceLine',
            header: 'Service line',
            render: (r) => (
              <div style={{ minWidth: 170 }}>
                <Combobox
                  ariaLabel={`Service line for ${r.name}`}
                  clearable
                  value={r.serviceLineId ?? ''}
                  onChange={(val) => void setWorkCodeServiceLine(r.id, val || null)}
                  options={slOptions}
                  placeholder="Any"
                  size="sm"
                />
              </div>
            ),
          },
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
