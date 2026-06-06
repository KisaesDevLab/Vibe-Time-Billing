// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// BK-3 / BK-7 — the tabbed Appointments surface: a 4-step multi-staff
// booking wizard, the appointments list with a detail drawer, the
// reschedule inbox, and per-staff availability. Hash-routed tabs.

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { Button, Card, Combobox, Input, Pill, Table, Tabs, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { useAuth } from '../auth-context';
import { BookingSettingsEditor } from './BookingSettingsEditor';

type LocationType = 'VIDEO' | 'PHONE' | 'IN_PERSON';
const LOC_LABEL: Record<LocationType, string> = {
  IN_PERSON: 'In-person',
  PHONE: 'Phone',
  VIDEO: 'Video',
};

interface BookableStaff {
  id: string;
  name: string;
  bookingEnabled: boolean;
  hasConnection: boolean;
  provider?: string | null;
}

function providerLabel(provider: string | null | undefined): string {
  if (provider === 'microsoft') return 'M365';
  if (provider === 'google') return 'Google';
  return 'Calendar';
}
interface ApptType {
  id: string;
  name: string;
  defaultDurationMinutes: number;
  defaultLocationType: LocationType;
  color: string | null;
}
interface Slot {
  start: string;
  end: string;
  durationMinutes: number;
  available: boolean;
  staffAvailability: { staffId: string; free: boolean }[];
}
interface ApptRow {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';
  location: LocationType;
  locationDetail: string | null;
}
interface ApptListRow {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';
  location: LocationType;
  clientId: string | null;
  clientName: string | null;
  engagementId: string | null;
  engagementName: string | null;
  typeName: string | null;
  typeColor: string | null;
  staff: { id: string; name: string }[];
  hasPendingReschedule: boolean;
}

/** A small green (free) / red (busy) availability dot. */
function Pip({ free }: { free: boolean }): JSX.Element {
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: free ? tokens.color.success : tokens.color.danger,
        display: 'inline-block',
      }}
    />
  );
}

const AVATAR_COLORS = ['#2563eb', '#7c3aed', '#0891b2', '#16a34a', '#ca8a04', '#db2777', '#475569'];
function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

/** Overlapping circular avatars; +N reveals the rest on click. */
function StaffAvatarStack({ staff }: { staff: { id: string; name: string }[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  if (staff.length === 0)
    return <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>—</span>;
  const MAX = 3;
  const shown = staff.slice(0, MAX);
  const extra = staff.length - shown.length;
  const dot = (s: { id: string; name: string }, i: number): JSX.Element => (
    <span
      key={s.id}
      title={s.name}
      style={{
        width: 26,
        height: 26,
        borderRadius: '50%',
        background: avatarColor(s.id),
        color: '#fff',
        fontSize: 11,
        fontWeight: 600,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: `2px solid ${tokens.color.surface}`,
        marginLeft: i === 0 ? 0 : -8,
      }}
    >
      {initials(s.name)}
    </span>
  );
  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      {shown.map(dot)}
      {extra > 0 && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={{
            width: 26,
            height: 26,
            borderRadius: '50%',
            background: tokens.color.border,
            color: tokens.color.text,
            fontSize: 11,
            fontWeight: 600,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: `2px solid ${tokens.color.surface}`,
            marginLeft: -8,
            cursor: 'pointer',
          }}
          aria-label={`${extra} more staff`}
        >
          +{extra}
        </button>
      )}
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 30,
            left: 0,
            zIndex: 20,
            background: tokens.color.surface,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            padding: 8,
            minWidth: 160,
            boxShadow: '0 6px 20px rgba(0,0,0,0.12)',
          }}
        >
          {staff.map((s) => (
            <div key={s.id} style={{ fontSize: 12, padding: '2px 0' }}>
              {s.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const TABS = ['list', 'book', 'inbox', 'availability'] as const;
type TabKey = (typeof TABS)[number];

function hashTab(): TabKey {
  const h = (window.location.hash || '').replace('#', '');
  return (TABS as readonly string[]).includes(h) ? (h as TabKey) : 'list';
}

export function AppointmentsPage(): JSX.Element {
  const [tab, setTab] = useState<TabKey>(hashTab());
  const [inboxCount, setInboxCount] = useState(0);

  useEffect(() => {
    const onHash = (): void => setTab(hashTab());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    let alive = true;
    const poll = (): void => {
      void api<{ count: number }>('/api/staff/appointments/reschedule-requests/count')
        .then((r) => alive && setInboxCount(r.count))
        .catch(() => undefined);
    };
    poll();
    const t = setInterval(poll, 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [tab]);

  function go(k: TabKey): void {
    window.location.hash = k;
    setTab(k);
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Appointments</h1>
        <Button onClick={() => go('book')}>Book appointment</Button>
      </div>
      <Tabs
        tabs={[
          { key: 'list', label: 'Appointments' },
          { key: 'book', label: 'Book' },
          {
            key: 'inbox',
            label: 'Reschedule inbox',
            badge: inboxCount > 0 ? <Pill tone="danger">{inboxCount}</Pill> : undefined,
          },
          { key: 'availability', label: 'Availability' },
        ]}
        active={tab}
        onChange={(k) => go(k as TabKey)}
      />
      {tab === 'list' && <ListTab />}
      {tab === 'book' && <BookTab onBooked={() => go('list')} />}
      {tab === 'inbox' && <InboxTab onResolved={() => setInboxCount((c) => Math.max(0, c - 1))} />}
      {tab === 'availability' && <AvailabilityTab />}
    </div>
  );
}

// ---------------------------------------------------------------- List
const PAGE_SIZE = 25;
function ListTab(): JSX.Element {
  const [rows, setRows] = useState<ApptListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // filters
  const [status, setStatus] = useState('');
  const [staffId, setStaffId] = useState('');
  const [typeId, setTypeId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'asc' | 'desc'>('desc');
  // filter option sources
  const [staffOpts, setStaffOpts] = useState<BookableStaff[]>([]);
  const [typeOpts, setTypeOpts] = useState<ApptType[]>([]);

  useEffect(() => {
    void api<{ items: BookableStaff[] }>('/api/staff/appointments/bookable-staff')
      .then((r) => setStaffOpts(r.items ?? []))
      .catch(() => undefined);
    void api<{ items: ApptType[] }>('/api/staff/appointments/appointment-types')
      .then((r) => setTypeOpts(r.items ?? []))
      .catch(() => undefined);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (staffId) params.set('staffId', staffId);
      if (typeId) params.set('typeId', typeId);
      if (from) params.set('from', new Date(from).toISOString());
      if (to) params.set('to', new Date(to + 'T23:59:59').toISOString());
      if (q.trim()) params.set('q', q.trim());
      params.set('sort', sort);
      params.set('page', String(page));
      params.set('pageSize', String(PAGE_SIZE));
      const r = await api<{ items: ApptListRow[]; total: number }>(
        `/api/staff/appointments/list?${params.toString()}`,
      );
      setRows(r.items ?? []);
      setTotal(r.total ?? 0);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    }
  }, [status, staffId, typeId, from, to, q, sort, page]);
  useEffect(() => {
    void load();
  }, [load]);
  // Reset to page 1 whenever a filter changes.
  useEffect(() => {
    setPage(1);
  }, [status, staffId, typeId, from, to, q, sort]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Card title={`Appointments (${total})`}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          alignItems: 'end',
          marginBottom: 12,
        }}
      >
        <Input
          label="Search subject"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Subject…"
          style={{ minWidth: 160 }}
        />
        <FilterSelect label="Status" value={status} onChange={setStatus}>
          <option value="">All</option>
          <option value="SCHEDULED">Scheduled</option>
          <option value="COMPLETED">Completed</option>
          <option value="CANCELLED">Cancelled</option>
        </FilterSelect>
        <FilterSelect label="Staff" value={staffId} onChange={setStaffId}>
          <option value="">All staff</option>
          {staffOpts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="Type" value={typeId} onChange={setTypeId}>
          <option value="">All types</option>
          {typeOpts.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </FilterSelect>
        <Input label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        {(status || staffId || typeId || from || to || q) && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setStatus('');
              setStaffId('');
              setTypeId('');
              setFrom('');
              setTo('');
              setQ('');
            }}
          >
            Clear
          </Button>
        )}
      </div>
      {err && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{err}</p>}
      <Table<ApptListRow>
        columns={[
          {
            key: 'when',
            header: (
              <button
                type="button"
                onClick={() => setSort((s) => (s === 'desc' ? 'asc' : 'desc'))}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  font: 'inherit',
                  fontWeight: 600,
                  color: tokens.color.text,
                  padding: 0,
                }}
              >
                Date &amp; time {sort === 'desc' ? '↓' : '↑'}
              </button> // reason: Table types header as string but renders it as a node;
            ) as // a JSX header is safe at runtime.
            unknown as string,
            render: (r) => (
              <div>
                <div style={{ fontWeight: 600 }}>{new Date(r.startsAt).toLocaleDateString()}</div>
                <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                  {new Date(r.startsAt).toLocaleTimeString([], {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </div>
              </div>
            ),
          },
          {
            key: 'title',
            header: 'Subject',
            render: (r) => (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {r.typeColor && (
                  <span
                    title={r.typeName ?? undefined}
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: r.typeColor,
                      flexShrink: 0,
                    }}
                  />
                )}
                <span>{r.title}</span>
              </div>
            ),
          },
          { key: 'staff', header: 'Staff', render: (r) => <StaffAvatarStack staff={r.staff} /> },
          {
            key: 'client',
            header: 'Client',
            render: (r) => r.clientName ?? <span style={{ color: tokens.color.textMuted }}>—</span>,
          },
          {
            key: 'engagement',
            header: 'Engagement',
            render: (r) =>
              r.engagementName ?? <span style={{ color: tokens.color.textMuted }}>—</span>,
          },
          {
            key: 'status',
            header: 'Status',
            render: (r) => (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Pill
                  tone={
                    r.status === 'SCHEDULED'
                      ? 'accent'
                      : r.status === 'COMPLETED'
                        ? 'success'
                        : 'neutral'
                  }
                >
                  {r.status.toLowerCase()}
                </Pill>
                {r.hasPendingReschedule && (
                  <span
                    title="Pending reschedule request"
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: tokens.color.warning,
                    }}
                  />
                )}
              </div>
            ),
          },
          {
            key: 'actions',
            header: '',
            render: (r) => (
              <Button size="sm" variant="secondary" onClick={() => setDetailId(r.id)}>
                Details
              </Button>
            ),
          },
        ]}
        rows={rows}
        rowKey={(r) => r.id}
        empty="No appointments match these filters."
      />
      {total > PAGE_SIZE && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 12,
            fontSize: 13,
            color: tokens.color.textMuted,
          }}
        >
          <span>
            Page {page} of {lastPage} · {total} total
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <Button
              size="sm"
              variant="secondary"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={page >= lastPage}
              onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      )}
      {detailId && (
        <DetailDrawer
          id={detailId}
          onClose={() => setDetailId(null)}
          onChanged={() => void load()}
        />
      )}
    </Card>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 4, fontSize: 12, color: tokens.color.textMuted }}>
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: '8px 10px',
          borderRadius: tokens.radius.sm,
          border: `1px solid ${tokens.color.border}`,
          background: tokens.color.surface,
          color: tokens.color.text,
          fontSize: 13,
        }}
      >
        {children}
      </select>
    </div>
  );
}

interface Detail {
  appointment: ApptRow & { internalNotes: string | null };
  staff: { staffId: string; name: string; writeStatus: string; writeError: string | null }[];
  participants: { id: string; name: string | null; email: string | null; rsvpStatus: string }[];
  rescheduleRequests: { id: string; message: string | null }[];
}

function DetailDrawer({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const [d, setD] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState(false);

  async function load(): Promise<void> {
    try {
      const r = await api<Detail>(`/api/staff/appointments/${id}/detail`);
      setD(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed to load');
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Escape closes the drawer (keyboard accessibility).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function cancel(): Promise<void> {
    if (!confirm('Cancel this appointment? Staff calendars + participants will be notified.'))
      return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/staff/appointments/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Cancelled by staff' }),
      });
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'cancel failed');
    } finally {
      setBusy(false);
    }
  }
  async function retry(staffId: string): Promise<void> {
    setErr(null);
    try {
      await api(`/api/staff/appointments/${id}/staff/${staffId}/retry-write`, { method: 'POST' });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'retry failed');
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Appointment detail"
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 'min(420px, 100%)',
        background: tokens.color.surface,
        borderLeft: `1px solid ${tokens.color.border}`,
        padding: tokens.space.lg,
        overflowY: 'auto',
        zIndex: 50,
        boxShadow: '-8px 0 24px rgba(0,0,0,0.2)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{d?.appointment.title ?? 'Appointment'}</h2>
        <Button size="sm" variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
      {err && <p style={{ color: tokens.color.danger, fontSize: 13 }}>{err}</p>}
      {!d && !err && <p style={{ color: tokens.color.textMuted }}>Loading…</p>}
      {d && (
        <div style={{ display: 'grid', gap: tokens.space.md, marginTop: tokens.space.md }}>
          <div style={{ fontSize: 13 }}>
            {new Date(d.appointment.startsAt).toLocaleString()} —{' '}
            {new Date(d.appointment.endsAt).toLocaleTimeString([], {
              hour: 'numeric',
              minute: '2-digit',
            })}
          </div>
          <Section title="Staff">
            {d.staff.map((s) => (
              <div
                key={s.staffId}
                style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}
              >
                <span style={{ flex: 1 }}>{s.name}</span>
                {s.writeStatus === 'written' && <Pill tone="success">on calendar</Pill>}
                {s.writeStatus === 'pending' && <Pill tone="neutral">pending</Pill>}
                {s.writeStatus === 'failed' && (
                  <>
                    <Pill tone="warning">write failed</Pill>
                    <Button size="sm" variant="secondary" onClick={() => void retry(s.staffId)}>
                      Retry
                    </Button>
                  </>
                )}
              </div>
            ))}
          </Section>
          {d.participants.length > 0 && (
            <Section title="Participants">
              {d.participants.map((p) => (
                <div key={p.id} style={{ fontSize: 13 }}>
                  {p.name ?? p.email} —{' '}
                  <span style={{ color: tokens.color.textMuted }}>{p.rsvpStatus}</span>
                </div>
              ))}
            </Section>
          )}
          {d.appointment.internalNotes && (
            <Section title="Internal notes (staff only)">
              <div style={{ fontSize: 13 }}>{d.appointment.internalNotes}</div>
            </Section>
          )}
          {d.rescheduleRequests.length > 0 && (
            <div
              style={{
                background: tokens.color.accentMuted,
                borderRadius: tokens.radius.sm,
                padding: 10,
                fontSize: 13,
              }}
            >
              Client requested a reschedule. Use the Reschedule inbox to pick a new time.
              {d.rescheduleRequests[0]!.message && <div>“{d.rescheduleRequests[0]!.message}”</div>}
            </div>
          )}
          {d.appointment.status === 'SCHEDULED' && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button
                variant="secondary"
                onClick={() => setRescheduling((v) => !v)}
                disabled={busy}
              >
                {rescheduling ? 'Close reschedule' : 'Reschedule'}
              </Button>
              <Button variant="danger" onClick={() => void cancel()} disabled={busy}>
                Cancel appointment
              </Button>
            </div>
          )}
          {rescheduling && (
            <SlotPicker
              appointmentId={id}
              submitLabel="Reschedule"
              onCancel={() => setRescheduling(false)}
              onSubmit={async (startsAt, endsAt) => {
                await api(`/api/staff/appointments/${id}/reschedule`, {
                  method: 'POST',
                  body: JSON.stringify({ startsAt, endsAt }),
                });
                setRescheduling(false);
                onChanged();
                await load();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          color: tokens.color.textMuted,
          marginBottom: 4,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- Book
// Calendly-style two-pane booker: a compact setup header (type + staff +
// auto duration/location) over a month calendar (bookable days bolded)
// with auto-loading time slots; client/details + confirm slide in once a
// slot is picked. Single-staff is the fast default (current user); add
// more staff to book the free/busy intersection.

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

const pad2 = (n: number): string => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number): string => `${y}-${pad2(m)}-${pad2(d)}`;
function todayYmd(): string {
  const n = new Date();
  return ymd(n.getFullYear(), n.getMonth() + 1, n.getDate());
}
function initials(name: string): string {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? '') + (p[1]?.[0] ?? '')).toUpperCase() || '?';
}
function fmtDayHeading(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function reasonMsg(reason?: string): string {
  return reason === 'staff_unavailable'
    ? 'A selected staff member isn’t available that day.'
    : reason === 'within_notice'
      ? 'Too soon to book — outside the minimum notice window.'
      : 'No open times on this day.';
}

function MonthCalendar({
  year,
  month,
  availability,
  selected,
  loading,
  canPrev,
  onSelect,
  onNav,
}: {
  year: number;
  month: number;
  availability: Record<string, boolean>;
  selected: string | null;
  loading: boolean;
  canPrev: boolean;
  onSelect: (d: string) => void;
  onNav: (delta: number) => void;
}): JSX.Element {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const today = todayYmd();
  const cells: (string | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(ymd(year, month, d));
  const navBtn = (disabled: boolean): React.CSSProperties => ({
    border: 'none',
    background: 'transparent',
    cursor: disabled ? 'default' : 'pointer',
    color: disabled ? tokens.color.textMuted : tokens.color.text,
    fontSize: 18,
    padding: '0 8px',
  });
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <button
          type="button"
          onClick={() => onNav(-1)}
          disabled={!canPrev}
          aria-label="Previous month"
          style={navBtn(!canPrev)}
        >
          ‹
        </button>
        <strong style={{ fontSize: 14 }}>
          {MONTH_NAMES[month - 1]} {year}
        </strong>
        <button
          type="button"
          onClick={() => onNav(1)}
          aria-label="Next month"
          style={navBtn(false)}
        >
          ›
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
        {WEEKDAYS.map((w) => (
          <div key={w} style={{ textAlign: 'center', fontSize: 10, color: tokens.color.textMuted }}>
            {w}
          </div>
        ))}
        {cells.map((c, i) => {
          if (!c) return <div key={`e${i}`} />;
          const day = Number(c.slice(-2));
          const open = availability[c] === true;
          const isPast = c < today;
          const isSel = c === selected;
          const isToday = c === today;
          const clickable = open && !isPast;
          const border = isSel
            ? `1.5px solid ${tokens.color.accent}`
            : isToday
              ? `1px solid ${tokens.color.accent}`
              : '1px solid transparent';
          return (
            <button
              key={c}
              type="button"
              disabled={!clickable}
              onClick={() => onSelect(c)}
              style={{
                aspectRatio: '1',
                borderRadius: tokens.radius.sm,
                fontSize: 13,
                cursor: clickable ? 'pointer' : 'default',
                border,
                background: isSel ? tokens.color.accent : 'transparent',
                color: isSel
                  ? '#fff'
                  : isToday
                    ? tokens.color.accent
                    : clickable
                      ? tokens.color.text
                      : tokens.color.textMuted,
                fontWeight: clickable && !isSel ? 600 : 400,
                opacity: isPast ? 0.35 : 1,
              }}
            >
              {day}
            </button>
          );
        })}
      </div>
      {loading && (
        <div style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 6 }}>
          Loading availability…
        </div>
      )}
    </div>
  );
}

// Reusable month-calendar + auto-loading slot picker for rescheduling an
// existing appointment (staff + duration read from the appointment; the
// appointment's own time is excluded from busy). Used by the detail drawer
// and the reschedule inbox.
function SlotPicker({
  appointmentId,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  appointmentId: string;
  submitLabel: string;
  onSubmit: (startsAt: string, endsAt: string) => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const [staffIds, setStaffIds] = useState<string[]>([]);
  const [duration, setDuration] = useState(30);
  const [ready, setReady] = useState(false);
  const now = new Date();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth() + 1);
  const [monthAvail, setMonthAvail] = useState<Record<string, boolean>>({});
  const [monthLoading, setMonthLoading] = useState(false);
  const [date, setDate] = useState<string | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotMsg, setSlotMsg] = useState<string | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<{
      appointment: { durationMinutes: number | null; startsAt: string; endsAt: string };
      staff: { staffId: string }[];
    }>(`/api/staff/appointments/${appointmentId}/detail`)
      .then((d) => {
        setStaffIds(d.staff.map((s) => s.staffId));
        const dm =
          d.appointment.durationMinutes ??
          Math.round(
            (new Date(d.appointment.endsAt).getTime() -
              new Date(d.appointment.startsAt).getTime()) /
              60000,
          );
        setDuration(dm || 30);
        setReady(true);
      })
      .catch(() => setErr('Failed to load appointment.'));
  }, [appointmentId]);

  useEffect(() => {
    if (!ready || staffIds.length === 0) return undefined;
    let alive = true;
    setMonthLoading(true);
    const p = new URLSearchParams({
      staffIds: staffIds.join(','),
      year: String(viewYear),
      month: String(viewMonth),
      durationMinutes: String(duration),
      excludeAppointmentId: appointmentId,
    });
    void api<{ days: Record<string, boolean> }>(`/api/staff/booking/slots/month?${p}`)
      .then((r) => alive && setMonthAvail(r.days ?? {}))
      .catch(() => alive && setMonthAvail({}))
      .finally(() => alive && setMonthLoading(false));
    return () => {
      alive = false;
    };
  }, [ready, staffIds, duration, viewYear, viewMonth, appointmentId]);

  useEffect(() => {
    if (!date || staffIds.length === 0) return undefined;
    let alive = true;
    setSlotsLoading(true);
    setSlot(null);
    setSlotMsg(null);
    const p = new URLSearchParams({
      staffIds: staffIds.join(','),
      date,
      durationMinutes: String(duration),
      excludeAppointmentId: appointmentId,
    });
    void api<{ slots: Slot[]; reason?: string }>(`/api/staff/booking/slots?${p}`)
      .then((r) => {
        if (!alive) return;
        setSlots(r.slots ?? []);
        if ((r.slots ?? []).length === 0) setSlotMsg(reasonMsg(r.reason));
      })
      .catch((e) => alive && setSlotMsg(e instanceof Error ? e.message : 'failed'))
      .finally(() => alive && setSlotsLoading(false));
    return () => {
      alive = false;
    };
  }, [date, staffIds, duration, appointmentId]);

  function navMonth(delta: number): void {
    let y = viewYear;
    let m = viewMonth + delta;
    if (m < 1) {
      m = 12;
      y--;
    }
    if (m > 12) {
      m = 1;
      y++;
    }
    setViewYear(y);
    setViewMonth(m);
  }
  const canPrev =
    viewYear > now.getFullYear() ||
    (viewYear === now.getFullYear() && viewMonth > now.getMonth() + 1);

  async function submit(): Promise<void> {
    if (!slot) return;
    setErr(null);
    setBusy(true);
    try {
      await onSubmit(slot.start, slot.end);
    } catch (e) {
      const m = e instanceof Error ? e.message : 'failed';
      setErr(/slot_taken/.test(m) ? 'That time isn’t available for all staff. Pick another.' : m);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        marginTop: 12,
        padding: 12,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 270px) 1fr', gap: 16 }}>
        <MonthCalendar
          year={viewYear}
          month={viewMonth}
          availability={monthAvail}
          selected={date}
          loading={monthLoading}
          canPrev={canPrev}
          onSelect={setDate}
          onNav={navMonth}
        />
        <div>
          {!date ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>
              Pick a day with openings.
            </p>
          ) : slotsLoading ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading times…</p>
          ) : slots.length === 0 ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>{slotMsg}</p>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))',
                gap: 8,
              }}
            >
              {slots.map((s) => {
                const sel = slot?.start === s.start;
                return (
                  <button
                    key={s.start}
                    type="button"
                    disabled={!s.available}
                    onClick={() => setSlot(s)}
                    style={{
                      padding: '8px 6px',
                      borderRadius: tokens.radius.sm,
                      fontSize: 13,
                      cursor: s.available ? 'pointer' : 'not-allowed',
                      border: `1.5px solid ${sel ? tokens.color.accent : tokens.color.border}`,
                      background: sel
                        ? tokens.color.accent
                        : s.available
                          ? tokens.color.surface
                          : tokens.color.bg,
                      color: sel
                        ? '#fff'
                        : s.available
                          ? tokens.color.text
                          : tokens.color.textMuted,
                      textDecoration: s.available ? 'none' : 'line-through',
                    }}
                  >
                    {fmtTime(s.start)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {err && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{err}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <Button size="sm" onClick={() => void submit()} disabled={!slot || busy}>
          {busy ? 'Saving…' : submitLabel}
        </Button>
        <Button size="sm" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function BookTab({ onBooked }: { onBooked: () => void }): JSX.Element {
  const { me } = useAuth();
  const [staff, setStaff] = useState<BookableStaff[]>([]);
  const [types, setTypes] = useState<ApptType[]>([]);
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  const [selStaff, setSelStaff] = useState<string[]>([]);
  const [typeId, setTypeId] = useState('');
  const [duration, setDuration] = useState(30);
  const [location, setLocation] = useState<LocationType>('VIDEO');
  const [locationDetail, setLocationDetail] = useState('');
  const now = new Date();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth() + 1);
  const [monthAvail, setMonthAvail] = useState<Record<string, boolean>>({});
  const [monthLoading, setMonthLoading] = useState(false);
  const [date, setDate] = useState<string | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotMsg, setSlotMsg] = useState<string | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [clientId, setClientId] = useState('');
  const [contacts, setContacts] = useState<
    { id: string; fullName: string; email: string | null }[]
  >([]);
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  const [engagements, setEngagements] = useState<{ id: string; name: string }[]>([]);
  const [engagementId, setEngagementId] = useState('');
  const [subject, setSubject] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const qClient = qs.get('clientId');
    const qStaff = qs.get('staffId');
    const qEng = qs.get('engagementId');
    if (qClient) setClientId(qClient);
    if (qEng) setEngagementId(qEng);
    void api<{ items: BookableStaff[] }>('/api/staff/appointments/bookable-staff')
      .then((r) => {
        const list = r.items ?? [];
        setStaff(list);
        setSelStaff((prev) => {
          if (prev.length) return prev;
          if (qStaff && list.some((s) => s.id === qStaff)) return [qStaff];
          if (me?.appUserId && list.some((s) => s.id === me.appUserId)) return [me.appUserId];
          return prev;
        });
      })
      .catch(() => undefined);
    void api<{ items: ApptType[] }>('/api/staff/appointments/appointment-types')
      .then((r) => setTypes(r.items ?? []))
      .catch(() => undefined);
    void api<{ items: { id: string; name: string }[] }>('/api/staff/clients')
      .then((r) => setClients(r.items ?? []))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!clientId) {
      setContacts([]);
      setParticipantIds([]);
      setEngagements([]);
      setEngagementId('');
      return;
    }
    void api<{ items: { id: string; fullName: string; email: string | null }[] }>(
      `/api/staff/clients/${clientId}/contacts`,
    )
      .then((r) => setContacts(r.items ?? []))
      .catch(() => setContacts([]));
    void api<{ items: { id: string; name: string }[] }>(
      `/api/staff/engagements?clientId=${clientId}`,
    )
      .then((r) => {
        const items = r.items ?? [];
        setEngagements(items);
        // Keep a (deep-linked) engagement only if it belongs to this client.
        setEngagementId((prev) => (items.some((e) => e.id === prev) ? prev : ''));
      })
      .catch(() => setEngagements([]));
  }, [clientId]);

  // Changing staff/duration invalidates a picked day/slot.
  useEffect(() => {
    setDate(null);
    setSlot(null);
    setSlots([]);
    setSlotMsg(null);
  }, [selStaff, duration]);

  // Month availability (which days have any open slot) auto-loads.
  useEffect(() => {
    if (selStaff.length === 0) {
      setMonthAvail({});
      return undefined;
    }
    let alive = true;
    setMonthLoading(true);
    const params = new URLSearchParams({
      staffIds: selStaff.join(','),
      year: String(viewYear),
      month: String(viewMonth),
      durationMinutes: String(duration),
    });
    void api<{ days: Record<string, boolean> }>(`/api/staff/booking/slots/month?${params}`)
      .then((r) => {
        if (alive) setMonthAvail(r.days ?? {});
      })
      .catch(() => {
        if (alive) setMonthAvail({});
      })
      .finally(() => {
        if (alive) setMonthLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selStaff, duration, viewYear, viewMonth]);

  const loadSlots = useCallback(
    (d: string) => {
      let alive = true;
      setSlotsLoading(true);
      setSlotMsg(null);
      setSlot(null);
      const params = new URLSearchParams({
        staffIds: selStaff.join(','),
        date: d,
        durationMinutes: String(duration),
      });
      void api<{ slots: Slot[]; reason?: string }>(`/api/staff/booking/slots?${params}`)
        .then((r) => {
          if (!alive) return;
          setSlots(r.slots ?? []);
          if ((r.slots ?? []).length === 0) setSlotMsg(reasonMsg(r.reason));
        })
        .catch((e) => {
          if (alive) setSlotMsg(e instanceof Error ? e.message : 'failed');
        })
        .finally(() => {
          if (alive) setSlotsLoading(false);
        });
      return () => {
        alive = false;
      };
    },
    [selStaff, duration],
  );

  // Slots auto-load when a day is selected.
  useEffect(() => {
    if (!date || selStaff.length === 0) {
      setSlots([]);
      return undefined;
    }
    return loadSlots(date);
  }, [date, selStaff, duration, loadSlots]);

  function pickType(t: ApptType): void {
    if (typeId === t.id) {
      setTypeId('');
      return;
    }
    setTypeId(t.id);
    setDuration(t.defaultDurationMinutes);
    setLocation(t.defaultLocationType);
    if (!subject || types.some((x) => x.name === subject)) setSubject(t.name);
  }
  function navMonth(delta: number): void {
    let y = viewYear;
    let m = viewMonth + delta;
    if (m < 1) {
      m = 12;
      y--;
    }
    if (m > 12) {
      m = 1;
      y++;
    }
    setViewYear(y);
    setViewMonth(m);
  }
  const canPrev =
    viewYear > now.getFullYear() ||
    (viewYear === now.getFullYear() && viewMonth > now.getMonth() + 1);
  const staffName = (id: string): string => staff.find((s) => s.id === id)?.name ?? id;

  async function confirm(): Promise<void> {
    if (!slot) return;
    setErr(null);
    setSubmitting(true);
    try {
      await api('/api/staff/appointments/book', {
        method: 'POST',
        body: JSON.stringify({
          staffIds: selStaff,
          appointmentTypeId: typeId || null,
          subject: subject.trim() || 'Appointment',
          startsAt: slot.start,
          endsAt: slot.end,
          location,
          locationDetail: locationDetail || null,
          clientId: clientId || null,
          engagementId: clientId && engagementId ? engagementId : null,
          participantContactIds: participantIds,
          internalNotes: internalNotes || null,
        }),
      });
      setDone(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed';
      if (/slot_taken/.test(msg)) {
        setErr('That time was just taken — please pick another.');
        if (date) loadSlots(date);
      } else {
        setErr(msg);
      }
    } finally {
      setSubmitting(false);
    }
  }

  function resetAll(): void {
    setDone(false);
    setStep(1);
    setTypeId('');
    setDuration(30);
    setLocation('VIDEO');
    setLocationDetail('');
    setDate(null);
    setSlots([]);
    setSlot(null);
    setSlotMsg(null);
    setClientId('');
    setParticipantIds([]);
    setEngagements([]);
    setEngagementId('');
    setSubject('');
    setInternalNotes('');
    setErr(null);
  }

  const fmtRange = (s: Slot): string =>
    `${fmtDayHeading(date!)} · ${fmtTime(s.start)}–${fmtTime(s.end)}`;
  const selectedType = types.find((t) => t.id === typeId) ?? null;
  const selectedClient = clients.find((c) => c.id === clientId) ?? null;
  const selectedEngagement = engagements.find((e) => e.id === engagementId) ?? null;
  const selectedContacts = contacts.filter((c) => participantIds.includes(c.id));

  if (done) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 20px' }}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            background: tokens.color.accentMuted,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 16px',
            fontSize: 26,
            color: tokens.color.accent,
          }}
        >
          ✓
        </div>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>Appointment booked</div>
        <div style={{ fontSize: 13, color: tokens.color.textMuted }}>
          {subject || 'Appointment'}
        </div>
        <div style={{ fontSize: 13, color: tokens.color.textMuted, marginBottom: 24 }}>
          {slot ? fmtRange(slot) : ''} · {selStaff.map(staffName).join(', ')}
        </div>
        <div
          style={{
            fontSize: 12,
            color: tokens.color.textMuted,
            background: tokens.color.surface,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            padding: '10px 16px',
            margin: '0 auto 24px',
            maxWidth: 380,
            textAlign: 'left',
            lineHeight: 1.7,
          }}
        >
          {selectedContacts.length > 0 ? (
            <div>✉ Confirmation sent to {selectedContacts.map((c) => c.fullName).join(' & ')}</div>
          ) : (
            <div>✉ No client contacts — no confirmation email sent</div>
          )}
          <div>📅 Added to {selStaff.map(staffName).join(', ')}&apos;s calendar</div>
          {selectedEngagement && <div>🗎 Note added to {selectedEngagement.name}</div>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 10 }}>
          <Button variant="secondary" onClick={onBooked}>
            View appointments
          </Button>
          <Button onClick={resetAll}>Book another</Button>
        </div>
      </div>
    );
  }

  const STEP_LABELS = ['Staff & type', 'Date & time', 'Client & details', 'Review'] as const;
  const locBtn = (loc: LocationType, label: string): JSX.Element => (
    <button
      type="button"
      onClick={() => setLocation(loc)}
      style={{
        flex: 1,
        padding: '7px 10px',
        borderRadius: tokens.radius.md,
        fontSize: 12,
        textAlign: 'center',
        cursor: 'pointer',
        border: `1.5px solid ${location === loc ? tokens.color.accent : tokens.color.border}`,
        background: location === loc ? tokens.color.accentMuted : tokens.color.surface,
        color: location === loc ? tokens.color.accent : tokens.color.textMuted,
        fontWeight: location === loc ? 600 : 400,
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      {/* Stepper */}
      <div
        style={{
          display: 'flex',
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          overflow: 'hidden',
        }}
      >
        {STEP_LABELS.map((label, i) => {
          const n = (i + 1) as 1 | 2 | 3 | 4;
          const active = n === step;
          const doneStep = n < step;
          return (
            <button
              key={label}
              type="button"
              onClick={() => doneStep && setStep(n)}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 12px',
                fontSize: 12,
                textAlign: 'left',
                cursor: doneStep ? 'pointer' : 'default',
                border: 'none',
                borderRight: i < 3 ? `1px solid ${tokens.color.border}` : 'none',
                background: active ? tokens.color.bg : tokens.color.surface,
                color: active ? tokens.color.text : tokens.color.textMuted,
              }}
            >
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  fontWeight: 600,
                  flexShrink: 0,
                  background: active
                    ? tokens.color.accent
                    : doneStep
                      ? tokens.color.success
                      : tokens.color.bg,
                  color: active || doneStep ? '#fff' : tokens.color.textMuted,
                  border: active || doneStep ? 'none' : `1px solid ${tokens.color.border}`,
                }}
              >
                {doneStep ? '✓' : n}
              </span>
              <span style={{ fontWeight: active ? 600 : 400 }}>{label}</span>
            </button>
          );
        })}
      </div>

      {err && <p style={{ color: tokens.color.danger, fontSize: 13, margin: 0 }}>{err}</p>}

      {/* STEP 1 — staff & type */}
      {step === 1 && (
        <div style={{ display: 'grid', gap: 16 }}>
          <div>
            <div style={fieldLabel}>Select staff member</div>
            {staff.length === 0 && (
              <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
                No bookable staff. Enable booking under Availability.
              </p>
            )}
            {staff.map((s) => {
              const sel = selStaff.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() =>
                    setSelStaff((p) => (sel ? p.filter((x) => x !== s.id) : [...p, s.id]))
                  }
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    border: `1.5px solid ${sel ? tokens.color.accent : tokens.color.border}`,
                    borderRadius: tokens.radius.md,
                    marginBottom: 6,
                    background: sel ? tokens.color.accentMuted : tokens.color.surface,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      background: avatarColor(s.id),
                      color: '#fff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11,
                      fontWeight: 600,
                      flexShrink: 0,
                    }}
                  >
                    {initials(s.name)}
                  </span>
                  <span style={{ flex: 1 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>
                      {s.name}
                    </span>
                    <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                      {s.hasConnection ? (
                        <span
                          style={{
                            fontSize: 10,
                            padding: '2px 6px',
                            borderRadius: 10,
                            background: tokens.color.accentMuted,
                            color: tokens.color.accent,
                          }}
                        >
                          {providerLabel(s.provider)} calendar
                        </span>
                      ) : (
                        'No calendar (read-only)'
                      )}
                    </span>
                  </span>
                  {sel && <span style={{ color: tokens.color.accent, fontSize: 16 }}>✓</span>}
                </button>
              );
            })}
          </div>

          {types.length > 0 && (
            <div>
              <div style={fieldLabel}>Appointment type</div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: 8,
                }}
              >
                {types.map((t) => {
                  const sel = typeId === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => pickType(t)}
                      style={{
                        textAlign: 'left',
                        padding: '10px 12px',
                        borderRadius: tokens.radius.md,
                        cursor: 'pointer',
                        border: `1.5px solid ${sel ? tokens.color.accent : tokens.color.border}`,
                        background: sel ? tokens.color.accentMuted : tokens.color.surface,
                      }}
                    >
                      <span
                        style={{
                          display: 'block',
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          marginBottom: 6,
                          background: t.color ?? tokens.color.accent,
                        }}
                      />
                      <span
                        style={{
                          display: 'block',
                          fontSize: 12,
                          fontWeight: 600,
                          color: sel ? tokens.color.accent : tokens.color.text,
                        }}
                      >
                        {t.name}
                      </span>
                      <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                        {t.defaultDurationMinutes} min default
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <div style={fieldLabel}>
                Duration <span style={{ textTransform: 'none' }}>(override)</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Input
                  type="number"
                  value={String(duration)}
                  onChange={(e) => setDuration(Number(e.target.value) || 30)}
                  style={{ width: 90 }}
                />
                <span style={{ fontSize: 12, color: tokens.color.textMuted }}>minutes</span>
              </div>
            </div>
            <div>
              <div style={fieldLabel}>Location</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {locBtn('IN_PERSON', 'In-person')}
                {locBtn('PHONE', 'Phone')}
                {locBtn('VIDEO', 'Video')}
              </div>
            </div>
          </div>

          <div>
            <div style={fieldLabel}>
              {location === 'VIDEO'
                ? 'Video link'
                : location === 'PHONE'
                  ? 'Phone number / call notes'
                  : 'Address'}{' '}
              <span style={{ textTransform: 'none' }}>(optional)</span>
            </div>
            <Input
              value={locationDetail}
              onChange={(e) => setLocationDetail(e.target.value)}
              placeholder={location === 'VIDEO' ? 'Paste Zoom, Teams, or Meet link…' : undefined}
            />
          </div>

          <div style={wizardFooter}>
            <Button variant="secondary" onClick={onBooked}>
              Cancel
            </Button>
            <Button onClick={() => setStep(2)} disabled={selStaff.length === 0}>
              Next: Date &amp; time →
            </Button>
          </div>
        </div>
      )}

      {/* STEP 2 — date & time */}
      {step === 2 && (
        <div style={{ display: 'grid', gap: 16 }}>
          {selStaff.length > 1 && (
            <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
              Showing times when all {selStaff.length} selected staff are free.
            </p>
          )}
          <div
            style={{ display: 'grid', gridTemplateColumns: 'minmax(230px, 290px) 1fr', gap: 20 }}
          >
            <div>
              <MonthCalendar
                year={viewYear}
                month={viewMonth}
                availability={monthAvail}
                selected={date}
                loading={monthLoading}
                canPrev={canPrev}
                onSelect={setDate}
                onNav={navMonth}
              />
              <div
                style={{
                  display: 'flex',
                  gap: 12,
                  marginTop: 10,
                  fontSize: 11,
                  color: tokens.color.textMuted,
                }}
              >
                <span>
                  <strong style={{ color: tokens.color.text }}>Bold</strong> = slots available
                </span>
                <span>Faded = no availability</span>
              </div>
            </div>
            <div>
              {!date ? (
                <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>
                  Pick a day with openings (bold) to see times.
                </p>
              ) : (
                <>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>{fmtDayHeading(date)}</div>
                  {slotsLoading ? (
                    <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading times…</p>
                  ) : slots.length === 0 ? (
                    <p style={{ fontSize: 13, color: tokens.color.textMuted }}>{slotMsg}</p>
                  ) : (
                    <>
                      {selStaff.length > 1 && (
                        <div
                          style={{
                            display: 'flex',
                            gap: 14,
                            fontSize: 11,
                            color: tokens.color.textMuted,
                            marginBottom: 8,
                          }}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <Pip free /> available
                          </span>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <Pip free={false} /> busy
                          </span>
                          <span>(one dot per staff)</span>
                        </div>
                      )}
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(4, 1fr)',
                          gap: 6,
                        }}
                      >
                        {slots.map((s) => {
                          const sel = slot?.start === s.start;
                          return (
                            <button
                              key={s.start}
                              type="button"
                              disabled={!s.available}
                              onClick={() => setSlot(s)}
                              title={
                                selStaff.length > 1
                                  ? s.staffAvailability
                                      .map(
                                        (p) =>
                                          `${staffName(p.staffId)}: ${p.free ? 'free' : 'busy'}`,
                                      )
                                      .join(', ')
                                  : s.available
                                    ? 'Available'
                                    : 'Unavailable'
                              }
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                gap: 4,
                                padding: '7px 4px',
                                borderRadius: tokens.radius.md,
                                fontSize: 12,
                                cursor: s.available ? 'pointer' : 'not-allowed',
                                border: `1px solid ${sel ? tokens.color.accent : tokens.color.border}`,
                                background: sel
                                  ? tokens.color.accent
                                  : s.available
                                    ? tokens.color.surface
                                    : tokens.color.bg,
                                color: sel
                                  ? '#fff'
                                  : s.available
                                    ? tokens.color.textMuted
                                    : tokens.color.textMuted,
                                textDecoration: s.available ? 'none' : 'line-through',
                              }}
                            >
                              {fmtTime(s.start)}
                              {selStaff.length > 1 && (
                                <span style={{ display: 'inline-flex', gap: 3 }}>
                                  {s.staffAvailability.map((p) => (
                                    <Pip key={p.staffId} free={p.free} />
                                  ))}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                      <div style={{ marginTop: 12, fontSize: 11, color: tokens.color.textMuted }}>
                        ⓘ Buffers + minimum notice applied · {selStaff.map(staffName).join(', ')}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
          <div style={wizardFooter}>
            <Button variant="secondary" onClick={() => setStep(1)}>
              ← Back
            </Button>
            <Button onClick={() => setStep(3)} disabled={!slot}>
              Next: Client &amp; details →
            </Button>
          </div>
        </div>
      )}

      {/* STEP 3 — client & details */}
      {step === 3 && (
        <div style={{ display: 'grid', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div style={{ display: 'grid', gap: 16 }}>
              <div>
                <div style={fieldLabel}>
                  Client <span style={{ textTransform: 'none' }}>(optional)</span>
                </div>
                <Combobox
                  ariaLabel="Client"
                  value={clientId}
                  onChange={setClientId}
                  options={clients.map((c) => ({ value: c.id, label: c.name }))}
                  placeholder="No client"
                  clearable
                />
              </div>
              {clientId && contacts.length > 0 && (
                <div>
                  <div style={fieldLabel}>
                    Participants {selectedClient ? `— ${selectedClient.name}` : ''}
                  </div>
                  <div
                    style={{
                      border: `1px solid ${tokens.color.border}`,
                      borderRadius: tokens.radius.md,
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        padding: '8px 12px',
                        background: tokens.color.surface,
                        borderBottom: `1px solid ${tokens.color.border}`,
                        fontSize: 11,
                        color: tokens.color.textMuted,
                      }}
                    >
                      Select contacts to include (emailed a confirmation)
                    </div>
                    <div style={{ padding: '0 12px' }}>
                      {contacts.map((c) => (
                        <label
                          key={c.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            padding: '8px 0',
                            borderBottom: `1px solid ${tokens.color.border}`,
                            cursor: 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={participantIds.includes(c.id)}
                            onChange={(e) =>
                              setParticipantIds((prev) =>
                                e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id),
                              )
                            }
                          />
                          <span style={{ flex: 1 }}>
                            <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>
                              {c.fullName}
                            </span>
                            {c.email && (
                              <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                                {c.email}
                              </span>
                            )}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: 'grid', gap: 16 }}>
              {clientId && engagements.length > 0 && (
                <div>
                  <div style={fieldLabel}>
                    Engagement <span style={{ textTransform: 'none' }}>(optional)</span>
                  </div>
                  {engagements.map((e) => {
                    const sel = engagementId === e.id;
                    return (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => setEngagementId(sel ? '' : e.id)}
                        style={{
                          width: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '9px 12px',
                          border: `1px solid ${sel ? tokens.color.accent : tokens.color.border}`,
                          borderRadius: tokens.radius.md,
                          background: sel ? tokens.color.accentMuted : tokens.color.surface,
                          marginBottom: 6,
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        <span
                          aria-hidden
                          style={{
                            fontSize: 15,
                            color: sel ? tokens.color.accent : tokens.color.textMuted,
                          }}
                        >
                          🗎
                        </span>
                        <span style={{ flex: 1 }}>
                          <span
                            style={{
                              display: 'block',
                              fontSize: 12,
                              fontWeight: 600,
                              color: sel ? tokens.color.accent : tokens.color.text,
                            }}
                          >
                            {e.name}
                          </span>
                          {selectedClient && (
                            <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                              {selectedClient.name}
                            </span>
                          )}
                        </span>
                        {sel && <span style={{ color: tokens.color.accent, fontSize: 14 }}>✓</span>}
                      </button>
                    );
                  })}
                </div>
              )}
              <div>
                <div style={fieldLabel}>Subject</div>
                <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
              </div>
              <div>
                <div style={fieldLabel}>
                  Internal notes{' '}
                  <span style={{ textTransform: 'none' }}>(staff only, not sent to client)</span>
                </div>
                <textarea
                  value={internalNotes}
                  onChange={(e) => setInternalNotes(e.target.value)}
                  rows={3}
                  placeholder="Preparation notes, agenda items, reminders…"
                  style={{ ...selectStyle, width: '100%', resize: 'vertical' }}
                />
              </div>
            </div>
          </div>
          <div style={wizardFooter}>
            <Button variant="secondary" onClick={() => setStep(2)}>
              ← Back
            </Button>
            <Button onClick={() => setStep(4)}>Review booking →</Button>
          </div>
        </div>
      )}

      {/* STEP 4 — review */}
      {step === 4 && slot && (
        <div style={{ display: 'grid', gap: 16 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: tokens.color.accentMuted,
              border: `1px solid ${tokens.color.accent}`,
              borderRadius: tokens.radius.md,
              padding: '10px 14px',
              fontSize: 12,
              color: tokens.color.accent,
            }}
          >
            ✓ Booking will be added to {selStaff.map(staffName).join(', ')}&apos;s calendar.
            {selectedContacts.length > 0
              ? ` Confirmation email sent to ${selectedContacts.length} contact${selectedContacts.length === 1 ? '' : 's'}.`
              : ' No client contacts selected.'}
          </div>

          <div
            style={{
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.lg,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '12px 16px',
                background: tokens.color.accentMuted,
                borderBottom: `1px solid ${tokens.color.accent}`,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: tokens.color.accent }}>
                {subject || 'Appointment'}
              </div>
              <div style={{ fontSize: 12, color: tokens.color.accent, marginTop: 2 }}>
                {fmtRange(slot)}
              </div>
            </div>
            <ReviewRow icon="👤" label="Staff" value={selStaff.map(staffName).join(', ')} />
            <ReviewRow
              icon="🕐"
              label="Duration & type"
              value={`${duration} min${selectedType ? ` · ${selectedType.name}` : ''}`}
            />
            <ReviewRow
              icon={location === 'VIDEO' ? '📹' : location === 'PHONE' ? '📞' : '📍'}
              label="Location"
              value={LOC_LABEL[location]}
              sub={locationDetail || undefined}
            />
            {selectedClient && (
              <ReviewRow
                icon="🏢"
                label="Client"
                value={selectedClient.name}
                sub={selectedEngagement ? `Engagement: ${selectedEngagement.name}` : undefined}
              />
            )}
            {selectedContacts.length > 0 && (
              <ReviewRow
                icon="👥"
                label={`Participants (${selectedContacts.length})`}
                chips={selectedContacts.map((c) => c.fullName)}
                sub="Confirmation + cancel/reschedule links sent via email"
              />
            )}
            {internalNotes.trim() && (
              <ReviewRow icon="🗒" label="Internal notes (staff only)" value={internalNotes} />
            )}
          </div>

          <div style={wizardFooter}>
            <Button variant="secondary" onClick={() => setStep(3)}>
              ← Back
            </Button>
            <Button onClick={() => void confirm()} disabled={submitting}>
              {submitting ? 'Booking…' : 'Confirm booking'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const fieldLabel: React.CSSProperties = {
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: tokens.color.textMuted,
  marginBottom: 6,
};

const wizardFooter: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  paddingTop: 16,
  borderTop: `1px solid ${tokens.color.border}`,
};

function ReviewRow({
  icon,
  label,
  value,
  sub,
  chips,
}: {
  icon: string;
  label: string;
  value?: string;
  sub?: string;
  chips?: string[];
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: '10px 16px',
        borderBottom: `1px solid ${tokens.color.border}`,
        alignItems: 'flex-start',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 28,
          height: 28,
          borderRadius: tokens.radius.md,
          background: tokens.color.surface,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 14,
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 2 }}>{label}</div>
        {chips ? (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
            {chips.map((c) => (
              <span
                key={c}
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  padding: '3px 8px',
                  borderRadius: 10,
                  background: tokens.color.accentMuted,
                  color: tokens.color.accent,
                }}
              >
                {c}
              </span>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'pre-wrap' }}>{value}</div>
        )}
        {sub && (
          <div style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 4 }}>{sub}</div>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------- Inbox
function InboxTab({ onResolved }: { onResolved: () => void }): JSX.Element {
  const [items, setItems] = useState<
    {
      id: string;
      appointmentId: string;
      subject: string;
      startsAt: string;
      message: string | null;
      contactName: string | null;
    }[]
  >([]);
  const [pick, setPick] = useState<{ id: string; appointmentId: string } | null>(null);

  async function load(): Promise<void> {
    const r = await api<{ items: typeof items }>('/api/staff/appointments/reschedule-requests');
    setItems(r.items ?? []);
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function decline(id: string): Promise<void> {
    await api(`/api/staff/appointments/reschedule-requests/${id}/decline`, { method: 'POST' });
    onResolved();
    await load();
  }

  return (
    <Card title="Reschedule requests">
      {items.length === 0 && (
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>No pending requests.</p>
      )}
      {items.map((it) => (
        <div
          key={it.id}
          style={{ borderBottom: `1px solid ${tokens.color.border}`, padding: '10px 0' }}
        >
          <div style={{ fontWeight: 600 }}>{it.subject}</div>
          <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
            {it.contactName ?? 'Client'} · originally {new Date(it.startsAt).toLocaleString()}
          </div>
          {it.message && <div style={{ fontSize: 13, marginTop: 4 }}>“{it.message}”</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <Button
              size="sm"
              onClick={() => setPick({ id: it.id, appointmentId: it.appointmentId })}
            >
              Accept (pick time)
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void decline(it.id)}>
              Decline
            </Button>
          </div>
        </div>
      ))}
      {pick && (
        <SlotPicker
          appointmentId={pick.appointmentId}
          submitLabel="Reschedule to this time"
          onCancel={() => setPick(null)}
          onSubmit={async (startsAt, endsAt) => {
            await api(`/api/staff/appointments/reschedule-requests/${pick.id}/accept`, {
              method: 'POST',
              body: JSON.stringify({ startsAt, endsAt }),
            });
            setPick(null);
            onResolved();
            void load();
          }}
        />
      )}
    </Card>
  );
}

// -------------------------------------------------------- Availability
function AvailabilityTab(): JSX.Element {
  const { me } = useAuth();
  const id = me?.appUserId;
  if (!id) return <Card title="Availability">Sign in required.</Card>;
  // Self-service: the per-staff booking endpoints are self-or-admin, so a
  // staff member edits their own hours here (no admin profile page needed).
  return <BookingSettingsEditor userId={id} />;
}

const selectStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.surface,
  color: tokens.color.text,
  fontSize: 13,
  marginTop: 4,
};
