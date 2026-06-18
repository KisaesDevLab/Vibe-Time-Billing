// SPDX-License-Identifier: Elastic-2.0
//
// 0168 — staff-side management of public booking pages. List of pages
// (with copyable public URL), plus a master-detail create/edit form that
// edits the page settings, its weekly availability windows, the approver
// list, and the per-staff notify list. Backs onto
// /api/staff/appointments/booking-links (CRUD).

import { useEffect, useState } from 'react';

import { Button, Card, Combobox, Input, MultiCombobox, Pill, Table, tokens } from '@vibe/ui';
import type { ComboboxOption } from '@vibe/ui';

import { api } from '../../api-client';

interface LinkListRow {
  id: string;
  slug: string;
  staffId: string;
  staffName: string;
  isActive: boolean;
  createdAt: string;
  publicUrl: string;
}

interface BookableStaff {
  id: string;
  name: string;
}

interface ApptType {
  id: string;
  name: string;
}

type NotifyChannel = 'EMAIL' | 'SMS';

type LocationType = 'IN_PERSON' | 'PHONE' | 'VIDEO';

const LOCATION_TYPES: LocationType[] = ['IN_PERSON', 'PHONE', 'VIDEO'];
const LOCATION_LABELS: Record<LocationType, string> = {
  IN_PERSON: 'In-person',
  PHONE: 'Phone',
  VIDEO: 'Video',
};

interface WindowRow {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  locationTypes: LocationType[]; // empty = all contact types allowed
}

interface NotifyRow {
  appUserId: string;
  channels: NotifyChannel[];
}

// The detail GET returns the full link DB row plus its children.
interface LinkDetail {
  link: {
    id: string;
    slug: string;
    staffId: string;
    isActive: boolean;
    allowedAppointmentTypeIds: string[] | null;
    customMessage: string | null;
    holdExpiryHours: number;
    slotIncrementMinutes: number;
    minNoticeHours: number;
    bufferBeforeMinutes: number;
    bufferAfterMinutes: number;
    defaultDurationMinutes: number;
    requireCaptcha: boolean;
    dailyCap: number | null;
  };
  publicUrl: string;
  windows: {
    id: string;
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    locationOptionId: string | null;
    locationTypes: string[] | null;
    appointmentTypeIds: string[] | null;
    isActive: boolean;
  }[];
  approverIds: string[];
  notify: { appUserId: string; channels: NotifyChannel[] }[];
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_OPTIONS: ComboboxOption[] = DAY_NAMES.map((label, i) => ({ value: String(i), label }));

// HH:MM:SS (from Postgres `time`) → HH:MM for the <input type="time">.
function hhmm(t: string): string {
  return t.length >= 5 ? t.slice(0, 5) : t;
}

interface FormState {
  staffId: string;
  slug: string;
  customMessage: string;
  allowedAppointmentTypeIds: string[];
  defaultDurationMinutes: number;
  slotIncrementMinutes: number;
  minNoticeHours: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  holdExpiryHours: number;
  requireCaptcha: boolean;
  dailyCap: string; // empty = no cap
  isActive: boolean;
  windows: WindowRow[];
  approverIds: string[];
  notify: NotifyRow[];
}

function emptyForm(): FormState {
  return {
    staffId: '',
    slug: '',
    customMessage: '',
    allowedAppointmentTypeIds: [],
    defaultDurationMinutes: 30,
    slotIncrementMinutes: 30,
    minNoticeHours: 1,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    holdExpiryHours: 72,
    requireCaptcha: true,
    dailyCap: '',
    isActive: true,
    windows: [],
    approverIds: [],
    notify: [],
  };
}

export function BookingPagesPage({
  scopeStaffId,
}: {
  // When set, the screen manages only this staff member's own pages (their
  // booking page is for their own calendar) — no cross-staff picker/listing.
  scopeStaffId?: string;
} = {}): JSX.Element {
  const [items, setItems] = useState<LinkListRow[]>([]);
  const [staff, setStaff] = useState<BookableStaff[]>([]);
  const [types, setTypes] = useState<ApptType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // editId: null = list; '' = creating; uuid = editing.
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const r = await api<{ items: LinkListRow[] }>('/api/staff/appointments/booking-links');
      setItems(r.items ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    void api<{ items: BookableStaff[] }>('/api/staff/appointments/bookable-staff')
      .then((r) => setStaff(r.items ?? []))
      .catch(() => undefined);
    void api<{ items: ApptType[] }>('/api/staff/appointments/appointment-types')
      .then((r) => setTypes(r.items ?? []))
      .catch(() => undefined);
  }, []);

  function staffName(id: string): string {
    return staff.find((s) => s.id === id)?.name ?? id;
  }

  async function copyUrl(url: string, id: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    } catch {
      // Clipboard may be unavailable (insecure context); ignore.
    }
  }

  function startCreate(): void {
    const f = emptyForm();
    if (scopeStaffId) f.staffId = scopeStaffId;
    setForm(f);
    setEditId('');
    setError(null);
  }

  async function startEdit(id: string): Promise<void> {
    setError(null);
    try {
      const d = await api<LinkDetail>(`/api/staff/appointments/booking-links/${id}`);
      setForm({
        staffId: d.link.staffId,
        slug: d.link.slug,
        customMessage: d.link.customMessage ?? '',
        allowedAppointmentTypeIds: d.link.allowedAppointmentTypeIds ?? [],
        defaultDurationMinutes: d.link.defaultDurationMinutes,
        slotIncrementMinutes: d.link.slotIncrementMinutes,
        minNoticeHours: d.link.minNoticeHours,
        bufferBeforeMinutes: d.link.bufferBeforeMinutes,
        bufferAfterMinutes: d.link.bufferAfterMinutes,
        holdExpiryHours: d.link.holdExpiryHours,
        requireCaptcha: d.link.requireCaptcha,
        dailyCap: d.link.dailyCap == null ? '' : String(d.link.dailyCap),
        isActive: d.link.isActive,
        windows: d.windows.map((w) => ({
          dayOfWeek: w.dayOfWeek,
          startTime: hhmm(w.startTime),
          endTime: hhmm(w.endTime),
          locationTypes: (w.locationTypes ?? []).filter((t): t is LocationType =>
            (LOCATION_TYPES as string[]).includes(t),
          ),
        })),
        approverIds: d.approverIds,
        notify: d.notify.map((n) => ({ appUserId: n.appUserId, channels: n.channels })),
      });
      setEditId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function remove(id: string): Promise<void> {
    if (!confirm('Delete this booking page? Its public URL will stop working.')) return;
    setError(null);
    try {
      await api(`/api/staff/appointments/booking-links/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  if (editId !== null && form) {
    return (
      <BookingPageForm
        form={form}
        setForm={setForm}
        isNew={editId === ''}
        editId={editId}
        staff={staff}
        types={types}
        lockStaff={Boolean(scopeStaffId)}
        onCancel={() => {
          setEditId(null);
          setForm(null);
        }}
        onSaved={() => {
          setEditId(null);
          setForm(null);
          void load();
        }}
      />
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card
        title="Public booking pages"
        action={<Button onClick={startCreate}>New booking page</Button>}
      >
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          Each page exposes a public URL where visitors can request a time. A request becomes an
          appointment only after a staff approver confirms it from the Booking requests inbox.
        </p>
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12 }} role="alert">
            {error}
          </p>
        )}
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table<LinkListRow>
            columns={[
              { key: 'staff', header: 'Staff', render: (r) => r.staffName || staffName(r.staffId) },
              {
                key: 'url',
                header: 'Public URL',
                render: (r) => (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <code style={{ fontSize: 11 }}>{r.publicUrl}</code>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void copyUrl(r.publicUrl, r.id)}
                    >
                      {copied === r.id ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                ),
              },
              {
                key: 'active',
                header: 'Status',
                render: (r) =>
                  r.isActive ? (
                    <Pill tone="success">active</Pill>
                  ) : (
                    <Pill tone="neutral">inactive</Pill>
                  ),
              },
              {
                key: 'actions',
                header: '',
                render: (r) => (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Button size="sm" variant="secondary" onClick={() => void startEdit(r.id)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => void remove(r.id)}>
                      Delete
                    </Button>
                  </div>
                ),
              },
            ]}
            rows={scopeStaffId ? items.filter((i) => i.staffId === scopeStaffId) : items}
            rowKey={(r) => r.id}
            empty="No booking page yet — create one to share a public link."
          />
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- form

function fieldLabel(text: string): JSX.Element {
  return <span style={{ fontSize: 12, color: tokens.color.textMuted }}>{text}</span>;
}

function BookingPageForm({
  form,
  setForm,
  isNew,
  editId,
  staff,
  types,
  lockStaff,
  onCancel,
  onSaved,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState | null>>;
  isNew: boolean;
  editId: string;
  staff: BookableStaff[];
  types: ApptType[];
  lockStaff: boolean;
  onCancel: () => void;
  onSaved: (result?: { id: string; publicUrl: string }) => void;
}): JSX.Element {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const staffOptions: ComboboxOption[] = staff.map((s) => ({ value: s.id, label: s.name }));
  const typeOptions: ComboboxOption[] = types.map((t) => ({ value: t.id, label: t.name }));
  const notifyEligible = staff.filter((s) => !form.notify.some((n) => n.appUserId === s.id));

  // Strongly-typed patch helper so we never reach for `any`.
  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  function numField(value: number, onChange: (n: number) => void, min = 0): JSX.Element {
    return (
      <Input
        type="number"
        min={min}
        value={String(value)}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    );
  }

  function addWindow(): void {
    set('windows', [
      ...form.windows,
      { dayOfWeek: 1, startTime: '09:00', endTime: '17:00', locationTypes: [] },
    ]);
  }
  function updateWindow(idx: number, patch: Partial<WindowRow>): void {
    set(
      'windows',
      form.windows.map((w, i) => (i === idx ? { ...w, ...patch } : w)),
    );
  }
  function removeWindow(idx: number): void {
    set(
      'windows',
      form.windows.filter((_, i) => i !== idx),
    );
  }
  function toggleWindowLocationType(idx: number, type: LocationType): void {
    set(
      'windows',
      form.windows.map((w, i) => {
        if (i !== idx) return w;
        const has = w.locationTypes.includes(type);
        const locationTypes = has
          ? w.locationTypes.filter((t) => t !== type)
          : [...w.locationTypes, type];
        return { ...w, locationTypes };
      }),
    );
  }

  function addNotify(appUserId: string): void {
    if (!appUserId || form.notify.some((n) => n.appUserId === appUserId)) return;
    set('notify', [...form.notify, { appUserId, channels: ['EMAIL'] }]);
  }
  function toggleNotifyChannel(idx: number, channel: NotifyChannel): void {
    set(
      'notify',
      form.notify.map((n, i) => {
        if (i !== idx) return n;
        const has = n.channels.includes(channel);
        const channels = has ? n.channels.filter((c) => c !== channel) : [...n.channels, channel];
        return { ...n, channels };
      }),
    );
  }
  function removeNotify(idx: number): void {
    set(
      'notify',
      form.notify.filter((_, i) => i !== idx),
    );
  }

  async function save(): Promise<void> {
    if (!form.staffId) {
      setError('Pick a staff member for this page.');
      return;
    }
    setSaving(true);
    setError(null);
    const body = {
      staffId: form.staffId,
      slug: form.slug.trim() || undefined,
      customMessage: form.customMessage.trim() || null,
      allowedAppointmentTypeIds:
        form.allowedAppointmentTypeIds.length > 0 ? form.allowedAppointmentTypeIds : null,
      holdExpiryHours: form.holdExpiryHours,
      slotIncrementMinutes: form.slotIncrementMinutes,
      minNoticeHours: form.minNoticeHours,
      bufferBeforeMinutes: form.bufferBeforeMinutes,
      bufferAfterMinutes: form.bufferAfterMinutes,
      defaultDurationMinutes: form.defaultDurationMinutes,
      requireCaptcha: form.requireCaptcha,
      dailyCap: form.dailyCap.trim() === '' ? null : Number(form.dailyCap),
      isActive: form.isActive,
      windows: form.windows.map((w) => ({
        dayOfWeek: w.dayOfWeek,
        startTime: w.startTime,
        endTime: w.endTime,
        // empty selection = all contact types allowed → null
        locationTypes: w.locationTypes.length > 0 ? w.locationTypes : null,
      })),
      approverIds: form.approverIds,
      notify: form.notify.map((n) => ({ appUserId: n.appUserId, channels: n.channels })),
    };
    try {
      if (isNew) {
        const r = await api<{ id: string; slug: string; publicUrl: string }>(
          '/api/staff/appointments/booking-links',
          { method: 'POST', body: JSON.stringify(body) },
        );
        onSaved({ id: r.id, publicUrl: r.publicUrl });
      } else {
        await api(`/api/staff/appointments/booking-links/${editId}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        onSaved();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'failed';
      setError(msg === 'slug_unavailable' ? 'That custom slug is already taken.' : msg);
    } finally {
      setSaving(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    padding: '8px 10px',
    background: tokens.color.surface,
    color: tokens.color.text,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.md,
  };

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title={isNew ? 'New booking page' : 'Edit booking page'}>
        <div style={{ marginBottom: 12 }}>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            ← Back to booking pages
          </Button>
        </div>
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12 }} role="alert">
            {error}
          </p>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 12,
          }}
        >
          {!lockStaff && (
            <label style={{ display: 'grid', gap: 4 }}>
              {fieldLabel('Staff member')}
              <Combobox
                ariaLabel="Staff member"
                value={form.staffId}
                onChange={(v) => set('staffId', v)}
                options={staffOptions}
                placeholder="— pick staff —"
              />
            </label>
          )}
          <label style={{ display: 'grid', gap: 4 }}>
            {fieldLabel('Custom slug (optional)')}
            <input
              value={form.slug}
              onChange={(e) => set('slug', e.target.value)}
              placeholder="auto-generated if blank"
              style={inputStyle}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            {fieldLabel('Allowed appointment types')}
            <MultiCombobox
              ariaLabel="Allowed appointment types"
              selected={form.allowedAppointmentTypeIds}
              onChange={(v) => set('allowedAppointmentTypeIds', v)}
              options={typeOptions}
              placeholder="All types"
            />
          </label>
        </div>

        <label style={{ display: 'grid', gap: 4, marginTop: 12 }}>
          {fieldLabel('Custom message (shown on the public page)')}
          <textarea
            value={form.customMessage}
            onChange={(e) => set('customMessage', e.target.value)}
            rows={3}
            style={{ ...inputStyle, fontFamily: tokens.font.body, fontSize: 13 }}
          />
        </label>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
            gap: 12,
            marginTop: 12,
          }}
        >
          <label style={{ display: 'grid', gap: 4 }}>
            {fieldLabel('Default duration (min)')}
            {numField(form.defaultDurationMinutes, (n) => set('defaultDurationMinutes', n), 5)}
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            {fieldLabel('Slot increment (min)')}
            {numField(form.slotIncrementMinutes, (n) => set('slotIncrementMinutes', n), 5)}
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            {fieldLabel('Minimum notice (hours)')}
            {numField(form.minNoticeHours, (n) => set('minNoticeHours', n))}
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            {fieldLabel('Buffer before (min)')}
            {numField(form.bufferBeforeMinutes, (n) => set('bufferBeforeMinutes', n))}
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            {fieldLabel('Buffer after (min)')}
            {numField(form.bufferAfterMinutes, (n) => set('bufferAfterMinutes', n))}
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            {fieldLabel('Hold expiry (hours)')}
            {numField(form.holdExpiryHours, (n) => set('holdExpiryHours', n), 1)}
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            {fieldLabel('Daily cap (optional)')}
            <Input
              type="number"
              min={1}
              value={form.dailyCap}
              placeholder="no cap"
              onChange={(e) => set('dailyCap', e.target.value)}
            />
          </label>
        </div>

        <div style={{ display: 'flex', gap: 18, marginTop: 12, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={form.requireCaptcha}
              onChange={(e) => set('requireCaptcha', e.target.checked)}
            />
            Require captcha
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => set('isActive', e.target.checked)}
            />
            Active
          </label>
        </div>
      </Card>

      <Card title="Availability windows">
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          The weekly hours during which visitors can request times on this page.
        </p>
        <div style={{ display: 'grid', gap: 8 }}>
          {form.windows.map((w, idx) => (
            <div
              key={idx}
              style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
            >
              <div style={{ minWidth: 140 }}>
                <Combobox
                  ariaLabel="Day of week"
                  value={String(w.dayOfWeek)}
                  onChange={(v) => updateWindow(idx, { dayOfWeek: Number(v) })}
                  options={DAY_OPTIONS}
                />
              </div>
              <input
                type="time"
                value={w.startTime}
                onChange={(e) => updateWindow(idx, { startTime: e.target.value })}
                style={inputStyle}
                aria-label="Start time"
              />
              <span style={{ color: tokens.color.textMuted }}>–</span>
              <input
                type="time"
                value={w.endTime}
                onChange={(e) => updateWindow(idx, { endTime: e.target.value })}
                style={inputStyle}
                aria-label="End time"
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                  Contact types{w.locationTypes.length === 0 ? ' (Any):' : ':'}
                </span>
                {LOCATION_TYPES.map((type) => {
                  const checked = w.locationTypes.includes(type);
                  return (
                    <label
                      key={type}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        fontSize: 12,
                        padding: '4px 8px',
                        borderRadius: tokens.radius.sm,
                        border: `1px solid ${checked ? tokens.color.accent : tokens.color.border}`,
                        background: checked ? tokens.color.accentMuted : tokens.color.surface,
                        color: tokens.color.text,
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleWindowLocationType(idx, type)}
                      />
                      {LOCATION_LABELS[type]}
                    </label>
                  );
                })}
              </div>
              <Button size="sm" variant="ghost" onClick={() => removeWindow(idx)}>
                Remove
              </Button>
            </div>
          ))}
          {form.windows.length === 0 && (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No windows yet.</p>
          )}
        </div>
        <div style={{ marginTop: 10 }}>
          <Button size="sm" variant="secondary" onClick={addWindow}>
            Add window
          </Button>
        </div>
      </Card>

      <Card title="Approvers">
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          Staff who may approve or decline requests for this page. If none are set, the page&rsquo;s
          staff member may decide.
        </p>
        <MultiCombobox
          ariaLabel="Approvers"
          selected={form.approverIds}
          onChange={(v) => set('approverIds', v)}
          options={staffOptions}
          placeholder="— select approvers —"
        />
      </Card>

      <Card title="Notify on new request">
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          Staff emailed or texted when a new request comes in.
        </p>
        <div style={{ display: 'grid', gap: 8 }}>
          {form.notify.map((n, idx) => (
            <div
              key={n.appUserId}
              style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}
            >
              <span style={{ minWidth: 160, fontSize: 13 }}>
                {staff.find((s) => s.id === n.appUserId)?.name ?? n.appUserId}
              </span>
              {(['EMAIL', 'SMS'] as const).map((ch) => (
                <label
                  key={ch}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}
                >
                  <input
                    type="checkbox"
                    checked={n.channels.includes(ch)}
                    onChange={() => toggleNotifyChannel(idx, ch)}
                  />
                  {ch}
                </label>
              ))}
              <Button size="sm" variant="ghost" onClick={() => removeNotify(idx)}>
                Remove
              </Button>
            </div>
          ))}
          {form.notify.length === 0 && (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No one notified yet.</p>
          )}
        </div>
        <div style={{ marginTop: 10, maxWidth: 280 }}>
          <Combobox
            ariaLabel="Add staff to notify"
            value=""
            onChange={(v) => addNotify(v)}
            options={notifyEligible.map((s) => ({ value: s.id, label: s.name }))}
            placeholder="+ Add staff to notify"
          />
        </div>
      </Card>

      <div style={{ display: 'flex', gap: 8 }}>
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : isNew ? 'Create page' : 'Save changes'}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
