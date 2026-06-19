// SPDX-License-Identifier: Elastic-2.0
//
// PS Phase 9 — on-demand pricing suggestion on the engagement Activity card.
// The number comes from the deterministic engine; drivers are editable and
// recompute the range live. Accept / Edit / Override is logged (no fee written).

import { useState } from 'react';

import { Button, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface TierBreakdown {
  tier: string;
  expectedHours: number;
  burdenedCostRateCents: number;
  costCents: number;
}
interface PriceResult {
  mode: 'COST_BUILD' | 'PRIOR_FEE_FALLBACK';
  costBaseCents: number;
  breakdownByTier: TierBreakdown[];
  targetMarginPct: number;
  economicFactorPct: number;
  grossedUpCents: number;
  suggestedCents: number;
  lowCents: number;
  highCents: number;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  bandPct: number;
}
interface Signal {
  key: string;
  agreesRaise: boolean;
  text: string;
}
interface Suggestion {
  price: PriceResult;
  economic: { pct: number; source: string; asOf: string | null };
  signals: { signals: Signal[] };
  rationale: { text: string; source: 'AI' | 'TEMPLATE' };
  ownActualHoursByTier: Record<string, number>;
  complexity: string;
  cohortSize: number;
  statistic: string;
  returnType: string | null;
}
interface Overrides {
  tiers?: { tier: string; expectedHours?: number; burdenedCostRateCents?: number }[];
  targetMarginPct?: number;
  economicFactorPct?: number;
}
interface FormState {
  tiers: Record<string, { hours: number; rateCents: number }>;
  marginPct: number;
  economicPct: number;
}

const money = (c: number): string => `$${Math.round(c / 100).toLocaleString()}`;
const confTone = (c: string): 'success' | 'warning' | 'danger' =>
  c === 'HIGH' ? 'success' : c === 'MEDIUM' ? 'warning' : 'danger';

const cell: React.CSSProperties = {
  padding: '6px 8px',
  borderBottom: `1px solid ${tokens.color.border}`,
  fontSize: 13,
};
const num: React.CSSProperties = {
  width: 80,
  padding: '4px 6px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  fontSize: 13,
};

function fromData(d: Suggestion): FormState {
  const tiers: FormState['tiers'] = {};
  for (const t of d.price.breakdownByTier)
    tiers[t.tier] = { hours: t.expectedHours, rateCents: t.burdenedCostRateCents };
  return { tiers, marginPct: d.price.targetMarginPct, economicPct: d.economic.pct };
}
function toOverrides(f: FormState): Overrides {
  return {
    tiers: Object.entries(f.tiers).map(([tier, v]) => ({
      tier,
      expectedHours: v.hours,
      burdenedCostRateCents: v.rateCents,
    })),
    targetMarginPct: f.marginPct,
    economicFactorPct: f.economicPct,
  };
}

export function PricingSuggestionPanel({ engagementId }: { engagementId: string }): JSX.Element {
  const [data, setData] = useState<Suggestion | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decided, setDecided] = useState<string | null>(null);
  const [ovLow, setOvLow] = useState('');
  const [ovHigh, setOvHigh] = useState('');

  async function compute(overrides?: Overrides, seedForm = false): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ suggestion: Suggestion }>(
        `/api/staff/pricing/engagements/${engagementId}/suggestion`,
        { method: 'POST', body: JSON.stringify({ overrides: overrides ?? {} }) },
      );
      setData(r.suggestion);
      if (seedForm || !form) setForm(fromData(r.suggestion));
      setDecided(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  function recompute(next: FormState): void {
    setForm(next);
    void compute(toOverrides(next));
  }

  async function decide(action: 'ACCEPTED' | 'EDITED' | 'OVERRIDDEN'): Promise<void> {
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { action, overrides: toOverrides(form) };
      if (action === 'OVERRIDDEN') {
        body['finalLowCents'] = Math.round(Number(ovLow) * 100);
        body['finalHighCents'] = Math.round(Number(ovHigh) * 100);
      }
      await api(`/api/staff/pricing/engagements/${engagementId}/decision`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setDecided(action);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  if (!data || !form) {
    return (
      <div style={{ marginTop: 16 }}>
        <Button onClick={() => void compute({}, true)} disabled={busy}>
          {busy ? 'Computing…' : 'Suggest pricing'}
        </Button>
        {error && <span style={{ color: tokens.color.danger, marginLeft: 12 }}>{error}</span>}
      </div>
    );
  }

  const p = data.price;
  const edited = JSON.stringify(toOverrides(form)) !== JSON.stringify(toOverrides(fromData(data)));

  return (
    <div
      style={{
        marginTop: 16,
        padding: 16,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        display: 'grid',
        gap: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 20 }}>
          {money(p.lowCents)} – {money(p.highCents)}
        </strong>
        <Pill tone={confTone(p.confidence)}>{p.confidence} confidence</Pill>
        <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
          {p.mode === 'PRIOR_FEE_FALLBACK'
            ? `Thin cohort (${data.cohortSize}) — prior-fee fallback`
            : `${data.cohortSize} similar engagements · ${data.complexity}`}
        </span>
      </div>

      {/* Editable cost build by tier */}
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: tokens.color.textMuted, fontSize: 11 }}>
            <th style={cell}>Tier</th>
            <th style={cell}>Expected hrs</th>
            <th style={cell}>Burdened $/h</th>
            <th style={cell}>Cost</th>
            <th style={cell}>This client (actual hrs)</th>
          </tr>
        </thead>
        <tbody>
          {p.breakdownByTier.map((t) => (
            <tr key={t.tier}>
              <td style={cell}>{t.tier}</td>
              <td style={cell}>
                <input
                  style={num}
                  type="number"
                  step="0.25"
                  defaultValue={form.tiers[t.tier]?.hours ?? t.expectedHours}
                  onBlur={(e) =>
                    recompute({
                      ...form,
                      tiers: {
                        ...form.tiers,
                        [t.tier]: {
                          hours: Number(e.target.value),
                          rateCents: form.tiers[t.tier]?.rateCents ?? t.burdenedCostRateCents,
                        },
                      },
                    })
                  }
                />
              </td>
              <td style={cell}>
                <input
                  style={num}
                  type="number"
                  step="1"
                  defaultValue={(form.tiers[t.tier]?.rateCents ?? t.burdenedCostRateCents) / 100}
                  onBlur={(e) =>
                    recompute({
                      ...form,
                      tiers: {
                        ...form.tiers,
                        [t.tier]: {
                          hours: form.tiers[t.tier]?.hours ?? t.expectedHours,
                          rateCents: Math.round(Number(e.target.value) * 100),
                        },
                      },
                    })
                  }
                />
              </td>
              <td style={cell}>{money(t.costCents)}</td>
              <td style={{ ...cell, color: tokens.color.textMuted }}>
                {(data.ownActualHoursByTier[t.tier] ?? 0).toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Margin + economic drivers */}
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13 }}>
        <label>
          Target margin %{' '}
          <input
            style={num}
            type="number"
            step="0.5"
            defaultValue={form.marginPct}
            onBlur={(e) => recompute({ ...form, marginPct: Number(e.target.value) })}
          />
        </label>
        <label>
          Economic %{' '}
          <input
            style={num}
            type="number"
            step="0.1"
            defaultValue={form.economicPct}
            onBlur={(e) => recompute({ ...form, economicPct: Number(e.target.value) })}
          />
        </label>
        <span style={{ color: tokens.color.textMuted }}>
          {data.economic.source}
          {data.economic.asOf ? ` · as of ${data.economic.asOf}` : ''}
        </span>
      </div>

      <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
        Cost base {money(p.costBaseCents)} ÷ (1 − {p.targetMarginPct}%) = {money(p.grossedUpCents)},
        ×(1 + {p.economicFactorPct}%) = {money(p.suggestedCents)} midpoint.
      </div>

      {/* Tier-2 sanity signals */}
      {data.signals.signals.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          {data.signals.signals.map((s) => (
            <div key={s.key} style={{ fontSize: 12, display: 'flex', gap: 8 }}>
              <Pill tone={s.agreesRaise ? 'warning' : 'neutral'}>
                {s.agreesRaise ? 'raise' : 'ok'}
              </Pill>
              <span>{s.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* Rationale */}
      <div style={{ fontSize: 13, lineHeight: 1.5 }}>
        {data.rationale.text}
        <span style={{ marginLeft: 8, fontSize: 11, color: tokens.color.textMuted }}>
          ({data.rationale.source === 'AI' ? 'AI' : 'templated'} rationale)
        </span>
      </div>

      {error && <span style={{ color: tokens.color.danger }}>{error}</span>}

      {/* Actions */}
      {decided ? (
        <Pill tone="success">Recorded · {decided}</Pill>
      ) : (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button onClick={() => void decide(edited ? 'EDITED' : 'ACCEPTED')} disabled={busy}>
            {edited ? 'Accept edited' : 'Accept'}
          </Button>
          <span style={{ fontSize: 12, color: tokens.color.textMuted }}>or override to $</span>
          <input
            style={num}
            type="number"
            placeholder="low"
            value={ovLow}
            onChange={(e) => setOvLow(e.target.value)}
          />
          <input
            style={num}
            type="number"
            placeholder="high"
            value={ovHigh}
            onChange={(e) => setOvHigh(e.target.value)}
          />
          <Button
            variant="secondary"
            onClick={() => void decide('OVERRIDDEN')}
            disabled={busy || !ovLow || !ovHigh}
          >
            Log override
          </Button>
        </div>
      )}
    </div>
  );
}
