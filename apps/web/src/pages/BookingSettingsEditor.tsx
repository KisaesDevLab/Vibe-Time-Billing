// SPDX-License-Identifier: Elastic-2.0
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

type LocationType = 'IN_PERSON' | 'PHONE' | 'VIDEO';
const LOCATION_OPTS: { key: LocationType; label: string }[] = [
  { key: 'IN_PERSON', label: 'In-person' },
  { key: 'PHONE', label: 'Phone' },
  { key: 'VIDEO', label: 'Video' },
];

interface LocOption {
  id: string;
  name: string;
  locationType: LocationType;
}

interface Win {
  startTime: string;
  endTime: string;
  /** Empty = all locations allowed for this window. */
  locationTypes: LocationType[];
  /** 0144 — preset location for bookings made in this window (null = none). */
  locationOptionId: string | null;
}

const newWin = (): Win => ({
  startTime: '09:00',
  endTime: '17:00',
  locationTypes: [],
  locationOptionId: null,
});

export function BookingSettingsEditor({ userId }: { userId: string }): JSX.Element {
  const [settings, setSettings] = useState<BookingSettings>({
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeHours: 1,
    slotIncrementMinutes: 30,
    bookingEnabled: true,
  });
  // One array of windows per day-of-week (index 0=Sun … 6=Sat).
  const [windows, setWindows] = useState<Win[][]>(() =>
    DOW.map((_, i) => (i >= 1 && i <= 5 ? [newWin()] : [])),
  );
  const [locations, setLocations] = useState<LocOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<{ items: LocOption[] }>('/api/staff/appointments/locations')
      .then((r) => setLocations(r.items ?? []))
      .catch(() => undefined);
  }, []);

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
        rows: {
          dayOfWeek: number;
          startTime: string;
          endTime: string;
          locationTypes: LocationType[] | null;
          locationOptionId: string | null;
          isActive: boolean;
        }[];
      }>(`/api/staff/booking/${userId}/availability`);
      if (a.rows.length > 0) {
        const next: Win[][] = DOW.map(() => []);
        for (const r of a.rows) {
          if (r.dayOfWeek >= 0 && r.dayOfWeek <= 6 && r.isActive) {
            next[r.dayOfWeek]!.push({
              startTime: r.startTime.slice(0, 5),
              endTime: r.endTime.slice(0, 5),
              locationTypes: r.locationTypes ?? [],
              locationOptionId: r.locationOptionId ?? null,
            });
          }
        }
        setWindows(next);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  function addWindow(dow: number): void {
    setWindows((prev) => prev.map((wins, i) => (i === dow ? [...wins, newWin()] : wins)));
  }
  function removeWindow(dow: number, idx: number): void {
    setWindows((prev) =>
      prev.map((wins, i) => (i === dow ? wins.filter((_, j) => j !== idx) : wins)),
    );
  }
  function updateWindow(dow: number, idx: number, change: Partial<Win>): void {
    setWindows((prev) =>
      prev.map((wins, i) =>
        i === dow ? wins.map((w, j) => (j === idx ? { ...w, ...change } : w)) : wins,
      ),
    );
  }
  function toggleLoc(dow: number, idx: number, loc: LocationType): void {
    setWindows((prev) =>
      prev.map((wins, i) =>
        i === dow
          ? wins.map((w, j) =>
              j === idx
                ? {
                    ...w,
                    locationTypes: w.locationTypes.includes(loc)
                      ? w.locationTypes.filter((l) => l !== loc)
                      : [...w.locationTypes, loc],
                  }
                : w,
            )
          : wins,
      ),
    );
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
      const rows = windows.flatMap((wins, dow) =>
        wins.map((w) => ({
          dayOfWeek: dow,
          startTime: w.startTime,
          endTime: w.endTime,
          locationTypes: w.locationTypes.length > 0 ? w.locationTypes : null,
          locationId: w.locationOptionId,
          isActive: true,
        })),
      );
      await api(`/api/staff/booking/${userId}/availability`, {
        method: 'PUT',
        body: JSON.stringify({ rows }),
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
          Hours this staff member can be booked. Add multiple windows per day for split shifts (e.g.
          a lunch break). For each window you can limit which meeting types it accepts — leave all
          unchecked to allow any. Bookable slots are the intersection of these hours with the staff
          member&apos;s connected-calendar free/busy.
        </p>
        <div style={{ display: 'grid', gap: 10 }}>
          {DOW.map((label, dow) => (
            <div
              key={label}
              style={{
                display: 'grid',
                gridTemplateColumns: '110px 1fr',
                gap: 10,
                alignItems: 'start',
                paddingBottom: 10,
                borderBottom: `1px solid ${tokens.color.border}`,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 500, paddingTop: 6 }}>{label}</div>
              <div style={{ display: 'grid', gap: 8 }}>
                {windows[dow]!.length === 0 && (
                  <span style={{ fontSize: 12, color: tokens.color.textMuted, paddingTop: 6 }}>
                    Unavailable
                  </span>
                )}
                {windows[dow]!.map((w, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 8,
                      alignItems: 'center',
                    }}
                  >
                    <Input
                      type="time"
                      value={w.startTime}
                      onChange={(e) => updateWindow(dow, idx, { startTime: e.target.value })}
                      style={{ width: 110 }}
                    />
                    <span style={{ fontSize: 12, color: tokens.color.textMuted }}>to</span>
                    <Input
                      type="time"
                      value={w.endTime}
                      onChange={(e) => updateWindow(dow, idx, { endTime: e.target.value })}
                      style={{ width: 110 }}
                    />
                    <div style={{ display: 'inline-flex', gap: 6 }}>
                      {LOCATION_OPTS.map((opt) => {
                        const on = w.locationTypes.includes(opt.key);
                        return (
                          <button
                            key={opt.key}
                            type="button"
                            onClick={() => toggleLoc(dow, idx, opt.key)}
                            title={
                              w.locationTypes.length === 0
                                ? 'All meeting types allowed'
                                : `${opt.label} ${on ? 'allowed' : 'not allowed'}`
                            }
                            style={{
                              padding: '5px 9px',
                              borderRadius: tokens.radius.sm,
                              fontSize: 12,
                              cursor: 'pointer',
                              border: `1px solid ${on ? tokens.color.accent : tokens.color.border}`,
                              background: on ? tokens.color.accentMuted : tokens.color.surface,
                              color: on ? tokens.color.accent : tokens.color.textMuted,
                              fontWeight: on ? 600 : 400,
                            }}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                    {locations.length > 0 && (
                      <select
                        aria-label="Window location"
                        value={w.locationOptionId ?? ''}
                        onChange={(e) =>
                          updateWindow(dow, idx, { locationOptionId: e.target.value || null })
                        }
                        title="Bookings in this window default to this location"
                        style={{
                          padding: '5px 8px',
                          borderRadius: tokens.radius.sm,
                          border: `1px solid ${tokens.color.border}`,
                          background: tokens.color.surface,
                          color: tokens.color.text,
                          fontSize: 12,
                        }}
                      >
                        <option value="">No location</option>
                        {locations.map((l) => (
                          <option key={l.id} value={l.id}>
                            @ {l.name}
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      type="button"
                      aria-label="Remove window"
                      onClick={() => removeWindow(dow, idx)}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        color: tokens.color.textMuted,
                        fontSize: 14,
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <div>
                  <Button size="sm" variant="secondary" onClick={() => addWindow(dow)}>
                    + Add hours
                  </Button>
                </div>
              </div>
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
