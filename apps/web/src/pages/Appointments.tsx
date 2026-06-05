// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// BK-3 / BK-7 — the tabbed Appointments surface: a 4-step multi-staff
// booking wizard, the appointments list with a detail drawer, the
// reschedule inbox, and per-staff availability. Hash-routed tabs.

import { useEffect, useState, type ReactNode } from 'react';

import { Button, Card, Combobox, Input, MultiCombobox, Pill, Table, Tabs, tokens } from '@vibe/ui';

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
function ListTab(): JSX.Element {
  const [rows, setRows] = useState<ApptRow[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: ApptRow[] }>('/api/staff/appointments');
      setRows(r.items ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  return (
    <Card title={`Appointments (${rows.length})`}>
      {err && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{err}</p>}
      <Table<ApptRow>
        columns={[
          {
            key: 'when',
            header: 'Date & time',
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
          { key: 'title', header: 'Subject', render: (r) => r.title },
          {
            key: 'location',
            header: 'Location',
            render: (r) => LOC_LABEL[r.location],
          },
          {
            key: 'status',
            header: 'Status',
            render: (r) => (
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
        empty="No appointments yet."
      />
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
            <Button variant="danger" onClick={() => void cancel()} disabled={busy}>
              Cancel appointment
            </Button>
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
function BookTab({ onBooked }: { onBooked: () => void }): JSX.Element {
  const [step, setStep] = useState(1);
  const [staff, setStaff] = useState<BookableStaff[]>([]);
  const [types, setTypes] = useState<ApptType[]>([]);
  const [selStaff, setSelStaff] = useState<string[]>([]);
  const [typeId, setTypeId] = useState('');
  const [duration, setDuration] = useState(30);
  const [location, setLocation] = useState<LocationType>('VIDEO');
  const [locationDetail, setLocationDetail] = useState('');
  const [date, setDate] = useState('');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotMsg, setSlotMsg] = useState<string | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  const [clientId, setClientId] = useState('');
  const [contacts, setContacts] = useState<
    { id: string; fullName: string; email: string | null }[]
  >([]);
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  const [subject, setSubject] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    void api<{ items: BookableStaff[] }>('/api/staff/appointments/bookable-staff')
      .then((r) => setStaff(r.items ?? []))
      .catch(() => undefined);
    void api<{ items: ApptType[] }>('/api/staff/appointments/appointment-types')
      .then((r) => setTypes(r.items ?? []))
      .catch(() => undefined);
    void api<{ items: { id: string; name: string }[] }>('/api/staff/clients')
      .then((r) => setClients(r.items ?? []))
      .catch(() => undefined);
    // Deep-link prefill: /appointments?clientId=…&staffId=…#book
    const qs = new URLSearchParams(window.location.search);
    const qClient = qs.get('clientId');
    const qStaff = qs.get('staffId');
    if (qClient) setClientId(qClient);
    if (qStaff) setSelStaff((prev) => (prev.includes(qStaff) ? prev : [...prev, qStaff]));
  }, []);

  useEffect(() => {
    if (!clientId) {
      setContacts([]);
      setParticipantIds([]);
      return;
    }
    void api<{ items: { id: string; fullName: string; email: string | null }[] }>(
      `/api/staff/clients/${clientId}/contacts`,
    )
      .then((r) => setContacts(r.items ?? []))
      .catch(() => setContacts([]));
  }, [clientId]);

  // Any change to the inputs that define a slot invalidates a previously
  // picked slot — otherwise a stale slot (sized for the old duration/date/
  // staff) could be submitted, producing a 409 or an inconsistent record.
  useEffect(() => {
    setSlots([]);
    setSlot(null);
    setSlotMsg(null);
  }, [selStaff, duration, date]);

  function pickType(t: ApptType): void {
    setTypeId(t.id);
    setDuration(t.defaultDurationMinutes);
    setLocation(t.defaultLocationType);
    if (!subject) setSubject(t.name);
  }

  async function findTimes(): Promise<void> {
    setSlotMsg(null);
    setSlots([]);
    setSlot(null);
    if (selStaff.length === 0) {
      setSlotMsg('Select at least one staff member in step 1 first.');
      return;
    }
    if (!date) {
      setSlotMsg('Pick a date.');
      return;
    }
    try {
      const params = new URLSearchParams({
        staffIds: selStaff.join(','),
        date,
        durationMinutes: String(duration),
      });
      const r = await api<{ slots: Slot[]; reason?: string }>(`/api/staff/booking/slots?${params}`);
      setSlots(r.slots ?? []);
      if ((r.slots ?? []).length === 0) {
        setSlotMsg(
          r.reason === 'staff_unavailable'
            ? 'A selected staff member has no availability that day.'
            : r.reason === 'within_notice'
              ? 'Too soon to book — outside the minimum notice window.'
              : 'No shared availability on this date.',
        );
      }
    } catch (e) {
      setSlotMsg(e instanceof Error ? e.message : 'failed');
    }
  }

  async function confirm(): Promise<void> {
    if (!slot) return;
    setErr(null);
    try {
      await api('/api/staff/appointments/book', {
        method: 'POST',
        body: JSON.stringify({
          staffIds: selStaff,
          appointmentTypeId: typeId || null,
          subject: subject.trim() || 'Appointment',
          startsAt: slot.start,
          endsAt: slot.end,
          durationMinutes: duration,
          location,
          locationDetail: locationDetail || null,
          clientId: clientId || null,
          engagementId: null,
          participantContactIds: participantIds,
          internalNotes: internalNotes || null,
        }),
      });
      setDone(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed';
      if (/slot_taken|409/.test(msg)) {
        setErr('That slot was just taken. Pick a new time.');
        setStep(2);
      } else {
        setErr(msg);
      }
    }
  }

  if (done) {
    return (
      <Card title="Appointment booked">
        <p style={{ fontSize: 14 }}>✓ {subject} is booked.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={onBooked}>View appointments</Button>
          <Button
            variant="secondary"
            onClick={() => {
              // Full reset — leftover internalNotes/participants from a prior
              // booking must not carry into the next one.
              setDone(false);
              setStep(1);
              setSelStaff([]);
              setTypeId('');
              setDuration(30);
              setLocation('VIDEO');
              setLocationDetail('');
              setDate('');
              setSlots([]);
              setSlot(null);
              setSlotMsg(null);
              setClientId('');
              setParticipantIds([]);
              setSubject('');
              setInternalNotes('');
              setErr(null);
            }}
          >
            Book another
          </Button>
        </div>
      </Card>
    );
  }

  const staffOpts = staff.map((s) => ({
    value: s.id,
    label: s.hasConnection ? s.name : `${s.name} (read-only cal)`,
  }));

  return (
    <Card title={`Book appointment — step ${step} of 4`}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {['Staff & type', 'Date & time', 'Client & details', 'Review'].map((l, i) => (
          <Pill key={l} tone={step === i + 1 ? 'accent' : step > i + 1 ? 'success' : 'neutral'}>
            {i + 1}. {l}
          </Pill>
        ))}
      </div>
      {err && <p style={{ color: tokens.color.danger, fontSize: 13 }}>{err}</p>}

      {step === 1 && (
        <div style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
          <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
            <div style={{ marginBottom: 4 }}>Staff (slots = when all are free)</div>
            <MultiCombobox
              options={staffOpts}
              selected={selStaff}
              onChange={setSelStaff}
              placeholder="Select staff…"
              ariaLabel="Select staff"
            />
          </div>
          <div>
            <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>Type</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {types.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => pickType(t)}
                  style={{
                    padding: '8px 12px',
                    borderRadius: tokens.radius.sm,
                    cursor: 'pointer',
                    border: `1.5px solid ${typeId === t.id ? tokens.color.accent : tokens.color.border}`,
                    background: typeId === t.id ? tokens.color.accentMuted : tokens.color.surface,
                    color: tokens.color.text,
                  }}
                >
                  {t.name} · {t.defaultDurationMinutes}m
                </button>
              ))}
            </div>
          </div>
          <Input
            label="Duration (min)"
            type="number"
            value={String(duration)}
            onChange={(e) => setDuration(Number(e.target.value) || 30)}
          />
          <label style={{ fontSize: 12, color: tokens.color.textMuted }}>
            Location
            <select
              value={location}
              onChange={(e) => setLocation(e.target.value as LocationType)}
              style={selectStyle}
            >
              <option value="IN_PERSON">In-person</option>
              <option value="PHONE">Phone</option>
              <option value="VIDEO">Video</option>
            </select>
          </label>
          <Input
            label={
              location === 'VIDEO'
                ? 'Meeting link'
                : location === 'PHONE'
                  ? 'Call notes'
                  : 'Address'
            }
            value={locationDetail}
            onChange={(e) => setLocationDetail(e.target.value)}
          />
          <div>
            <Button onClick={() => setStep(2)} disabled={selStaff.length === 0 || duration < 5}>
              Next: Date & time →
            </Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
          <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <div>
            <Button variant="secondary" onClick={() => void findTimes()} disabled={!date}>
              Find times
            </Button>
          </div>
          {slotMsg && <p style={{ fontSize: 13, color: tokens.color.textMuted }}>{slotMsg}</p>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {slots.map((s) => (
              <button
                key={s.start}
                type="button"
                disabled={!s.available}
                onClick={() => setSlot(s)}
                title={
                  s.available
                    ? 'Available'
                    : `Busy: ${s.staffAvailability.filter((p) => !p.free).length} staff`
                }
                style={{
                  padding: '8px 10px',
                  borderRadius: tokens.radius.sm,
                  cursor: s.available ? 'pointer' : 'not-allowed',
                  border: `1.5px solid ${slot?.start === s.start ? tokens.color.accent : tokens.color.border}`,
                  background:
                    slot?.start === s.start
                      ? tokens.color.accent
                      : s.available
                        ? tokens.color.surface
                        : tokens.color.bg,
                  color:
                    slot?.start === s.start
                      ? '#fff'
                      : s.available
                        ? tokens.color.text
                        : tokens.color.textMuted,
                  textDecoration: s.available ? 'none' : 'line-through',
                }}
              >
                {new Date(s.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" onClick={() => setStep(1)}>
              ← Back
            </Button>
            <Button onClick={() => setStep(3)} disabled={!slot}>
              Next: Client & details →
            </Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
          <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
            <div style={{ marginBottom: 4 }}>Client (optional)</div>
            <Combobox
              options={clients.map((c) => ({ value: c.id, label: c.name }))}
              value={clientId}
              onChange={setClientId}
              placeholder="No client"
              clearable
              ariaLabel="Client"
            />
          </div>
          {clientId && contacts.length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                Participants
              </div>
              {contacts.map((c) => (
                <label
                  key={c.id}
                  style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}
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
                  {c.fullName} {c.email ? `· ${c.email}` : ''}
                </label>
              ))}
            </div>
          )}
          <Input label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          <label style={{ fontSize: 12, color: tokens.color.textMuted }}>
            Internal notes (staff only)
            <textarea
              value={internalNotes}
              onChange={(e) => setInternalNotes(e.target.value)}
              rows={3}
              style={{ ...selectStyle, width: '100%', resize: 'vertical' }}
            />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" onClick={() => setStep(2)}>
              ← Back
            </Button>
            <Button onClick={() => setStep(4)}>Review →</Button>
          </div>
        </div>
      )}

      {step === 4 && slot && (
        <div style={{ display: 'grid', gap: 10, maxWidth: 560 }}>
          <div style={{ fontSize: 14 }}>
            <strong>{subject || 'Appointment'}</strong>
            <div>
              {new Date(slot.start).toLocaleString()} · {duration} min
            </div>
            <div>
              Staff: {selStaff.map((id) => staff.find((s) => s.id === id)?.name ?? id).join(', ')}
            </div>
            <div>
              {LOC_LABEL[location]}
              {locationDetail ? `: ${locationDetail}` : ''}
            </div>
            {clientId && <div>Client: {clients.find((c) => c.id === clientId)?.name}</div>}
            {participantIds.length > 0 && (
              <div>{participantIds.length} participant(s) will be emailed.</div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" onClick={() => setStep(3)}>
              ← Back
            </Button>
            <Button onClick={() => void confirm()}>Confirm booking</Button>
          </div>
        </div>
      )}
    </Card>
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
        <AcceptModal
          request={pick}
          onClose={() => setPick(null)}
          onDone={() => {
            setPick(null);
            onResolved();
            void load();
          }}
        />
      )}
    </Card>
  );
}

function AcceptModal({
  request,
  onClose,
  onDone,
}: {
  request: { id: string; appointmentId: string };
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setErr(null);
    setBusy(true);
    try {
      await api(`/api/staff/appointments/reschedule-requests/${request.id}/accept`, {
        method: 'POST',
        body: JSON.stringify({
          startsAt: new Date(start).toISOString(),
          endsAt: new Date(end).toISOString(),
        }),
      });
      onDone();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed';
      setErr(
        /slot_taken/.test(msg) ? 'That time isn’t available for all staff. Pick another.' : msg,
      );
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
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        Pick a new time (re-validated against availability):
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Input
          label="Start"
          type="datetime-local"
          value={start}
          onChange={(e) => setStart(e.target.value)}
        />
        <Input
          label="End"
          type="datetime-local"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
        />
      </div>
      {err && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{err}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <Button size="sm" onClick={() => void submit()} disabled={!start || !end || busy}>
          {busy ? 'Rescheduling…' : 'Reschedule'}
        </Button>
        <Button size="sm" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
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
