// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Inline stop-and-save form inside the timer popover. Shows the exact
// elapsed alongside the derived decimal hours ("17m 42s → 0.30 hr") —
// hours stay free-decimal (user decision: no capture-time rounding) but
// are editable before saving. A rejected save (paused engagement,
// late-entry lockout, …) surfaces the error and offers the full Log time
// form on /time; the timer itself survives server-side as PAUSED.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Combobox, Input, tokens } from '@vibe/ui';

import type { ApiError } from '../api-client';
import { elapsedToHours, formatHuman, useTimers, type TimerDto } from '../timer-context';
import type { EngagementOptions } from './useEngagementOptions';

const ERROR_LABELS: Record<string, string> = {
  engagement_required: 'Pick an engagement before saving.',
  engagement_not_writable: 'That engagement is paused or closed — time can’t be logged to it.',
  retainer_locked: 'A retainer billing batch has this engagement locked.',
  late_entry_locked: 'This date is past the firm’s late-entry window.',
  required_fields_missing: 'A required field rule blocked the save (check description/work code).',
  no_rate_resolves: 'No bill rate resolves for you on this engagement.',
  nte_cap_exceeded: 'This entry would exceed the engagement’s not-to-exceed cap.',
};

export function TimerSaveForm({
  timer,
  options,
  onSaved,
  onCancel,
}: {
  timer: TimerDto;
  options: EngagementOptions;
  onSaved: () => void;
  onCancel: () => void;
}): JSX.Element {
  const { elapsedSeconds, saveTimer } = useTimers();
  const navigate = useNavigate();
  const elapsed = elapsedSeconds(timer);

  const [engagementId, setEngagementId] = useState(timer.engagementId ?? '');
  const [workCodeId, setWorkCodeId] = useState(timer.workCodeId ?? '');
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [hours, setHours] = useState(String(elapsedToHours(elapsed)));
  const [description, setDescription] = useState(timer.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (!engagementId) {
      setError(ERROR_LABELS['engagement_required']!);
      return;
    }
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0 || h > 24) {
      setError('Hours must be between 0.01 and 24.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveTimer(timer.id, {
        engagementId,
        workCodeId: workCodeId || undefined,
        entryDate,
        hours: h,
        description: description || undefined,
      });
      onSaved();
    } catch (err) {
      const e = err as ApiError;
      setError(ERROR_LABELS[e.message] ?? `Save failed (${e.message}).`);
    } finally {
      setSaving(false);
    }
  }

  const label: React.CSSProperties = {
    fontSize: 11,
    color: tokens.color.textMuted,
    display: 'block',
    marginBottom: 4,
  };
  // Match the sm Combobox metrics (6px/10px padding, 13px text) so the
  // stacked fields share one height/rhythm instead of md inputs (14px)
  // jostling sm comboboxes.
  const compactInput: React.CSSProperties = { padding: '6px 10px', fontSize: 13 };

  return (
    <div
      style={{
        display: 'grid',
        gap: 12,
        padding: 12,
        borderRadius: tokens.radius.sm,
        border: `1px solid ${tokens.color.border}`,
        background: tokens.color.bg,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>
        {formatHuman(elapsed)} → {elapsedToHours(elapsed).toFixed(2)} hr
      </div>
      <div>
        <span style={label}>Engagement</span>
        <Combobox
          size="sm"
          value={engagementId}
          onChange={setEngagementId}
          options={options.engagementOptions(timer.clientId)}
          placeholder={options.loading ? 'Loading…' : 'Select engagement…'}
        />
      </div>
      {/* iPad Safari: input[type=date] has an intrinsic min-width the
          grid can't shrink — it was sliding under the Hours field. Two
          defenses: appearance:none + minWidth:0 ON THE INPUT lets it
          actually fit its column, and a wrapping flex row means that if
          the control still refuses to shrink, Hours wraps below it
          instead of overlapping. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ flex: '1 1 150px', minWidth: 0 }}>
          <span style={label}>Date</span>
          <Input
            type="date"
            style={{
              ...compactInput,
              minWidth: 0,
              maxWidth: '100%',
              WebkitAppearance: 'none',
              appearance: 'none',
            }}
            value={entryDate}
            onChange={(e) => setEntryDate(e.target.value)}
          />
        </div>
        <div style={{ flex: '1 1 110px', minWidth: 0 }}>
          <span style={label}>Hours</span>
          <Input
            type="number"
            step="any"
            min={0.01}
            max={24}
            style={{ ...compactInput, minWidth: 0, maxWidth: '100%' }}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
        </div>
      </div>
      <div>
        <span style={label}>Work code (optional)</span>
        <Combobox
          size="sm"
          value={workCodeId}
          onChange={setWorkCodeId}
          options={options.workCodeOptions(engagementId || null)}
          placeholder="None"
          clearable
        />
      </div>
      <div>
        <span style={label}>Description</span>
        <Input
          style={compactInput}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What was this time for?"
        />
      </div>
      {error && (
        <div style={{ fontSize: 12, color: tokens.color.danger }}>
          {error}{' '}
          <button
            type="button"
            onClick={() => {
              onCancel();
              navigate(`/time?timerId=${timer.id}`);
            }}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              color: tokens.color.accent,
              cursor: 'pointer',
              fontSize: 12,
              textDecoration: 'underline',
            }}
          >
            Finish on Time page
          </button>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          Back
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={saving}>
          {saving ? 'Saving…' : 'Save entry'}
        </Button>
      </div>
    </div>
  );
}
