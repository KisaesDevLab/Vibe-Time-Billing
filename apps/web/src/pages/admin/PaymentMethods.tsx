/* eslint-disable jsx-a11y/label-has-associated-control -- labels and controls are siblings inside grid containers; revisit with htmlFor/id pairs in a polish pass */
// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Admin → Catalog → Payment methods. Firm-editable list backing the
// dropdown on the Receive Payment form. The 4 system rows
// (CHECK / CASH / ACH_MANUAL / OTHER) ship seeded; the firm can rename
// or deactivate them but cannot delete them. Custom rows (Wire, Zelle,
// Bill.com, etc.) can be added freely and removed at will.

import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface PaymentMethodType {
  id: string;
  key: string;
  label: string;
  active: boolean;
  displayOrder: number;
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}

export function PaymentMethodsPage(): JSX.Element {
  const [items, setItems] = useState<PaymentMethodType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [newKey, setNewKey] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newOrder, setNewOrder] = useState('100');

  const [editLabel, setEditLabel] = useState('');
  const [editActive, setEditActive] = useState(true);
  const [editOrder, setEditOrder] = useState('100');

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: PaymentMethodType[] }>('/api/staff/admin/payment-method-types');
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function add(e: FormEvent): Promise<void> {
    e.preventDefault();
    const key = newKey.trim().toUpperCase().replace(/\s+/g, '_');
    if (!key) return;
    setError(null);
    setNotice(null);
    try {
      await api('/api/staff/admin/payment-method-types', {
        method: 'POST',
        body: JSON.stringify({
          key,
          label: newLabel.trim() || key,
          displayOrder: Number(newOrder) || 100,
        }),
      });
      setNewKey('');
      setNewLabel('');
      setNewOrder('100');
      setShowAdd(false);
      setNotice(`Added "${key}".`);
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'add_failed';
      setError(
        msg === 'duplicate_key'
          ? `A method with key "${key}" already exists.`
          : msg.includes('invalid_payload')
            ? 'Key must be UPPER_SNAKE_CASE (letters, digits, underscores; e.g. WIRE_TRANSFER).'
            : `Add failed: ${msg}`,
      );
    }
  }

  function beginEdit(m: PaymentMethodType): void {
    setEditingId(m.id);
    setEditLabel(m.label);
    setEditActive(m.active);
    setEditOrder(String(m.displayOrder));
    setError(null);
    setNotice(null);
  }

  async function saveEdit(id: string): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await api(`/api/staff/admin/payment-method-types/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          label: editLabel.trim() || undefined,
          active: editActive,
          displayOrder: Number(editOrder) || 100,
        }),
      });
      setEditingId(null);
      setNotice('Saved.');
      await load();
    } catch (err) {
      setError(`Save failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  async function remove(m: PaymentMethodType): Promise<void> {
    if (!window.confirm(`Delete payment method "${m.label}" (${m.key})?`)) return;
    setError(null);
    setNotice(null);
    try {
      await api(`/api/staff/admin/payment-method-types/${m.id}`, { method: 'DELETE' });
      setNotice(`Deleted "${m.label}".`);
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'delete_failed';
      setError(
        msg === 'system_row_undeletable'
          ? 'System rows can be renamed or deactivated, but not deleted.'
          : `Delete failed: ${msg}`,
      );
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900 }}>
      <Card
        title="Payment methods"
        action={
          <Button
            size="sm"
            variant={showAdd ? 'ghost' : 'secondary'}
            onClick={() => setShowAdd((v) => !v)}
          >
            {showAdd ? 'Cancel' : '+ Add method'}
          </Button>
        }
      >
        <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>
          Controls the dropdown on the <strong>Receive Payment</strong> form. Card (Stripe) and
          Credit application aren&apos;t shown here — those appear automatically when Stripe is
          wired or when the client has an open credit memo.
        </p>
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p style={{ color: tokens.color.success, fontSize: 12, marginBottom: 8 }}>{notice}</p>
        )}

        {showAdd && (
          <form
            onSubmit={add}
            style={{
              display: 'grid',
              gap: 10,
              padding: 12,
              marginBottom: 14,
              background: tokens.color.surface,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 120px', gap: 10 }}>
              <Input
                label="Key (UPPER_SNAKE)"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/\s+/g, '_'))}
                placeholder="WIRE_TRANSFER"
                required
              />
              <Input
                label="Display label"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Wire transfer"
                required
              />
              <Input
                type="number"
                label="Order"
                value={newOrder}
                onChange={(e) => setNewOrder(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button type="submit" size="sm" disabled={!newKey.trim() || !newLabel.trim()}>
                Add method
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setShowAdd(false)}>
                Cancel
              </Button>
            </div>
            <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: 0 }}>
              The <strong>key</strong> is the stable value stored on each payment row (e.g.
              <code> WIRE_TRANSFER</code>). The <strong>label</strong> is what the user sees in the
              dropdown. Lower display-order values sort first.
            </p>
          </form>
        )}

        <Table<PaymentMethodType>
          columns={[
            {
              key: 'order',
              header: 'Order',
              align: 'right',
              render: (m) =>
                editingId === m.id ? (
                  <input
                    type="number"
                    value={editOrder}
                    onChange={(e) => setEditOrder(e.target.value)}
                    style={{
                      width: 70,
                      padding: '4px 6px',
                      border: `1px solid ${tokens.color.border}`,
                      borderRadius: tokens.radius.sm,
                      background: tokens.color.surface,
                      color: tokens.color.text,
                      fontSize: 13,
                    }}
                  />
                ) : (
                  <span
                    style={{ color: tokens.color.textMuted, fontVariantNumeric: 'tabular-nums' }}
                  >
                    {m.displayOrder}
                  </span>
                ),
            },
            {
              key: 'key',
              header: 'Key',
              render: (m) => (
                <code style={{ fontSize: 12, color: tokens.color.textMuted }}>{m.key}</code>
              ),
            },
            {
              key: 'label',
              header: 'Label',
              render: (m) =>
                editingId === m.id ? (
                  <input
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '4px 6px',
                      border: `1px solid ${tokens.color.border}`,
                      borderRadius: tokens.radius.sm,
                      background: tokens.color.surface,
                      color: tokens.color.text,
                      fontSize: 13,
                    }}
                  />
                ) : (
                  <span style={{ fontWeight: 500 }}>{m.label}</span>
                ),
            },
            {
              key: 'active',
              header: 'Active',
              render: (m) =>
                editingId === m.id ? (
                  <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={editActive}
                      onChange={(e) => setEditActive(e.target.checked)}
                    />
                  </label>
                ) : (
                  <Pill tone={m.active ? 'success' : 'neutral'}>{m.active ? 'Active' : 'Off'}</Pill>
                ),
            },
            {
              key: 'system',
              header: 'Type',
              render: (m) => (m.isSystem ? <Pill tone="accent">System</Pill> : <Pill>Custom</Pill>),
            },
            {
              key: 'actions',
              header: '',
              render: (m) => (
                <div style={{ display: 'inline-flex', gap: 4 }}>
                  {editingId === m.id ? (
                    <>
                      <Button size="sm" onClick={() => void saveEdit(m.id)}>
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => beginEdit(m)}>
                        Edit
                      </Button>
                      {!m.isSystem && (
                        <Button size="sm" variant="ghost" onClick={() => void remove(m)}>
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
          rowKey={(m) => m.id}
          empty="No payment methods configured. Click + Add method to start."
        />
      </Card>
    </div>
  );
}
