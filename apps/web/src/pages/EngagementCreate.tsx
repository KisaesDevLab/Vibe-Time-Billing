// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
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

import { api } from '../api-client';
import { centsToDollarsInput, dollarsInputToCents } from '../lib/money';

interface Client {
  id: string;
  name: string;
}

interface EngagementTpl {
  id: string;
  key: string;
  name: string;
  defaultFeeStructure: FeeStructure;
  defaultFeeAmountCents: number | null;
  defaultBudgetHours: string | null;
  inScopeWorkCodeIds: string[];
  defaultLetterTemplateId: string | null;
  isSystem: boolean;
  status: string;
}

interface WorkCode {
  id: string;
  name: string;
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
  const [pickedTemplateId, setPickedTemplateId] = useState<string>('');

  const [clientId, setClientId] = useState(initialClientId);
  const [name, setName] = useState('');
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
  const [inScopeIds, setInScopeIds] = useState<string[]>([]);
  const [mixedModeEnabled, setMixedModeEnabled] = useState(false);
  const [feePassthroughEnabled, setFeePassthroughEnabled] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [c, t, w] = await Promise.all([
          api<{ items: Client[] }>('/api/staff/clients'),
          api<{ items: EngagementTpl[] }>('/api/staff/admin/templates/engagement'),
          api<{ items: WorkCode[] }>('/api/staff/taxonomy/work-codes'),
        ]);
        setClients(c.items ?? []);
        setTemplates((t.items ?? []).filter((tpl) => tpl.status === 'ACTIVE'));
        setWorkCodes(w.items ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'load_failed');
      }
    })();
  }, []);

  function applyTemplate(id: string): void {
    setPickedTemplateId(id);
    const tpl = templates.find((t) => t.id === id);
    if (!tpl) return;
    if (!name.trim()) setName(tpl.name);
    setFeeStructure(tpl.defaultFeeStructure);
    setFeeAmountDollars(centsToDollarsInput(tpl.defaultFeeAmountCents));
    setBudgetHours(tpl.defaultBudgetHours ?? '');
    setInScopeIds(tpl.inScopeWorkCodeIds ?? []);
  }

  async function submit(): Promise<void> {
    if (!clientId || !name.trim()) {
      setError('Client and name are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        clientId,
        name: name.trim(),
        feeStructure,
        mixedModeEnabled,
        feePassthroughEnabled,
      };
      const feeCents = dollarsInputToCents(feeAmountDollars);
      if (feeCents != null) body.feeAmountCents = feeCents;
      if (budgetHours.trim()) body.budgetHours = Number(budgetHours);
      const nteCents = dollarsInputToCents(nteCapDollars);
      if (nteCents != null) body.nteCapCents = nteCents;
      if (startDate) body.startDate = startDate;
      if (endDate) body.endDate = endDate;
      if (inScopeIds.length > 0) body.inScopeWorkCodeIds = inScopeIds;
      const r = await api<{ engagement: { id: string } }>('/api/staff/engagements', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      navigate(`/engagements/${r.engagement.id}`);
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
          <Input label="Name *" value={name} onChange={(e) => setName(e.target.value)} required />

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

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
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
