// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
/* eslint-disable jsx-a11y/label-has-associated-control -- labels and controls are siblings inside grid containers; revisit with htmlFor/id pairs in a polish pass */
//
// Time ▸ Expenses tab. Enter out-of-pocket engagement costs (filing fees,
// courier, travel) that the firm bills at cost + markup. Expenses carry no
// timekeeper and are pulled into a billing batch the same way time is.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import {
  Button,
  Card,
  Combobox,
  Input,
  Table,
  type TableColumn,
  tokens,
  type ComboboxOption,
} from '@vibe/ui';
import { useClientPage } from '../lib/use-paged-list';

import { api } from '../api-client';
import { usePermission } from '../auth-context';

interface Engagement {
  id: string;
  name: string;
  clientId: string;
  status?: string;
}
interface Client {
  id: string;
  name: string;
  status?: string;
}

interface ExpenseRow {
  id: string;
  expenseDate: string;
  description: string;
  costCents: number;
  category: string | null;
  vendor: string | null;
  status: string;
  billingBatchId: string | null;
  engagementId: string;
  engagementName: string;
  clientId: string;
  clientName: string;
}

const today = (): string => new Date().toISOString().slice(0, 10);

function dollars(cents: number): string {
  return (cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const inlineInputStyle: React.CSSProperties = {
  padding: '4px 6px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  fontSize: 13,
  boxSizing: 'border-box',
  width: '100%',
};

export function ExpensesView({
  engagements,
  clients,
}: {
  engagements: Engagement[];
  clients: Client[];
}): JSX.Element {
  // Filters
  const [filterClientId, setFilterClientId] = useState('');
  const [filterEngagementId, setFilterEngagementId] = useState('');
  const [filterStart, setFilterStart] = useState('');
  const [filterEnd, setFilterEnd] = useState('');

  // Add form
  const [clientId, setClientId] = useState('');
  const [engagementId, setEngagementId] = useState('');
  const [expenseDate, setExpenseDate] = useState(today());
  const [description, setDescription] = useState('');
  const [cost, setCost] = useState('');
  const [category, setCategory] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 0210 — managed category picklist (+ inline "add new"). Managing the
  // firm-wide list is admin territory (same as work codes: taxonomy:write);
  // everyone can pick from it.
  const canManageCategories = usePermission('taxonomy:write');
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategory, setNewCategory] = useState('');
  const loadCategories = useCallback(async () => {
    try {
      const r = await api<{ items: { id: string; name: string }[] }>(
        '/api/staff/expenses/categories',
      );
      setCategories(r.items ?? []);
    } catch {
      // Picklist stays empty; the field still works as a plain dropdown.
    }
  }, []);
  useEffect(() => {
    void loadCategories();
  }, [loadCategories]);
  async function saveNewCategory(): Promise<void> {
    const name = newCategory.trim();
    if (!name) return;
    try {
      await api('/api/staff/expenses/categories', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      setNewCategory('');
      setAddingCategory(false);
      await loadCategories();
      setCategory(name);
    } catch {
      setError('Could not add the category.');
    }
  }
  const categoryOptions = useMemo<ComboboxOption[]>(() => {
    const opts = categories.map((c) => ({ value: c.name, label: c.name }));
    // Keep a historical value selectable even if it's not in the list.
    if (category && !categories.some((c) => c.name === category)) {
      opts.push({ value: category, label: category });
    }
    return opts;
  }, [categories, category]);

  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Inline edit
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editCost, setEditCost] = useState('');
  const [editCategory, setEditCategory] = useState('');

  const activeClients = useMemo(() => clients.filter((c) => c.status !== 'ARCHIVED'), [clients]);
  const engagementsForClient = useCallback(
    (cid: string): Engagement[] =>
      engagements.filter((e) => (!cid || e.clientId === cid) && e.status !== 'ARCHIVED'),
    [engagements],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterClientId) params.set('clientId', filterClientId);
      if (filterEngagementId) params.set('engagementId', filterEngagementId);
      if (filterStart) params.set('startDate', filterStart);
      if (filterEnd) params.set('endDate', filterEnd);
      const t = await api<{ rows: ExpenseRow[] }>(`/api/staff/expenses/list?${params.toString()}`);
      setRows(t.rows ?? []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [filterClientId, filterEngagementId, filterStart, filterEnd]);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-select the sole engagement when a client is chosen in the form.
  const formEngagements = engagementsForClient(clientId);
  useEffect(() => {
    if (clientId && formEngagements.length === 1) setEngagementId(formEngagements[0]!.id);
  }, [clientId, formEngagements]);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!engagementId) {
      setError('Choose an engagement.');
      return;
    }
    const costCents = Math.round(Number(cost) * 100);
    if (!Number.isFinite(costCents) || costCents < 0) {
      setError('Enter a valid cost.');
      return;
    }
    setSubmitting(true);
    try {
      await api('/api/staff/expenses', {
        method: 'POST',
        body: JSON.stringify({
          engagementId,
          expenseDate,
          description: description.trim() || 'Expense',
          costCents,
          category: category.trim() || undefined,
        }),
      });
      setDescription('');
      setCost('');
      setCategory('');
      await load();
    } catch {
      setError('Could not save the expense.');
    } finally {
      setSubmitting(false);
    }
  }

  function beginEdit(r: ExpenseRow): void {
    setEditingId(r.id);
    setEditDate(r.expenseDate);
    setEditDesc(r.description);
    setEditCost((r.costCents / 100).toFixed(2));
    setEditCategory(r.category ?? '');
  }
  function cancelEdit(): void {
    setEditingId(null);
  }
  const [rowError, setRowError] = useState<string | null>(null);
  async function saveEdit(id: string): Promise<void> {
    const costCents = Math.round(Number(editCost) * 100);
    if (!Number.isFinite(costCents) || costCents < 0) return;
    setRowError(null);
    try {
      await api(`/api/staff/expenses/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          expenseDate: editDate,
          description: editDesc.trim() || 'Expense',
          costCents,
          category: editCategory.trim() || null,
        }),
      });
      setEditingId(null);
      await load();
    } catch (err) {
      // e.g. another user pulled the expense into a billing batch mid-edit.
      setRowError(
        err instanceof Error && err.message === 'expense_in_batch'
          ? 'This expense was just claimed by a billing batch — it can no longer be edited.'
          : 'Could not save the change.',
      );
    }
  }
  async function remove(id: string): Promise<void> {
    setRowError(null);
    try {
      await api(`/api/staff/expenses/${id}`, { method: 'DELETE' });
      await load();
    } catch {
      setRowError('Could not delete the expense.');
    }
  }

  const { paged, pagination } = useClientPage(rows);

  const columns: TableColumn<ExpenseRow>[] = [
    {
      key: 'date',
      header: 'Date',
      render: (r) =>
        editingId === r.id ? (
          <input
            type="date"
            value={editDate}
            onChange={(e) => setEditDate(e.target.value)}
            style={inlineInputStyle}
          />
        ) : (
          r.expenseDate
        ),
    },
    {
      key: 'client',
      header: 'Client',
      render: (r) => <a href={`/clients/${r.clientId}`}>{r.clientName}</a>,
    },
    {
      key: 'engagement',
      header: 'Engagement',
      render: (r) => <a href={`/engagements/${r.engagementId}`}>{r.engagementName}</a>,
    },
    {
      key: 'description',
      header: 'Description',
      render: (r) =>
        editingId === r.id ? (
          <input
            value={editDesc}
            onChange={(e) => setEditDesc(e.target.value)}
            style={inlineInputStyle}
          />
        ) : (
          r.description
        ),
    },
    {
      key: 'category',
      header: 'Category',
      render: (r) =>
        editingId === r.id ? (
          <Combobox
            size="sm"
            value={editCategory}
            onChange={setEditCategory}
            options={
              editCategory && !categories.some((c) => c.name === editCategory)
                ? [
                    ...categories.map((c) => ({ value: c.name, label: c.name })),
                    { value: editCategory, label: editCategory },
                  ]
                : categories.map((c) => ({ value: c.name, label: c.name }))
            }
            clearable
            placeholder="Category"
          />
        ) : (
          (r.category ?? '—')
        ),
    },
    {
      key: 'cost',
      header: 'Cost',
      align: 'right',
      render: (r) =>
        editingId === r.id ? (
          <input
            type="number"
            min={0}
            step="0.01"
            value={editCost}
            onChange={(e) => setEditCost(e.target.value)}
            style={{ ...inlineInputStyle, textAlign: 'right' }}
          />
        ) : (
          `$${dollars(r.costCents)}`
        ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) =>
        r.billingBatchId != null ? (
          <span style={{ color: tokens.color.textMuted }}>In batch</span>
        ) : (
          'Open'
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) => {
        const billed = r.billingBatchId != null;
        const editing = editingId === r.id;
        return billed ? (
          <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>Locked</span>
        ) : editing ? (
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <Button type="button" onClick={() => void saveEdit(r.id)}>
              Save
            </Button>
            <Button type="button" variant="ghost" onClick={cancelEdit}>
              Cancel
            </Button>
          </span>
        ) : (
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <Button type="button" variant="ghost" onClick={() => beginEdit(r)}>
              Edit
            </Button>
            <Button type="button" variant="ghost" onClick={() => void remove(r.id)}>
              Delete
            </Button>
          </span>
        );
      },
    },
  ];

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      <Card title="Add expense">
        <form onSubmit={(e) => void submit(e)} style={{ display: 'grid', gap: tokens.space.md }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: tokens.space.md,
            }}
          >
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              <span>Client</span>
              <Combobox
                value={clientId}
                onChange={(v) => {
                  setClientId(v);
                  setEngagementId('');
                }}
                options={activeClients.map<ComboboxOption>((c) => ({ value: c.id, label: c.name }))}
                placeholder="Select client"
              />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              <span>Engagement</span>
              <Combobox
                value={engagementId}
                onChange={setEngagementId}
                options={formEngagements.map<ComboboxOption>((e) => ({
                  value: e.id,
                  label: e.name,
                }))}
                placeholder="Select engagement"
              />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              <span>Date</span>
              <Input
                type="date"
                value={expenseDate}
                onChange={(e) => setExpenseDate(e.target.value)}
              />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              <span>Cost ($)</span>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                placeholder="0.00"
              />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              <span
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                Category
                {canManageCategories && (
                  <button
                    type="button"
                    onClick={() => setAddingCategory((v) => !v)}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      color: tokens.color.accent,
                      fontSize: 12,
                    }}
                  >
                    {addingCategory ? 'cancel' : '+ new'}
                  </button>
                )}
              </span>
              {addingCategory ? (
                <span style={{ display: 'flex', gap: 4 }}>
                  <Input
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    placeholder="New category name"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void saveNewCategory();
                      }
                    }}
                  />
                  <Button type="button" size="sm" onClick={() => void saveNewCategory()}>
                    Add
                  </Button>
                </span>
              ) : (
                <Combobox
                  value={category}
                  onChange={setCategory}
                  options={categoryOptions}
                  clearable
                  placeholder="Select category"
                />
              )}
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 13, gridColumn: '1 / -1' }}>
              <span>Description</span>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What was the cost for?"
              />
            </label>
          </div>
          {error && <p style={{ color: tokens.color.danger, fontSize: 13, margin: 0 }}>{error}</p>}
          <div>
            <Button type="submit" disabled={submitting || !engagementId}>
              {submitting ? 'Saving…' : 'Add expense'}
            </Button>
          </div>
        </form>
      </Card>

      <Card title="Expenses">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: tokens.space.md,
            marginBottom: tokens.space.md,
          }}
        >
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
            <span>Client</span>
            <Combobox
              value={filterClientId}
              onChange={(v) => {
                setFilterClientId(v);
                setFilterEngagementId('');
              }}
              options={[
                { value: '', label: 'All clients' },
                ...activeClients.map<ComboboxOption>((c) => ({ value: c.id, label: c.name })),
              ]}
              placeholder="All clients"
            />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
            <span>Engagement</span>
            <Combobox
              value={filterEngagementId}
              onChange={setFilterEngagementId}
              options={[
                { value: '', label: 'All engagements' },
                ...engagementsForClient(filterClientId).map<ComboboxOption>((e) => ({
                  value: e.id,
                  label: e.name,
                })),
              ]}
              placeholder="All engagements"
            />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
            <span>From</span>
            <Input
              type="date"
              value={filterStart}
              onChange={(e) => setFilterStart(e.target.value)}
            />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
            <span>To</span>
            <Input type="date" value={filterEnd} onChange={(e) => setFilterEnd(e.target.value)} />
          </label>
        </div>

        {rowError && (
          <p style={{ color: tokens.color.danger, fontSize: 13, marginTop: 0 }}>{rowError}</p>
        )}
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : rows.length === 0 ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>No expenses.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <Table<ExpenseRow>
              columns={columns}
              rows={paged}
              rowKey={(r) => r.id}
              pagination={pagination}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
