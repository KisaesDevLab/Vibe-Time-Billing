/* eslint-disable jsx-a11y/label-has-associated-control -- labels and controls are siblings inside grid containers; revisit with htmlFor/id pairs in a polish pass */
// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Reusable engagement-recurrence form. Two surfaces use it today:
//
//   - EngagementCreate — embedded as an optional section. When the
//     "Make this engagement recurring" toggle is on and the engagement
//     is created successfully, the parent posts a recurrence row using
//     the values captured here.
//
//   - ClientRecurrencesCard — pops the same form for an inline "add
//     another recurrence" flow (client + template chosen explicitly).
//
// The form is intentionally light: the worker / spawn helper resolves
// the next period from the previous engagement's period fields, so the
// user only needs to pick frequency + trigger + a starting next-run
// date (for SCHEDULE) or seed period (for the very first run when no
// previous engagement exists).

import { useEffect, useState } from 'react';

import { tokens } from '@vibe/ui';

export const RECURRENCE_FREQUENCIES = [
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'BIWEEKLY', label: 'Biweekly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'QUARTERLY', label: 'Quarterly' },
  { value: 'SEMIANNUAL', label: 'Semiannual' },
  { value: 'ANNUAL', label: 'Annual' },
] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number]['value'];

export type RecurrenceTriggerMode = 'SCHEDULE' | 'ON_COMPLETION';

export interface RecurrenceDraft {
  frequency: RecurrenceFrequency;
  triggerMode: RecurrenceTriggerMode;
  nextRunDate: string;
  seedPeriodYear: string;
  seedPeriodMonth: string;
  seedPeriodLabel: string;
  notes: string;
}

export function makeDefaultRecurrenceDraft(): RecurrenceDraft {
  // Default: annual schedule, fires same calendar day next year —
  // typical CPA tax engagement cadence (1040, 1120, etc.).
  const next = new Date();
  next.setFullYear(next.getFullYear() + 1);
  return {
    frequency: 'ANNUAL',
    triggerMode: 'SCHEDULE',
    nextRunDate: next.toISOString().slice(0, 10),
    seedPeriodYear: String(new Date().getFullYear() + 1),
    seedPeriodMonth: '',
    seedPeriodLabel: '',
    notes: '',
  };
}

interface Props {
  value: RecurrenceDraft;
  onChange: (v: RecurrenceDraft) => void;
  /** Show the seed-period inputs. Hide them when caller will derive the
   *  period from an existing engagement automatically. */
  showSeedFields?: boolean;
  disabled?: boolean;
}

export function RecurrenceComposer({
  value,
  onChange,
  showSeedFields = true,
  disabled,
}: Props): JSX.Element {
  const set = <K extends keyof RecurrenceDraft>(key: K, v: RecurrenceDraft[K]): void => {
    onChange({ ...value, [key]: v });
  };
  // When trigger flips to ON_COMPLETION, the date input becomes
  // irrelevant (worker fires when the previous engagement closes).
  // Keep the stored value but visually mute the field.
  const scheduleDateDisabled = disabled || value.triggerMode !== 'SCHEDULE';

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <label style={{ fontSize: 11, color: tokens.color.textMuted }}>Frequency</label>
        <select
          value={value.frequency}
          onChange={(e) => set('frequency', e.target.value as RecurrenceFrequency)}
          disabled={disabled}
          style={selectStyle()}
        >
          {RECURRENCE_FREQUENCIES.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      <fieldset
        style={{
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.sm,
          padding: 10,
          display: 'grid',
          gap: 6,
        }}
      >
        <legend
          style={{
            padding: '0 6px',
            fontSize: 11,
            color: tokens.color.textMuted,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
          }}
        >
          Trigger
        </legend>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
          <input
            type="radio"
            checked={value.triggerMode === 'SCHEDULE'}
            onChange={() => set('triggerMode', 'SCHEDULE')}
            disabled={disabled}
            style={{ marginTop: 3 }}
          />
          <span>
            <strong>On a schedule</strong>
            <br />
            <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
              Worker spawns the next engagement on or after the next run date.
            </span>
          </span>
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
          <input
            type="radio"
            checked={value.triggerMode === 'ON_COMPLETION'}
            onChange={() => set('triggerMode', 'ON_COMPLETION')}
            disabled={disabled}
            style={{ marginTop: 3 }}
          />
          <span>
            <strong>When the current one closes</strong>
            <br />
            <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
              Spawns automatically the moment the previous period&apos;s engagement is closed.
            </span>
          </span>
        </label>
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '4px 0 0' }}>
          You can always click <strong>Run now</strong> on a recurrence to spawn the next period
          manually regardless of the trigger.
        </p>
      </fieldset>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <label style={{ fontSize: 11, color: tokens.color.textMuted }}>
            Next run date{' '}
            <span style={{ fontSize: 10 }}>
              ({value.triggerMode === 'SCHEDULE' ? 'required' : 'ignored'})
            </span>
          </label>
          <input
            type="date"
            value={value.nextRunDate}
            onChange={(e) => set('nextRunDate', e.target.value)}
            disabled={scheduleDateDisabled}
            style={inputStyle()}
          />
        </div>
        {showSeedFields && (
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={{ fontSize: 11, color: tokens.color.textMuted }}>
              Seed period year (first spawn)
            </label>
            <input
              type="number"
              min={1900}
              max={9999}
              value={value.seedPeriodYear}
              onChange={(e) => set('seedPeriodYear', e.target.value)}
              disabled={disabled}
              style={inputStyle()}
            />
          </div>
        )}
      </div>
      {showSeedFields && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={{ fontSize: 11, color: tokens.color.textMuted }}>
              Seed period month (optional)
            </label>
            <input
              type="number"
              min={1}
              max={12}
              value={value.seedPeriodMonth}
              onChange={(e) => set('seedPeriodMonth', e.target.value)}
              disabled={disabled}
              style={inputStyle()}
            />
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={{ fontSize: 11, color: tokens.color.textMuted }}>
              Seed period label (optional)
            </label>
            <input
              type="text"
              value={value.seedPeriodLabel}
              onChange={(e) => set('seedPeriodLabel', e.target.value)}
              disabled={disabled}
              placeholder='e.g. "Q1 2026"'
              style={inputStyle()}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// Translate a draft to the wire payload accepted by the API. Empty
// strings are omitted so the server's Zod schema doesn't reject them.
export function recurrenceDraftToPayload(d: RecurrenceDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    frequency: d.frequency,
    triggerMode: d.triggerMode,
  };
  if (d.triggerMode === 'SCHEDULE' && d.nextRunDate) {
    body['nextRunDate'] = d.nextRunDate;
  }
  if (d.seedPeriodYear.trim()) body['seedPeriodYear'] = Number(d.seedPeriodYear);
  if (d.seedPeriodMonth.trim()) body['seedPeriodMonth'] = Number(d.seedPeriodMonth);
  if (d.seedPeriodLabel.trim()) body['seedPeriodLabel'] = d.seedPeriodLabel.trim();
  if (d.notes.trim()) body['notes'] = d.notes.trim();
  return body;
}

// Make the lint happy about unused — `useEffect`/`useState` may not be
// needed by the basic flow but a future enhancement (preview next
// period name) will use them. Strip when added.
void useEffect;
void useState;

function inputStyle(): React.CSSProperties {
  return {
    padding: '8px 10px',
    fontSize: 13,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    background: tokens.color.surface,
    color: tokens.color.text,
  };
}

function selectStyle(): React.CSSProperties {
  return {
    padding: '8px 10px',
    fontSize: 13,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    background: tokens.color.surface,
    color: tokens.color.text,
  };
}
