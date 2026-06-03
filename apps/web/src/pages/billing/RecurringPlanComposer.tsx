// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Inline form for creating a recurring billing plan. Reused by:
//   - Admin → Recurring plans (engagement picker exposed)
//   - Engagement detail page (engagement locked to current row)
//
// Hits POST /api/staff/recurring-plans which requires engagement:write.
// On success the parent's onCreated is invoked so it can refresh the
// surrounding list.

import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { dollarsInputToCents } from '../../lib/money';

const FREQUENCIES = [
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'BIWEEKLY', label: 'Biweekly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'QUARTERLY', label: 'Quarterly' },
  { value: 'SEMIANNUAL', label: 'Semiannual' },
  { value: 'ANNUAL', label: 'Annual' },
] as const;
type Frequency = (typeof FREQUENCIES)[number]['value'];

interface EngagementOption {
  id: string;
  name: string;
  clientName?: string | null;
}

interface RecurringPlanComposerProps {
  /** When set, the engagement picker is hidden and this id is sent. */
  engagementId?: string;
  /** Pre-filtered engagement list. When omitted and `engagementId` isn't
   *  set, the composer fetches all firm engagements. */
  engagementOptions?: EngagementOption[];
  onCreated: (planId: string) => void;
  onCancel: () => void;
}

export function RecurringPlanComposer({
  engagementId: lockedEngagementId,
  engagementOptions,
  onCreated,
  onCancel,
}: RecurringPlanComposerProps): JSX.Element {
  const [engagementId, setEngagementId] = useState(lockedEngagementId ?? '');
  const [frequency, setFrequency] = useState<Frequency>('MONTHLY');
  const [amountDollars, setAmountDollars] = useState('');
  const [billingDayOfMonth, setBillingDayOfMonth] = useState<string>('1');
  // Default first run = first of next month — common cadence for
  // monthly bookkeeping / advisory fees.
  const [nextRunDate, setNextRunDate] = useState(() => {
    const d = new Date();
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    return next.toISOString().slice(0, 10);
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [engagements, setEngagements] = useState<EngagementOption[]>(engagementOptions ?? []);
  const showPicker = !lockedEngagementId;

  useEffect(() => {
    if (!showPicker || engagementOptions) return;
    void (async () => {
      try {
        const r = await api<{ items: EngagementOption[] }>('/api/staff/engagements');
        setEngagements(r.items ?? []);
      } catch {
        // Picker stays empty; user sees a helpful error on submit.
      }
    })();
  }, [showPicker, engagementOptions]);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    const cents = dollarsInputToCents(amountDollars);
    if (cents == null || cents <= 0) {
      setError('Amount must be greater than $0.');
      return;
    }
    const dom = Number(billingDayOfMonth);
    if (!Number.isFinite(dom) || dom < 1 || dom > 31) {
      setError('Billing day of month must be between 1 and 31.');
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        engagementId,
        frequency,
        amountCents: cents,
        billingDayOfMonth: dom,
        nextRunDate,
      };
      const r = await api<{ id: string }>('/api/staff/recurring-plans', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      onCreated(r.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'create_failed';
      setError(
        msg === 'invalid_payload'
          ? 'Check the inputs — engagement, frequency, amount, and next run date are required.'
          : msg === 'engagement_not_found'
            ? 'That engagement no longer exists or belongs to a different firm.'
            : `Create failed: ${msg}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="New recurring billing plan">
      <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
        The recurring billing worker runs daily. On or after <strong>next run date</strong>, it
        generates an invoice for this engagement at the chosen amount, then advances the next run
        forward by the chosen frequency. Pause / cancel anytime from the plans list.
      </p>
      <form onSubmit={submit} style={{ display: 'grid', gap: 10, maxWidth: 640 }}>
        {showPicker && (
          <LabeledSelect
            label="Engagement"
            value={engagementId}
            onChange={setEngagementId}
            options={[
              { value: '', label: 'Select…' },
              ...engagements.map((e) => ({
                value: e.id,
                label: e.clientName ? `${e.clientName} — ${e.name}` : e.name,
              })),
            ]}
          />
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <LabeledSelect
            label="Frequency"
            value={frequency}
            onChange={(v) => setFrequency(v as Frequency)}
            options={FREQUENCIES.map((f) => ({ value: f.value, label: f.label }))}
          />
          <Input
            label="Amount (USD)"
            value={amountDollars}
            onChange={(e) => setAmountDollars(e.target.value)}
            placeholder="500.00"
            required
          />
          <Input
            label="Billing day of month"
            type="number"
            min={1}
            max={31}
            value={billingDayOfMonth}
            onChange={(e) => setBillingDayOfMonth(e.target.value)}
          />
          <Input
            label="Next run date"
            type="date"
            value={nextRunDate}
            onChange={(e) => setNextRunDate(e.target.value)}
            required
          />
        </div>
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }} role="alert">
            {error}
          </p>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button type="submit" size="sm" disabled={busy || !engagementId || !amountDollars.trim()}>
            {busy ? 'Creating…' : 'Create plan'}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function LabeledSelect({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled?: boolean;
}): JSX.Element {
  const id = `select-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <label htmlFor={id} style={{ fontSize: 11, color: tokens.color.textMuted }}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{
          padding: '10px 12px',
          fontSize: 14,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          background: tokens.color.surface,
          color: tokens.color.text,
          fontFamily: tokens.font.body,
          boxSizing: 'border-box',
          width: '100%',
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
