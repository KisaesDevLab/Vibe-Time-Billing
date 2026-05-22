// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { centsToDollarsInput, dollarsInputToCents } from '../../lib/money';

const FEE_STRUCTURES = [
  'HOURLY',
  'HOURLY_NTE',
  'FIXED_FEE',
  'FIXED_FEE_WITH_MILESTONES',
  'RECURRING_SUBSCRIPTION',
] as const;
type FeeStructure = (typeof FEE_STRUCTURES)[number];

const ALLOCATION_METHODS = [
  'SPECIFIC_ENTRIES',
  'PRO_RATA_BY_VALUE',
  'PRO_RATA_BY_HOURS',
  'PARTNER_ABSORBS',
  'HIERARCHICAL_CASCADE',
  'CUSTOM_WEIGHTED',
] as const;
type AllocationMethod = (typeof ALLOCATION_METHODS)[number];

interface Firm {
  id: string;
  name: string;
  fiscalYearStartMonth: number;
  defaultAllocationMethod: AllocationMethod;
  defaultTermsDays: number;
}

interface Settings {
  adjustmentApprovalThresholdCents: number;
  aiMonthlyBudgetCents: number;
  stepUpTimeoutMinutes: number;
  lateEntryAlertDays: number;
  lateEntryLockoutDays: number;
  invoiceNumberingPrefix: string;
  portalEnabled: boolean;
  portalSubdomain: string | null;
  timeEntryRoundingHours: string;
  brandDisplayName: string | null;
  brandLogoUrl: string | null;
  brandAccentColor: string | null;
  brandSupportEmail: string | null;
  brandSupportPhone: string | null;
  brandFooterHtml: string | null;
  enabledFeeStructures: FeeStructure[];
  billableTargetHoursPerMonth: number;
  aiProvider: 'local' | 'cloud' | null;
  invoiceTemplateStyle: 'modern' | 'classic' | 'minimal';
  // v2 — firm-wide default for the surcharge line label.
  defaultSurchargeLabel: string;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function FirmSettingsPage(): JSX.Element {
  const [s, setS] = useState<Settings | null>(null);
  const [f, setF] = useState<Firm | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ firm: Firm; settings: Settings }>('/api/staff/admin/firm-settings');
        setS(r.settings);
        setF(r.firm);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!s || !f) return;
    setSaving(true);
    setError(null);
    try {
      await api('/api/staff/admin/firm-settings', {
        method: 'PATCH',
        body: JSON.stringify({
          adjustmentApprovalThresholdCents: s.adjustmentApprovalThresholdCents,
          aiMonthlyBudgetCents: s.aiMonthlyBudgetCents,
          stepUpTimeoutMinutes: s.stepUpTimeoutMinutes,
          lateEntryAlertDays: s.lateEntryAlertDays,
          lateEntryLockoutDays: s.lateEntryLockoutDays,
          invoiceNumberingPrefix: s.invoiceNumberingPrefix,
          portalEnabled: s.portalEnabled,
          portalSubdomain: s.portalSubdomain || null,
          enabledFeeStructures: s.enabledFeeStructures,
          billableTargetHoursPerMonth: s.billableTargetHoursPerMonth,
          aiProvider: s.aiProvider,
          invoiceTemplateStyle: s.invoiceTemplateStyle,
          defaultSurchargeLabel: s.defaultSurchargeLabel,
          brandDisplayName: s.brandDisplayName || null,
          brandLogoUrl: s.brandLogoUrl || null,
          brandAccentColor: s.brandAccentColor || null,
          brandSupportEmail: s.brandSupportEmail || null,
          brandSupportPhone: s.brandSupportPhone || null,
          brandFooterHtml: s.brandFooterHtml || null,
          // Firm-table fields — server splits the body across tables.
          defaultAllocationMethod: f.defaultAllocationMethod,
          fiscalYearStartMonth: f.fiscalYearStartMonth,
          defaultTermsDays: f.defaultTermsDays,
        }),
      });
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p style={{ color: tokens.color.textMuted }}>Loading…</p>;
  if (!s || !f)
    return <p style={{ color: tokens.color.danger }}>{error ?? 'Settings unavailable'}</p>;

  function toggleFee(fee: FeeStructure): void {
    if (!s) return;
    const has = s.enabledFeeStructures.includes(fee);
    if (has && s.enabledFeeStructures.length === 1) return; // never drop to 0
    setS({
      ...s,
      enabledFeeStructures: has
        ? s.enabledFeeStructures.filter((x) => x !== fee)
        : [...s.enabledFeeStructures, fee],
    });
  }

  return (
    <form onSubmit={save} style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 720 }}>
      <Card title="Firm">
        <div style={{ display: 'grid', gap: 16, maxWidth: 480 }}>
          <Select
            label="Default allocation method (Phase 12 fallback)"
            value={f.defaultAllocationMethod}
            onChange={(v) => setF({ ...f, defaultAllocationMethod: v as AllocationMethod })}
            options={ALLOCATION_METHODS.map((m) => ({ value: m, label: m.replace(/_/g, ' ') }))}
          />
          <Select
            label="Fiscal year starts in"
            value={String(f.fiscalYearStartMonth)}
            onChange={(v) => setF({ ...f, fiscalYearStartMonth: Number(v) })}
            options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))}
          />
          <Input
            label="Default invoice terms (days)"
            type="number"
            min={0}
            max={365}
            value={f.defaultTermsDays}
            onChange={(e) => setF({ ...f, defaultTermsDays: Number(e.target.value) })}
          />
        </div>
      </Card>

      <Card title="Engagement defaults">
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ fontSize: 13 }}>
            <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 6 }}>
              Enabled fee structures — engagement-create dropdown filters by these
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {FEE_STRUCTURES.map((fee) => {
                const on = s.enabledFeeStructures.includes(fee);
                return (
                  <button
                    key={fee}
                    type="button"
                    onClick={() => toggleFee(fee)}
                    style={{
                      padding: '4px 10px',
                      borderRadius: tokens.radius.pill,
                      border: `1px solid ${on ? tokens.color.accent : tokens.color.border}`,
                      background: on ? tokens.color.accentMuted : 'transparent',
                      color: on ? tokens.color.text : tokens.color.textMuted,
                      cursor: 'pointer',
                      fontSize: 12,
                    }}
                  >
                    {fee.replace(/_/g, ' ')}
                  </button>
                );
              })}
            </div>
          </div>
          <Input
            label="Firm-wide billable target (hrs/month)"
            type="number"
            min={40}
            max={220}
            value={s.billableTargetHoursPerMonth}
            onChange={(e) => setS({ ...s, billableTargetHoursPerMonth: Number(e.target.value) })}
          />
          <Input
            label="Default invoice surcharge label"
            type="text"
            value={s.defaultSurchargeLabel ?? ''}
            placeholder="e.g. Technology fee"
            onChange={(e) => setS({ ...s, defaultSurchargeLabel: e.target.value })}
            hint="Shown on invoices when an engagement has surcharge enabled but no override label."
          />
        </div>
      </Card>

      <Card
        title="Approvals + auth + AI"
        action={
          <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
            locked decisions from QUESTIONS.md
          </span>
        }
      >
        <div style={{ display: 'grid', gap: 16, maxWidth: 480 }}>
          <Input
            label="Adjustment approval threshold ($) — Q27"
            type="text"
            inputMode="decimal"
            value={centsToDollarsInput(s.adjustmentApprovalThresholdCents)}
            onChange={(e) =>
              setS({
                ...s,
                adjustmentApprovalThresholdCents:
                  dollarsInputToCents(e.target.value) ?? s.adjustmentApprovalThresholdCents,
              })
            }
          />
          <Input
            label="AI monthly budget ($) — Q14"
            type="text"
            inputMode="decimal"
            value={centsToDollarsInput(s.aiMonthlyBudgetCents)}
            onChange={(e) =>
              setS({
                ...s,
                aiMonthlyBudgetCents: dollarsInputToCents(e.target.value) ?? s.aiMonthlyBudgetCents,
              })
            }
          />
          <Select
            label="AI provider preference — Q15 / Phase 23 #6"
            value={s.aiProvider ?? ''}
            onChange={(v) => setS({ ...s, aiProvider: v === '' ? null : (v as 'local' | 'cloud') })}
            options={[
              { value: '', label: 'Default (local-first)' },
              { value: 'local', label: 'Force local (Ollama)' },
              { value: 'cloud', label: 'Force cloud (Anthropic)' },
            ]}
          />
          <Input
            label="Step-up TOTP timeout (minutes) — Q4"
            type="number"
            value={s.stepUpTimeoutMinutes}
            onChange={(e) => setS({ ...s, stepUpTimeoutMinutes: Number(e.target.value) })}
          />
        </div>
      </Card>

      <Card title="Time entry">
        <div style={{ display: 'grid', gap: 12, maxWidth: 480 }}>
          <Input
            label="Late-entry alert (days)"
            type="number"
            min={1}
            max={90}
            value={s.lateEntryAlertDays}
            onChange={(e) => setS({ ...s, lateEntryAlertDays: Number(e.target.value) })}
          />
          <Input
            label="Late-entry lockout (days)"
            type="number"
            min={1}
            max={365}
            value={s.lateEntryLockoutDays}
            onChange={(e) => setS({ ...s, lateEntryLockoutDays: Number(e.target.value) })}
          />
          <Input
            label="Invoice numbering prefix"
            value={s.invoiceNumberingPrefix}
            onChange={(e) => setS({ ...s, invoiceNumberingPrefix: e.target.value })}
            placeholder="INV"
          />
        </div>
      </Card>

      <Card
        title="Portal"
        action={
          s.portalEnabled ? (
            <Pill tone="success">enabled</Pill>
          ) : (
            <Pill tone="warning">disabled</Pill>
          )
        }
      >
        <div style={{ display: 'grid', gap: 12, maxWidth: 480 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
            <input
              type="checkbox"
              checked={s.portalEnabled}
              onChange={(e) => setS({ ...s, portalEnabled: e.target.checked })}
            />
            Portal enabled
          </label>
          <Input
            label="Portal subdomain (Q10)"
            value={s.portalSubdomain ?? ''}
            onChange={(e) => setS({ ...s, portalSubdomain: e.target.value || null })}
            placeholder="portal"
          />
          <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: 0 }}>
            Used by Caddy routing templates. e.g. &ldquo;portal&rdquo; → portal.firm.com.
          </p>
        </div>
      </Card>

      <Card title="Branding">
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          Used on invoice PDFs, the client portal header, and dunning emails.
        </p>
        <div style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
          <Select
            label="Invoice template style"
            value={s.invoiceTemplateStyle}
            onChange={(v) =>
              setS({ ...s, invoiceTemplateStyle: v as 'modern' | 'classic' | 'minimal' })
            }
            options={[
              { value: 'modern', label: 'Modern (default — accent rule, two-column header)' },
              { value: 'classic', label: 'Classic (centered firm block, serif body)' },
              { value: 'minimal', label: 'Minimal (large total callout, single column)' },
            ]}
          />
          <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: 0 }}>
            Preview any invoice with <code>?style=classic</code> or <code>?style=minimal</code> on
            the PDF URL.
          </p>
          <Input
            label="Display name"
            value={s.brandDisplayName ?? ''}
            onChange={(e) => setS({ ...s, brandDisplayName: e.target.value })}
            placeholder="Smith & Associates, CPA"
          />
          <Input
            label="Logo URL"
            type="url"
            value={s.brandLogoUrl ?? ''}
            onChange={(e) => setS({ ...s, brandLogoUrl: e.target.value })}
            placeholder="https://cdn.example.com/logo.png"
          />
          <Input
            label="Accent color (hex)"
            value={s.brandAccentColor ?? ''}
            onChange={(e) => setS({ ...s, brandAccentColor: e.target.value })}
            placeholder="#0f6cbd"
          />
          <Input
            label="Support email"
            type="email"
            value={s.brandSupportEmail ?? ''}
            onChange={(e) => setS({ ...s, brandSupportEmail: e.target.value })}
            placeholder="[email protected]"
          />
          <Input
            label="Support phone"
            value={s.brandSupportPhone ?? ''}
            onChange={(e) => setS({ ...s, brandSupportPhone: e.target.value })}
            placeholder="(555) 555-5555"
          />
          <label style={{ fontSize: 13 }}>
            Footer HTML (rendered on invoice PDFs)
            <textarea
              value={s.brandFooterHtml ?? ''}
              onChange={(e) => setS({ ...s, brandFooterHtml: e.target.value })}
              rows={3}
              style={{
                marginTop: 4,
                width: '100%',
                fontFamily: tokens.font.mono,
                fontSize: 12,
                padding: 8,
                borderRadius: tokens.radius.sm,
                border: `1px solid ${tokens.color.border}`,
                background: tokens.color.surface,
                color: tokens.color.text,
              }}
            />
          </label>
        </div>
      </Card>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {savedAt && (
          <span style={{ fontSize: 12, color: tokens.color.success }}>
            Saved at {new Date(savedAt).toLocaleTimeString()}
          </span>
        )}
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
      </div>
    </form>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}): JSX.Element {
  return (
    <label style={{ fontSize: 13 }}>
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          marginTop: 4,
          padding: '8px 10px',
          width: '100%',
          background: tokens.color.surface,
          color: tokens.color.text,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.sm,
          fontSize: 13,
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
