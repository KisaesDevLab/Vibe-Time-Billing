// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// BK-1/BK-7 — per-staff booking config editor: weekly availability +
// buffers/notice/increment + the booking on/off switch. Reads/writes the
// per-staff booking endpoints (self-or-admin enforced server-side), so it
// works both on the admin staff profile and in the staff-facing
// Appointments → Availability tab.

import { useEffect, useState } from 'react';

import { Button, Card, Input, tokens } from '@vibe/ui';

import { api } from '../api-client';

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface BookingSettings {
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeHours: number;
  slotIncrementMinutes: number;
  bookingEnabled: boolean;
}

interface DayRow {
  active: boolean;
  startTime: string;
  endTime: string;
}

export function BookingSettingsEditor({ userId }: { userId: string }): JSX.Element {
  const [settings, setSettings] = useState<BookingSettings>({
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeHours: 1,
    slotIncrementMinutes: 30,
    bookingEnabled: true,
  });
  const [days, setDays] = useState<DayRow[]>(
    DOW.map((_, i) => ({
      active: i >= 1 && i <= 5,
      startTime: '09:00',
      endTime: '17:00',
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    setError(null);
    try {
      const s = await api<{ settings: BookingSettings }>(`/api/staff/booking/${userId}/settings`);
      setSettings({
        bufferBeforeMinutes: s.settings.bufferBeforeMinutes,
        bufferAfterMinutes: s.settings.bufferAfterMinutes,
        minNoticeHours: s.settings.minNoticeHours,
        slotIncrementMinutes: s.settings.slotIncrementMinutes,
        bookingEnabled: s.settings.bookingEnabled,
      });
      const a = await api<{
        rows: { dayOfWeek: number; startTime: string; endTime: string; isActive: boolean }[];
      }>(`/api/staff/booking/${userId}/availability`);
      if (a.rows.length > 0) {
        const next: DayRow[] = DOW.map(() => ({
          active: false,
          startTime: '09:00',
          endTime: '17:00',
        }));
        for (const r of a.rows) {
          if (r.dayOfWeek >= 0 && r.dayOfWeek <= 6) {
            next[r.dayOfWeek] = {
              active: r.isActive,
              startTime: r.startTime.slice(0, 5),
              endTime: r.endTime.slice(0, 5),
            };
          }
        }
        setDays(next);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  function setDay(i: number, change: Partial<DayRow>): void {
    setDays((prev) => prev.map((d, idx) => (idx === i ? { ...d, ...change } : d)));
  }

  async function saveAll(): Promise<void> {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await api(`/api/staff/booking/${userId}/settings`, {
        method: 'PATCH',
        body: JSON.stringify(settings),
      });
      await api(`/api/staff/booking/${userId}/availability`, {
        method: 'PUT',
        body: JSON.stringify({
          rows: days
            .map((d, i) => ({ dayOfWeek: i, ...d }))
            .filter((d) => d.active)
            .map((d) => ({
              dayOfWeek: d.dayOfWeek,
              startTime: d.startTime,
              endTime: d.endTime,
              isActive: true,
            })),
        }),
      });
      setStatus('Saved.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 720 }}>
      <Card title="Booking availability">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>
          Hours this staff member can be booked. Off days are skipped entirely. Bookable slots are
          the intersection of these hours with the staff member&apos;s connected-calendar free/busy.
        </p>
        <div style={{ display: 'grid', gap: 6 }}>
          {DOW.map((label, i) => (
            <div
              key={label}
              style={{
                display: 'grid',
                gridTemplateColumns: '120px 80px 1fr 1fr',
                gap: 8,
                alignItems: 'center',
              }}
            >
              <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={days[i]!.active}
                  onChange={(e) => setDay(i, { active: e.target.checked })}
                />
                {label}
              </label>
              {days[i]!.active ? (
                <>
                  <span style={{ fontSize: 12, color: tokens.color.textMuted }}>from</span>
                  <Input
                    type="time"
                    value={days[i]!.startTime}
                    onChange={(e) => setDay(i, { startTime: e.target.value })}
                  />
                  <Input
                    type="time"
                    value={days[i]!.endTime}
                    onChange={(e) => setDay(i, { endTime: e.target.value })}
                  />
                </>
              ) : (
                <span style={{ gridColumn: '2 / 5', fontSize: 12, color: tokens.color.textMuted }}>
                  Unavailable
                </span>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card title="Buffers & booking rules">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <NumberField
            label="Buffer before (min)"
            value={settings.bufferBeforeMinutes}
            onChange={(v) => setSettings((s) => ({ ...s, bufferBeforeMinutes: v }))}
            options={[0, 5, 10, 15, 30]}
          />
          <NumberField
            label="Buffer after (min)"
            value={settings.bufferAfterMinutes}
            onChange={(v) => setSettings((s) => ({ ...s, bufferAfterMinutes: v }))}
            options={[0, 5, 10, 15, 30]}
          />
          <NumberField
            label="Minimum notice (hours)"
            value={settings.minNoticeHours}
            onChange={(v) => setSettings((s) => ({ ...s, minNoticeHours: v }))}
            options={[1, 2, 4, 8, 24, 48]}
          />
          <NumberField
            label="Slot increment (min)"
            value={settings.slotIncrementMinutes}
            onChange={(v) => setSettings((s) => ({ ...s, slotIncrementMinutes: v }))}
            options={[15, 30, 60]}
          />
        </div>
        <label
          style={{
            display: 'inline-flex',
            gap: 8,
            alignItems: 'center',
            marginTop: 14,
            fontSize: 13,
          }}
        >
          <input
            type="checkbox"
            checked={settings.bookingEnabled}
            onChange={(e) => setSettings((s) => ({ ...s, bookingEnabled: e.target.checked }))}
          />
          Enable booking on my calendar
        </label>
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 0 }}>
          When off, this staff member is hidden from the booking form&apos;s staff picker.
        </p>
      </Card>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Button onClick={() => void saveAll()} disabled={busy}>
          {busy ? 'Saving…' : 'Save booking settings'}
        </Button>
        {status && <span style={{ fontSize: 12, color: tokens.color.success }}>{status}</span>}
        {error && <span style={{ fontSize: 12, color: tokens.color.danger }}>{error}</span>}
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  options: number[];
}): JSX.Element {
  return (
    <label style={{ display: 'grid', gap: 4, fontSize: 12, color: tokens.color.textMuted }}>
      {label}
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          padding: '8px 10px',
          borderRadius: tokens.radius.sm,
          border: `1px solid ${tokens.color.border}`,
          background: tokens.color.surface,
          color: tokens.color.text,
          fontSize: 13,
        }}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
