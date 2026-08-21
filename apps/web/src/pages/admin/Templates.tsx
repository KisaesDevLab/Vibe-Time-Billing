// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Template admin (v2 Sprint D). Replaces the read-only starter-pack
// viewer with full CRUD across the three template families:
//   Engagement / Letter / Client
//
// Each tab is a list with edit-in-place + clone + archive. New rows
// go through a small inline create form. The system templates seeded
// at install are marked with a "system" pill — you can clone them but
// editing/archiving leaves the originals intact (UI nicety; the API
// allows editing them too).

import { useEffect, useRef, useState } from 'react';

import { Button, Card, Combobox, Pill, Tabs, tokens } from '@vibe/ui';

const FEE_OPTIONS = [
  { value: 'HOURLY', label: 'Hourly' },
  { value: 'HOURLY_NTE', label: 'Hourly (NTE)' },
  { value: 'FIXED_FEE', label: 'Fixed fee' },
  { value: 'FIXED_FEE_WITH_MILESTONES', label: 'Fixed fee + milestones' },
  { value: 'RECURRING_SUBSCRIPTION', label: 'Recurring subscription' },
];

import { api, getCsrfToken } from '../../api-client';
import { centsToDollarsInput, dollarsInputToCents, percentInputToBps } from '../../lib/money';
import { TemplateLibraryPanel } from './TemplateLibraryPanel';
import {
  RichTextEditor,
  type RichTextApi,
  type RichTextVariable,
} from '../../proposal-editor/RichTextEditor';

// One-click letter building blocks inserted into the editor. Use only
// nodes the WYSIWYG understands (h1/p/strong/br/hr) so they survive Visual
// mode; the address block uses the raw {{{ }}} token for the multi-line
// block. Kept in sync with the server LETTER_TEMPLATE_TOKENS / DEFAULT_LETTER_CSS.
const LETTER_BLOCKS: Array<{ label: string; snippet: string }> = [
  {
    label: 'Letterhead',
    snippet:
      '<h1>{{ firm.name }}</h1><p>{{ firm.support_phone }} · {{ firm.support_email }} · {{ firm.support_web }}</p><hr>',
  },
  {
    label: 'Date',
    snippet: '<p>{{ today }}</p>',
  },
  {
    label: 'Address block',
    snippet:
      '<p><strong>{{ client.display_name }}</strong><br>{{{ client.address_block_html }}}</p>',
  },
  {
    label: 'Greeting',
    snippet: '<p>Dear {{ client.primary_contact }},</p>',
  },
  {
    label: 'Appointment',
    snippet:
      '<p>This confirms your appointment: <strong>{{ appointment.datetime }}</strong> ({{ appointment.location }}).</p>',
  },
  {
    label: 'Drop-off',
    snippet:
      '<p>Please drop off your documents by <strong>{{ client.drop_off_date }}</strong>.</p>',
  },
  {
    label: 'Closing',
    snippet: '<p>Sincerely,</p><p>{{ firm.name }}</p>',
  },
];

// Mirror of the server DEFAULT_LETTER_CSS (apps/api/src/clients/letter-merge.ts)
// so the editor preview matches the merged output for fragment letters.
const DEFAULT_LETTER_CSS = `
@page { size: Letter; margin: 1in; }
body { font: 12pt Georgia, "Times New Roman", serif; color: #1a1a1a; line-height: 1.5; }
h1 { font-family: Arial, Helvetica, sans-serif; font-size: 20pt; margin: 0 0 4px; }
h2 { font-size: 14pt; margin: 18px 0 6px; }
h3 { font-size: 12pt; margin: 14px 0 6px; }
p { margin: 0 0 12px; }
hr { border: none; border-top: 2px solid #1a1a1a; margin: 8px 0 24px; }
ul, ol { margin: 0 0 12px 22px; }
`;

// Merge tokens offered in the letter editor's variable picker. Mirrors the
// server LETTER_TEMPLATE_TOKENS (apps/api/src/clients/letter-merge.ts) —
// the ones that work well from the WYSIWYG (double-brace) editor. The raw
// address-block token needs triple braces, so it's documented but omitted
// from the picker; use the HTML source mode for that.
const LETTER_VARIABLES: RichTextVariable[] = [
  { token: 'client.display_name', label: 'Client display name' },
  { token: 'client.name', label: 'Client legal name' },
  { token: 'client.primary_contact', label: 'Primary contact name' },
  { token: 'client.city_state_zip', label: 'City, State ZIP' },
  { token: 'client.street1', label: 'Street line 1' },
  { token: 'client.city', label: 'City' },
  { token: 'client.state', label: 'State' },
  { token: 'client.postal', label: 'ZIP / postal' },
  { token: 'client.drop_off_date', label: 'Drop-off due date' },
  { token: 'appointment.datetime', label: 'Appointment date & time' },
  { token: 'appointment.date', label: 'Appointment date' },
  { token: 'appointment.time', label: 'Appointment time' },
  { token: 'appointment.title', label: 'Appointment title' },
  { token: 'appointment.location', label: 'Appointment location' },
  { token: 'engagement.name', label: 'Engagement name' },
  { token: 'firm.name', label: 'Firm name' },
  { token: 'firm.support_email', label: 'Firm email' },
  { token: 'firm.support_phone', label: 'Firm phone' },
  { token: 'firm.support_web', label: 'Firm website' },
  { token: 'today', label: "Today's date" },
];

// A stored letter body is a "full document" (has its own letterhead
// <style>/<head>) when it carries these markers — the WYSIWYG editor would
// strip them, so we default such templates to HTML-source mode.
function isFullHtmlDoc(html: string): boolean {
  return /<!doctype|<html|<head|<style/i.test(html);
}

type Kind = 'engagement' | 'letter' | 'client' | 'request' | 'invoice' | 'statement';

type SurchargeType = 'PERCENT' | 'FLAT_AMOUNT';
type RecurrenceFrequency =
  | 'WEEKLY'
  | 'BIWEEKLY'
  | 'MONTHLY'
  | 'QUARTERLY'
  | 'SEMIANNUAL'
  | 'ANNUAL';

type RecurrenceTriggerMode = 'SCHEDULE' | 'ON_COMPLETION';
type EngagementStatus = 'PROPOSED' | 'ACTIVE' | 'PAUSED' | 'CLOSED' | 'ARCHIVED';
const STATUS_OPTIONS: EngagementStatus[] = ['PROPOSED', 'ACTIVE', 'PAUSED', 'CLOSED', 'ARCHIVED'];
const TRIGGER_OPTIONS: { value: RecurrenceTriggerMode; label: string }[] = [
  { value: 'ON_COMPLETION', label: 'When the current one closes' },
  { value: 'SCHEDULE', label: 'On a schedule' },
];

const RECURRENCE_OPTIONS: { value: RecurrenceFrequency; label: string }[] = [
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'BIWEEKLY', label: 'Biweekly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'QUARTERLY', label: 'Quarterly' },
  { value: 'SEMIANNUAL', label: 'Semiannual' },
  { value: 'ANNUAL', label: 'Annual' },
];

interface EngagementTpl {
  id: string;
  key: string;
  name: string;
  defaultFeeStructure: string;
  defaultFeeAmountCents: number | null;
  defaultBudgetHours: string | null;
  defaultLetterTemplateId: string | null;
  defaultRateCodeId: string | null;
  engagementTypeId: string | null;
  // 0083 — Mustache name pattern resolved at engagement-creation time.
  namePattern: string | null;
  // New template defaults — inherited onto engagements created from this
  // template (mirrors the per-engagement controls on EngagementCreate).
  defaultMixedModeEnabled: boolean;
  inScopeWorkCodeIds: string[];
  defaultFeePassthroughEnabled: boolean;
  defaultTaxEnabled: boolean;
  defaultTaxRateBps: number | null;
  defaultTaxLabel: string | null;
  defaultSurchargeEnabled: boolean;
  defaultSurchargeType: SurchargeType | null;
  defaultSurchargeValueBps: number | null;
  defaultSurchargeAmountCents: number | null;
  defaultSurchargeLabel: string | null;
  defaultRecurrenceFrequency: RecurrenceFrequency | null;
  defaultRecurrenceTriggerMode: RecurrenceTriggerMode | null;
  defaultRecurrenceStatus: EngagementStatus | null;
  defaultEngagementStatus: EngagementStatus | null;
  isSystem: boolean;
  status: string;
}

interface WorkCode {
  id: string;
  key: string;
  name: string;
}

interface EngagementType {
  id: string;
  name: string;
  serviceLineId: string | null;
}

interface ServiceLine {
  id: string;
  name: string;
}

interface RateCode {
  id: string;
  code: string;
  active: boolean;
}

interface LetterTpl {
  id: string;
  key: string;
  name: string;
  bodyHtml: string;
  variablesJson: string[] | null;
  pageMargin: string | null;
  isSystem: boolean;
  status: string;
}

interface ClientTpl {
  id: string;
  key: string;
  name: string;
  clientType: 'INDIVIDUAL' | 'BUSINESS';
  defaultsJson: Record<string, unknown>;
  defaultEngagementTemplateIds: string[];
  isSystem: boolean;
  status: string;
}

const fieldStyle: React.CSSProperties = {
  padding: '6px 10px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontSize: 13,
};

function formatCents(c: number | null): string {
  if (c == null) return '—';
  return `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Shared shape for the engagement create/edit drafts. Holds the string
// representations typed in the inputs (dollars, percent) plus the
// new template-default toggles; converted to the API's cents/bps/null
// shape on submit.
interface EngagementDraftFields {
  name: string;
  defaultFeeStructure: string;
  defaultFeeAmountDollars: string;
  defaultBudgetHours: string;
  defaultRateCodeId: string;
  engagementTypeId: string;
  namePattern: string;
  defaultMixedModeEnabled: boolean;
  inScopeWorkCodeIds: string[];
  defaultFeePassthroughEnabled: boolean;
  defaultTaxEnabled: boolean;
  defaultTaxRatePercent: string;
  defaultTaxLabel: string;
  defaultSurchargeEnabled: boolean;
  defaultSurchargeType: SurchargeType;
  defaultSurchargePercent: string;
  defaultSurchargeFlatDollars: string;
  defaultSurchargeLabel: string;
  defaultRecurrenceFrequency: '' | RecurrenceFrequency;
  defaultRecurrenceTriggerMode: '' | RecurrenceTriggerMode;
  defaultRecurrenceStatus: '' | EngagementStatus;
  defaultEngagementStatus: '' | EngagementStatus;
}

const EMPTY_DEFAULTS = {
  defaultMixedModeEnabled: false,
  inScopeWorkCodeIds: [] as string[],
  defaultFeePassthroughEnabled: false,
  defaultTaxEnabled: false,
  defaultTaxRatePercent: '',
  defaultTaxLabel: '',
  defaultSurchargeEnabled: false,
  defaultSurchargeType: 'PERCENT' as SurchargeType,
  defaultSurchargePercent: '',
  defaultSurchargeFlatDollars: '',
  defaultSurchargeLabel: '',
  defaultRecurrenceFrequency: '' as '' | RecurrenceFrequency,
  defaultRecurrenceTriggerMode: '' as '' | RecurrenceTriggerMode,
  defaultRecurrenceStatus: '' as '' | EngagementStatus,
  defaultEngagementStatus: '' as '' | EngagementStatus,
};

// Translate a draft's new-defaults fields into the API payload shape
// (cents/bps/null). Shared by both the create POST and edit PATCH so the
// two paths can't drift.
function draftDefaultsToPayload(d: EngagementDraftFields): Record<string, unknown> {
  return {
    defaultMixedModeEnabled: d.defaultMixedModeEnabled,
    inScopeWorkCodeIds: d.defaultMixedModeEnabled ? d.inScopeWorkCodeIds : [],
    defaultFeePassthroughEnabled: d.defaultFeePassthroughEnabled,
    defaultTaxEnabled: d.defaultTaxEnabled,
    defaultTaxRateBps: d.defaultTaxEnabled
      ? (percentInputToBps(d.defaultTaxRatePercent) ?? 0)
      : null,
    defaultTaxLabel: d.defaultTaxEnabled ? d.defaultTaxLabel.trim() || null : null,
    defaultSurchargeEnabled: d.defaultSurchargeEnabled,
    defaultSurchargeType: d.defaultSurchargeEnabled ? d.defaultSurchargeType : null,
    defaultSurchargeValueBps:
      d.defaultSurchargeEnabled && d.defaultSurchargeType === 'PERCENT'
        ? (percentInputToBps(d.defaultSurchargePercent) ?? 0)
        : null,
    defaultSurchargeAmountCents:
      d.defaultSurchargeEnabled && d.defaultSurchargeType === 'FLAT_AMOUNT'
        ? (dollarsInputToCents(d.defaultSurchargeFlatDollars) ?? 0)
        : null,
    defaultSurchargeLabel: d.defaultSurchargeEnabled
      ? d.defaultSurchargeLabel.trim() || null
      : null,
    defaultRecurrenceFrequency: d.defaultRecurrenceFrequency || null,
    // Trigger only matters when a frequency is set; default to ON_COMPLETION
    // (no next-run date needed) so the recurrence is complete on apply.
    defaultRecurrenceTriggerMode: d.defaultRecurrenceFrequency
      ? d.defaultRecurrenceTriggerMode || 'ON_COMPLETION'
      : null,
    // Spawned-engagement status only matters when a recurrence is set.
    defaultRecurrenceStatus: d.defaultRecurrenceFrequency
      ? d.defaultRecurrenceStatus || null
      : null,
    // Default status for a NEW engagement created from this template (not
    // gated on recurrence).
    defaultEngagementStatus: d.defaultEngagementStatus || null,
  };
}

export function TemplatesPage(): JSX.Element {
  const [kind, setKind] = useState<Kind>('engagement');
  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Tabs
        tabs={[
          { key: 'engagement', label: 'Engagement templates' },
          { key: 'letter', label: 'Letter templates' },
          { key: 'client', label: 'Client templates' },
          { key: 'request', label: 'Request templates' },
          { key: 'invoice', label: 'Invoice template' },
          { key: 'statement', label: 'Statement template' },
        ]}
        active={kind}
        onChange={(k) => setKind(k as Kind)}
      />
      {kind === 'engagement' && <EngagementTab />}
      {kind === 'letter' && <LetterTab />}
      {kind === 'client' && <ClientTab />}
      {kind === 'request' && <RequestTab />}
      {kind === 'invoice' && <InvoiceTab />}
      {kind === 'statement' && <StatementTab />}
    </div>
  );
}

function EngagementTab(): JSX.Element {
  const [items, setItems] = useState<EngagementTpl[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // QA fix — these string drafts now hold the *dollars* representation
  // typed in the input ("750.00"), not the cents string ("75000"). We
  // translate via dollarsInputToCents on submit. Earlier the field said
  // "Fee (cents)" and accepted 75000 to mean $750 which was confusing
  // for any user not steeped in the storage shape.
  const [rateCodes, setRateCodes] = useState<RateCode[]>([]);
  const [engagementTypes, setEngagementTypes] = useState<EngagementType[]>([]);
  const [serviceLines, setServiceLines] = useState<ServiceLine[]>([]);
  const [workCodes, setWorkCodes] = useState<WorkCode[]>([]);
  const [editDraft, setEditDraft] = useState<EngagementDraftFields>({
    ...EMPTY_DEFAULTS,
    name: '',
    defaultFeeStructure: 'FIXED_FEE',
    defaultFeeAmountDollars: '',
    defaultBudgetHours: '',
    defaultRateCodeId: '',
    engagementTypeId: '',
    namePattern: '',
  });
  const [draft, setDraft] = useState<EngagementDraftFields & { key: string }>({
    ...EMPTY_DEFAULTS,
    key: '',
    name: '',
    defaultFeeStructure: 'FIXED_FEE',
    defaultFeeAmountDollars: '',
    defaultBudgetHours: '',
    defaultRateCodeId: '',
    engagementTypeId: '',
    namePattern: '',
  });

  async function load(): Promise<void> {
    try {
      const [r, rc, et, sl, wc] = await Promise.all([
        api<{ items: EngagementTpl[] }>('/api/staff/admin/templates/engagement'),
        api<{ items: RateCode[] }>('/api/staff/admin/rate-codes').catch(() => ({ items: [] })),
        api<{ items: EngagementType[] }>('/api/staff/taxonomy/engagement-types').catch(() => ({
          items: [],
        })),
        api<{ items: ServiceLine[] }>('/api/staff/taxonomy/service-lines').catch(() => ({
          items: [],
        })),
        api<{ items: WorkCode[] }>('/api/staff/taxonomy/work-codes').catch(() => ({
          items: [],
        })),
      ]);
      setItems(r.items ?? []);
      setRateCodes((rc.items ?? []).filter((c) => c.active));
      setEngagementTypes(et.items ?? []);
      setServiceLines(sl.items ?? []);
      setWorkCodes(wc.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function add(): Promise<void> {
    if (!draft.key.trim() || !draft.name.trim()) return;
    try {
      await api('/api/staff/admin/templates/engagement', {
        method: 'POST',
        body: JSON.stringify({
          key: draft.key.trim(),
          name: draft.name.trim(),
          defaultFeeStructure: draft.defaultFeeStructure,
          defaultFeeAmountCents: dollarsInputToCents(draft.defaultFeeAmountDollars),
          defaultBudgetHours: draft.defaultBudgetHours ? Number(draft.defaultBudgetHours) : null,
          defaultRateCodeId: draft.defaultRateCodeId || null,
          engagementTypeId: draft.engagementTypeId || null,
          namePattern: draft.namePattern.trim() || null,
          ...draftDefaultsToPayload(draft),
        }),
      });
      setDraft({
        ...EMPTY_DEFAULTS,
        key: '',
        name: '',
        defaultFeeStructure: 'FIXED_FEE',
        defaultFeeAmountDollars: '',
        defaultBudgetHours: '',
        defaultRateCodeId: '',
        engagementTypeId: '',
        namePattern: '',
      });
      setAdding(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'add_failed');
    }
  }

  async function clone(id: string): Promise<void> {
    try {
      await api(`/api/staff/admin/templates/engagement/${id}/clone`, { method: 'POST' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'clone_failed');
    }
  }

  async function archive(id: string): Promise<void> {
    if (!confirm('Archive this template? It will be hidden from pickers.')) return;
    try {
      await api(`/api/staff/admin/templates/engagement/${id}/archive`, { method: 'PATCH' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'archive_failed');
    }
  }

  function beginEdit(t: EngagementTpl): void {
    setEditingId(t.id);
    setEditDraft({
      name: t.name,
      defaultFeeStructure: t.defaultFeeStructure,
      defaultFeeAmountDollars: centsToDollarsInput(t.defaultFeeAmountCents),
      defaultBudgetHours: t.defaultBudgetHours ?? '',
      defaultRateCodeId: t.defaultRateCodeId ?? '',
      engagementTypeId: t.engagementTypeId ?? '',
      namePattern: t.namePattern ?? '',
      defaultMixedModeEnabled: t.defaultMixedModeEnabled,
      inScopeWorkCodeIds: t.inScopeWorkCodeIds ?? [],
      defaultFeePassthroughEnabled: t.defaultFeePassthroughEnabled,
      defaultTaxEnabled: t.defaultTaxEnabled,
      // bps → percent string for the input (e.g. 425 → "4.25").
      defaultTaxRatePercent: t.defaultTaxRateBps != null ? String(t.defaultTaxRateBps / 100) : '',
      defaultTaxLabel: t.defaultTaxLabel ?? '',
      defaultSurchargeEnabled: t.defaultSurchargeEnabled,
      defaultSurchargeType: t.defaultSurchargeType ?? 'PERCENT',
      defaultSurchargePercent:
        t.defaultSurchargeValueBps != null ? String(t.defaultSurchargeValueBps / 100) : '',
      defaultSurchargeFlatDollars: centsToDollarsInput(t.defaultSurchargeAmountCents),
      defaultSurchargeLabel: t.defaultSurchargeLabel ?? '',
      defaultRecurrenceFrequency: t.defaultRecurrenceFrequency ?? '',
      defaultRecurrenceTriggerMode: t.defaultRecurrenceTriggerMode ?? '',
      defaultRecurrenceStatus: t.defaultRecurrenceStatus ?? '',
      defaultEngagementStatus: t.defaultEngagementStatus ?? '',
    });
  }

  async function saveEdit(id: string): Promise<void> {
    if (!editDraft.name.trim()) return;
    try {
      await api(`/api/staff/admin/templates/engagement/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editDraft.name.trim(),
          defaultFeeStructure: editDraft.defaultFeeStructure,
          defaultFeeAmountCents: dollarsInputToCents(editDraft.defaultFeeAmountDollars),
          defaultBudgetHours: editDraft.defaultBudgetHours
            ? Number(editDraft.defaultBudgetHours)
            : null,
          defaultRateCodeId: editDraft.defaultRateCodeId || null,
          engagementTypeId: editDraft.engagementTypeId || null,
          namePattern: editDraft.namePattern.trim() || null,
          ...draftDefaultsToPayload(editDraft),
        }),
      });
      setEditingId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save_failed');
    }
  }

  // Shared editor for the new template-default toggles (mixed mode +
  // work codes, fee passthrough, sales tax, surcharge, recurrence).
  // Rendered identically in the create form and each edit row; `update`
  // merges a partial into whichever draft is in play. `idPrefix` keeps
  // the checkbox label `htmlFor`/`id` pairs unique across rows.
  function renderDefaultsEditor(
    d: EngagementDraftFields,
    update: (patch: Partial<EngagementDraftFields>) => void,
    idPrefix: string,
  ): JSX.Element {
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        <label
          htmlFor={`${idPrefix}-mixed-mode`}
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            padding: 10,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
          }}
        >
          <input
            id={`${idPrefix}-mixed-mode`}
            type="checkbox"
            aria-label="Default mixed-mode in-scope per entry"
            checked={d.defaultMixedModeEnabled}
            onChange={(e) => update({ defaultMixedModeEnabled: e.target.checked })}
          />
          <span style={{ flex: 1 }}>
            <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>
              Mixed-mode (in-scope per entry)
            </span>
            <span style={{ display: 'block', fontSize: 12, color: tokens.color.textMuted }}>
              Time entries get flagged in_scope when their work code is in the list below.
            </span>
          </span>
        </label>
        {d.defaultMixedModeEnabled && (
          <div>
            <div
              style={{
                fontSize: 11,
                color: tokens.color.textMuted,
                marginBottom: 4,
                textTransform: 'uppercase',
              }}
            >
              In-scope work codes ({d.inScopeWorkCodeIds.length})
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {workCodes.length === 0 ? (
                <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                  No work codes defined.
                </span>
              ) : (
                workCodes.map((w) => {
                  const on = d.inScopeWorkCodeIds.includes(w.id);
                  return (
                    <button
                      key={w.id}
                      type="button"
                      onClick={() =>
                        update({
                          inScopeWorkCodeIds: on
                            ? d.inScopeWorkCodeIds.filter((x) => x !== w.id)
                            : [...d.inScopeWorkCodeIds, w.id],
                        })
                      }
                      style={{
                        padding: '4px 10px',
                        borderRadius: 999,
                        border: `1px solid ${on ? tokens.color.accent : tokens.color.border}`,
                        background: on ? tokens.color.accentMuted : 'transparent',
                        color: on ? tokens.color.accent : tokens.color.text,
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      {w.name}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}

        <label
          htmlFor={`${idPrefix}-fee-passthrough`}
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            padding: 10,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
          }}
        >
          <input
            id={`${idPrefix}-fee-passthrough`}
            type="checkbox"
            aria-label="Default fee passthrough"
            checked={d.defaultFeePassthroughEnabled}
            onChange={(e) => update({ defaultFeePassthroughEnabled: e.target.checked })}
          />
          <span style={{ flex: 1 }}>
            <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>Fee passthrough</span>
            <span style={{ display: 'block', fontSize: 12, color: tokens.color.textMuted }}>
              Adds a processing-fee line item to invoices for engagements from this template.
            </span>
          </span>
        </label>

        <label
          htmlFor={`${idPrefix}-tax-enabled`}
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            padding: 10,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
          }}
        >
          <input
            id={`${idPrefix}-tax-enabled`}
            type="checkbox"
            aria-label="Default charge sales tax"
            checked={d.defaultTaxEnabled}
            onChange={(e) => update({ defaultTaxEnabled: e.target.checked })}
          />
          <span style={{ flex: 1 }}>
            <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>
              Charge sales tax
            </span>
            <span style={{ display: 'block', fontSize: 12, color: tokens.color.textMuted }}>
              Adds a tax line on invoices (applied to subtotal + surcharge).
            </span>
          </span>
        </label>
        {d.defaultTaxEnabled && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <input
              type="text"
              inputMode="decimal"
              value={d.defaultTaxRatePercent}
              onChange={(e) => update({ defaultTaxRatePercent: e.target.value })}
              placeholder="Tax rate (%)"
              aria-label="Default tax rate percent"
              style={fieldStyle}
            />
            <input
              type="text"
              value={d.defaultTaxLabel}
              onChange={(e) => update({ defaultTaxLabel: e.target.value })}
              placeholder="Tax label (e.g. GET, GRT, Sales tax)"
              aria-label="Default tax label"
              style={fieldStyle}
            />
          </div>
        )}

        <label
          htmlFor={`${idPrefix}-surcharge-enabled`}
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            padding: 10,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
          }}
        >
          <input
            id={`${idPrefix}-surcharge-enabled`}
            type="checkbox"
            aria-label="Default add surcharge"
            checked={d.defaultSurchargeEnabled}
            onChange={(e) => update({ defaultSurchargeEnabled: e.target.checked })}
          />
          <span style={{ flex: 1 }}>
            <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>
              Add invoice surcharge
            </span>
            <span style={{ display: 'block', fontSize: 12, color: tokens.color.textMuted }}>
              Firm-defined fee (e.g. technology fee, filing fee). Computed against the subtotal.
            </span>
          </span>
        </label>
        {d.defaultSurchargeEnabled && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 8 }}>
            <select
              value={d.defaultSurchargeType}
              onChange={(e) => update({ defaultSurchargeType: e.target.value as SurchargeType })}
              aria-label="Default surcharge type"
              style={fieldStyle}
            >
              <option value="PERCENT">Percent of subtotal</option>
              <option value="FLAT_AMOUNT">Flat dollar amount</option>
            </select>
            {d.defaultSurchargeType === 'PERCENT' ? (
              <input
                type="text"
                inputMode="decimal"
                value={d.defaultSurchargePercent}
                onChange={(e) => update({ defaultSurchargePercent: e.target.value })}
                placeholder="Surcharge %"
                aria-label="Default surcharge percent"
                style={fieldStyle}
              />
            ) : (
              <input
                type="text"
                inputMode="decimal"
                value={d.defaultSurchargeFlatDollars}
                onChange={(e) => update({ defaultSurchargeFlatDollars: e.target.value })}
                placeholder="Surcharge ($)"
                aria-label="Default surcharge dollars"
                style={fieldStyle}
              />
            )}
            <input
              type="text"
              value={d.defaultSurchargeLabel}
              onChange={(e) => update({ defaultSurchargeLabel: e.target.value })}
              placeholder="Surcharge label"
              aria-label="Default surcharge label"
              style={fieldStyle}
            />
          </div>
        )}

        <div>
          <label
            htmlFor={`${idPrefix}-new-status`}
            style={{
              fontSize: 11,
              color: tokens.color.textMuted,
              display: 'block',
              marginBottom: 4,
            }}
          >
            Default status for new engagements
          </label>
          <select
            id={`${idPrefix}-new-status`}
            value={d.defaultEngagementStatus}
            onChange={(e) =>
              update({ defaultEngagementStatus: e.target.value as '' | EngagementStatus })
            }
            aria-label="Default status for new engagements"
            style={{ ...fieldStyle, width: '100%' }}
          >
            <option value="">New status: Proposed (default)</option>
            {STATUS_OPTIONS.map((o) => (
              <option key={o} value={o}>
                New status: {o}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor={`${idPrefix}-recurrence`}
            style={{
              fontSize: 11,
              color: tokens.color.textMuted,
              display: 'block',
              marginBottom: 4,
            }}
          >
            Default recurrence
          </label>
          <select
            id={`${idPrefix}-recurrence`}
            value={d.defaultRecurrenceFrequency}
            onChange={(e) =>
              update({ defaultRecurrenceFrequency: e.target.value as '' | RecurrenceFrequency })
            }
            aria-label="Default recurrence frequency"
            style={{ ...fieldStyle, width: '100%' }}
          >
            <option value="">— none —</option>
            {RECURRENCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {d.defaultRecurrenceFrequency && (
            <select
              id={`${idPrefix}-recurrence-trigger`}
              value={d.defaultRecurrenceTriggerMode || 'ON_COMPLETION'}
              onChange={(e) =>
                update({
                  defaultRecurrenceTriggerMode: e.target.value as RecurrenceTriggerMode,
                })
              }
              aria-label="Default recurrence trigger"
              style={{ ...fieldStyle, width: '100%', marginTop: 6 }}
            >
              {TRIGGER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          {d.defaultRecurrenceFrequency && (
            <select
              id={`${idPrefix}-recurrence-status`}
              value={d.defaultRecurrenceStatus}
              onChange={(e) =>
                update({ defaultRecurrenceStatus: e.target.value as '' | EngagementStatus })
              }
              aria-label="Default recurrence engagement status"
              style={{ ...fieldStyle, width: '100%', marginTop: 6 }}
            >
              <option value="">Spawned status: Active (default)</option>
              {STATUS_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  Spawned status: {o}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      <TemplateLibraryPanel area="engagements" onImported={() => void load()} />
      <Card
        title="Engagement templates"
        action={
          <Button size="sm" onClick={() => setAdding(!adding)}>
            {adding ? 'Cancel' : '+ New template'}
          </Button>
        }
      >
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}
        {adding && (
          <div
            style={{
              padding: 12,
              marginBottom: 12,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
              display: 'grid',
              gap: 8,
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8 }}>
              <input
                value={draft.key}
                onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                placeholder="key (lower_snake) *"
                style={fieldStyle}
              />
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Name *"
                style={fieldStyle}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
              <Combobox
                ariaLabel="Default fee structure"
                value={draft.defaultFeeStructure}
                onChange={(v) => setDraft({ ...draft, defaultFeeStructure: v })}
                options={FEE_OPTIONS}
              />
              <input
                type="text"
                inputMode="decimal"
                value={draft.defaultFeeAmountDollars}
                onChange={(e) => setDraft({ ...draft, defaultFeeAmountDollars: e.target.value })}
                placeholder="Fee ($)"
                aria-label="Default fee in dollars"
                style={fieldStyle}
              />
              <input
                value={draft.defaultBudgetHours}
                onChange={(e) => setDraft({ ...draft, defaultBudgetHours: e.target.value })}
                placeholder="Budget hours"
                style={fieldStyle}
              />
            </div>
            <select
              value={draft.defaultRateCodeId}
              onChange={(e) => setDraft({ ...draft, defaultRateCodeId: e.target.value })}
              aria-label="Default rate code"
              style={fieldStyle}
            >
              <option value="">— StandardRate (default) —</option>
              {rateCodes.map((rc) => (
                <option key={rc.id} value={rc.id}>
                  {rc.code}
                </option>
              ))}
            </select>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8 }}>
              <select
                value={draft.engagementTypeId}
                onChange={(e) => setDraft({ ...draft, engagementTypeId: e.target.value })}
                aria-label="Engagement type"
                style={fieldStyle}
              >
                <option value="">— Type (none) —</option>
                {engagementTypes.map((t) => {
                  const sl = serviceLines.find((s) => s.id === t.serviceLineId);
                  return (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {sl ? ` — ${sl.name}` : ''}
                    </option>
                  );
                })}
              </select>
              <div
                style={{
                  ...fieldStyle,
                  background: tokens.color.bg,
                  color: tokens.color.textMuted,
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                {(() => {
                  const t = engagementTypes.find((x) => x.id === draft.engagementTypeId);
                  const sl = serviceLines.find((s) => s.id === t?.serviceLineId);
                  return sl ? `Service line: ${sl.name}` : 'Service line: — derived from Type —';
                })()}
              </div>
            </div>
            <div>
              <label
                htmlFor="new-name-pattern"
                style={{
                  fontSize: 11,
                  color: tokens.color.textMuted,
                  display: 'block',
                  marginBottom: 4,
                }}
              >
                Name pattern (optional)
              </label>
              <input
                id="new-name-pattern"
                value={draft.namePattern}
                onChange={(e) => setDraft({ ...draft, namePattern: e.target.value })}
                placeholder="e.g. Bookkeeping {{period.month}}/{{period.year}}"
                aria-label="Engagement name pattern"
                style={{ ...fieldStyle, width: '100%' }}
              />
              <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: '4px 0 0' }}>
                Tokens: <code>{'{{client.name}}'}</code>, <code>{'{{period.year}}'}</code>,{' '}
                <code>{'{{period.month}}'}</code>, <code>{'{{period.label}}'}</code>,{' '}
                <code>{'{{today}}'}</code>. Left blank → engagement name comes from the create form.
              </p>
            </div>
            {renderDefaultsEditor(draft, (patch) => setDraft({ ...draft, ...patch }), 'new-tpl')}
            <div>
              <Button size="sm" onClick={() => void add()}>
                Create
              </Button>
            </div>
          </div>
        )}
        {items.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No templates yet.</p>
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            {items.map((t) => {
              const isEditing = editingId === t.id;
              return (
                <div
                  key={t.id}
                  style={{
                    padding: 10,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.md,
                    display: 'grid',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {isEditing ? (
                      <input
                        value={editDraft.name}
                        onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })}
                        style={{ ...fieldStyle, flex: 1, minWidth: 220 }}
                      />
                    ) : (
                      <strong style={{ fontSize: 13 }}>{t.name}</strong>
                    )}
                    <code style={{ fontSize: 11, color: tokens.color.textMuted }}>{t.key}</code>
                    {!isEditing && <Pill>{t.defaultFeeStructure}</Pill>}
                    {!isEditing && (
                      <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                        {formatCents(t.defaultFeeAmountCents)} ·{' '}
                        {t.defaultBudgetHours ? `${t.defaultBudgetHours}h` : 'no budget'}
                      </span>
                    )}
                    {t.isSystem && <Pill tone="accent">system</Pill>}
                    {t.status === 'ARCHIVED' && <Pill tone="neutral">archived</Pill>}
                    {!isEditing && t.namePattern && (
                      <span
                        style={{
                          fontSize: 11,
                          color: tokens.color.textMuted,
                          fontFamily: 'monospace',
                        }}
                        title={`Engagement name pattern: ${t.namePattern}`}
                      >
                        📝 {t.namePattern}
                      </span>
                    )}
                    {t.status === 'ARCHIVED' && <Pill tone="warning">archived</Pill>}
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                      {isEditing ? (
                        <>
                          <Button size="sm" onClick={() => void saveEdit(t.id)}>
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => beginEdit(t)}>
                            Edit
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => void clone(t.id)}>
                            Clone
                          </Button>
                          {t.status === 'ACTIVE' && (
                            <Button size="sm" variant="ghost" onClick={() => void archive(t.id)}>
                              Archive
                            </Button>
                          )}
                        </>
                      )}
                    </span>
                  </div>
                  {isEditing && (
                    <div
                      style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 8 }}
                    >
                      <Combobox
                        ariaLabel="Default fee structure"
                        value={editDraft.defaultFeeStructure}
                        onChange={(v) => setEditDraft({ ...editDraft, defaultFeeStructure: v })}
                        options={FEE_OPTIONS}
                      />
                      <input
                        type="text"
                        inputMode="decimal"
                        value={editDraft.defaultFeeAmountDollars}
                        onChange={(e) =>
                          setEditDraft({ ...editDraft, defaultFeeAmountDollars: e.target.value })
                        }
                        placeholder="Fee ($)"
                        aria-label="Default fee in dollars"
                        style={fieldStyle}
                      />
                      <input
                        value={editDraft.defaultBudgetHours}
                        onChange={(e) =>
                          setEditDraft({ ...editDraft, defaultBudgetHours: e.target.value })
                        }
                        placeholder="Budget hours"
                        style={fieldStyle}
                      />
                      <select
                        value={editDraft.defaultRateCodeId}
                        onChange={(e) =>
                          setEditDraft({ ...editDraft, defaultRateCodeId: e.target.value })
                        }
                        aria-label="Default rate code"
                        style={fieldStyle}
                      >
                        <option value="">— StandardRate (default) —</option>
                        {rateCodes.map((rc) => (
                          <option key={rc.id} value={rc.id}>
                            {rc.code}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {isEditing && (
                    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8 }}>
                      <select
                        value={editDraft.engagementTypeId}
                        onChange={(e) =>
                          setEditDraft({ ...editDraft, engagementTypeId: e.target.value })
                        }
                        aria-label="Engagement type"
                        style={fieldStyle}
                      >
                        <option value="">— Type (none) —</option>
                        {engagementTypes.map((et) => {
                          const sl = serviceLines.find((s) => s.id === et.serviceLineId);
                          return (
                            <option key={et.id} value={et.id}>
                              {et.name}
                              {sl ? ` — ${sl.name}` : ''}
                            </option>
                          );
                        })}
                      </select>
                      <div
                        style={{
                          ...fieldStyle,
                          background: tokens.color.bg,
                          color: tokens.color.textMuted,
                          display: 'flex',
                          alignItems: 'center',
                        }}
                      >
                        {(() => {
                          const et = engagementTypes.find(
                            (x) => x.id === editDraft.engagementTypeId,
                          );
                          const sl = serviceLines.find((s) => s.id === et?.serviceLineId);
                          return sl ? `Service line: ${sl.name}` : 'Service line: — derived —';
                        })()}
                      </div>
                    </div>
                  )}
                  {isEditing && (
                    <div>
                      <label
                        htmlFor={`edit-name-pattern-${t.id}`}
                        style={{
                          fontSize: 11,
                          color: tokens.color.textMuted,
                          display: 'block',
                          marginBottom: 4,
                        }}
                      >
                        Name pattern (optional)
                      </label>
                      <input
                        id={`edit-name-pattern-${t.id}`}
                        value={editDraft.namePattern}
                        onChange={(e) =>
                          setEditDraft({ ...editDraft, namePattern: e.target.value })
                        }
                        placeholder="e.g. Bookkeeping {{period.month}}/{{period.year}}"
                        aria-label="Engagement name pattern"
                        style={{ ...fieldStyle, width: '100%' }}
                      />
                      <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: '4px 0 0' }}>
                        Tokens: <code>{'{{client.name}}'}</code>, <code>{'{{period.year}}'}</code>,{' '}
                        <code>{'{{period.month}}'}</code>, <code>{'{{period.label}}'}</code>,{' '}
                        <code>{'{{today}}'}</code>.
                      </p>
                    </div>
                  )}
                  {isEditing &&
                    renderDefaultsEditor(
                      editDraft,
                      (patch) => setEditDraft({ ...editDraft, ...patch }),
                      `edit-tpl-${t.id}`,
                    )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function LetterTab(): JSX.Element {
  const [items, setItems] = useState<LetterTpl[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  // 0221 — author new letter templates in place (previously the only way
  // in was importing the shipped system pack).
  const [createOpen, setCreateOpen] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [editBody, setEditBody] = useState('');
  const [editMargin, setEditMargin] = useState('');
  const [editMode, setEditMode] = useState<'visual' | 'html'>('visual');
  const [error, setError] = useState<string | null>(null);
  const insertApiRef = useRef<RichTextApi | null>(null);
  const htmlRef = useRef<HTMLTextAreaElement | null>(null);

  // A valid CSS margin: 1–4 space-separated lengths (in/cm/mm/px/pt).
  const marginValid =
    editMargin.trim() === '' || /^(\d+(\.\d+)?(in|cm|mm|px|pt)\s*){1,4}$/i.test(editMargin.trim());

  function startEdit(t: LetterTpl): void {
    setEditingId(t.id);
    setEditBody(t.bodyHtml);
    setEditMargin(t.pageMargin ?? '');
    // Protect letterhead docs — WYSIWYG would drop <style>/<head>.
    setEditMode(isFullHtmlDoc(t.bodyHtml) ? 'html' : 'visual');
  }

  // Insert a building block at the cursor — via the editor API in Visual
  // mode, or into the textarea selection in HTML mode.
  function insertBlock(snippet: string): void {
    if (editMode === 'visual') {
      insertApiRef.current?.insertText(snippet);
      return;
    }
    const ta = htmlRef.current;
    if (!ta) {
      setEditBody((b) => (b ? `${b}\n${snippet}` : snippet));
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    setEditBody(editBody.slice(0, start) + snippet + editBody.slice(end));
  }

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: LetterTpl[] }>('/api/staff/admin/templates/letter');
      setItems(r.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function createTemplate(): Promise<void> {
    const key = newKey.trim();
    const name = newName.trim();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(key)) {
      setError('Key must be lower_snake (letters, digits, _ or -).');
      return;
    }
    if (!name) {
      setError('Enter a template name.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const r = await api<{ id: string }>('/api/staff/admin/templates/letter', {
        method: 'POST',
        body: JSON.stringify({
          key,
          name,
          bodyHtml: '<p>Dear {{client.name}},</p><p></p><p>Sincerely,</p><p>{{firm.name}}</p>',
        }),
      });
      setCreateOpen(false);
      setNewKey('');
      setNewName('');
      await load();
      // Drop straight into the editor for the new template.
      if (r?.id) {
        setEditingId(r.id);
        setEditBody('<p>Dear {{client.name}},</p><p></p><p>Sincerely,</p><p>{{firm.name}}</p>');
        setEditMargin('');
        setEditMode('visual');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'create_failed');
    } finally {
      setCreating(false);
    }
  }

  async function archiveTemplate(t: LetterTpl): Promise<void> {
    if (!window.confirm(`Archive letter template "${t.name}"? It disappears from pickers.`)) return;
    try {
      await api(`/api/staff/admin/templates/letter/${t.id}/archive`, {
        method: 'PATCH',
        body: '{}',
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'archive_failed');
    }
  }

  async function save(id: string): Promise<void> {
    try {
      await api(`/api/staff/admin/templates/letter/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ bodyHtml: editBody, pageMargin: editMargin.trim() }),
      });
      setEditingId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save_failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      <TemplateLibraryPanel area="letters" onImported={() => void load()} />
      <Card
        title="Letter templates"
        action={
          <span style={{ display: 'flex', gap: 8 }}>
            {items.some((t) => t.status === 'ARCHIVED') && (
              <Button size="sm" variant="ghost" onClick={() => setShowArchived((v) => !v)}>
                {showArchived ? 'Hide archived' : 'Show archived'}
              </Button>
            )}
            <Button size="sm" onClick={() => setCreateOpen((v) => !v)}>
              + New template
            </Button>
          </span>
        }
      >
        {createOpen && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexWrap: 'wrap',
              marginBottom: 12,
              padding: '8px 10px',
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
            }}
          >
            <input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="key (lower_snake)"
              style={{ ...fieldStyle, width: 180, fontFamily: tokens.font.mono }}
            />
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Template name"
              style={{ ...fieldStyle, width: 260 }}
            />
            <Button size="sm" disabled={creating} onClick={() => void createTemplate()}>
              {creating ? 'Creating…' : 'Create'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
          </div>
        )}
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}
        <p style={{ fontSize: 12, color: tokens.color.textMuted }}>
          Variables follow the same <code>{'{{entity.field}}'}</code> markers as notification
          templates. The &ldquo;Generate letter&rdquo; button on an engagement detail page
          substitutes them in.
        </p>
        <div style={{ display: 'grid', gap: 12 }}>
          {items
            .filter((t) => showArchived || t.status !== 'ARCHIVED')
            .map((t) => (
              <div
                key={t.id}
                style={{
                  padding: 12,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.md,
                  display: 'grid',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 13 }}>{t.name}</strong>
                  <code style={{ fontSize: 11, color: tokens.color.textMuted }}>{t.key}</code>
                  {t.isSystem && <Pill tone="accent">system</Pill>}
                  {t.status === 'ARCHIVED' && <Pill tone="neutral">archived</Pill>}
                  {t.variablesJson && t.variablesJson.length > 0 && (
                    <Pill>{`${t.variablesJson.length} vars`}</Pill>
                  )}
                  <span style={{ marginLeft: 'auto' }}>
                    {editingId === t.id ? (
                      <>
                        <Button size="sm" disabled={!marginValid} onClick={() => void save(t.id)}>
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => startEdit(t)}>
                          Edit body
                        </Button>
                        {t.status !== 'ARCHIVED' && (
                          <Button size="sm" variant="ghost" onClick={() => void archiveTemplate(t)}>
                            Archive
                          </Button>
                        )}
                      </>
                    )}
                  </span>
                </div>
                {editingId === t.id ? (
                  <div style={{ display: 'grid', gap: 8 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: tokens.color.textMuted }}>Editor:</span>
                      <Button
                        size="sm"
                        variant={editMode === 'visual' ? 'secondary' : 'ghost'}
                        disabled={isFullHtmlDoc(editBody)}
                        title={
                          isFullHtmlDoc(editBody)
                            ? 'This letter has a letterhead/<style> block; the visual editor would strip it. Edit in HTML mode.'
                            : undefined
                        }
                        onClick={() => setEditMode('visual')}
                      >
                        Visual
                      </Button>
                      <Button
                        size="sm"
                        variant={editMode === 'html' ? 'secondary' : 'ghost'}
                        onClick={() => setEditMode('html')}
                      >
                        {'</> HTML'}
                      </Button>
                      {isFullHtmlDoc(editBody) && (
                        <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                          Letterhead/&lt;style&gt; letter — editing in HTML to preserve it.
                        </span>
                      )}
                    </div>
                    <div
                      style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
                    >
                      <label
                        htmlFor={`letter-margin-${t.id}`}
                        style={{ fontSize: 11, color: tokens.color.textMuted }}
                      >
                        Page margin
                      </label>
                      <input
                        id={`letter-margin-${t.id}`}
                        value={editMargin}
                        onChange={(e) => setEditMargin(e.target.value)}
                        placeholder="1in (default)"
                        style={{ ...fieldStyle, width: 140, fontFamily: tokens.font.mono }}
                      />
                      <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                        CSS length — e.g. <code>1in</code>, <code>0.75in</code>, or per-side{' '}
                        <code>1in 0.75in</code>. Blank = 1in.
                      </span>
                      {!marginValid && (
                        <span style={{ fontSize: 11, color: tokens.color.danger }}>
                          Enter a valid CSS length (in/cm/mm/px/pt).
                        </span>
                      )}
                    </div>
                    <div
                      style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}
                    >
                      <span style={{ fontSize: 11, color: tokens.color.textMuted }}>Insert:</span>
                      {LETTER_BLOCKS.map((b) => (
                        <Button
                          key={b.label}
                          size="sm"
                          variant="ghost"
                          onClick={() => insertBlock(b.snippet)}
                          title={`Insert a ${b.label.toLowerCase()} block`}
                        >
                          {b.label}
                        </Button>
                      ))}
                    </div>
                    {editMode === 'visual' ? (
                      <RichTextEditor
                        key={`${t.id}-visual`}
                        format="html"
                        value={editBody}
                        onChange={setEditBody}
                        onReady={(apiRef) => {
                          insertApiRef.current = apiRef;
                        }}
                        variables={LETTER_VARIABLES}
                        minHeight={260}
                        placeholder="Write the letter. Use Insert for letterhead / address / variables."
                      />
                    ) : (
                      <textarea
                        ref={htmlRef}
                        value={editBody}
                        onChange={(e) => setEditBody(e.target.value)}
                        rows={14}
                        style={{ ...fieldStyle, fontFamily: tokens.font.mono, resize: 'vertical' }}
                      />
                    )}
                    <div style={{ fontSize: 11, color: tokens.color.textMuted }}>Preview</div>
                    <iframe
                      title="Letter preview"
                      srcDoc={
                        isFullHtmlDoc(editBody)
                          ? editBody
                          : `<!doctype html><html><head><meta charset="utf-8" /><style>${DEFAULT_LETTER_CSS}</style></head><body>${editBody}</body></html>`
                      }
                      style={{
                        width: '100%',
                        height: 320,
                        border: `1px solid ${tokens.color.border}`,
                        borderRadius: tokens.radius.sm,
                        background: '#fff',
                      }}
                    />
                  </div>
                ) : (
                  // 0221 — show the letter as it renders, not its HTML source.
                  <iframe
                    title={`Preview of ${t.name}`}
                    sandbox=""
                    srcDoc={
                      isFullHtmlDoc(t.bodyHtml)
                        ? t.bodyHtml
                        : `<!doctype html><html><head><meta charset="utf-8" /><style>${DEFAULT_LETTER_CSS}</style></head><body>${t.bodyHtml}</body></html>`
                    }
                    style={{
                      width: '100%',
                      height: 220,
                      border: `1px solid ${tokens.color.border}`,
                      borderRadius: tokens.radius.sm,
                      background: '#fff',
                      pointerEvents: 'none',
                    }}
                  />
                )}
              </div>
            ))}
        </div>
      </Card>
    </div>
  );
}

interface DocToken {
  token: string;
  scope: string;
  description: string;
  raw?: boolean;
}

interface DocTemplateConfig {
  /** API base, e.g. '/api/staff/admin/templates/invoice'. */
  base: string;
  cardTitle: string;
  intro: JSX.Element;
  /** Friendly labels per token scope; falls back to the raw scope name. */
  scopeLabels: Record<string, string>;
  /** Builtin render-mode <option>s ('' = custom). */
  builtinOptions: Array<{ value: string; label: string }>;
  resetLabel: string;
  /** Quick block-insert buttons. */
  blocks: Array<{ label: string; snippet: string }>;
}

// Generic document-template editor (HTML body / variables / CSS / live
// PDF preview). Shared by the Invoice and Statement tabs.
function DocumentTemplateTab({ cfg }: { cfg: DocTemplateConfig }): JSX.Element {
  const [bodyHtml, setBodyHtml] = useState('');
  const [css, setCss] = useState('');
  const [builtinStyle, setBuiltinStyle] = useState('');
  const [tokens_, setTokens] = useState<DocToken[]>([]);
  const [defaults, setDefaults] = useState<{ bodyHtml: string; css: string }>({
    bodyHtml: '',
    css: '',
  });
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  async function load(): Promise<void> {
    try {
      const [tpl, vars] = await Promise.all([
        api<{
          template: { bodyHtml: string | null; css: string | null; builtinStyle: string | null };
        }>(cfg.base),
        api<{ tokens: DocToken[]; defaults: { bodyHtml: string; css: string } }>(
          `${cfg.base}/variables`,
        ),
      ]);
      setBodyHtml(tpl.template.bodyHtml ?? vars.defaults.bodyHtml);
      setCss(tpl.template.css ?? vars.defaults.css);
      setBuiltinStyle(tpl.template.builtinStyle ?? '');
      setTokens(vars.tokens ?? []);
      setDefaults(vars.defaults);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.base]);

  // Debounced live preview — renders the actual PDF (Puppeteer) so the
  // editor is true WYSIWYG; the blob is shown via an object URL.
  useEffect(() => {
    if (!bodyHtml) return;
    let cancelled = false;
    setPreviewing(true);
    const t = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`${cfg.base}/preview?format=pdf`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() ?? '' },
            credentials: 'same-origin',
            body: JSON.stringify({ bodyHtml, css }),
          });
          if (!res.ok) throw new Error('preview_failed');
          const blob = await res.blob();
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          setPreviewUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return url;
          });
          setPreviewError(false);
        } catch {
          if (!cancelled) setPreviewError(true);
        } finally {
          if (!cancelled) setPreviewing(false);
        }
      })();
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [bodyHtml, css, cfg.base]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function insertAtCursor(text: string): void {
    const el = bodyRef.current;
    if (!el) {
      setBodyHtml((b) => b + text);
      return;
    }
    const start = el.selectionStart ?? bodyHtml.length;
    const end = el.selectionEnd ?? bodyHtml.length;
    const next = bodyHtml.slice(0, start) + text + bodyHtml.slice(end);
    setBodyHtml(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
    });
  }

  async function save(): Promise<void> {
    try {
      await api(cfg.base, {
        method: 'PUT',
        body: JSON.stringify({ bodyHtml, css, builtinStyle: builtinStyle || null }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save_failed');
    }
  }

  const grouped = tokens_.reduce<Record<string, DocToken[]>>((acc, t) => {
    (acc[t.scope] ??= []).push(t);
    return acc;
  }, {});

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      <Card title={cfg.cardTitle}>
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}
        <p style={{ fontSize: 12, color: tokens.color.textMuted }}>{cfg.intro}</p>

        <div
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            flexWrap: 'wrap',
            margin: '12px 0',
          }}
        >
          <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
            Render mode:
            <select
              value={builtinStyle}
              onChange={(e) => setBuiltinStyle(e.target.value)}
              style={fieldStyle}
            >
              <option value="">Custom template (HTML + CSS below)</option>
              {cfg.builtinOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setBodyHtml(defaults.bodyHtml);
              setCss(defaults.css);
            }}
          >
            {cfg.resetLabel}
          </Button>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            {saved && <Pill tone="accent">saved</Pill>}
            <Button size="sm" onClick={() => void save()}>
              Save
            </Button>
          </span>
        </div>

        {builtinStyle && (
          <p
            style={{
              fontSize: 12,
              color: tokens.color.textMuted,
              padding: 8,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              marginBottom: 12,
            }}
          >
            This document will use the built-in <strong>{builtinStyle}</strong> layout. Switch back
            to <em>Custom template</em> to use the HTML/CSS below.
          </p>
        )}

        <div style={{ display: 'grid', gap: 16 }}>
          {/* HTML body — full width, white */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>HTML body</div>
            <textarea
              ref={bodyRef}
              value={bodyHtml}
              onChange={(e) => setBodyHtml(e.target.value)}
              rows={20}
              spellCheck={false}
              style={{
                ...fieldStyle,
                width: '100%',
                background: '#fff',
                color: '#111',
                fontFamily: tokens.font.mono,
                resize: 'vertical',
              }}
            />
          </div>

          {/* Variables — between HTML and CSS */}
          <div>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                marginBottom: 4,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <span>Variables (click to insert)</span>
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {cfg.blocks.map((b) => (
                  <Button
                    key={b.label}
                    size="sm"
                    variant="ghost"
                    onClick={() => insertAtCursor(b.snippet)}
                  >
                    {b.label}
                  </Button>
                ))}
              </span>
            </div>
            <div
              style={{
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                padding: 8,
                display: 'grid',
                gap: 8,
              }}
            >
              {Object.keys(grouped).map((scope) => (
                <div key={scope}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: tokens.color.textMuted }}>
                    {cfg.scopeLabels[scope] ?? scope}
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                    {grouped[scope]!.map((t) => (
                      <button
                        key={`${scope}-${t.token}`}
                        type="button"
                        title={t.description}
                        onClick={() =>
                          insertAtCursor(t.raw ? `{{{ ${t.token} }}}` : `{{ ${t.token} }}`)
                        }
                        style={{
                          fontFamily: tokens.font.mono,
                          fontSize: 11,
                          padding: '2px 6px',
                          border: `1px solid ${tokens.color.border}`,
                          borderRadius: tokens.radius.sm,
                          background: tokens.color.surface,
                          color: tokens.color.text,
                          cursor: 'pointer',
                        }}
                      >
                        {t.token}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* CSS — full width, white */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>CSS</div>
            <textarea
              value={css}
              onChange={(e) => setCss(e.target.value)}
              rows={16}
              spellCheck={false}
              style={{
                ...fieldStyle,
                width: '100%',
                background: '#fff',
                color: '#111',
                fontFamily: tokens.font.mono,
                resize: 'vertical',
              }}
            />
          </div>

          {/* Live preview — full-width bottom row */}
          <div>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                marginBottom: 4,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              Live preview — PDF, sample data
              {previewing && (
                <span style={{ fontWeight: 400, color: tokens.color.textMuted }}>rendering…</span>
              )}
              {previewError && (
                <span style={{ fontWeight: 400, color: tokens.color.danger }}>render failed</span>
              )}
            </div>
            <iframe
              title={`${cfg.cardTitle}-preview`}
              src={previewUrl || undefined}
              style={{
                width: '100%',
                height: 760,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                background: '#fff',
              }}
            />
          </div>
        </div>
      </Card>
    </div>
  );
}

function InvoiceTab(): JSX.Element {
  return (
    <DocumentTemplateTab
      cfg={{
        base: '/api/staff/admin/templates/invoice',
        cardTitle: 'Invoice template',
        resetLabel: 'Reset to default letterhead',
        scopeLabels: {
          firm: 'Firm',
          client: 'Client',
          invoice: 'Invoice',
          line_items: 'Line items ({{#each line_items}})',
          surcharges: 'Surcharges ({{#each surcharges}})',
          safe_html: 'HTML blocks (raw)',
        },
        builtinOptions: [
          { value: 'modern', label: 'Built-in · Modern' },
          { value: 'classic', label: 'Built-in · Classic' },
          { value: 'minimal', label: 'Built-in · Minimal' },
        ],
        blocks: [
          { label: 'each line_items', snippet: '{{#each line_items}}\n  \n{{/each}}' },
          { label: 'each surcharges', snippet: '{{#each surcharges}}\n  \n{{/each}}' },
          { label: 'if … / else', snippet: '{{#if invoice.notes}}\n  \n{{/if}}' },
        ],
        intro: (
          <>
            Design the invoice your clients receive (staff PDF, portal view, pay-by-link and email
            all use this). Tokens use <code>{'{{ scope.field }}'}</code>; loop line items with{' '}
            <code>{'{{#each line_items}}…{{/each}}'}</code>; optional blocks with{' '}
            <code>{'{{#if token}}…{{/if}}'}</code>; raw HTML with <code>{'{{{ token }}}'}</code>.
          </>
        ),
      }}
    />
  );
}

function StatementTab(): JSX.Element {
  return (
    <DocumentTemplateTab
      cfg={{
        base: '/api/staff/admin/templates/statement',
        cardTitle: 'Statement template',
        resetLabel: 'Reset to default statement',
        scopeLabels: {
          firm: 'Firm',
          client: 'Client',
          statement: 'Statement',
          aging: 'Aging buckets',
          lines: 'Ledger rows ({{#each lines}})',
          safe_html: 'HTML blocks (raw)',
        },
        builtinOptions: [{ value: 'classic', label: 'Built-in · Classic' }],
        blocks: [
          { label: 'each lines', snippet: '{{#each lines}}\n  \n{{/each}}' },
          { label: 'if period', snippet: '{{#if statement.period_start}}\n  \n{{/if}}' },
        ],
        intro: (
          <>
            Design the statement of account clients receive (single PDF, bulk generate and email all
            use this). Works for both outstanding-balance and date-range activity statements. Tokens
            use <code>{'{{ scope.field }}'}</code>; loop ledger rows with{' '}
            <code>{'{{#each lines}}…{{/each}}'}</code>; the activity-only opening/closing rows are
            gated on <code>{'{{#if statement.period_start}}'}</code>.
          </>
        ),
      }}
    />
  );
}

function ClientTab(): JSX.Element {
  const [items, setItems] = useState<ClientTpl[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editClientType, setEditClientType] = useState<'INDIVIDUAL' | 'BUSINESS'>('BUSINESS');
  const [editDefaults, setEditDefaults] = useState('');

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: ClientTpl[] }>('/api/staff/admin/templates/client');
      setItems(r.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  function beginEdit(t: ClientTpl): void {
    setEditingId(t.id);
    setEditName(t.name);
    setEditClientType(t.clientType);
    setEditDefaults(JSON.stringify(t.defaultsJson ?? {}, null, 2));
  }

  async function saveEdit(id: string): Promise<void> {
    let parsedDefaults: Record<string, unknown>;
    try {
      parsedDefaults = editDefaults.trim() ? JSON.parse(editDefaults) : {};
    } catch {
      setError('Defaults must be valid JSON.');
      return;
    }
    try {
      await api(`/api/staff/admin/templates/client/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName.trim(),
          clientType: editClientType,
          defaultsJson: parsedDefaults,
        }),
      });
      setEditingId(null);
      setError(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save_failed');
    }
  }

  async function archive(id: string): Promise<void> {
    if (!confirm('Archive this client template? Wizard will no longer offer it.')) return;
    try {
      await api(`/api/staff/admin/templates/client/${id}/archive`, { method: 'PATCH' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'archive_failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      <TemplateLibraryPanel area="clients" onImported={() => void load()} />
      <Card title="Client templates">
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}
        <p style={{ fontSize: 12, color: tokens.color.textMuted }}>
          Prefill defaults for the Create Client wizard. Picking a template fills tags, terms, and
          pipeline stage in the wizard. <code>defaultsJson</code> keys match wizard field names
          (e.g. <code>termsDays</code>, <code>pipelineStage</code>, <code>tags</code>).
        </p>
        {items.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No templates yet.</p>
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            {items.map((t) => {
              const isEditing = editingId === t.id;
              return (
                <div
                  key={t.id}
                  style={{
                    padding: 10,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.md,
                    display: 'grid',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {isEditing ? (
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        style={{ ...fieldStyle, flex: 1, minWidth: 220 }}
                      />
                    ) : (
                      <strong style={{ fontSize: 13 }}>{t.name}</strong>
                    )}
                    <code style={{ fontSize: 11, color: tokens.color.textMuted }}>{t.key}</code>
                    {isEditing ? (
                      <Combobox
                        ariaLabel="Client type"
                        value={editClientType}
                        onChange={(v) => setEditClientType(v as 'INDIVIDUAL' | 'BUSINESS')}
                        options={[
                          { value: 'INDIVIDUAL', label: 'Individual' },
                          { value: 'BUSINESS', label: 'Business' },
                        ]}
                      />
                    ) : (
                      <Pill>{t.clientType}</Pill>
                    )}
                    {t.isSystem && <Pill tone="accent">system</Pill>}
                    {t.status === 'ARCHIVED' && <Pill tone="neutral">archived</Pill>}
                    {t.status === 'ARCHIVED' && <Pill tone="warning">archived</Pill>}
                    {!isEditing && (
                      <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                        {Object.keys(t.defaultsJson ?? {}).length} default field(s)
                      </span>
                    )}
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                      {isEditing ? (
                        <>
                          <Button size="sm" onClick={() => void saveEdit(t.id)}>
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => beginEdit(t)}>
                            Edit
                          </Button>
                          {t.status === 'ACTIVE' && (
                            <Button size="sm" variant="ghost" onClick={() => void archive(t.id)}>
                              Archive
                            </Button>
                          )}
                        </>
                      )}
                    </span>
                  </div>
                  {isEditing && (
                    <textarea
                      value={editDefaults}
                      onChange={(e) => setEditDefaults(e.target.value)}
                      rows={6}
                      style={{
                        ...fieldStyle,
                        fontFamily: tokens.font.mono,
                        fontSize: 11,
                        resize: 'vertical',
                      }}
                      aria-label="Defaults JSON"
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

// ============================================================
// 0084 — Request templates tab.
// ============================================================

type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
type ItemKind = 'QUESTION' | 'DOCUMENT' | 'SIGNATURE';

interface RequestTpl {
  id: string;
  key: string;
  name: string;
  titlePattern: string;
  bodyPattern: string;
  defaultPriority: Priority;
  defaultDueOffsetDays: number | null;
  defaultReminderDaysBefore: number | null;
  defaultAssignedAppUserId: string | null;
  isSystem: boolean;
  status: string;
  items: Array<{
    id: string;
    ordinal: number;
    label: string;
    body: string;
    itemKind: ItemKind;
    required: boolean;
    defaultDueOffsetDays: number | null;
  }>;
}

interface RequestItemDraft {
  ordinal: number;
  label: string;
  body: string;
  itemKind: ItemKind;
  required: boolean;
}

const PRIORITY_OPTIONS: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

function RequestTab(): JSX.Element {
  const [items, setItems] = useState<RequestTpl[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{
    name: string;
    titlePattern: string;
    bodyPattern: string;
    defaultPriority: Priority;
    defaultDueOffsetDays: string;
    defaultReminderDaysBefore: string;
  }>({
    name: '',
    titlePattern: '',
    bodyPattern: '',
    defaultPriority: 'MEDIUM',
    defaultDueOffsetDays: '',
    defaultReminderDaysBefore: '',
  });
  const [editItems, setEditItems] = useState<RequestItemDraft[]>([]);
  const [draft, setDraft] = useState({
    key: '',
    name: '',
    titlePattern: '',
    bodyPattern: '',
    defaultPriority: 'MEDIUM' as Priority,
    defaultDueOffsetDays: '',
    defaultReminderDaysBefore: '',
  });
  const [draftItems, setDraftItems] = useState<RequestItemDraft[]>([]);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: RequestTpl[] }>('/api/staff/admin/templates/request');
      setItems(r.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function add(): Promise<void> {
    if (!draft.key.trim() || !draft.name.trim() || !draft.titlePattern.trim()) return;
    try {
      await api('/api/staff/admin/templates/request', {
        method: 'POST',
        body: JSON.stringify({
          key: draft.key.trim(),
          name: draft.name.trim(),
          titlePattern: draft.titlePattern.trim(),
          bodyPattern: draft.bodyPattern.trim() || undefined,
          defaultPriority: draft.defaultPriority,
          defaultDueOffsetDays: draft.defaultDueOffsetDays
            ? Number(draft.defaultDueOffsetDays)
            : undefined,
          defaultReminderDaysBefore: draft.defaultReminderDaysBefore
            ? Number(draft.defaultReminderDaysBefore)
            : undefined,
          items: draftItems
            .filter((i) => i.label.trim().length > 0)
            .map((i, idx) => ({
              ordinal: idx,
              label: i.label.trim(),
              body: i.body.trim() || undefined,
              itemKind: i.itemKind,
              required: i.required,
            })),
        }),
      });
      setDraft({
        key: '',
        name: '',
        titlePattern: '',
        bodyPattern: '',
        defaultPriority: 'MEDIUM',
        defaultDueOffsetDays: '',
        defaultReminderDaysBefore: '',
      });
      setDraftItems([]);
      setAdding(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'add_failed');
    }
  }

  async function archive(id: string): Promise<void> {
    if (!confirm('Archive this request template?')) return;
    try {
      await api(`/api/staff/admin/templates/request/${id}/archive`, { method: 'PATCH' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'archive_failed');
    }
  }

  function beginEdit(t: RequestTpl): void {
    setEditingId(t.id);
    setEditDraft({
      name: t.name,
      titlePattern: t.titlePattern,
      bodyPattern: t.bodyPattern,
      defaultPriority: t.defaultPriority,
      defaultDueOffsetDays: t.defaultDueOffsetDays != null ? String(t.defaultDueOffsetDays) : '',
      defaultReminderDaysBefore:
        t.defaultReminderDaysBefore != null ? String(t.defaultReminderDaysBefore) : '',
    });
    setEditItems(
      t.items.map((i) => ({
        ordinal: i.ordinal,
        label: i.label,
        body: i.body,
        itemKind: i.itemKind,
        required: i.required,
      })),
    );
  }

  async function saveEdit(id: string): Promise<void> {
    try {
      await api(`/api/staff/admin/templates/request/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editDraft.name.trim(),
          titlePattern: editDraft.titlePattern.trim(),
          bodyPattern: editDraft.bodyPattern.trim() || null,
          defaultPriority: editDraft.defaultPriority,
          defaultDueOffsetDays: editDraft.defaultDueOffsetDays
            ? Number(editDraft.defaultDueOffsetDays)
            : null,
          defaultReminderDaysBefore: editDraft.defaultReminderDaysBefore
            ? Number(editDraft.defaultReminderDaysBefore)
            : null,
        }),
      });
      await api(`/api/staff/admin/templates/request/${id}/items`, {
        method: 'POST',
        body: JSON.stringify({
          items: editItems
            .filter((i) => i.label.trim().length > 0)
            .map((i, idx) => ({
              ordinal: idx,
              label: i.label.trim(),
              body: i.body.trim() || undefined,
              itemKind: i.itemKind,
              required: i.required,
            })),
        }),
      });
      setEditingId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save_failed');
    }
  }

  function renderItemEditor(
    list: RequestItemDraft[],
    setList: (l: RequestItemDraft[]) => void,
  ): JSX.Element {
    return (
      <div>
        <div
          style={{
            fontSize: 12,
            marginBottom: 4,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>Checklist items ({list.length})</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              setList([
                ...list,
                {
                  ordinal: list.length,
                  label: '',
                  body: '',
                  itemKind: 'QUESTION',
                  required: true,
                },
              ])
            }
          >
            + Item
          </Button>
        </div>
        {list.length === 0 ? (
          <div style={{ fontSize: 11, color: tokens.color.textMuted }}>None.</div>
        ) : (
          <div style={{ display: 'grid', gap: 4 }}>
            {list.map((it, idx) => (
              <div
                key={idx}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 130px 100px 40px',
                  gap: 4,
                  alignItems: 'center',
                }}
              >
                <input
                  type="text"
                  value={it.label}
                  onChange={(e) =>
                    setList(list.map((x, i) => (i === idx ? { ...x, label: e.target.value } : x)))
                  }
                  placeholder={`Item ${idx + 1}`}
                  style={fieldStyle}
                />
                <select
                  value={it.itemKind}
                  onChange={(e) =>
                    setList(
                      list.map((x, i) =>
                        i === idx ? { ...x, itemKind: e.target.value as ItemKind } : x,
                      ),
                    )
                  }
                  style={fieldStyle}
                >
                  <option value="QUESTION">Question</option>
                  <option value="DOCUMENT">Document</option>
                  <option value="SIGNATURE">Signature</option>
                </select>
                <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={it.required}
                    onChange={(e) =>
                      setList(
                        list.map((x, i) => (i === idx ? { ...x, required: e.target.checked } : x)),
                      )
                    }
                  />
                  required
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setList(list.filter((_, i) => i !== idx))}
                >
                  ✕
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      <TemplateLibraryPanel area="requests" onImported={() => void load()} />
      <Card title="Request templates">
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}
        <p style={{ fontSize: 12, color: tokens.color.textMuted }}>
          Reusable client-request shells with Mustache title/body patterns plus a default checklist.
          Tokens: <code>{'{{client.name}}'}</code>, <code>{'{{engagement.name}}'}</code>,{' '}
          <code>{'{{today}}'}</code>. Spawn from the Requests page or via bulk-send.
        </p>

        {adding ? (
          <div
            style={{
              padding: 10,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
              display: 'grid',
              gap: 8,
              marginBottom: 12,
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <input
                placeholder="key (lowercase, e.g. year-end-docs)"
                value={draft.key}
                onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                style={fieldStyle}
              />
              <input
                placeholder="Name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                style={fieldStyle}
              />
            </div>
            <input
              placeholder="Title pattern (supports {{client.name}})"
              value={draft.titlePattern}
              onChange={(e) => setDraft({ ...draft, titlePattern: e.target.value })}
              style={fieldStyle}
            />
            <textarea
              placeholder="Body pattern (optional)"
              value={draft.bodyPattern}
              onChange={(e) => setDraft({ ...draft, bodyPattern: e.target.value })}
              rows={3}
              style={{ ...fieldStyle, resize: 'vertical' }}
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <Combobox
                ariaLabel="Default priority"
                options={PRIORITY_OPTIONS.map((p) => ({ value: p, label: p }))}
                value={draft.defaultPriority}
                onChange={(v) => setDraft({ ...draft, defaultPriority: v as Priority })}
              />
              <input
                placeholder="Due offset (days)"
                type="number"
                value={draft.defaultDueOffsetDays}
                onChange={(e) => setDraft({ ...draft, defaultDueOffsetDays: e.target.value })}
                style={fieldStyle}
              />
              <input
                placeholder="Reminder days before"
                type="number"
                value={draft.defaultReminderDaysBefore}
                onChange={(e) => setDraft({ ...draft, defaultReminderDaysBefore: e.target.value })}
                style={fieldStyle}
              />
            </div>
            {renderItemEditor(draftItems, setDraftItems)}
            <div style={{ display: 'flex', gap: 6 }}>
              <Button onClick={() => void add()}>Create</Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setAdding(false);
                  setDraftItems([]);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div style={{ marginBottom: 12 }}>
            <Button onClick={() => setAdding(true)}>+ New request template</Button>
          </div>
        )}

        {items.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No request templates yet.</p>
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            {items.map((t) => {
              const isEditing = editingId === t.id;
              return (
                <div
                  key={t.id}
                  style={{
                    padding: 10,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.md,
                    display: 'grid',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {isEditing ? (
                      <input
                        value={editDraft.name}
                        onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })}
                        style={{ ...fieldStyle, flex: 1, minWidth: 220 }}
                      />
                    ) : (
                      <strong style={{ fontSize: 13 }}>{t.name}</strong>
                    )}
                    <code style={{ fontSize: 11, color: tokens.color.textMuted }}>{t.key}</code>
                    {t.isSystem && <Pill tone="accent">system</Pill>}
                    {t.status === 'ARCHIVED' && <Pill tone="neutral">archived</Pill>}
                    {t.status === 'ARCHIVED' && <Pill tone="warning">archived</Pill>}
                    {!isEditing && <Pill>{t.defaultPriority}</Pill>}
                    {!isEditing && (
                      <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                        {t.items.length} item(s)
                      </span>
                    )}
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                      {isEditing ? (
                        <>
                          <Button size="sm" onClick={() => void saveEdit(t.id)}>
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => beginEdit(t)}>
                            Edit
                          </Button>
                          {t.status === 'ACTIVE' && (
                            <Button size="sm" variant="ghost" onClick={() => void archive(t.id)}>
                              Archive
                            </Button>
                          )}
                        </>
                      )}
                    </span>
                  </div>
                  {isEditing ? (
                    <>
                      <input
                        value={editDraft.titlePattern}
                        onChange={(e) =>
                          setEditDraft({ ...editDraft, titlePattern: e.target.value })
                        }
                        placeholder="Title pattern"
                        style={fieldStyle}
                      />
                      <textarea
                        value={editDraft.bodyPattern}
                        onChange={(e) =>
                          setEditDraft({ ...editDraft, bodyPattern: e.target.value })
                        }
                        rows={2}
                        placeholder="Body pattern"
                        style={{ ...fieldStyle, resize: 'vertical' }}
                      />
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                        <Combobox
                          ariaLabel="Default priority"
                          options={PRIORITY_OPTIONS.map((p) => ({ value: p, label: p }))}
                          value={editDraft.defaultPriority}
                          onChange={(v) =>
                            setEditDraft({ ...editDraft, defaultPriority: v as Priority })
                          }
                        />
                        <input
                          type="number"
                          placeholder="Due offset (days)"
                          value={editDraft.defaultDueOffsetDays}
                          onChange={(e) =>
                            setEditDraft({ ...editDraft, defaultDueOffsetDays: e.target.value })
                          }
                          style={fieldStyle}
                        />
                        <input
                          type="number"
                          placeholder="Reminder days before"
                          value={editDraft.defaultReminderDaysBefore}
                          onChange={(e) =>
                            setEditDraft({
                              ...editDraft,
                              defaultReminderDaysBefore: e.target.value,
                            })
                          }
                          style={fieldStyle}
                        />
                      </div>
                      {renderItemEditor(editItems, setEditItems)}
                    </>
                  ) : (
                    <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                      <div>
                        <strong>Title:</strong> {t.titlePattern}
                      </div>
                      {t.bodyPattern && (
                        <div style={{ marginTop: 2 }}>
                          <strong>Body:</strong> {t.bodyPattern.slice(0, 100)}
                          {t.bodyPattern.length > 100 ? '…' : ''}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
