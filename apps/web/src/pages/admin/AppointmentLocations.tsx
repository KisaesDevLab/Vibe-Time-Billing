// SPDX-License-Identifier: Elastic-2.0
//
// 0144 — Appointment Locations admin. The firm-managed list of reusable
// appointment locations (name + meeting type + detail). Selectable on the
// booking form (in addition to typing a one-off location) and attachable to
// a staff availability window. A location in use can't be hard-deleted —
// only deactivated (server returns 409 `location_in_use`).

import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

type LocationType = 'VIDEO' | 'PHONE' | 'IN_PERSON';

interface LocationOption {
  id: string;
  name: string;
  locationType: LocationType;
  detail: string | null;
  isActive: boolean;
  sortOrder: number;
}

const LOCATION_LABELS: Record<LocationType, string> = {
  IN_PERSON: 'In-person',
  PHONE: 'Phone',
  VIDEO: 'Video',
};

const DETAIL_PLACEHOLDER: Record<LocationType, string> = {
  IN_PERSON: 'Street address',
  PHONE: 'Phone number',
  VIDEO: 'Meeting link (Zoom/Teams/Meet)',
};

export function AppointmentLocationsPage(): JSX.Element {
  const [items, setItems] = useState<LocationOption[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<LocationType>('IN_PERSON');
  const [newDetail, setNewDetail] = useState('');
  const [editing, setEditing] = useState<Record<string, Partial<LocationOption>>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: LocationOption[] }>('/api/staff/admin/appointment-locations');
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
      await api('/api/staff/admin/appointment-locations', {
        method: 'POST',
        body: JSON.stringify({
          name: newName.trim(),
          locationType: newType,
          detail: newDetail.trim() || null,
        }),
      });
      setNewName('');
      setNewDetail('');
      await load();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'create_failed');
    } finally {
      setCreating(false);
    }
  }

  function patch(id: string, change: Partial<LocationOption>): void {
    setEditing((prev) => ({ ...prev, [id]: { ...prev[id], ...change } }));
  }
  function dirty(id: string): boolean {
    return Boolean(editing[id] && Object.keys(editing[id]!).length > 0);
  }
  function effective(row: LocationOption): LocationOption {
    return { ...row, ...editing[row.id] };
  }

  async function save(id: string): Promise<void> {
    const body = editing[id];
    if (!body) return;
    setErr(null);
    setSavingId(id);
    try {
      await api(`/api/staff/admin/appointment-locations/${id}`, {
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

  async function move(index: number, dir: -1 | 1): Promise<void> {
    const target = index + dir;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    setItems(next); // optimistic
    setErr(null);
    try {
      await api('/api/staff/admin/appointment-locations/reorder', {
        method: 'POST',
        body: JSON.stringify({ order: next.map((r) => r.id) }),
      });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'reorder_failed');
      await load();
    }
  }

  async function remove(row: LocationOption): Promise<void> {
    if (
      !confirm(
        `Delete "${row.name}"? If it's used by an appointment or availability window this will fail — deactivate instead.`,
      )
    )
      return;
    setErr(null);
    try {
      await api(`/api/staff/admin/appointment-locations/${row.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'delete_failed';
      if (/location_in_use|409/.test(msg)) {
        setErr('This location is in use — deactivate it instead of deleting.');
      } else {
        setErr(msg);
      }
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1000 }}>
      <Card title="Add location">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0, marginBottom: 12 }}>
          Reusable locations appear as a dropdown on the booking form (staff can still type a
          one-off location), and can be attached to a staff availability window so bookings default
          to them. Locations in use can be deactivated but not deleted.
        </p>
        <form
          onSubmit={create}
          style={{
            display: 'grid',
            gridTemplateColumns: '1.4fr 130px 2fr auto',
            gap: 12,
            alignItems: 'end',
          }}
        >
          <Input
            label="Name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Main Office"
            required
          />
          <label style={{ display: 'grid', gap: 4, fontSize: 12, color: tokens.color.textMuted }}>
            Type
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value as LocationType)}
              style={selectStyle}
            >
              <option value="IN_PERSON">In-person</option>
              <option value="PHONE">Phone</option>
              <option value="VIDEO">Video</option>
            </select>
          </label>
          <Input
            label="Detail"
            value={newDetail}
            onChange={(e) => setNewDetail(e.target.value)}
            placeholder={DETAIL_PLACEHOLDER[newType]}
          />
          <Button type="submit" disabled={creating || !newName.trim()}>
            {creating ? 'Adding…' : 'Add'}
          </Button>
        </form>
        {err && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{err}</p>}
      </Card>

      <Card title={`Locations (${items.length})`}>
        <Table<LocationOption>
          columns={[
            {
              key: 'reorder',
              header: '',
              render: (r) => {
                const idx = items.findIndex((x) => x.id === r.id);
                return (
                  <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
                    <button
                      type="button"
                      aria-label="Move up"
                      disabled={idx <= 0}
                      onClick={() => void move(idx, -1)}
                      style={reorderBtnStyle}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label="Move down"
                      disabled={idx >= items.length - 1}
                      onClick={() => void move(idx, 1)}
                      style={reorderBtnStyle}
                    >
                      ↓
                    </button>
                  </div>
                );
              },
            },
            {
              key: 'name',
              header: 'Name',
              render: (r) => {
                const e = effective(r);
                return (
                  <Input value={e.name} onChange={(ev) => patch(r.id, { name: ev.target.value })} />
                );
              },
            },
            {
              key: 'type',
              header: 'Type',
              render: (r) => {
                const e = effective(r);
                return (
                  <select
                    value={e.locationType}
                    onChange={(ev) =>
                      patch(r.id, { locationType: ev.target.value as LocationType })
                    }
                    style={selectStyle}
                  >
                    {(Object.keys(LOCATION_LABELS) as LocationType[]).map((k) => (
                      <option key={k} value={k}>
                        {LOCATION_LABELS[k]}
                      </option>
                    ))}
                  </select>
                );
              },
            },
            {
              key: 'detail',
              header: 'Detail',
              render: (r) => {
                const e = effective(r);
                return (
                  <Input
                    value={e.detail ?? ''}
                    placeholder={DETAIL_PLACEHOLDER[e.locationType]}
                    onChange={(ev) => patch(r.id, { detail: ev.target.value })}
                    style={{ minWidth: 220 }}
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
                      checked={e.isActive}
                      onChange={(ev) => patch(r.id, { isActive: ev.target.checked })}
                    />
                    {!e.isActive && <Pill tone="neutral">inactive</Pill>}
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
                  <Button size="sm" variant="danger" onClick={() => void remove(r)}>
                    Delete
                  </Button>
                </div>
              ),
            },
          ]}
          rows={items}
          rowKey={(r) => r.id}
          empty="No locations yet — add one above."
        />
      </Card>
    </div>
  );
}

const reorderBtnStyle: React.CSSProperties = {
  width: 22,
  height: 18,
  lineHeight: '14px',
  padding: 0,
  fontSize: 11,
  borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.surface,
  color: tokens.color.text,
  cursor: 'pointer',
};

const selectStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.surface,
  color: tokens.color.text,
  fontSize: 13,
};
