// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// BK-1 — Appointment Types admin. The firm-managed library of bookable
// meeting types (name + default duration + default location + color).
// Types with appointment history can't be hard-deleted — only
// deactivated (the server returns 409 `type_in_use`).

import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { ReminderScheduleEditor, type ReminderStep } from '../../components/ReminderScheduleEditor';

type LocationType = 'VIDEO' | 'PHONE' | 'IN_PERSON';

interface AppointmentType {
  id: string;
  name: string;
  defaultDurationMinutes: number;
  defaultLocationType: LocationType;
  description: string | null;
  color: string | null;
  isActive: boolean;
  sortOrder: number;
  reminderSchedule: ReminderStep[] | null;
}

const LOCATION_LABELS: Record<LocationType, string> = {
  IN_PERSON: 'In-person',
  PHONE: 'Phone',
  VIDEO: 'Video',
};

const PRESET_COLORS = [
  '#2563eb',
  '#7c3aed',
  '#0891b2',
  '#16a34a',
  '#ca8a04',
  '#dc2626',
  '#db2777',
  '#475569',
];

export function AppointmentTypesPage(): JSX.Element {
  const [items, setItems] = useState<AppointmentType[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDuration, setNewDuration] = useState('30');
  const [newLocation, setNewLocation] = useState<LocationType>('VIDEO');
  const [newColor, setNewColor] = useState('#2563eb');
  const [editing, setEditing] = useState<Record<string, Partial<AppointmentType>>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: AppointmentType[] }>('/api/staff/admin/appointment-types');
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
      await api('/api/staff/admin/appointment-types', {
        method: 'POST',
        body: JSON.stringify({
          name: newName.trim(),
          defaultDurationMinutes: Number(newDuration) || 30,
          defaultLocationType: newLocation,
          color: newColor,
        }),
      });
      setNewName('');
      setNewDuration('30');
      setNewLocation('VIDEO');
      await load();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'create_failed');
    } finally {
      setCreating(false);
    }
  }

  async function seedDefaults(): Promise<void> {
    setErr(null);
    try {
      await api('/api/staff/admin/appointment-types/seed-defaults', { method: 'POST' });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'seed_failed');
    }
  }

  function patch(id: string, change: Partial<AppointmentType>): void {
    setEditing((prev) => ({ ...prev, [id]: { ...prev[id], ...change } }));
  }
  function dirty(id: string): boolean {
    return Boolean(editing[id] && Object.keys(editing[id]!).length > 0);
  }
  function effective(row: AppointmentType): AppointmentType {
    return { ...row, ...editing[row.id] };
  }

  async function save(id: string): Promise<void> {
    const body = editing[id];
    if (!body) return;
    setErr(null);
    setSavingId(id);
    try {
      await api(`/api/staff/admin/appointment-types/${id}`, {
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
      await api('/api/staff/admin/appointment-types/reorder', {
        method: 'POST',
        body: JSON.stringify({ order: next.map((r) => r.id) }),
      });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'reorder_failed');
      await load(); // revert to server truth
    }
  }

  async function remove(row: AppointmentType): Promise<void> {
    if (
      !confirm(
        `Delete "${row.name}"? If it has appointment history this will fail — deactivate instead.`,
      )
    )
      return;
    setErr(null);
    try {
      await api(`/api/staff/admin/appointment-types/${row.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'delete_failed';
      // Server returns 409 type_in_use — guide the operator to deactivate.
      if (/type_in_use|409/.test(msg)) {
        setErr('This type has appointment history — deactivate it instead of deleting.');
      } else {
        setErr(msg);
      }
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1000 }}>
      <Card title="Add appointment type">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0, marginBottom: 12 }}>
          Appointment types pre-fill the booking form&apos;s duration and location. The booker can
          still override duration per booking. Types with history can be deactivated but not
          deleted.
        </p>
        <form
          onSubmit={create}
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 110px 130px 90px auto',
            gap: 12,
            alignItems: 'end',
          }}
        >
          <Input
            label="Name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Initial Consultation"
            required
          />
          <Input
            label="Duration (min)"
            type="number"
            value={newDuration}
            onChange={(e) => setNewDuration(e.target.value)}
          />
          <label style={{ display: 'grid', gap: 4, fontSize: 12, color: tokens.color.textMuted }}>
            Location
            <select
              value={newLocation}
              onChange={(e) => setNewLocation(e.target.value as LocationType)}
              style={selectStyle}
            >
              <option value="IN_PERSON">In-person</option>
              <option value="PHONE">Phone</option>
              <option value="VIDEO">Video</option>
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 12, color: tokens.color.textMuted }}>
            Color
            <input
              type="color"
              value={newColor}
              onChange={(e) => setNewColor(e.target.value)}
              style={{ width: 48, height: 34, padding: 0, border: 'none', background: 'none' }}
            />
          </label>
          <Button type="submit" disabled={creating || !newName.trim()}>
            {creating ? 'Adding…' : 'Add'}
          </Button>
        </form>
        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Use color ${c}`}
              onClick={() => setNewColor(c)}
              style={{
                width: 18,
                height: 18,
                borderRadius: 4,
                background: c,
                border: newColor === c ? `2px solid ${tokens.color.text}` : '1px solid transparent',
                cursor: 'pointer',
              }}
            />
          ))}
        </div>
        {err && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{err}</p>}
      </Card>

      <Card title={`Appointment types (${items.length})`}>
        {items.length === 0 && (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
            No types yet.{' '}
            <Button size="sm" variant="secondary" onClick={() => void seedDefaults()}>
              Add default types
            </Button>
          </p>
        )}
        <Table<AppointmentType>
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
              key: 'color',
              header: '',
              render: (r) => {
                const e = effective(r);
                return (
                  <input
                    type="color"
                    value={e.color ?? '#2563eb'}
                    onChange={(ev) => patch(r.id, { color: ev.target.value })}
                    style={{
                      width: 28,
                      height: 28,
                      padding: 0,
                      border: 'none',
                      background: 'none',
                    }}
                    aria-label="Type color"
                  />
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
              key: 'duration',
              header: 'Duration',
              align: 'right',
              render: (r) => {
                const e = effective(r);
                return (
                  <Input
                    type="number"
                    value={String(e.defaultDurationMinutes)}
                    onChange={(ev) =>
                      patch(r.id, { defaultDurationMinutes: Number(ev.target.value) || 0 })
                    }
                    style={{ width: 80 }}
                  />
                );
              },
            },
            {
              key: 'location',
              header: 'Location',
              render: (r) => {
                const e = effective(r);
                return (
                  <select
                    value={e.defaultLocationType}
                    onChange={(ev) =>
                      patch(r.id, { defaultLocationType: ev.target.value as LocationType })
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
              key: 'description',
              header: 'Description',
              render: (r) => {
                const e = effective(r);
                return (
                  <Input
                    value={e.description ?? ''}
                    placeholder="Shown to staff on the booking form"
                    onChange={(ev) => patch(r.id, { description: ev.target.value })}
                    style={{ minWidth: 180 }}
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
              key: 'reminders',
              header: 'Reminders',
              render: (r) => {
                const n = (effective(r).reminderSchedule ?? []).length;
                return (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setExpandedId((id) => (id === r.id ? null : r.id))}
                  >
                    {n > 0 ? `Reminders (${n})` : 'Set reminders'}
                  </Button>
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
          empty="No appointment types yet."
        />
        {expandedId &&
          (() => {
            const row = items.find((r) => r.id === expandedId);
            if (!row) return null;
            const eff = effective(row);
            return (
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.md,
                  background: tokens.color.bg,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                  Default reminders — {eff.name}
                </div>
                <ReminderScheduleEditor
                  value={eff.reminderSchedule ?? []}
                  onChange={(next) => patch(row.id, { reminderSchedule: next })}
                  helpText="bookings of this type fall back to the firm default"
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <Button
                    size="sm"
                    onClick={() => void save(row.id)}
                    disabled={!dirty(row.id) || savingId === row.id}
                  >
                    {savingId === row.id ? 'Saving…' : 'Save reminders'}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setExpandedId(null)}>
                    Close
                  </Button>
                </div>
              </div>
            );
          })()}
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
