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

interface EngagementType {
  id: string;
  key: string;
  name: string;
  serviceLineId: string | null;
  defaultFeeStructure: string | null;
  status: string;
}

const FEE_OPTIONS = [
  { value: 'HOURLY', label: 'Hourly' },
  { value: 'HOURLY_NTE', label: 'Hourly (NTE)' },
  { value: 'FIXED_FEE', label: 'Fixed fee' },
  { value: 'FIXED_FEE_WITH_MILESTONES', label: 'Fixed fee + milestones' },
  { value: 'RECURRING_SUBSCRIPTION', label: 'Recurring subscription' },
];

export function TaxonomyPage(): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <ServiceLinesPanel />
      <EngagementTypesPanel />
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

function EngagementTypesPanel(): JSX.Element {
  const [items, setItems] = useState<EngagementType[]>([]);
  const [serviceLines, setServiceLines] = useState<ServiceLine[]>([]);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [newServiceLineId, setNewServiceLineId] = useState('');
  const [newFee, setNewFee] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function load(): Promise<void> {
    const [r, sl] = await Promise.all([
      api<{ items: EngagementType[] }>('/api/staff/taxonomy/engagement-types'),
      api<{ items: ServiceLine[] }>('/api/staff/taxonomy/service-lines'),
    ]);
    setItems(r.items ?? []);
    setServiceLines(sl.items ?? []);
  }
  useEffect(() => {
    void load();
  }, []);

  function fail(e: unknown, fallback: string): void {
    if (e instanceof Error && e.message === 'in_use') {
      const count = (e as { body?: { count?: number } }).body?.count;
      setErr(`In use by ${count ?? 'existing'} engagement(s) — cannot archive.`);
      return;
    }
    setErr(e instanceof Error ? e.message : fallback);
  }

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    try {
      await api('/api/staff/taxonomy/engagement-types', {
        method: 'POST',
        body: JSON.stringify({
          key,
          name,
          ...(newServiceLineId ? { serviceLineId: newServiceLineId } : {}),
          ...(newFee ? { defaultFeeStructure: newFee } : {}),
        }),
      });
      setKey('');
      setName('');
      setNewServiceLineId('');
      setNewFee('');
      await load();
    } catch (e2) {
      fail(e2, 'create_failed');
    }
  }

  async function patch(id: string, body: Record<string, unknown>): Promise<void> {
    setErr(null);
    try {
      await api(`/api/staff/taxonomy/engagement-types/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      await load();
    } catch (e2) {
      fail(e2, 'update_failed');
    }
  }

  const slOptions = serviceLines.map((sl) => ({ value: sl.id, label: sl.name }));

  return (
    <Card title="Engagement types">
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
            placeholder="No service line"
          />
        </div>
        <div style={{ width: 200 }}>
          <Combobox
            ariaLabel="Default fee structure"
            clearable
            value={newFee}
            onChange={setNewFee}
            options={FEE_OPTIONS}
            placeholder="Default fee"
          />
        </div>
        <Button type="submit">Add</Button>
      </form>
      <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
        Types classify engagements and templates and derive their service line. The default fee
        structure pre-fills new engagements of this type. Archiving is blocked while any engagement
        references the type.
      </p>
      {err && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{err}</p>}
      <Table<EngagementType>
        columns={[
          { key: 'key', header: 'Key', render: (r) => <code>{r.key}</code> },
          { key: 'name', header: 'Name', render: (r) => r.name },
          {
            key: 'serviceLine',
            header: 'Service line',
            render: (r) =>
              r.status === 'ARCHIVED' ? (
                (serviceLines.find((s) => s.id === r.serviceLineId)?.name ?? '—')
              ) : (
                <div style={{ minWidth: 170 }}>
                  <Combobox
                    ariaLabel={`Service line for ${r.name}`}
                    value={r.serviceLineId ?? ''}
                    onChange={(val) => {
                      if (val && val !== r.serviceLineId) void patch(r.id, { serviceLineId: val });
                    }}
                    options={slOptions}
                    placeholder="None"
                    size="sm"
                  />
                </div>
              ),
          },
          {
            key: 'fee',
            header: 'Default fee',
            render: (r) =>
              r.status === 'ARCHIVED' ? (
                (FEE_OPTIONS.find((f) => f.value === r.defaultFeeStructure)?.label ?? '—')
              ) : (
                <div style={{ minWidth: 170 }}>
                  <Combobox
                    ariaLabel={`Default fee structure for ${r.name}`}
                    value={r.defaultFeeStructure ?? ''}
                    onChange={(val) => {
                      if (val && val !== r.defaultFeeStructure)
                        void patch(r.id, { defaultFeeStructure: val });
                    }}
                    options={FEE_OPTIONS}
                    placeholder="None"
                    size="sm"
                  />
                </div>
              ),
          },
          {
            key: 'edit',
            header: '',
            align: 'right',
            render: (r) =>
              r.status === 'ARCHIVED' ? (
                <Pill>ARCHIVED</Pill>
              ) : (
                <div
                  style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end' }}
                >
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const next = prompt(`Rename engagement type "${r.name}":`, r.name);
                      if (!next || next.trim() === r.name) return;
                      void patch(r.id, { name: next.trim() });
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (!confirm(`Archive engagement type "${r.name}"?`)) return;
                      setErr(null);
                      void api(`/api/staff/taxonomy/engagement-types/${r.id}/archive`, {
                        method: 'PATCH',
                      })
                        .then(load)
                        .catch((e2) => fail(e2, 'archive_failed'));
                    }}
                  >
                    Archive
                  </Button>
                </div>
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
