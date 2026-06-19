// SPDX-License-Identifier: Elastic-2.0
//
// 0168 — the booking-request approval inbox. Each pending public-booking
// request renders as a card with the requested time, the staff member,
// the visitor's contact details and notes, and Approve / Decline actions.
// Approving creates the appointment; declining records a reason and emails
// the visitor. Backs onto /api/staff/appointments/booking-requests.

import { useEffect, useState } from 'react';

import { Button, Card, Input, Pill, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface BookingRequest {
  id: string;
  bookingLinkId: string | null;
  staffId: string;
  staffName: string;
  startsAt: string;
  endsAt: string;
  visitorName: string;
  visitorEmail: string;
  visitorPhone: string | null;
  notes: string | null;
  holdExpiresAt: string;
  createdAt: string;
}

interface Slot {
  start: string;
  end: string;
}

function durationMin(r: BookingRequest): number {
  return Math.max(
    15,
    Math.round((new Date(r.endsAt).getTime() - new Date(r.startsAt).getTime()) / 60_000),
  );
}
function ymd(iso: string): string {
  const d = new Date(iso);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
function slotTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fmtRange(startsAt: string, endsAt: string): string {
  const s = new Date(startsAt);
  const e = new Date(endsAt);
  const date = s.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const t = (d: Date): string => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${t(s)} – ${t(e)}`;
}

export function BookingRequestsPage(): JSX.Element {
  const [items, setItems] = useState<BookingRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [decliningId, setDecliningId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  // Change-time state (per request being rescheduled on approval).
  const [changingId, setChangingId] = useState<string | null>(null);
  const [slotDate, setSlotDate] = useState('');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsBusy, setSlotsBusy] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [chosenStart, setChosenStart] = useState<string | null>(null);

  async function loadSlots(r: BookingRequest, date: string): Promise<void> {
    setSlotsBusy(true);
    setSlotsError(null);
    setSlots([]);
    try {
      const p = new URLSearchParams({
        staffIds: r.staffId,
        date,
        durationMinutes: String(durationMin(r)),
      });
      const resp = await api<{ slots: Slot[] }>(`/api/staff/booking/slots?${p.toString()}`);
      setSlots(resp.slots ?? []);
    } catch (err) {
      setSlotsError(err instanceof Error ? err.message : 'failed to load times');
    } finally {
      setSlotsBusy(false);
    }
  }

  function startChange(r: BookingRequest): void {
    const date = ymd(r.startsAt);
    setChangingId(r.id);
    setDecliningId(null);
    setChosenStart(null);
    setSlotDate(date);
    void loadSlots(r, date);
  }
  function cancelChange(): void {
    setChangingId(null);
    setChosenStart(null);
    setSlots([]);
    setSlotsError(null);
  }

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const r = await api<{ items: BookingRequest[] }>('/api/staff/appointments/booking-requests');
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
  }, []);

  async function approve(id: string, startsAt?: string): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      await api<{ ok: boolean; appointmentId: string }>(
        `/api/staff/appointments/booking-requests/${id}/approve`,
        { method: 'POST', body: JSON.stringify(startsAt ? { startsAt } : {}) },
      );
      cancelChange();
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'failed';
      setError(
        msg === 'slot_taken'
          ? 'That time is no longer available — the slot was taken.'
          : msg === 'not_an_approver'
            ? 'You are not an approver for this booking page.'
            : msg,
      );
    } finally {
      setBusyId(null);
    }
  }

  async function decline(id: string): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      await api(`/api/staff/appointments/booking-requests/${id}/decline`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      });
      setDecliningId(null);
      setReason('');
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'failed';
      setError(msg === 'not_an_approver' ? 'You are not an approver for this booking page.' : msg);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Booking requests</h1>
        {items.length > 0 && <Pill tone="danger">{items.length} pending</Pill>}
      </div>
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12 }} role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
      ) : items.length === 0 ? (
        <Card title="No pending requests">
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            New requests from your public booking pages will appear here for approval.
          </p>
        </Card>
      ) : (
        items.map((r) => (
          <Card key={r.id} title={fmtRange(r.startsAt, r.endsAt)}>
            <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
              <div>
                <span style={{ color: tokens.color.textMuted }}>Staff: </span>
                {r.staffName}
              </div>
              <div>
                <span style={{ color: tokens.color.textMuted }}>Visitor: </span>
                {r.visitorName} · <a href={`mailto:${r.visitorEmail}`}>{r.visitorEmail}</a>
                {r.visitorPhone ? ` · ${r.visitorPhone}` : ''}
              </div>
              {r.notes && (
                <div>
                  <span style={{ color: tokens.color.textMuted }}>Notes: </span>
                  {r.notes}
                </div>
              )}
              <div style={{ color: tokens.color.textMuted, fontSize: 12 }}>
                Hold expires {new Date(r.holdExpiresAt).toLocaleString()}
              </div>
            </div>

            {decliningId === r.id ? (
              <div style={{ display: 'grid', gap: 8, marginTop: 12, maxWidth: 480 }}>
                <Input
                  placeholder="Optional reason (emailed to the visitor)"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busyId === r.id}
                    onClick={() => void decline(r.id)}
                  >
                    Confirm decline
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId === r.id}
                    onClick={() => {
                      setDecliningId(null);
                      setReason('');
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : changingId === r.id ? (
              <div style={{ display: 'grid', gap: 8, marginTop: 12, maxWidth: 520 }}>
                <label
                  style={{ fontSize: 12, color: tokens.color.textMuted, display: 'grid', gap: 4 }}
                >
                  New date
                  <input
                    type="date"
                    value={slotDate}
                    onChange={(e) => {
                      setSlotDate(e.target.value);
                      setChosenStart(null);
                      void loadSlots(r, e.target.value);
                    }}
                    style={{
                      padding: '6px 8px',
                      borderRadius: tokens.radius.sm,
                      border: `1px solid ${tokens.color.border}`,
                      background: tokens.color.surface,
                      color: tokens.color.text,
                      width: 190,
                    }}
                  />
                </label>
                {slotsBusy ? (
                  <p style={{ fontSize: 12, color: tokens.color.textMuted }}>Loading times…</p>
                ) : slotsError ? (
                  <p style={{ fontSize: 12, color: tokens.color.danger }}>{slotsError}</p>
                ) : slots.length === 0 ? (
                  <p style={{ fontSize: 12, color: tokens.color.textMuted }}>
                    No open times that day.
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {slots.map((s) => (
                      <Button
                        key={s.start}
                        size="sm"
                        variant={chosenStart === s.start ? undefined : 'secondary'}
                        onClick={() => setChosenStart(s.start)}
                      >
                        {slotTime(s.start)}
                      </Button>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <Button
                    size="sm"
                    disabled={busyId === r.id || !chosenStart}
                    onClick={() => void approve(r.id, chosenStart ?? undefined)}
                  >
                    Approve at selected time
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId === r.id}
                    onClick={cancelChange}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <Button size="sm" disabled={busyId === r.id} onClick={() => void approve(r.id)}>
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busyId === r.id}
                  onClick={() => startChange(r)}
                >
                  Change time
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busyId === r.id}
                  onClick={() => {
                    setDecliningId(r.id);
                    setReason('');
                  }}
                >
                  Decline
                </Button>
              </div>
            )}
          </Card>
        ))
      )}
    </div>
  );
}
