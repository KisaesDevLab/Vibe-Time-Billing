// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// 0121 — shared editor for an appointment reminder schedule (a list of
// { offsetMinutes, channel } steps). Used by the appointment-type admin and
// the booking wizard. Controlled: pass value + onChange.

import { tokens } from '@vibe/ui';

export type ReminderChannel = 'EMAIL' | 'SMS' | 'CALL';
export interface ReminderStep {
  offsetMinutes: number;
  channel: ReminderChannel;
}

const PRESETS: { label: string; minutes: number }[] = [
  { label: '1 week before', minutes: 10080 },
  { label: '3 days before', minutes: 4320 },
  { label: '1 day before', minutes: 1440 },
  { label: '2 hours before', minutes: 120 },
  { label: '1 hour before', minutes: 60 },
  { label: '30 minutes before', minutes: 30 },
];

const CHANNELS: { value: ReminderChannel; label: string }[] = [
  { value: 'EMAIL', label: 'Email' },
  { value: 'SMS', label: 'SMS' },
  { value: 'CALL', label: 'Phone call' },
];

export function humanizeOffset(minutes: number): string {
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return d === 1 ? '1 day before' : `${d} days before`;
  }
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return h === 1 ? '1 hour before' : `${h} hours before`;
  }
  return `${minutes} min before`;
}

const selectStyle: React.CSSProperties = {
  padding: '6px 8px',
  borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.surface,
  color: tokens.color.text,
  fontSize: 13,
};

export function ReminderScheduleEditor({
  value,
  onChange,
  helpText,
}: {
  value: ReminderStep[];
  onChange: (next: ReminderStep[]) => void;
  helpText?: string;
}): JSX.Element {
  function update(i: number, change: Partial<ReminderStep>): void {
    onChange(value.map((s, idx) => (idx === i ? { ...s, ...change } : s)));
  }
  function remove(i: number): void {
    onChange(value.filter((_, idx) => idx !== i));
  }
  function add(): void {
    onChange([...value, { offsetMinutes: 1440, channel: 'EMAIL' }]);
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {value.length === 0 && (
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
          No reminders{helpText ? ` — ${helpText}` : '.'}
        </p>
      )}
      {value.map((step, i) => (
        <div key={i} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <select
            value={PRESETS.some((p) => p.minutes === step.offsetMinutes) ? step.offsetMinutes : ''}
            onChange={(e) => {
              if (e.target.value) update(i, { offsetMinutes: Number(e.target.value) });
            }}
            style={selectStyle}
            aria-label="When"
          >
            {!PRESETS.some((p) => p.minutes === step.offsetMinutes) && (
              <option value="">{humanizeOffset(step.offsetMinutes)}</option>
            )}
            {PRESETS.map((p) => (
              <option key={p.minutes} value={p.minutes}>
                {p.label}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={5}
            max={20160}
            value={step.offsetMinutes}
            onChange={(e) => update(i, { offsetMinutes: Number(e.target.value) || 0 })}
            style={{ ...selectStyle, width: 80 }}
            aria-label="Minutes before"
            title="Minutes before the appointment"
          />
          <span style={{ fontSize: 12, color: tokens.color.textMuted }}>min before ·</span>
          <select
            value={step.channel}
            onChange={(e) => update(i, { channel: e.target.value as ReminderChannel })}
            style={selectStyle}
            aria-label="Channel"
          >
            {CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label="Remove reminder"
            onClick={() => remove(i)}
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
        <button
          type="button"
          onClick={add}
          style={{
            padding: '5px 10px',
            borderRadius: tokens.radius.sm,
            border: `1px solid ${tokens.color.border}`,
            background: tokens.color.surface,
            color: tokens.color.text,
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          + Add reminder
        </button>
      </div>
    </div>
  );
}
