// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Admin → Catalog → Tax payments. Two coordinated sections:
//   1. Jurisdictions  (Federal, State - CA, Local - Oakland, …)
//   2. Payment types  (Income Tax, Estimate, Tax Notice, …) — each
//      row owned by a jurisdiction and carrying the URL the portal
//      links to so clients can pay online.
//
// System rows ship seeded by bootstrap-firm (Federal + 5 federal
// payment types). The firm can rename or deactivate them; only
// custom (non-system) rows can be deleted.

import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Jurisdiction {
  id: string;
  name: string;
  active: boolean;
  displayOrder: number;
  isSystem: boolean;
}

interface PaymentType {
  id: string;
  jurisdictionId: string;
  name: string;
  paymentUrl: string | null;
  active: boolean;
  displayOrder: number;
  isSystem: boolean;
}

export function TaxPaymentCatalogPage(): JSX.Element {
  const [jurisdictions, setJurisdictions] = useState<Jurisdiction[]>([]);
  const [types, setTypes] = useState<PaymentType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const [j, t] = await Promise.all([
        api<{ items: Jurisdiction[] }>('/api/staff/admin/tax-jurisdictions'),
        api<{ items: PaymentType[] }>('/api/staff/admin/tax-payment-types'),
      ]);
      setJurisdictions(j.items ?? []);
      setTypes(t.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
        Controls the Jurisdiction + Payment type dropdowns on the New Tax Payment form. Each
        payment-type row belongs to a jurisdiction so the form&apos;s type list filters by the
        chosen jurisdiction. The <strong>Payment URL</strong> is the link clients tap from the
        portal to pay online (EFTPS, FTB, etc.).
      </p>

      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }} role="alert">
          {error}
        </p>
      )}
      {notice && <p style={{ color: tokens.color.success, fontSize: 12, margin: 0 }}>{notice}</p>}

      <JurisdictionsCard
        items={jurisdictions}
        types={types}
        onChanged={(msg) => {
          setNotice(msg);
          void load();
        }}
        onError={setError}
      />

      <PaymentTypesCard
        items={types}
        jurisdictions={jurisdictions}
        onChanged={(msg) => {
          setNotice(msg);
          void load();
        }}
        onError={setError}
      />
    </div>
  );
}

// ---------- Jurisdictions ----------

interface JurisdictionsCardProps {
  items: Jurisdiction[];
  types: PaymentType[];
  onChanged: (msg: string) => void;
  onError: (msg: string) => void;
}

function JurisdictionsCard({
  items,
  types,
  onChanged,
  onError,
}: JurisdictionsCardProps): JSX.Element {
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [order, setOrder] = useState('100');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editActive, setEditActive] = useState(true);
  const [editOrder, setEditOrder] = useState('100');

  async function add(e: FormEvent): Promise<void> {
    e.preventDefault();
    onError('');
    try {
      await api('/api/staff/admin/tax-jurisdictions', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          displayOrder: Number(order) || 100,
        }),
      });
      setName('');
      setOrder('100');
      setShowAdd(false);
      onChanged(`Added "${name.trim()}".`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'add_failed';
      onError(msg === 'duplicate_name' ? `"${name.trim()}" already exists.` : `Add failed: ${msg}`);
    }
  }

  function beginEdit(j: Jurisdiction): void {
    setEditingId(j.id);
    setEditName(j.name);
    setEditActive(j.active);
    setEditOrder(String(j.displayOrder));
    onError('');
  }

  async function save(id: string): Promise<void> {
    onError('');
    try {
      await api(`/api/staff/admin/tax-jurisdictions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName.trim() || undefined,
          active: editActive,
          displayOrder: Number(editOrder) || 100,
        }),
      });
      setEditingId(null);
      onChanged('Saved.');
    } catch (err) {
      onError(`Save failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  async function remove(j: Jurisdiction): Promise<void> {
    const dependentTypes = types.filter((t) => t.jurisdictionId === j.id).length;
    const msg =
      dependentTypes > 0
        ? `Delete "${j.name}"? This will also delete its ${dependentTypes} payment-type row${dependentTypes === 1 ? '' : 's'}.`
        : `Delete "${j.name}"?`;
    if (!window.confirm(msg)) return;
    onError('');
    try {
      await api(`/api/staff/admin/tax-jurisdictions/${j.id}`, { method: 'DELETE' });
      onChanged(`Deleted "${j.name}".`);
    } catch (err) {
      const m = err instanceof Error ? err.message : 'delete_failed';
      onError(
        m === 'system_row_undeletable'
          ? 'System jurisdictions can be renamed or deactivated, but not deleted.'
          : `Delete failed: ${m}`,
      );
    }
  }

  return (
    <Card
      title="Jurisdictions"
      action={
        <Button
          size="sm"
          variant={showAdd ? 'ghost' : 'secondary'}
          onClick={() => setShowAdd((v) => !v)}
        >
          {showAdd ? 'Cancel' : '+ Add jurisdiction'}
        </Button>
      }
    >
      {showAdd && (
        <form
          onSubmit={add}
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 120px auto',
            gap: 10,
            padding: 12,
            marginBottom: 14,
            background: tokens.color.surface,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            alignItems: 'end',
          }}
        >
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="State - CA · Local - Oakland · Foreign - Canada"
            required
          />
          <Input
            type="number"
            label="Order"
            value={order}
            onChange={(e) => setOrder(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={!name.trim()}>
            Add
          </Button>
        </form>
      )}
      <Table<Jurisdiction>
        columns={[
          {
            key: 'order',
            header: 'Order',
            align: 'right',
            render: (j) =>
              editingId === j.id ? (
                <CellInput value={editOrder} onChange={setEditOrder} type="number" width={70} />
              ) : (
                <span style={{ color: tokens.color.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                  {j.displayOrder}
                </span>
              ),
          },
          {
            key: 'name',
            header: 'Name',
            render: (j) =>
              editingId === j.id ? (
                <CellInput value={editName} onChange={setEditName} />
              ) : (
                <span style={{ fontWeight: 500 }}>{j.name}</span>
              ),
          },
          {
            key: 'types',
            header: 'Payment types',
            render: (j) => (
              <span style={{ color: tokens.color.textMuted }}>
                {types.filter((t) => t.jurisdictionId === j.id).length}
              </span>
            ),
          },
          {
            key: 'active',
            header: 'Active',
            render: (j) =>
              editingId === j.id ? (
                <input
                  type="checkbox"
                  checked={editActive}
                  onChange={(e) => setEditActive(e.target.checked)}
                />
              ) : (
                <Pill tone={j.active ? 'success' : 'neutral'}>{j.active ? 'Active' : 'Off'}</Pill>
              ),
          },
          {
            key: 'system',
            header: 'Type',
            render: (j) => (j.isSystem ? <Pill tone="accent">System</Pill> : <Pill>Custom</Pill>),
          },
          {
            key: 'actions',
            header: '',
            render: (j) => (
              <div style={{ display: 'inline-flex', gap: 4 }}>
                {editingId === j.id ? (
                  <>
                    <Button size="sm" onClick={() => void save(j.id)}>
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => beginEdit(j)}>
                      Edit
                    </Button>
                    {!j.isSystem && (
                      <Button size="sm" variant="ghost" onClick={() => void remove(j)}>
                        Delete
                      </Button>
                    )}
                  </>
                )}
              </div>
            ),
          },
        ]}
        rows={items}
        rowKey={(j) => j.id}
        empty="No jurisdictions yet."
      />
    </Card>
  );
}

// ---------- Payment types ----------

interface PaymentTypesCardProps {
  items: PaymentType[];
  jurisdictions: Jurisdiction[];
  onChanged: (msg: string) => void;
  onError: (msg: string) => void;
}

function PaymentTypesCard({
  items,
  jurisdictions,
  onChanged,
  onError,
}: PaymentTypesCardProps): JSX.Element {
  const [showAdd, setShowAdd] = useState(false);
  const [jurisdictionId, setJurisdictionId] = useState('');
  const [name, setName] = useState('');
  const [paymentUrl, setPaymentUrl] = useState('');
  const [order, setOrder] = useState('100');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editActive, setEditActive] = useState(true);
  const [editOrder, setEditOrder] = useState('100');

  // Group by jurisdiction for display.
  const grouped = jurisdictions.map((j) => ({
    jurisdiction: j,
    rows: items.filter((t) => t.jurisdictionId === j.id),
  }));

  async function add(e: FormEvent): Promise<void> {
    e.preventDefault();
    onError('');
    try {
      const body: Record<string, unknown> = {
        jurisdictionId,
        name: name.trim(),
        displayOrder: Number(order) || 100,
      };
      if (paymentUrl.trim()) body['paymentUrl'] = paymentUrl.trim();
      await api('/api/staff/admin/tax-payment-types', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setName('');
      setPaymentUrl('');
      setOrder('100');
      setShowAdd(false);
      onChanged(`Added "${name.trim()}".`);
    } catch (err) {
      const m = err instanceof Error ? err.message : 'add_failed';
      onError(
        m === 'duplicate_name_in_jurisdiction'
          ? `A payment type with that name already exists for this jurisdiction.`
          : m.includes('invalid_payload')
            ? 'Payment URL must be a valid http:// or https:// URL.'
            : `Add failed: ${m}`,
      );
    }
  }

  function beginEdit(t: PaymentType): void {
    setEditingId(t.id);
    setEditName(t.name);
    setEditUrl(t.paymentUrl ?? '');
    setEditActive(t.active);
    setEditOrder(String(t.displayOrder));
    onError('');
  }

  async function save(id: string): Promise<void> {
    onError('');
    try {
      await api(`/api/staff/admin/tax-payment-types/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName.trim() || undefined,
          paymentUrl: editUrl.trim() || null,
          active: editActive,
          displayOrder: Number(editOrder) || 100,
        }),
      });
      setEditingId(null);
      onChanged('Saved.');
    } catch (err) {
      onError(`Save failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  async function remove(t: PaymentType): Promise<void> {
    if (!window.confirm(`Delete payment type "${t.name}"?`)) return;
    onError('');
    try {
      await api(`/api/staff/admin/tax-payment-types/${t.id}`, { method: 'DELETE' });
      onChanged(`Deleted "${t.name}".`);
    } catch (err) {
      const m = err instanceof Error ? err.message : 'delete_failed';
      onError(
        m === 'system_row_undeletable'
          ? 'System payment types can be renamed or deactivated, but not deleted.'
          : `Delete failed: ${m}`,
      );
    }
  }

  return (
    <Card
      title="Payment types"
      action={
        <Button
          size="sm"
          variant={showAdd ? 'ghost' : 'secondary'}
          disabled={jurisdictions.filter((j) => j.active).length === 0}
          onClick={() => setShowAdd((v) => !v)}
        >
          {showAdd ? 'Cancel' : '+ Add payment type'}
        </Button>
      }
    >
      {jurisdictions.filter((j) => j.active).length === 0 && (
        <p style={{ fontSize: 12, color: tokens.color.warning, marginTop: 0 }}>
          Add at least one active jurisdiction above before configuring payment types.
        </p>
      )}

      {showAdd && (
        <form
          onSubmit={add}
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 2fr 90px auto',
            gap: 10,
            padding: 12,
            marginBottom: 14,
            background: tokens.color.surface,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            alignItems: 'end',
          }}
        >
          <div style={{ display: 'grid', gap: 4 }}>
            <label
              htmlFor="add-juris"
              style={{ fontSize: 11, color: tokens.color.textMuted, display: 'block' }}
            >
              Jurisdiction
            </label>
            <select
              id="add-juris"
              value={jurisdictionId}
              onChange={(e) => setJurisdictionId(e.target.value)}
              required
              style={{
                padding: '10px 12px',
                fontSize: 14,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                background: tokens.color.surface,
                color: tokens.color.text,
              }}
            >
              <option value="">Select…</option>
              {jurisdictions
                .filter((j) => j.active)
                .map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.name}
                  </option>
                ))}
            </select>
          </div>
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Income Tax · Estimate · Sales Tax · Tax Notice"
            required
          />
          <Input
            label="Payment URL (optional)"
            value={paymentUrl}
            onChange={(e) => setPaymentUrl(e.target.value)}
            placeholder="https://www.eftps.gov"
            type="url"
          />
          <Input
            type="number"
            label="Order"
            value={order}
            onChange={(e) => setOrder(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={!name.trim() || !jurisdictionId}>
            Add
          </Button>
        </form>
      )}

      {grouped.map(({ jurisdiction: j, rows }) => (
        <div key={j.id} style={{ marginBottom: tokens.space.md }}>
          <div
            style={{
              fontSize: 11,
              color: tokens.color.textMuted,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              margin: '8px 0 6px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span>{j.name}</span>
            {!j.active && <Pill tone="neutral">Inactive</Pill>}
          </div>
          {rows.length === 0 ? (
            <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '0 0 8px 0' }}>
              No payment types under this jurisdiction yet.
            </p>
          ) : (
            <Table<PaymentType>
              columns={[
                {
                  key: 'order',
                  header: 'Order',
                  align: 'right',
                  render: (t) =>
                    editingId === t.id ? (
                      <CellInput
                        value={editOrder}
                        onChange={setEditOrder}
                        type="number"
                        width={70}
                      />
                    ) : (
                      <span
                        style={{
                          color: tokens.color.textMuted,
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {t.displayOrder}
                      </span>
                    ),
                },
                {
                  key: 'name',
                  header: 'Name',
                  render: (t) =>
                    editingId === t.id ? (
                      <CellInput value={editName} onChange={setEditName} />
                    ) : (
                      <span style={{ fontWeight: 500 }}>{t.name}</span>
                    ),
                },
                {
                  key: 'url',
                  header: 'Payment URL',
                  render: (t) =>
                    editingId === t.id ? (
                      <CellInput value={editUrl} onChange={setEditUrl} placeholder="https://…" />
                    ) : t.paymentUrl ? (
                      <a
                        href={t.paymentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: 12, color: tokens.color.accent }}
                      >
                        {t.paymentUrl}
                      </a>
                    ) : (
                      <span style={{ fontSize: 12, color: tokens.color.textMuted }}>—</span>
                    ),
                },
                {
                  key: 'active',
                  header: 'Active',
                  render: (t) =>
                    editingId === t.id ? (
                      <input
                        type="checkbox"
                        checked={editActive}
                        onChange={(e) => setEditActive(e.target.checked)}
                      />
                    ) : (
                      <Pill tone={t.active ? 'success' : 'neutral'}>
                        {t.active ? 'Active' : 'Off'}
                      </Pill>
                    ),
                },
                {
                  key: 'system',
                  header: 'Type',
                  render: (t) =>
                    t.isSystem ? <Pill tone="accent">System</Pill> : <Pill>Custom</Pill>,
                },
                {
                  key: 'actions',
                  header: '',
                  render: (t) => (
                    <div style={{ display: 'inline-flex', gap: 4 }}>
                      {editingId === t.id ? (
                        <>
                          <Button size="sm" onClick={() => void save(t.id)}>
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => beginEdit(t)}>
                            Edit
                          </Button>
                          {!t.isSystem && (
                            <Button size="sm" variant="ghost" onClick={() => void remove(t)}>
                              Delete
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  ),
                },
              ]}
              rows={rows}
              rowKey={(t) => t.id}
              empty=""
            />
          )}
        </div>
      ))}
    </Card>
  );
}

function CellInput({
  value,
  onChange,
  type = 'text',
  width,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: 'text' | 'number';
  width?: number;
  placeholder?: string;
}): JSX.Element {
  return (
    <input
      value={value}
      type={type}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: width ?? '100%',
        padding: '4px 6px',
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
        background: tokens.color.surface,
        color: tokens.color.text,
        fontSize: 13,
        fontFamily: tokens.font.body,
      }}
    />
  );
}
