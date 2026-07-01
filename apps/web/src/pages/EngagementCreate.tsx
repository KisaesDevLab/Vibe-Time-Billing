// SPDX-License-Identifier: Elastic-2.0
//
// Create-engagement page (v2 followup). Opens from /engagements/new or
// /engagements/new?clientId=<id> (the latter is what the time-entry
// "Create engagement for {client}" CTA links to when a client has no
// active engagements).
//
// The first step is a template picker — picking a row prefills fee
// structure, fee amount, budget hours, in-scope work codes, and the
// default letter template. Skipping the picker lands on a blank form.

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { Button, Card, Combobox, Input, Pill, tokens, type ComboboxOption } from '@vibe/ui';
import { advancePeriod, resolveEngagementName } from '@vibe/core/engagements';

import { api } from '../api-client';
import { centsToDollarsInput, dollarsInputToCents, percentInputToBps } from '../lib/money';
import {
  RecurrenceComposer,
  makeDefaultRecurrenceDraft,
  recurrenceDraftToPayload,
  type RecurrenceDraft,
  type RecurrenceFrequency,
  type RecurrenceTriggerMode,
} from './engagements/RecurrenceComposer';

interface Client {
  id: string;
  name: string;
  // The clients list already returns the client's owning partner; the
  // form defaults the Partner field to it when a client is selected.
  partnerInChargeId: string | null;
}

type EngagementStatusValue = 'PROPOSED' | 'ACTIVE' | 'PAUSED' | 'CLOSED' | 'ARCHIVED';
const ENGAGEMENT_STATUS_OPTIONS: EngagementStatusValue[] = [
  'PROPOSED',
  'ACTIVE',
  'PAUSED',
  'CLOSED',
  'ARCHIVED',
];

interface EngagementTpl {
  id: string;
  key: string;
  name: string;
  defaultFeeStructure: FeeStructure;
  defaultFeeAmountCents: number | null;
  defaultBudgetHours: string | null;
  inScopeWorkCodeIds: string[];
  defaultLetterTemplateId: string | null;
  // 0054 — engagements created from this template inherit this code.
  defaultRateCodeId: string | null;
  // 0083 — Mustache name template (e.g. "Bookkeeping
  // {{period.month}}/{{period.year}}"). Server resolves at create
  // time if `name` is left blank.
  namePattern: string | null;
  // Inherited onto the engagement at create time so list/report views
  // can roll up by type → service line.
  engagementTypeId: string | null;
  // v2 — additional defaults the template carries onto the form when
  // picked (mixed-mode, fee passthrough, sales tax, surcharge, and the
  // recurrence frequency to prefill).
  defaultMixedModeEnabled: boolean;
  defaultFeePassthroughEnabled: boolean;
  defaultTaxEnabled: boolean;
  defaultTaxRateBps: number | null;
  defaultTaxLabel: string | null;
  defaultSurchargeEnabled: boolean;
  defaultSurchargeType: 'PERCENT' | 'FLAT_AMOUNT';
  defaultSurchargeValueBps: number | null;
  defaultSurchargeAmountCents: number | null;
  defaultSurchargeLabel: string | null;
  defaultRecurrenceFrequency: RecurrenceFrequency | null;
  defaultRecurrenceTriggerMode: RecurrenceTriggerMode | null;
  // 0195 — default lifecycle status for a new engagement from this template.
  defaultEngagementStatus: EngagementStatusValue | null;
  isSystem: boolean;
  status: string;
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
  description: string | null;
  active: boolean;
}

interface WorkCode {
  id: string;
  name: string;
}

interface FirmUser {
  id: string;
  fullName: string;
  email: string;
  status: string;
}

type AssignmentRole = 'PARTNER' | 'MANAGER' | 'REVIEWER' | 'PREPARER' | 'STAFF';
const ASSIGNMENT_ROLES: AssignmentRole[] = ['PARTNER', 'MANAGER', 'REVIEWER', 'PREPARER', 'STAFF'];

interface AssignmentDraft {
  appUserId: string;
  role: AssignmentRole;
}

const FEE_STRUCTURES = [
  'HOURLY',
  'HOURLY_NTE',
  'FIXED_FEE',
  'FIXED_FEE_WITH_MILESTONES',
  'RECURRING_SUBSCRIPTION',
] as const;
type FeeStructure = (typeof FEE_STRUCTURES)[number];

export function EngagementCreatePage(): JSX.Element {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const initialClientId = search.get('clientId') ?? '';

  const [clients, setClients] = useState<Client[]>([]);
  const [templates, setTemplates] = useState<EngagementTpl[]>([]);
  const [workCodes, setWorkCodes] = useState<WorkCode[]>([]);
  const [firmUsers, setFirmUsers] = useState<FirmUser[]>([]);
  const [engagementTypes, setEngagementTypes] = useState<EngagementType[]>([]);
  const [serviceLines, setServiceLines] = useState<ServiceLine[]>([]);
  const [engagementTypeId, setEngagementTypeId] = useState<string>('');
  const [pickedTemplateId, setPickedTemplateId] = useState<string>('');

  // 0050 — assignee fields. partnerId / managerId remain authoritative
  // for billing-side defaults; `assignments` adds additional staff with
  // explicit roles and widens "My Work".
  const [partnerId, setPartnerId] = useState<string>('');
  const [managerId, setManagerId] = useState<string>('');
  const [assignments, setAssignments] = useState<AssignmentDraft[]>([]);
  const [pickedStaffId, setPickedStaffId] = useState<string>('');
  const [pickedRole, setPickedRole] = useState<AssignmentRole>('STAFF');

  const [clientId, setClientId] = useState(initialClientId);
  const [name, setName] = useState('');
  // While true, the Name field mirrors the template's rendered name pattern
  // (and re-renders as the client/period changes). Set false once the user
  // edits the field so we never clobber a manual name.
  const [nameAutoFilled, setNameAutoFilled] = useState(true);
  // 0083 — period inputs. All optional; populated either by the
  // template's name_pattern requirements or because the firm wants to
  // tag this engagement with a (year, month, label) tuple regardless.
  const [periodYear, setPeriodYear] = useState<string>('');
  const [periodMonth, setPeriodMonth] = useState<string>('');
  const [periodLabel, setPeriodLabel] = useState<string>('');
  // 0195 — initial status; '' means "use the server/template default".
  const [status, setStatus] = useState<'' | EngagementStatusValue>('');
  const [rateCodes, setRateCodes] = useState<RateCode[]>([]);
  const [defaultRateCodeId, setDefaultRateCodeId] = useState<string>('');
  const [feeStructure, setFeeStructure] = useState<FeeStructure>('FIXED_FEE');
  // QA fix — these strings hold the dollars representation shown in the
  // inputs ("750.00") rather than the cents value the API expects.
  // Translation happens in applyTemplate (cents → dollars) and submit
  // (dollars → cents) so users don't have to do mental math.
  const [feeAmountDollars, setFeeAmountDollars] = useState('');
  const [budgetHours, setBudgetHours] = useState('');
  const [nteCapDollars, setNteCapDollars] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [inScopeIds, setInScopeIds] = useState<string[]>([]);
  const [mixedModeEnabled, setMixedModeEnabled] = useState(false);
  const [feePassthroughEnabled, setFeePassthroughEnabled] = useState(false);

  // v2 — sales tax (per-engagement). UI shows %; we round-trip via bps.
  const [taxEnabled, setTaxEnabled] = useState(false);
  const [taxRatePercent, setTaxRatePercent] = useState('');
  const [taxLabel, setTaxLabel] = useState('Sales tax');

  // v2 — per-engagement surcharge. Type discriminates which input is live.
  const [surchargeEnabled, setSurchargeEnabled] = useState(false);
  const [surchargeType, setSurchargeType] = useState<'PERCENT' | 'FLAT_AMOUNT'>('PERCENT');
  const [surchargePercent, setSurchargePercent] = useState('');
  const [surchargeFlatDollars, setSurchargeFlatDollars] = useState('');
  const [surchargeLabel, setSurchargeLabel] = useState('');

  // Recurrence — when on, a recurrence row is created after the
  // engagement is inserted, pointing at the same template and this
  // engagement as last_engagement_id (so the next period derives from
  // it). Requires a template pick (the recurrence table FK is to
  // engagement_template, not the engagement itself).
  const [makeRecurring, setMakeRecurring] = useState(false);
  const [recurrenceDraft, setRecurrenceDraft] = useState<RecurrenceDraft>(() =>
    makeDefaultRecurrenceDraft(),
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed period (first spawn) tracks the entered Period year, not today —
  // e.g. an Annual recurrence seeds Period year + 1. Re-derives when the
  // period or frequency changes.
  useEffect(() => {
    if (!makeRecurring) return;
    const y = periodYear.trim() ? Number(periodYear) : null;
    if (y == null || !Number.isFinite(y)) return;
    const m = periodMonth.trim() ? Number(periodMonth) : null;
    const next = advancePeriod(
      { year: y, month: m, label: periodLabel.trim() || null },
      recurrenceDraft.frequency,
    );
    const sy = next.year == null ? '' : String(next.year);
    const sm = next.month == null ? '' : String(next.month);
    setRecurrenceDraft((d) =>
      d.seedPeriodYear === sy && d.seedPeriodMonth === sm
        ? d
        : { ...d, seedPeriodYear: sy, seedPeriodMonth: sm },
    );
  }, [makeRecurring, periodYear, periodMonth, periodLabel, recurrenceDraft.frequency]);

  // Keep the Name field showing the template's rendered name pattern until the
  // user edits it (e.g. "2025 - 1040 Preparation" from {{period.year}} - …).
  useEffect(() => {
    if (!nameAutoFilled) return;
    const tpl = templates.find((t) => t.id === pickedTemplateId);
    if (!tpl?.namePattern) return;
    const clientName = clients.find((c) => c.id === clientId)?.name ?? '';
    const rendered = resolveEngagementName(tpl.namePattern, {
      client: { name: clientName },
      period: {
        year: periodYear.trim() ? Number(periodYear) : null,
        month: periodMonth.trim() ? Number(periodMonth) : null,
        label: periodLabel.trim() || null,
      },
      today: new Date().toISOString().slice(0, 10),
    }).output.trim();
    if (rendered) setName(rendered);
  }, [
    nameAutoFilled,
    pickedTemplateId,
    templates,
    clientId,
    clients,
    periodYear,
    periodMonth,
    periodLabel,
  ]);

  useEffect(() => {
    void (async () => {
      try {
        const [c, t, w, u, rc, et, sl] = await Promise.all([
          api<{ items: Client[] }>('/api/staff/clients').catch(() => ({ items: [] })),
          api<{ items: EngagementTpl[] }>('/api/staff/admin/templates/engagement').catch(() => ({
            items: [],
          })),
          api<{ items: WorkCode[] }>('/api/staff/taxonomy/work-codes').catch(() => ({
            items: [],
          })),
          api<{ users: FirmUser[] }>('/api/staff/admin/users').catch(() => ({ users: [] })),
          api<{ items: RateCode[] }>('/api/staff/admin/rate-codes').catch(() => ({ items: [] })),
          api<{ items: EngagementType[] }>('/api/staff/taxonomy/engagement-types').catch(() => ({
            items: [],
          })),
          api<{ items: ServiceLine[] }>('/api/staff/taxonomy/service-lines').catch(() => ({
            items: [],
          })),
        ]);
        setClients(c.items ?? []);
        setTemplates((t.items ?? []).filter((tpl) => tpl.status === 'ACTIVE'));
        setWorkCodes(w.items ?? []);
        setFirmUsers((u.users ?? []).filter((x) => x.status === 'ACTIVE'));
        setRateCodes((rc.items ?? []).filter((x) => x.active));
        setEngagementTypes(et.items ?? []);
        setServiceLines(sl.items ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'load_failed');
      }
    })();
  }, []);

  // Default the Partner to the selected client's owning partner. Keyed
  // on clientId + the loaded clients list so it also runs once the list
  // resolves for the ?clientId= deep-link case. Re-defaults whenever the
  // user changes the Client; a manual Partner change after that sticks
  // until the Client changes again (this effect only fires on clientId).
  useEffect(() => {
    if (!clientId) return;
    const client = clients.find((c) => c.id === clientId);
    if (client?.partnerInChargeId) setPartnerId(client.partnerInChargeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally
    // omit setPartnerId (stable) and depend only on clientId/clients so a
    // later manual partner edit isn't overwritten.
  }, [clientId, clients]);

  function applyTemplate(id: string): void {
    setPickedTemplateId(id);
    const tpl = templates.find((t) => t.id === id);
    if (!tpl) {
      // Back to "— blank —": drop the template-driven recurrence.
      setMakeRecurring(false);
      return;
    }
    // Re-enable name auto-fill on (re)pick. Pattern templates are rendered by
    // the effect above ("2025 - 1040 Preparation"); static-name templates
    // prefill their plain name here.
    setNameAutoFilled(true);
    if (!tpl.namePattern) setName(tpl.name);
    // Prefill the initial status from the template's default (if any).
    setStatus(tpl.defaultEngagementStatus ?? '');
    setFeeStructure(tpl.defaultFeeStructure);
    setFeeAmountDollars(centsToDollarsInput(tpl.defaultFeeAmountCents));
    setBudgetHours(tpl.defaultBudgetHours ?? '');
    setInScopeIds(tpl.inScopeWorkCodeIds ?? []);
    if (tpl.defaultRateCodeId) setDefaultRateCodeId(tpl.defaultRateCodeId);
    // Inherit the type from the template so the engagement (and every
    // report that rolls up by type → service line) gets categorized
    // without the user having to pick a second time.
    if (tpl.engagementTypeId) setEngagementTypeId(tpl.engagementTypeId);
    // v2 — additional fee/billing defaults carried by the template.
    setMixedModeEnabled(tpl.defaultMixedModeEnabled);
    setFeePassthroughEnabled(tpl.defaultFeePassthroughEnabled);
    setTaxEnabled(tpl.defaultTaxEnabled);
    setTaxRatePercent(tpl.defaultTaxRateBps != null ? String(tpl.defaultTaxRateBps / 100) : '');
    setTaxLabel(tpl.defaultTaxLabel ?? '');
    setSurchargeEnabled(tpl.defaultSurchargeEnabled);
    setSurchargeType(tpl.defaultSurchargeType);
    setSurchargePercent(
      tpl.defaultSurchargeValueBps != null ? String(tpl.defaultSurchargeValueBps / 100) : '',
    );
    setSurchargeFlatDollars(centsToDollarsInput(tpl.defaultSurchargeAmountCents));
    setSurchargeLabel(tpl.defaultSurchargeLabel ?? '');
    // When the template carries a recurrence default, turn "Make recurring"
    // ON and fully populate the composer (frequency + trigger) so it
    // actually applies; clear it when the template has no default.
    const freq = tpl.defaultRecurrenceFrequency;
    if (freq) {
      setMakeRecurring(true);
      setRecurrenceDraft((d) => ({
        ...d,
        frequency: freq,
        triggerMode: tpl.defaultRecurrenceTriggerMode ?? d.triggerMode,
      }));
    } else {
      setMakeRecurring(false);
    }
  }

  // 0083 — pick a template that uses a name_pattern + the user left
  // the name field blank → preview what the server will resolve. Used
  // in the UI hint below the name input.
  const pickedTpl = templates.find((t) => t.id === pickedTemplateId) ?? null;
  const pickedClientName = clients.find((c) => c.id === clientId)?.name ?? null;
  const periodPreview = {
    year: periodYear.trim() ? Number(periodYear) : null,
    month: periodMonth.trim() ? Number(periodMonth) : null,
    label: periodLabel.trim() || null,
  };
  const namePreview =
    pickedTpl?.namePattern && !name.trim()
      ? resolveEngagementName(pickedTpl.namePattern, {
          client: { name: pickedClientName ?? '' },
          period: periodPreview,
          today: new Date().toISOString().slice(0, 10),
        })
      : null;

  async function submit(): Promise<void> {
    if (!clientId) {
      setError('Client is required.');
      return;
    }
    if (!name.trim() && !pickedTpl?.namePattern) {
      setError('Name is required (or pick a template with a name pattern).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        clientId,
        feeStructure,
        mixedModeEnabled,
        feePassthroughEnabled,
      };
      if (name.trim()) body.name = name.trim();
      if (status) body.status = status;
      if (pickedTemplateId) body.templateId = pickedTemplateId;
      if (periodPreview.year != null || periodPreview.month != null || periodPreview.label) {
        body.period = periodPreview;
      }
      const feeCents = dollarsInputToCents(feeAmountDollars);
      if (feeCents != null) body.feeAmountCents = feeCents;
      if (budgetHours.trim()) body.budgetHours = Number(budgetHours);
      const nteCents = dollarsInputToCents(nteCapDollars);
      if (nteCents != null) body.nteCapCents = nteCents;
      if (startDate) body.startDate = startDate;
      if (endDate) body.endDate = endDate;
      if (dueDate) body.dueDate = dueDate;
      if (inScopeIds.length > 0) body.inScopeWorkCodeIds = inScopeIds;
      if (defaultRateCodeId) body.defaultRateCodeId = defaultRateCodeId;
      if (engagementTypeId) body.engagementTypeId = engagementTypeId;
      if (partnerId) body.partnerId = partnerId;
      if (managerId) body.managerId = managerId;
      if (assignments.length > 0) body.assignments = assignments;
      // v2 — tax + surcharge payload.
      body.taxEnabled = taxEnabled;
      if (taxEnabled) {
        body.taxRateBps = percentInputToBps(taxRatePercent) ?? 0;
        if (taxLabel.trim()) body.taxLabel = taxLabel.trim();
      }
      body.surchargeEnabled = surchargeEnabled;
      if (surchargeEnabled) {
        body.surchargeType = surchargeType;
        if (surchargeType === 'PERCENT') {
          body.surchargeValueBps = percentInputToBps(surchargePercent) ?? 0;
          body.surchargeAmountCents = 0;
        } else {
          body.surchargeAmountCents = dollarsInputToCents(surchargeFlatDollars) ?? 0;
          body.surchargeValueBps = 0;
        }
        body.surchargeLabel = surchargeLabel.trim() || null;
      }
      const r = await api<{ id: string }>('/api/staff/engagements', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      // Recurrence — best-effort after the engagement insert succeeds.
      // A failure here does not unwind the engagement (the partner can
      // add the recurrence later from the client detail card).
      if (makeRecurring && pickedTemplateId) {
        try {
          await api('/api/staff/engagement-recurrences', {
            method: 'POST',
            body: JSON.stringify({
              clientId,
              templateId: pickedTemplateId,
              ...recurrenceDraftToPayload(recurrenceDraft),
            }),
          });
        } catch (e) {
          // Surface the failure but still navigate to the engagement so
          // the user can see what was created.
          setError(
            `Engagement created, but recurrence setup failed: ${
              e instanceof Error ? e.message : 'unknown_error'
            }. Add the recurrence from the client's Engagements tab.`,
          );
        }
      }
      navigate(`/engagements/${r.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'create_failed');
    } finally {
      setBusy(false);
    }
  }

  const activeClients = clients.filter((c) => c.id);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900 }}>
      <Card title="New engagement">
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
          <div>
            <div
              style={{
                fontSize: 11,
                color: tokens.color.textMuted,
                display: 'block',
                marginBottom: 4,
              }}
            >
              Client *
            </div>
            <Combobox
              ariaLabel="Client"
              required
              value={clientId}
              onChange={setClientId}
              options={activeClients.map<ComboboxOption>((c) => ({ value: c.id, label: c.name }))}
              placeholder="— select —"
            />
          </div>
          <div>
            <div
              style={{
                fontSize: 11,
                color: tokens.color.textMuted,
                display: 'block',
                marginBottom: 4,
              }}
            >
              Start from template
            </div>
            <Combobox
              ariaLabel="Engagement template"
              clearable
              value={pickedTemplateId}
              onChange={applyTemplate}
              options={templates.map<ComboboxOption>((t) => ({
                value: t.id,
                label: t.name,
                description: t.isSystem ? 'system' : undefined,
              }))}
              placeholder="— blank —"
            />
          </div>
        </div>

        {pickedTemplateId && (
          <p style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 12 }}>
            Prefilled from template. Edit any field below before creating.
          </p>
        )}

        <div style={{ display: 'grid', gap: 12 }}>
          <div>
            <Input
              label={pickedTpl?.namePattern ? 'Name (optional — template fills in)' : 'Name *'}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameAutoFilled(false);
              }}
              placeholder={pickedTpl?.namePattern ? '(blank uses template pattern)' : ''}
            />
            {namePreview && (
              <p
                style={{
                  fontSize: 11,
                  color: tokens.color.textMuted,
                  margin: '4px 0 0',
                }}
              >
                Will save as:{' '}
                <strong style={{ color: tokens.color.text }}>
                  {namePreview.output || '(empty — fill in period fields below)'}
                </strong>
                {namePreview.unresolvedTokens.length > 0 && (
                  <span style={{ color: tokens.color.warning }}>
                    {' '}
                    — missing: {namePreview.unresolvedTokens.join(', ')}
                  </span>
                )}
              </p>
            )}
          </div>

          {/* 0195 — initial lifecycle status. Blank uses the template's
              default (or PROPOSED). Prefilled from the picked template. */}
          <div>
            <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 4 }}>
              Status
            </div>
            <select
              aria-label="Initial engagement status"
              value={status}
              onChange={(e) => setStatus(e.target.value as '' | EngagementStatusValue)}
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: tokens.radius.sm,
                border: `1px solid ${tokens.color.border}`,
                background: tokens.color.surface,
                color: tokens.color.text,
                fontSize: 14,
              }}
            >
              <option value="">
                {pickedTpl?.defaultEngagementStatus
                  ? `Template default (${pickedTpl.defaultEngagementStatus})`
                  : 'Default (Proposed)'}
              </option>
              {ENGAGEMENT_STATUS_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>

          {/* 0083 — period inputs. Render only when a template is
              picked (the period fields are template-driven), or when
              the user wants to tag the engagement with structured
              period data even without a template. Show always so
              firms can use them for any engagement. */}
          <div>
            <div
              style={{
                fontSize: 11,
                color: tokens.color.textMuted,
                marginBottom: 4,
              }}
            >
              Period (optional){' '}
              {pickedTpl?.namePattern && (
                <span style={{ color: tokens.color.accent }}>— used by template name pattern</span>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 8 }}>
              <Input
                type="number"
                min={1900}
                max={9999}
                label="Year"
                value={periodYear}
                onChange={(e) => setPeriodYear(e.target.value)}
                placeholder="2026"
              />
              <div>
                <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 4 }}>
                  Month
                </div>
                <Combobox
                  ariaLabel="Period month"
                  clearable
                  value={periodMonth}
                  onChange={(v) => setPeriodMonth(v ?? '')}
                  options={Array.from({ length: 12 }, (_, i) => ({
                    value: String(i + 1),
                    label: new Date(2000, i, 1).toLocaleString('en-US', { month: 'long' }),
                  }))}
                  placeholder="—"
                />
              </div>
              <Input
                label="Label"
                value={periodLabel}
                onChange={(e) => setPeriodLabel(e.target.value)}
                placeholder="e.g. Q1 2026, FY26"
              />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
            <div>
              <div
                style={{
                  fontSize: 11,
                  color: tokens.color.textMuted,
                  display: 'block',
                  marginBottom: 4,
                }}
              >
                Fee structure
              </div>
              <Combobox
                ariaLabel="Fee structure"
                value={feeStructure}
                onChange={(v) => setFeeStructure(v as FeeStructure)}
                options={FEE_STRUCTURES.map<ComboboxOption>((s) => ({ value: s, label: s }))}
              />
            </div>
            <Input
              type="text"
              inputMode="decimal"
              label="Fee amount ($)"
              value={feeAmountDollars}
              onChange={(e) => setFeeAmountDollars(e.target.value)}
              placeholder="0.00"
            />
            <Input
              type="number"
              min={0}
              step={0.25}
              label="Budget hours"
              value={budgetHours}
              onChange={(e) => setBudgetHours(e.target.value)}
            />
          </div>

          {feeStructure === 'HOURLY_NTE' && (
            <Input
              type="text"
              inputMode="decimal"
              label="NTE cap ($)"
              value={nteCapDollars}
              onChange={(e) => setNteCapDollars(e.target.value)}
              placeholder="0.00"
              hint="Hard cap on billable amount for an HOURLY_NTE engagement."
            />
          )}

          <div>
            <div
              style={{
                fontSize: 11,
                color: tokens.color.textMuted,
                display: 'block',
                marginBottom: 4,
              }}
            >
              Default rate code
            </div>
            <Combobox
              ariaLabel="Default rate code"
              clearable
              value={defaultRateCodeId}
              onChange={(v) => setDefaultRateCodeId(v || '')}
              options={rateCodes.map<ComboboxOption>((rc) => ({
                value: rc.id,
                label: rc.code,
                description: rc.description ?? undefined,
              }))}
              placeholder="StandardRate (default)"
            />
            <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: '4px 0 0' }}>
              Drives which billing rate is pulled from each staff member&apos;s snapshot. Leave
              blank to fall back to StandardRate.
            </p>
          </div>

          {/* Type → service line. Picking a Type both categorizes the
              engagement for reports (Profitability by Service Line,
              AR by Service Line, etc.) and inherits the type's
              default fee structure / budget guidance. Service line
              is derived from the type and shown read-only. */}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
            <div>
              <div
                style={{
                  fontSize: 11,
                  color: tokens.color.textMuted,
                  display: 'block',
                  marginBottom: 4,
                }}
              >
                Type
              </div>
              <Combobox
                ariaLabel="Engagement type"
                clearable
                value={engagementTypeId}
                onChange={(v) => setEngagementTypeId(v || '')}
                options={engagementTypes.map<ComboboxOption>((t) => {
                  const sl = serviceLines.find((s) => s.id === t.serviceLineId);
                  return {
                    value: t.id,
                    label: t.name,
                    description: sl?.name ?? undefined,
                  };
                })}
                placeholder="— select —"
              />
            </div>
            <div>
              <div
                style={{
                  fontSize: 11,
                  color: tokens.color.textMuted,
                  display: 'block',
                  marginBottom: 4,
                }}
              >
                Service line
              </div>
              <div
                style={{
                  padding: '10px 12px',
                  background: tokens.color.bg,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.md,
                  fontSize: 14,
                  color: tokens.color.textMuted,
                  minHeight: 'calc(14px + 20px)',
                  display: 'flex',
                  alignItems: 'center',
                  boxSizing: 'border-box',
                }}
              >
                {(() => {
                  const type = engagementTypes.find((t) => t.id === engagementTypeId);
                  const sl = serviceLines.find((s) => s.id === type?.serviceLineId);
                  return sl?.name ?? '— derived from Type —';
                })()}
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <Input
              type="date"
              label="Start date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
            <Input
              type="date"
              label="End date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
            <Input
              type="date"
              label="Due date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              hint="External deadline (filing date, audit report due, etc)."
            />
          </div>

          {/* 0050 — partner/manager + additional staff assignments. */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <div
                style={{
                  fontSize: 11,
                  color: tokens.color.textMuted,
                  display: 'block',
                  marginBottom: 4,
                }}
              >
                Partner
              </div>
              <Combobox
                ariaLabel="Partner"
                clearable
                value={partnerId}
                onChange={setPartnerId}
                options={firmUsers.map<ComboboxOption>((u) => ({
                  value: u.id,
                  label: u.fullName,
                  description: u.email,
                }))}
                placeholder="— none —"
              />
            </div>
            <div>
              <div
                style={{
                  fontSize: 11,
                  color: tokens.color.textMuted,
                  display: 'block',
                  marginBottom: 4,
                }}
              >
                Manager
              </div>
              <Combobox
                ariaLabel="Manager"
                clearable
                value={managerId}
                onChange={setManagerId}
                options={firmUsers.map<ComboboxOption>((u) => ({
                  value: u.id,
                  label: u.fullName,
                  description: u.email,
                }))}
                placeholder="— none —"
              />
            </div>
          </div>

          <div>
            <div
              style={{
                fontSize: 11,
                color: tokens.color.textMuted,
                marginBottom: 4,
                textTransform: 'uppercase',
              }}
            >
              Additional staff ({assignments.length})
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 8 }}>
              <div style={{ flex: 1 }}>
                <Combobox
                  ariaLabel="Staff"
                  value={pickedStaffId}
                  onChange={setPickedStaffId}
                  options={[
                    { value: '', label: '— select staff —' },
                    ...firmUsers
                      .filter((u) => !assignments.some((a) => a.appUserId === u.id))
                      .map<ComboboxOption>((u) => ({
                        value: u.id,
                        label: u.fullName,
                        description: u.email,
                      })),
                  ]}
                  size="sm"
                />
              </div>
              <div style={{ width: 140 }}>
                <Combobox
                  ariaLabel="Role"
                  value={pickedRole}
                  onChange={(v) => setPickedRole(v as AssignmentRole)}
                  options={ASSIGNMENT_ROLES.map<ComboboxOption>((r) => ({ value: r, label: r }))}
                  size="sm"
                />
              </div>
              <Button
                size="sm"
                disabled={!pickedStaffId}
                onClick={() => {
                  if (!pickedStaffId) return;
                  setAssignments([...assignments, { appUserId: pickedStaffId, role: pickedRole }]);
                  setPickedStaffId('');
                  setPickedRole('STAFF');
                }}
              >
                Add
              </Button>
            </div>
            {assignments.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {assignments.map((a) => {
                  const u = firmUsers.find((x) => x.id === a.appUserId);
                  return (
                    <Pill key={`${a.appUserId}:${a.role}`} tone="accent">
                      {u?.fullName ?? a.appUserId} · {a.role}
                      <button
                        type="button"
                        aria-label="Remove"
                        onClick={() =>
                          setAssignments(
                            assignments.filter(
                              (x) => !(x.appUserId === a.appUserId && x.role === a.role),
                            ),
                          )
                        }
                        style={{
                          marginLeft: 6,
                          background: 'transparent',
                          border: 'none',
                          color: 'inherit',
                          cursor: 'pointer',
                        }}
                      >
                        ×
                      </button>
                    </Pill>
                  );
                })}
              </div>
            )}
          </div>

          <label
            htmlFor="mixed-mode"
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
              id="mixed-mode"
              type="checkbox"
              aria-label="Mixed-mode in-scope per entry"
              checked={mixedModeEnabled}
              onChange={(e) => setMixedModeEnabled(e.target.checked)}
            />
            <span style={{ flex: 1 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>
                Mixed-mode (in-scope per entry)
              </span>
              <span style={{ display: 'block', fontSize: 12, color: tokens.color.textMuted }}>
                Time entries get flagged in_scope at write time when their work code is in the list
                below.
              </span>
            </span>
          </label>

          <label
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              padding: 10,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
            }}
            htmlFor="fee-passthrough"
          >
            <input
              id="fee-passthrough"
              type="checkbox"
              aria-label="Fee passthrough"
              checked={feePassthroughEnabled}
              onChange={(e) => setFeePassthroughEnabled(e.target.checked)}
            />
            <span style={{ flex: 1 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>
                Fee passthrough
              </span>
              <span style={{ display: 'block', fontSize: 12, color: tokens.color.textMuted }}>
                Adds a processing-fee line item to invoices for this engagement.
              </span>
            </span>
          </label>

          {/* v2 — sales tax (per-engagement). */}
          <label
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              padding: 10,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
            }}
            htmlFor="tax-enabled"
          >
            <input
              id="tax-enabled"
              type="checkbox"
              aria-label="Charge sales tax"
              checked={taxEnabled}
              onChange={(e) => setTaxEnabled(e.target.checked)}
            />
            <span style={{ flex: 1 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>
                Charge sales tax
              </span>
              <span style={{ display: 'block', fontSize: 12, color: tokens.color.textMuted }}>
                Adds a tax line on invoices (applied to subtotal + surcharge). For HI GET, NM GRT,
                and other jurisdictions that tax professional services.
              </span>
            </span>
          </label>
          {taxEnabled && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Input
                type="text"
                inputMode="decimal"
                label="Tax rate (%)"
                value={taxRatePercent}
                onChange={(e) => setTaxRatePercent(e.target.value)}
                placeholder="4.25"
              />
              <Input
                type="text"
                label="Tax label"
                value={taxLabel}
                onChange={(e) => setTaxLabel(e.target.value)}
                placeholder="Sales tax"
                hint='Customizable: "GET", "GRT", "Sales tax", etc.'
              />
            </div>
          )}

          {/* v2 — per-engagement surcharge. */}
          <label
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              padding: 10,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
            }}
            htmlFor="surcharge-enabled"
          >
            <input
              id="surcharge-enabled"
              type="checkbox"
              aria-label="Add surcharge"
              checked={surchargeEnabled}
              onChange={(e) => setSurchargeEnabled(e.target.checked)}
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
          {surchargeEnabled && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 12 }}>
              <Combobox
                ariaLabel="Surcharge type"
                value={surchargeType}
                onChange={(v) => setSurchargeType(v as 'PERCENT' | 'FLAT_AMOUNT')}
                options={[
                  { value: 'PERCENT', label: 'Percent of subtotal' },
                  { value: 'FLAT_AMOUNT', label: 'Flat dollar amount' },
                ]}
              />
              {surchargeType === 'PERCENT' ? (
                <Input
                  type="text"
                  inputMode="decimal"
                  label="Surcharge %"
                  value={surchargePercent}
                  onChange={(e) => setSurchargePercent(e.target.value)}
                  placeholder="3.00"
                />
              ) : (
                <Input
                  type="text"
                  inputMode="decimal"
                  label="Surcharge ($)"
                  value={surchargeFlatDollars}
                  onChange={(e) => setSurchargeFlatDollars(e.target.value)}
                  placeholder="50.00"
                />
              )}
              <Input
                type="text"
                label="Surcharge label"
                value={surchargeLabel}
                onChange={(e) => setSurchargeLabel(e.target.value)}
                placeholder="(uses firm default)"
                hint="Override if this engagement needs a custom label."
              />
            </div>
          )}

          {mixedModeEnabled && (
            <div>
              <div
                style={{
                  fontSize: 11,
                  color: tokens.color.textMuted,
                  marginBottom: 4,
                  textTransform: 'uppercase',
                }}
              >
                In-scope work codes ({inScopeIds.length})
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {workCodes.map((w) => {
                  const on = inScopeIds.includes(w.id);
                  return (
                    <button
                      key={w.id}
                      type="button"
                      onClick={() =>
                        setInScopeIds(
                          on ? inScopeIds.filter((x) => x !== w.id) : [...inScopeIds, w.id],
                        )
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
                })}
              </div>
            </div>
          )}

          <fieldset
            style={{
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
              padding: 12,
              marginTop: 8,
              display: 'grid',
              gap: 10,
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
              Recurrence
            </legend>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={makeRecurring}
                onChange={(e) => setMakeRecurring(e.target.checked)}
                disabled={!pickedTemplateId}
              />
              <span>
                <strong>Make this engagement recurring</strong>{' '}
                {!pickedTemplateId && (
                  <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                    (pick a template above to enable — the recurrence reuses the template each
                    cycle)
                  </span>
                )}
              </span>
            </label>
            {makeRecurring && pickedTemplateId && (
              <div
                style={{
                  background: tokens.color.surface,
                  padding: 10,
                  borderRadius: tokens.radius.sm,
                }}
              >
                <RecurrenceComposer value={recurrenceDraft} onChange={setRecurrenceDraft} />
              </div>
            )}
          </fieldset>

          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Button onClick={() => void submit()} disabled={busy || !clientId || !name.trim()}>
              {busy ? 'Creating…' : 'Create engagement'}
            </Button>
            <Button variant="ghost" onClick={() => navigate(-1)} disabled={busy}>
              Cancel
            </Button>
            {pickedTemplateId && <Pill tone="accent">Template applied</Pill>}
          </div>
        </div>
      </Card>
    </div>
  );
}
