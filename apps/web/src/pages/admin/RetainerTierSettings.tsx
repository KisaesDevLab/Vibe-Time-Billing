// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R1 — Retainer tier configuration page. Six return-type tabs, two
// side-by-side editor cards per tab (TIER_1 + TIER_2). Firm-level
// settings panel below for the feature flag, biller-toggle default,
// reminder cadence, and prep-fee work-code set.
//
// Reads + writes go through /api/staff/admin/retainer/* (mounted in
// app.ts). Requires retainer:tier_config:write — page is partner-only.

import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { centsToDollarsInput, dollarsInputToCents } from '../../lib/money';

const RETURN_TYPES = ['1040', '1065', '1120', '1120S', '1041', '990'] as const;
type ReturnType = (typeof RETURN_TYPES)[number];

interface TierShape {
  id: string;
  name: string;
  description: string;
  hours: number;
  baseFeeCents: number;
  pctOfPrepFeeBps: number;
  isActive: boolean;
  eligibleWorkCodeIds: string[];
}

// Server returns description as nullable; client TierShape normalizes
// to '' so the textarea is always a controlled string.
type TierShapeFromServer = Omit<TierShape, 'description'> & { description: string | null };

interface TierConfigResponse {
  returnType: ReturnType;
  tier1: TierShapeFromServer | null;
  tier2: TierShapeFromServer | null;
}

interface FirmSettings {
  firmId: string;
  featureEnabled: boolean;
  defaultBillerToggleOn: boolean;
  offerWindowDays: number;
  prepFeeWorkCodeIds: string[];
  notifyOnBill: boolean;
  notifyDay30: boolean;
  notifyDay55: boolean;
  revenueGlAccount: string | null;
  offsetGlAccount: string | null;
}

interface WorkCode {
  id: string;
  name: string;
  key: string | null;
}

const DEFAULT_TIER: TierShape = {
  id: '',
  name: '',
  description: '',
  hours: 0,
  baseFeeCents: 0,
  pctOfPrepFeeBps: 0,
  isActive: true,
  eligibleWorkCodeIds: [],
};

export function RetainerTierSettingsPage(): JSX.Element {
  const [activeReturn, setActiveReturn] = useState<ReturnType>('1040');
  const [tier1, setTier1] = useState<TierShape>(DEFAULT_TIER);
  const [tier2, setTier2] = useState<TierShape>(DEFAULT_TIER);
  const [settings, setSettings] = useState<FirmSettings | null>(null);
  const [workCodes, setWorkCodes] = useState<WorkCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingTiers, setSavingTiers] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTiersAt, setSavedTiersAt] = useState<number | null>(null);
  const [savedSettingsAt, setSavedSettingsAt] = useState<number | null>(null);

  // Load tiers when return type changes.
  useEffect(() => {
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const r = await api<TierConfigResponse>(
          `/api/staff/admin/retainer/tier-configs?returnType=${activeReturn}`,
        );
        setTier1(
          r.tier1 ? { ...r.tier1, description: r.tier1.description ?? '' } : { ...DEFAULT_TIER },
        );
        setTier2(
          r.tier2 ? { ...r.tier2, description: r.tier2.description ?? '' } : { ...DEFAULT_TIER },
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : 'load failed');
      } finally {
        setLoading(false);
      }
    })();
  }, [activeReturn]);

  // Load firm settings + work codes once.
  useEffect(() => {
    void (async () => {
      try {
        const [s, wc] = await Promise.all([
          api<{ settings: FirmSettings | null }>('/api/staff/admin/retainer/firm-settings'),
          api<{ items: WorkCode[] }>('/api/staff/taxonomy/work-codes'),
        ]);
        setSettings(s.settings);
        setWorkCodes(wc.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'load failed');
      }
    })();
  }, []);

  async function saveTiers(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSavingTiers(true);
    setError(null);
    try {
      if (tier1.eligibleWorkCodeIds.length === 0 || tier2.eligibleWorkCodeIds.length === 0) {
        setError('Each tier requires at least one eligible work code');
        setSavingTiers(false);
        return;
      }
      await api(`/api/staff/admin/retainer/tier-configs/${activeReturn}`, {
        method: 'PUT',
        body: JSON.stringify({
          tier1: {
            name: tier1.name,
            description: tier1.description.trim() || null,
            hours: tier1.hours,
            baseFeeCents: tier1.baseFeeCents,
            pctOfPrepFeeBps: tier1.pctOfPrepFeeBps,
            isActive: tier1.isActive,
            eligibleWorkCodeIds: tier1.eligibleWorkCodeIds,
          },
          tier2: {
            name: tier2.name,
            description: tier2.description.trim() || null,
            hours: tier2.hours,
            baseFeeCents: tier2.baseFeeCents,
            pctOfPrepFeeBps: tier2.pctOfPrepFeeBps,
            isActive: tier2.isActive,
            eligibleWorkCodeIds: tier2.eligibleWorkCodeIds,
          },
        }),
      });
      setSavedTiersAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setSavingTiers(false);
    }
  }

  async function saveSettings(): Promise<void> {
    if (!settings) return;
    setSavingSettings(true);
    setError(null);
    try {
      await api('/api/staff/admin/retainer/firm-settings', {
        method: 'PUT',
        body: JSON.stringify({
          featureEnabled: settings.featureEnabled,
          defaultBillerToggleOn: settings.defaultBillerToggleOn,
          offerWindowDays: settings.offerWindowDays,
          prepFeeWorkCodeIds: settings.prepFeeWorkCodeIds,
          notifyOnBill: settings.notifyOnBill,
          notifyDay30: settings.notifyDay30,
          notifyDay55: settings.notifyDay55,
          revenueGlAccount: settings.revenueGlAccount || null,
          offsetGlAccount: settings.offsetGlAccount || null,
        }),
      });
      setSavedSettingsAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setSavingSettings(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Retainer tier configuration">
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          Two tiers per return type. Tier 1 is the default offer; Tier 2 is the upgrade card.
          Pricing = base fee + (pct × prep-fee basis). Eligibility lists the work codes a retainer
          will cover when activated.
        </p>
        <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
          {RETURN_TYPES.map((rt) => (
            <button
              key={rt}
              type="button"
              onClick={() => setActiveReturn(rt)}
              style={{
                padding: '6px 12px',
                fontSize: 13,
                borderRadius: tokens.radius.sm,
                border: `1px solid ${tokens.color.border}`,
                background: rt === activeReturn ? tokens.color.accent : tokens.color.surface,
                color: rt === activeReturn ? '#fff' : tokens.color.text,
                cursor: 'pointer',
              }}
            >
              {rt}
            </button>
          ))}
        </div>
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <form onSubmit={saveTiers}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 16,
              }}
            >
              <TierEditor
                title="Tier 1 — Standard"
                tier={tier1}
                onChange={setTier1}
                workCodes={workCodes}
              />
              <TierEditor
                title="Tier 2 — Premium"
                tier={tier2}
                onChange={setTier2}
                workCodes={workCodes}
              />
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
              <Button type="submit" disabled={savingTiers}>
                {savingTiers ? 'Saving…' : 'Save tiers'}
              </Button>
              {savedTiersAt && (
                <span style={{ fontSize: 12, color: tokens.color.success }}>
                  Saved at {new Date(savedTiersAt).toLocaleTimeString()}
                </span>
              )}
            </div>
          </form>
        )}
      </Card>

      {settings && (
        <Card title="Firm-level retainer settings">
          <div style={{ display: 'grid', gap: 12, maxWidth: 540 }}>
            <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={settings.featureEnabled}
                onChange={(e) => setSettings({ ...settings, featureEnabled: e.target.checked })}
              />
              <span>
                Feature enabled
                <span style={{ marginLeft: 8 }}>
                  <Pill tone={settings.featureEnabled ? 'success' : 'neutral'}>
                    {settings.featureEnabled ? 'ON' : 'OFF'}
                  </Pill>
                </span>
              </span>
            </label>
            <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: 0 }}>
              Master switch — when off, no offers are auto-created and the portal offer page is
              hidden. Schema is still installed.
            </p>
            <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={settings.defaultBillerToggleOn}
                onChange={(e) =>
                  setSettings({ ...settings, defaultBillerToggleOn: e.target.checked })
                }
              />
              Biller toggle defaults ON when conditions match
            </label>
            <Input
              label="Offer window (days from invoice date)"
              type="number"
              min={1}
              max={365}
              value={settings.offerWindowDays}
              onChange={(e) =>
                setSettings({ ...settings, offerWindowDays: Number(e.target.value) })
              }
            />
            <fieldset
              style={{
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
                padding: 12,
              }}
            >
              <legend style={{ fontSize: 12, padding: '0 6px', color: tokens.color.textMuted }}>
                Prep-fee work codes
              </legend>
              <p style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 0 }}>
                Lines on a tax-prep invoice with these work codes count toward the offer&apos;s
                prep-fee basis. Without a match, no offer is created.
              </p>
              <WorkCodeMultiSelect
                value={settings.prepFeeWorkCodeIds}
                workCodes={workCodes}
                onChange={(ids) => setSettings({ ...settings, prepFeeWorkCodeIds: ids })}
              />
            </fieldset>
            <div
              style={{
                display: 'flex',
                gap: 12,
                flexWrap: 'wrap',
                padding: 8,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
              }}
            >
              <strong style={{ fontSize: 12, width: '100%', color: tokens.color.textMuted }}>
                Reminder cadence (TCPA — only if client has subscribed)
              </strong>
              <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={settings.notifyOnBill}
                  onChange={(e) => setSettings({ ...settings, notifyOnBill: e.target.checked })}
                />
                On-bill
              </label>
              <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={settings.notifyDay30}
                  onChange={(e) => setSettings({ ...settings, notifyDay30: e.target.checked })}
                />
                Day 30
              </label>
              <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={settings.notifyDay55}
                  onChange={(e) => setSettings({ ...settings, notifyDay55: e.target.checked })}
                />
                Day 55
              </label>
            </div>
            <Input
              label="GL revenue account (R6 — leave blank until set)"
              value={settings.revenueGlAccount ?? ''}
              onChange={(e) =>
                setSettings({ ...settings, revenueGlAccount: e.target.value || null })
              }
            />
            <Input
              label="GL offset account"
              value={settings.offsetGlAccount ?? ''}
              onChange={(e) =>
                setSettings({ ...settings, offsetGlAccount: e.target.value || null })
              }
            />
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <Button type="button" onClick={saveSettings} disabled={savingSettings}>
                {savingSettings ? 'Saving…' : 'Save settings'}
              </Button>
              {savedSettingsAt && (
                <span style={{ fontSize: 12, color: tokens.color.success }}>
                  Saved at {new Date(savedSettingsAt).toLocaleTimeString()}
                </span>
              )}
            </div>
          </div>
        </Card>
      )}

      {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
    </div>
  );
}

function TierEditor({
  title,
  tier,
  onChange,
  workCodes,
}: {
  title: string;
  tier: TierShape;
  onChange: (t: TierShape) => void;
  workCodes: WorkCode[];
}): JSX.Element {
  // Live preview against an example $1,500 basis.
  const previewCents = useMemo(() => {
    const base = tier.baseFeeCents;
    const variable = Math.round((tier.pctOfPrepFeeBps * 150000) / 10000);
    return base + variable;
  }, [tier.baseFeeCents, tier.pctOfPrepFeeBps]);

  return (
    <div
      style={{
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        padding: 12,
        display: 'grid',
        gap: 10,
      }}
    >
      <strong style={{ fontSize: 14 }}>{title}</strong>
      <Input
        label="Display name"
        value={tier.name}
        onChange={(e) => onChange({ ...tier, name: e.target.value })}
      />
      <label style={{ display: 'grid', gap: 4 }}>
        <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
          Description{' '}
          <span style={{ fontStyle: 'italic' }}>
            (optional — shown on the portal offer card + the admin tier view)
          </span>
        </span>
        <textarea
          value={tier.description}
          onChange={(e) => onChange({ ...tier, description: e.target.value })}
          rows={3}
          placeholder="E.g. Includes federal + one state, mid-year check-in call, and unlimited Q&A by email."
          style={{
            padding: '8px 10px',
            fontSize: 13,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            background: tokens.color.surface,
            color: tokens.color.text,
            resize: 'vertical',
            fontFamily: tokens.font.body,
            boxSizing: 'border-box',
            width: '100%',
          }}
        />
      </label>
      <Input
        label="Hours covered"
        type="number"
        step={0.25}
        min={0}
        value={tier.hours}
        onChange={(e) => onChange({ ...tier, hours: Number(e.target.value) })}
      />
      <Input
        label="Base fee ($)"
        type="number"
        step="0.01"
        min={0}
        value={centsToDollarsInput(tier.baseFeeCents)}
        onChange={(e) =>
          onChange({ ...tier, baseFeeCents: dollarsInputToCents(e.target.value) ?? 0 })
        }
      />
      <Input
        label="Pct of prep fee (basis points, 100 = 1%)"
        type="number"
        step={1}
        min={0}
        max={10000}
        value={tier.pctOfPrepFeeBps}
        onChange={(e) =>
          onChange({
            ...tier,
            pctOfPrepFeeBps: Math.max(0, Math.min(10000, Number(e.target.value))),
          })
        }
      />
      <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={tier.isActive}
          onChange={(e) => onChange({ ...tier, isActive: e.target.checked })}
        />
        Active
      </label>
      <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '4px 0 0 0' }}>
        Example: $1,500 basis → <strong>${(previewCents / 100).toFixed(2)}</strong>
      </p>
      <fieldset
        style={{
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.sm,
          padding: 8,
        }}
      >
        <legend style={{ fontSize: 11, padding: '0 4px', color: tokens.color.textMuted }}>
          Eligible work codes
        </legend>
        <WorkCodeMultiSelect
          value={tier.eligibleWorkCodeIds}
          workCodes={workCodes}
          onChange={(ids) => onChange({ ...tier, eligibleWorkCodeIds: ids })}
        />
      </fieldset>
    </div>
  );
}

function WorkCodeMultiSelect({
  value,
  workCodes,
  onChange,
}: {
  value: string[];
  workCodes: WorkCode[];
  onChange: (ids: string[]) => void;
}): JSX.Element {
  function toggle(id: string): void {
    if (value.includes(id)) onChange(value.filter((x) => x !== id));
    else onChange([...value, id]);
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {workCodes.length === 0 ? (
        <span style={{ fontSize: 12, color: tokens.color.textMuted }}>No work codes defined.</span>
      ) : (
        workCodes.map((wc) => {
          const on = value.includes(wc.id);
          return (
            <button
              key={wc.id}
              type="button"
              onClick={() => toggle(wc.id)}
              style={{
                padding: '4px 10px',
                fontSize: 12,
                borderRadius: tokens.radius.sm,
                border: `1px solid ${on ? tokens.color.accent : tokens.color.border}`,
                background: on ? tokens.color.accent : tokens.color.surface,
                color: on ? '#fff' : tokens.color.text,
                cursor: 'pointer',
              }}
            >
              {wc.name}
            </button>
          );
        })
      )}
    </div>
  );
}
