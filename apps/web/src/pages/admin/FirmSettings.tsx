// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import {
  NAMING_SLOTS,
  SAMPLE_NAMING_FIELDS,
  composeFilename,
  validatePattern,
} from '@vibe/core/filer';
import { centsToDollarsInput, dollarsInputToCents } from '../../lib/money';
import { BrandingUpload } from './BrandingUpload';

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
  // 0223 — AI file naming (router-mode only).
  autoRenameUploads: boolean;
  fileNamingPattern: string;
  fileNamingExamples: string;
  fileNamingMinConfidence: number;
  aiMonthlyBudgetCents: number;
  estimatedLaborPct: number;
  dropoffDueOffsetDays: number | null;
  // 0235 — engagement video retention defaults (null = that clock off).
  videoDefaultDeleteAfterDays: number | null;
  videoDefaultDeleteDaysAfterPlay: number | null;
  stepUpTimeoutMinutes: number;
  staffSecondFactorRequired: boolean;
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
  brandSupportFax: string | null;
  brandSupportWeb: string | null;
  mailingStreet1: string | null;
  mailingStreet2: string | null;
  mailingCity: string | null;
  mailingState: string | null;
  mailingPostal: string | null;
  mailingCountry: string | null;
  brandFooterHtml: string | null;
  enabledFeeStructures: FeeStructure[];
  billableTargetHoursPerMonth: number;
  aiProvider: 'local' | 'cloud' | null;
  invoiceTemplateStyle: 'modern' | 'classic' | 'minimal';
  // Cloudflare Turnstile (public intake CAPTCHA). Secret is write-only; the
  // API returns only whether one is saved.
  turnstileSiteKey: string | null;
  turnstileSecretSet?: boolean;
  // v2 — firm-wide default for the surcharge line label.
  defaultSurchargeLabel: string;
  // 0053 — Billing + A/R
  arTermsText: string | null;
  statementEmailMessage: string | null;
  defaultStatementFormat: string;
  achProcessingEnabled: boolean;
  creditCardProcessingEnabled: boolean;
  assessServiceChargesEnabled: boolean;
  serviceChargeRateBps: number;
  dunningMessage1: string | null;
  dunningMessage2: string | null;
  dunningMessage3: string | null;
  dunningMessage4: string | null;
  dunningMessage5: string | null;
  // 0178 — AI pricing-suggestion knobs.
  pricingEconomicSource: string;
  pricingEconomicManualPct: string;
  pricingTargetMarginPct: string;
  pricingExpectedHoursStat: string;
  pricingCohortMin: number;
  pricingBurdenedCostPerTier: Record<string, number>;
  pricingAllowLlmAdjust: boolean;
}

const PRICING_TIERS = ['PARTNER', 'MANAGER', 'REVIEWER', 'PREPARER', 'STAFF'] as const;

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

type EsignProvider = 'native' | 'opensign';

// 0054 — statement layouts the renderer supports. One today; add
// entries here (and to the renderer + the admin zod enum) as more
// formats land.
const STATEMENT_FORMAT_OPTIONS = [
  { value: 'detailed_open_amounts', label: 'Detailed — open items with aging (default)' },
];

export function FirmSettingsPage(): JSX.Element {
  const [s, setS] = useState<Settings | null>(null);
  const [f, setF] = useState<Firm | null>(null);
  // Q35 — e-sign provider (firm_settings_proposals.esign_provider).
  const [esignProvider, setEsignProvider] = useState<EsignProvider>('native');
  const [openSignAvailable, setOpenSignAvailable] = useState(false);
  // 0223 — AI file naming section only makes sense on the router.
  const [aiMode, setAiMode] = useState<'direct' | 'router'>('direct');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  // Write-only Turnstile secret entry (the API never returns the stored one).
  const [turnstileSecret, setTurnstileSecret] = useState('');
  const [unlockMode, setUnlockMode] = useState<'sealed-on-disk' | 'admin-passphrase' | 'unknown'>(
    'unknown',
  );

  async function refreshSettings(): Promise<void> {
    const r = await api<{
      firm: Firm;
      settings: Settings;
      esignProvider?: EsignProvider;
      openSignAvailable?: boolean;
      aiMode?: 'direct' | 'router';
    }>('/api/staff/admin/firm-settings');
    setS(r.settings);
    setF(r.firm);
    setAiMode(r.aiMode ?? 'direct');
    setEsignProvider(r.esignProvider ?? 'native');
    setOpenSignAvailable(Boolean(r.openSignAvailable));
  }

  useEffect(() => {
    void (async () => {
      try {
        await refreshSettings();
        try {
          const status = await api<{
            locked: boolean;
            mode: 'sealed-on-disk' | 'admin-passphrase' | 'unknown';
          }>('/api/staff/admin/unlock/status');
          setUnlockMode(status.mode);
        } catch {
          // status endpoint failures aren't fatal — the Security card just hides.
        }
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
          ...(aiMode === 'router'
            ? {
                autoRenameUploads: s.autoRenameUploads,
                fileNamingPattern: s.fileNamingPattern,
                fileNamingExamples: s.fileNamingExamples,
                fileNamingMinConfidence: s.fileNamingMinConfidence,
              }
            : {}),
          estimatedLaborPct: s.estimatedLaborPct,
          dropoffDueOffsetDays: s.dropoffDueOffsetDays,
          videoDefaultDeleteAfterDays: s.videoDefaultDeleteAfterDays,
          videoDefaultDeleteDaysAfterPlay: s.videoDefaultDeleteDaysAfterPlay,
          stepUpTimeoutMinutes: s.stepUpTimeoutMinutes,
          staffSecondFactorRequired: s.staffSecondFactorRequired,
          lateEntryAlertDays: s.lateEntryAlertDays,
          timeEntryRoundingHours: s.timeEntryRoundingHours,
          lateEntryLockoutDays: s.lateEntryLockoutDays,
          invoiceNumberingPrefix: s.invoiceNumberingPrefix,
          portalEnabled: s.portalEnabled,
          portalSubdomain: s.portalSubdomain || null,
          enabledFeeStructures: s.enabledFeeStructures,
          billableTargetHoursPerMonth: s.billableTargetHoursPerMonth,
          aiProvider: s.aiProvider,
          invoiceTemplateStyle: s.invoiceTemplateStyle,
          defaultSurchargeLabel: s.defaultSurchargeLabel,
          turnstileSiteKey: s.turnstileSiteKey || null,
          // Only send the secret when the admin typed a new one (write-only).
          ...(turnstileSecret.trim() ? { turnstileSecret: turnstileSecret.trim() } : {}),
          brandDisplayName: s.brandDisplayName || null,
          brandLogoUrl: s.brandLogoUrl || null,
          brandAccentColor: s.brandAccentColor || null,
          brandSupportEmail: s.brandSupportEmail || null,
          brandSupportPhone: s.brandSupportPhone || null,
          brandSupportFax: s.brandSupportFax || null,
          brandSupportWeb: s.brandSupportWeb || null,
          mailingStreet1: s.mailingStreet1 || null,
          mailingStreet2: s.mailingStreet2 || null,
          mailingCity: s.mailingCity || null,
          mailingState: s.mailingState || null,
          mailingPostal: s.mailingPostal || null,
          mailingCountry: s.mailingCountry || null,
          brandFooterHtml: s.brandFooterHtml || null,
          // 0053 — Billing + A/R
          arTermsText: s.arTermsText || null,
          statementEmailMessage: s.statementEmailMessage || null,
          defaultStatementFormat: s.defaultStatementFormat || 'detailed_open_amounts',
          achProcessingEnabled: s.achProcessingEnabled,
          creditCardProcessingEnabled: s.creditCardProcessingEnabled,
          assessServiceChargesEnabled: s.assessServiceChargesEnabled,
          serviceChargeRateBps: s.serviceChargeRateBps,
          dunningMessage1: s.dunningMessage1 || null,
          dunningMessage2: s.dunningMessage2 || null,
          dunningMessage3: s.dunningMessage3 || null,
          dunningMessage4: s.dunningMessage4 || null,
          dunningMessage5: s.dunningMessage5 || null,
          // 0178 — pricing-suggestion knobs.
          pricingEconomicSource: s.pricingEconomicSource,
          pricingEconomicManualPct: Number(s.pricingEconomicManualPct),
          pricingTargetMarginPct: Number(s.pricingTargetMarginPct),
          pricingExpectedHoursStat: s.pricingExpectedHoursStat,
          pricingCohortMin: s.pricingCohortMin,
          pricingBurdenedCostPerTier: s.pricingBurdenedCostPerTier,
          pricingAllowLlmAdjust: s.pricingAllowLlmAdjust,
          // Firm-table fields — server splits the body across tables.
          name: f.name,
          defaultAllocationMethod: f.defaultAllocationMethod,
          fiscalYearStartMonth: f.fiscalYearStartMonth,
          defaultTermsDays: f.defaultTermsDays,
          // Q35 — e-sign provider (firm_settings_proposals).
          esignProvider,
        }),
      });
      setSavedAt(Date.now());
      if (turnstileSecret.trim()) {
        setTurnstileSecret('');
        await refreshSettings(); // pick up turnstileSecretSet
      }
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
          <Input
            label="Firm name"
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            required
          />
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
            label="Estimated labor % (recurring rollforward budgeting)"
            type="number"
            min={1}
            max={100}
            value={s.estimatedLaborPct}
            onChange={(e) =>
              setS({ ...s, estimatedLaborPct: Math.max(1, Math.min(100, Number(e.target.value))) })
            }
          />
          <Input
            label="Auto due date: days after drop-off (blank = off)"
            type="number"
            min={0}
            max={365}
            value={s.dropoffDueOffsetDays ?? ''}
            placeholder="e.g. 14"
            onChange={(e) =>
              setS({
                ...s,
                dropoffDueOffsetDays:
                  e.target.value === '' ? null : Math.max(0, Math.min(365, Number(e.target.value))),
              })
            }
          />
          <Input
            label="Videos: delete N days after upload (blank = no limit)"
            type="number"
            min={1}
            max={3650}
            value={s.videoDefaultDeleteAfterDays ?? ''}
            placeholder="e.g. 30"
            hint="Default for new engagement videos; staff can change it per video."
            onChange={(e) =>
              setS({
                ...s,
                videoDefaultDeleteAfterDays:
                  e.target.value === ''
                    ? null
                    : Math.max(1, Math.min(3650, Number(e.target.value))),
              })
            }
          />
          <Input
            label="Videos: delete M days after first play (blank = no limit)"
            type="number"
            min={1}
            max={3650}
            value={s.videoDefaultDeleteDaysAfterPlay ?? ''}
            placeholder="e.g. 3"
            hint="Whichever clock ends first removes the video."
            onChange={(e) =>
              setS({
                ...s,
                videoDefaultDeleteDaysAfterPlay:
                  e.target.value === ''
                    ? null
                    : Math.max(1, Math.min(3650, Number(e.target.value))),
              })
            }
          />
          <Input
            label="Step-up TOTP timeout (minutes) — Q4"
            type="number"
            value={s.stepUpTimeoutMinutes}
            onChange={(e) => setS({ ...s, stepUpTimeoutMinutes: Number(e.target.value) })}
          />
          <div style={{ display: 'grid', gap: 4 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
              <input
                type="checkbox"
                checked={s.staffSecondFactorRequired}
                onChange={(e) => setS({ ...s, staffSecondFactorRequired: e.target.checked })}
              />
              Require a second factor for staff sign-in
            </label>
            <span style={{ fontSize: 12, color: tokens.color.textMuted, paddingLeft: 24 }}>
              When off, a correct password signs staff in directly and sensitive actions skip the
              step-up prompt. Only disable this on a fully internal deployment that is not reachable
              from the internet.
            </span>
          </div>
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

      <Card
        title="E-signature"
        action={
          <Pill tone={esignProvider === 'opensign' ? 'success' : 'neutral'}>
            {esignProvider === 'opensign' ? 'OpenSign' : 'Native'}
          </Pill>
        }
      >
        <div style={{ display: 'grid', gap: 12, maxWidth: 480 }}>
          <Select
            label="Proposal e-signature provider"
            value={esignProvider}
            onChange={(v) => setEsignProvider(v as EsignProvider)}
            options={[
              { value: 'native', label: 'Native (typed name / drawn signature — default)' },
              ...(openSignAvailable
                ? [{ value: 'opensign', label: 'OpenSign (self-hosted sidecar)' }]
                : []),
            ]}
          />
          <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: 0 }}>
            Native signs inline in the client portal. OpenSign delegates signing to the self-hosted
            OpenSign sidecar over the private docker network; the client confirms payment in our
            portal, then signs in OpenSign&rsquo;s UI.
            {!openSignAvailable &&
              ' OpenSign is not configured on this appliance (set OPENSIGN_URL to enable it).'}
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
          <BrandingUpload
            kind="logo"
            label="Logo (wide)"
            help="Shown on the portal header, shared pages, and invoice/statement PDFs. Use a transparent PNG or SVG ~600px+ wide; it scales down automatically."
            onChanged={() => void refreshSettings()}
          />
          <Input
            label="…or paste a logo URL"
            type="url"
            value={s.brandLogoUrl ?? ''}
            onChange={(e) => setS({ ...s, brandLogoUrl: e.target.value })}
            placeholder="https://cdn.example.com/logo.png"
          />
          <BrandingUpload
            kind="icon"
            label="App icon (square)"
            help="Used for the installable portal app icon (home screen + notifications). Upload a square PNG ≥512×512; we generate the required sizes. Optional — falls back to a generated accent-color icon."
            onChanged={() => void refreshSettings()}
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
          <Input
            label="Support fax"
            value={s.brandSupportFax ?? ''}
            onChange={(e) => setS({ ...s, brandSupportFax: e.target.value })}
            placeholder="(555) 555-5556"
          />
          <Input
            label="Website"
            value={s.brandSupportWeb ?? ''}
            onChange={(e) => setS({ ...s, brandSupportWeb: e.target.value })}
            placeholder="www.example.com"
          />
          <div
            style={{
              gridColumn: '1 / -1',
              fontSize: 12,
              fontWeight: 600,
              color: tokens.color.textMuted,
              marginTop: 4,
            }}
          >
            Mailing address (used on invoices, statements &amp; letters)
          </div>
          <Input
            label="Street"
            value={s.mailingStreet1 ?? ''}
            onChange={(e) => setS({ ...s, mailingStreet1: e.target.value })}
            placeholder="123 Main St"
          />
          <Input
            label="Street 2 (suite, etc.)"
            value={s.mailingStreet2 ?? ''}
            onChange={(e) => setS({ ...s, mailingStreet2: e.target.value })}
            placeholder="Suite 200"
          />
          <Input
            label="City"
            value={s.mailingCity ?? ''}
            onChange={(e) => setS({ ...s, mailingCity: e.target.value })}
            placeholder="Springfield"
          />
          <Input
            label="State / province"
            value={s.mailingState ?? ''}
            onChange={(e) => setS({ ...s, mailingState: e.target.value })}
            placeholder="IL"
          />
          <Input
            label="ZIP / postal code"
            value={s.mailingPostal ?? ''}
            onChange={(e) => setS({ ...s, mailingPostal: e.target.value })}
            placeholder="62704"
          />
          <Input
            label="Country"
            value={s.mailingCountry ?? ''}
            onChange={(e) => setS({ ...s, mailingCountry: e.target.value })}
            placeholder="USA"
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

      <Card title="Document intake — CAPTCHA">
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          Protect the public document-intake form with Cloudflare Turnstile. Create a widget at{' '}
          <a
            href="https://dash.cloudflare.com/?to=/:account/turnstile"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: tokens.color.accent }}
          >
            Cloudflare → Turnstile
          </a>{' '}
          and paste the site key + secret here. Leave both blank to disable.
        </p>
        <div style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
          <Input
            label="Turnstile site key"
            value={s.turnstileSiteKey ?? ''}
            onChange={(e) => setS({ ...s, turnstileSiteKey: e.target.value })}
            placeholder="0x4AAAAAAA…"
          />
          <Input
            label={
              s.turnstileSecretSet
                ? 'Turnstile secret (saved · enter to replace)'
                : 'Turnstile secret'
            }
            type="password"
            value={turnstileSecret}
            onChange={(e) => setTurnstileSecret(e.target.value)}
            placeholder={s.turnstileSecretSet ? '••••••••' : '0x4AAAAAAA…'}
          />
          <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: 0 }}>
            The secret is encrypted at rest and never shown again. CAPTCHA activates once both the
            site key and secret are saved.
          </p>
        </div>
      </Card>

      {/* 0178 — AI pricing-suggestion knobs. The engine picks the number
          deterministically; these only tune the inputs. */}
      {aiMode === 'router' && (
        <Card title="AI file naming">
          <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
            Available because AI requests go through the Vibe AI Router. Names are proposed from
            each document&apos;s contents and composed from the pattern below, so the model never
            invents a filename. Originals are kept and any AI rename can be reverted.
          </p>
          <div style={{ display: 'grid', gap: 14, maxWidth: 620 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
              <input
                type="checkbox"
                checked={s.autoRenameUploads}
                onChange={(e) => setS({ ...s, autoRenameUploads: e.target.checked })}
              />
              Automatically rename client uploads on arrival (portal, intake, staff uploads)
            </label>
            <div>
              <Input
                label="Naming pattern"
                value={s.fileNamingPattern}
                onChange={(e) => setS({ ...s, fileNamingPattern: e.target.value })}
              />
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {NAMING_SLOTS.map((slot) => (
                  <button
                    key={slot}
                    type="button"
                    onClick={() =>
                      setS({ ...s, fileNamingPattern: `${s.fileNamingPattern} {${slot}}`.trim() })
                    }
                    style={{
                      fontSize: 11,
                      fontFamily: tokens.font.mono,
                      padding: '2px 8px',
                      borderRadius: 999,
                      border: `1px solid ${tokens.color.border}`,
                      background: tokens.color.surface,
                      color: tokens.color.text,
                      cursor: 'pointer',
                    }}
                  >
                    {`{${slot}}`}
                  </button>
                ))}
              </div>
              {(() => {
                const v = validatePattern(s.fileNamingPattern);
                return v.ok ? (
                  <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '6px 0 0' }}>
                    Preview:{' '}
                    <code>
                      {composeFilename(s.fileNamingPattern, SAMPLE_NAMING_FIELDS, 'scan0023.pdf')}
                    </code>
                  </p>
                ) : (
                  <p style={{ fontSize: 12, color: tokens.color.danger, margin: '6px 0 0' }}>
                    {v.error.replace(/_/g, ' ')}
                  </p>
                );
              })()}
            </div>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              <span>Examples the AI is shown (one per line)</span>
              <textarea
                rows={4}
                value={s.fileNamingExamples}
                onChange={(e) => setS({ ...s, fileNamingExamples: e.target.value })}
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 12,
                  padding: 8,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  background: tokens.color.surface,
                  color: tokens.color.text,
                }}
              />
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
              Auto-rename only when confidence is at least
              <input
                type="number"
                min={0}
                max={100}
                step={5}
                value={Math.round(s.fileNamingMinConfidence * 100)}
                onChange={(e) =>
                  setS({
                    ...s,
                    fileNamingMinConfidence:
                      Math.max(0, Math.min(100, Number(e.target.value))) / 100,
                  })
                }
                style={{ width: 70 }}
              />
              %
              <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                (below this the suggestion is kept for one-click apply)
              </span>
            </label>
          </div>
        </Card>
      )}

      <Card title="Pricing suggestion">
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          Drives the on-demand pricing suggestion on engagements. The number is computed by a
          deterministic engine (cost build → gross margin → economic factor); these settings only
          tune its inputs.
        </p>
        <div style={{ display: 'grid', gap: 16, maxWidth: 480 }}>
          <Select
            label="Economic factor source"
            value={s.pricingEconomicSource}
            onChange={(v) => setS({ ...s, pricingEconomicSource: v })}
            options={[
              { value: 'MANUAL', label: 'Manual annual % (no network)' },
              { value: 'CPI', label: 'CPI (live, requires egress)' },
              { value: 'ECI', label: 'ECI — labor (live, requires egress)' },
            ]}
          />
          {s.pricingEconomicSource === 'MANUAL' && (
            <Input
              label="Manual annual increase (%)"
              type="number"
              step="0.01"
              value={s.pricingEconomicManualPct}
              onChange={(e) => setS({ ...s, pricingEconomicManualPct: e.target.value })}
            />
          )}
          <Input
            label="Target gross margin (%) — applied by division, cost ÷ (1 − margin)"
            type="number"
            step="0.01"
            min={0}
            max={99.99}
            value={s.pricingTargetMarginPct}
            onChange={(e) => setS({ ...s, pricingTargetMarginPct: e.target.value })}
          />
          <Select
            label="Expected-hours statistic"
            value={s.pricingExpectedHoursStat}
            onChange={(v) => setS({ ...s, pricingExpectedHoursStat: v })}
            options={[
              { value: 'TRIMMED_MEAN', label: 'Trimmed mean (default)' },
              { value: 'MEDIAN', label: 'Median' },
            ]}
          />
          <Input
            label="Minimum cohort size before the cost build is trusted"
            type="number"
            min={1}
            max={100}
            value={String(s.pricingCohortMin)}
            onChange={(e) => setS({ ...s, pricingCohortMin: Number(e.target.value) })}
          />
          <div>
            <p style={{ fontSize: 13, margin: '0 0 6px' }}>
              Burdened cost rate fallback ($/hour by tier)
            </p>
            <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: '0 0 8px' }}>
              Used only when the cohort has no captured cost rate for a tier.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {PRICING_TIERS.map((tier) => (
                <Input
                  key={tier}
                  label={tier}
                  type="number"
                  min={0}
                  step="1"
                  value={String((s.pricingBurdenedCostPerTier[tier] ?? 0) / 100)}
                  onChange={(e) =>
                    setS({
                      ...s,
                      pricingBurdenedCostPerTier: {
                        ...s.pricingBurdenedCostPerTier,
                        [tier]: Math.round(Number(e.target.value) * 100),
                      },
                    })
                  }
                />
              ))}
            </div>
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={s.pricingAllowLlmAdjust}
              onChange={(e) => setS({ ...s, pricingAllowLlmAdjust: e.target.checked })}
            />
            Allow the LLM to adjust the suggested number (off by default — the LLM normally writes
            only the rationale)
          </label>
        </div>
      </Card>

      {/* 0053 — Billing and A/R block, mirrors legacy Firm settings tab. */}
      <Card title="Billing and A/R">
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          Firm-wide invoice + statement defaults. The A/R Terms text prints at the bottom of every
          invoice PDF; dunning messages feed the automated dunning sweep at each period age.
        </p>
        <div style={{ display: 'grid', gap: 16, maxWidth: 720 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input
              label="Number of days until invoice is due"
              type="number"
              min={0}
              max={365}
              value={f.defaultTermsDays}
              onChange={(e) => setF({ ...f, defaultTermsDays: Number(e.target.value) })}
            />
            <Select
              label="Time entry rounding (hours, firm-wide)"
              value={s.timeEntryRoundingHours}
              onChange={(v) => setS({ ...s, timeEntryRoundingHours: v })}
              options={[
                { value: '0.25', label: '0.25 — quarter hour (default)' },
                { value: '0.10', label: '0.10 — six minutes' },
                { value: '0.00', label: 'No rounding (free decimal)' },
              ]}
            />
          </div>

          <h3
            style={{
              fontSize: 12,
              color: tokens.color.textMuted,
              margin: '12px 0 0',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
          >
            A/R options
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Select
              label="Default statement format (new clients)"
              value={s.defaultStatementFormat || 'detailed_open_amounts'}
              onChange={(v) => setS({ ...s, defaultStatementFormat: v })}
              options={STATEMENT_FORMAT_OPTIONS}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 18 }}>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={s.achProcessingEnabled}
                  onChange={(e) => setS({ ...s, achProcessingEnabled: e.target.checked })}
                />
                Enable ACH processing
              </label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={s.creditCardProcessingEnabled}
                  onChange={(e) => setS({ ...s, creditCardProcessingEnabled: e.target.checked })}
                />
                Enable credit card processing
              </label>
            </div>
          </div>

          <label style={{ fontSize: 13 }}>
            Statement e-mail message
            <textarea
              value={s.statementEmailMessage ?? ''}
              onChange={(e) => setS({ ...s, statementEmailMessage: e.target.value })}
              rows={2}
              placeholder="Standing message attached to outbound statement emails."
              style={textareaStyle}
            />
          </label>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={s.assessServiceChargesEnabled}
                onChange={(e) => setS({ ...s, assessServiceChargesEnabled: e.target.checked })}
              />
              Assess service charges
            </label>
            <span style={{ fontSize: 13, color: tokens.color.textMuted }}>at rate</span>
            <Input
              type="number"
              min={0}
              max={100}
              step={0.01}
              value={(s.serviceChargeRateBps / 100).toString()}
              onChange={(e) =>
                setS({ ...s, serviceChargeRateBps: Math.round(Number(e.target.value) * 100) })
              }
              disabled={!s.assessServiceChargesEnabled}
              style={{ maxWidth: 80 }}
            />
            <span style={{ fontSize: 13, color: tokens.color.textMuted }}>% annually</span>
          </div>

          <h3
            style={{
              fontSize: 12,
              color: tokens.color.textMuted,
              margin: '12px 0 0',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
          >
            Dunning messages
          </h3>
          <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: 0 }}>
            Used by the automated dunning sweep when an invoice ages into each bucket.
          </p>
          {([1, 2, 3, 4, 5] as const).map((n) => {
            const key = `dunningMessage${n}` as
              | 'dunningMessage1'
              | 'dunningMessage2'
              | 'dunningMessage3'
              | 'dunningMessage4'
              | 'dunningMessage5';
            return (
              <Input
                key={n}
                label={n === 5 ? `${n} Periods or older` : `${n} Period${n === 1 ? '' : 's'} old`}
                value={s[key] ?? ''}
                onChange={(e) => setS({ ...s, [key]: e.target.value })}
                placeholder={
                  n === 1
                    ? 'You have a balance over 30 days old. Please remit…'
                    : n === 5
                      ? 'Services are suspended until payment is made.'
                      : ''
                }
              />
            );
          })}

          <label style={{ fontSize: 13 }}>
            A/R Terms (printed at the bottom of every invoice PDF)
            <textarea
              value={s.arTermsText ?? ''}
              onChange={(e) => setS({ ...s, arTermsText: e.target.value })}
              rows={4}
              placeholder="PLEASE MAIL PAYMENTS TO: …  EIN: …  Thank you for your business. Payment is due upon presentation of this invoice. There will be a 1.5% interest charge per month on late invoices…"
              style={textareaStyle}
            />
          </label>
        </div>
      </Card>

      <SecurityCard mode={unlockMode} onMigrated={(m) => setUnlockMode(m)} />

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

const textareaStyle: React.CSSProperties = {
  marginTop: 4,
  width: '100%',
  fontFamily: 'inherit',
  fontSize: 13,
  padding: 8,
  borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.surface,
  color: tokens.color.text,
  boxSizing: 'border-box',
};

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

function SecurityCard({
  mode,
  onMigrated,
}: {
  mode: 'sealed-on-disk' | 'admin-passphrase' | 'unknown';
  onMigrated: (m: 'admin-passphrase') => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [pp, setPp] = useState('');
  const [pp2, setPp2] = useState('');
  const [ack, setAck] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (mode === 'unknown') return null;

  async function migrate(): Promise<void> {
    setErr(null);
    if (pp !== pp2) {
      setErr('passphrases do not match');
      return;
    }
    if (pp.length < 12) {
      setErr('passphrase must be at least 12 characters');
      return;
    }
    if (!ack) {
      setErr('you must acknowledge irreversibility');
      return;
    }
    setBusy(true);
    try {
      await api('/api/staff/admin/unlock/migrate-mode', {
        method: 'POST',
        body: JSON.stringify({
          targetMode: 'admin-passphrase',
          passphrase: pp,
          acknowledgeIrreversible: true,
        }),
      });
      setOpen(false);
      setPp('');
      setPp2('');
      setAck(false);
      onMigrated('admin-passphrase');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'migrate failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Security · Unlock mode">
      <div style={{ display: 'grid', gap: 12, maxWidth: 540 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13 }}>Current mode:</span>
          <Pill tone={mode === 'admin-passphrase' ? 'success' : 'neutral'}>
            {mode === 'sealed-on-disk' ? 'Sealed on disk' : 'Admin passphrase'}
          </Pill>
        </div>
        {mode === 'sealed-on-disk' ? (
          <>
            <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
              Sealed-on-disk keeps the master key on the appliance volume. Switching to
              admin-passphrase requires an operator to enter the passphrase at every boot before the
              API will serve traffic. <strong>This change is one-way</strong> — there is no UI to
              switch back.
            </p>
            {!open ? (
              <Button type="button" onClick={() => setOpen(true)}>
                Switch to admin-passphrase
              </Button>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gap: 10,
                  padding: 12,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  background: tokens.color.surface,
                }}
              >
                <Input
                  label="New passphrase (min 12 chars)"
                  type="password"
                  value={pp}
                  onChange={(e) => setPp(e.target.value)}
                  autoComplete="new-password"
                />
                <Input
                  label="Confirm passphrase"
                  type="password"
                  value={pp2}
                  onChange={(e) => setPp2(e.target.value)}
                  autoComplete="new-password"
                />
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={ack}
                    onChange={(e) => setAck(e.target.checked)}
                    style={{ marginTop: 3 }}
                  />
                  <span>
                    I understand this is irreversible. If the passphrase is lost, the appliance
                    cannot be unlocked and all encrypted firm data becomes unrecoverable.
                  </span>
                </label>
                {err && (
                  <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }}>{err}</p>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button type="button" onClick={migrate} disabled={busy || !ack}>
                    {busy ? 'Migrating…' : 'Confirm migration'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setOpen(false);
                      setErr(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : (
          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
            An operator must enter the firm passphrase at every appliance boot before the API will
            serve traffic. Recovery requires offline access to the original passphrase — there is no
            remote reset.
          </p>
        )}
      </div>
    </Card>
  );
}
