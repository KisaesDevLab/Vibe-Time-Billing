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

import { Button, Card, Input, Pill, tokens } from '@vibe/ui';

import { api } from '../api-client';

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

const fieldStyle: React.CSSProperties = {
  padding: '8px 10px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
};

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
  const [feeAmountCents, setFeeAmountCents] = useState('');
  const [budgetHours, setBudgetHours] = useState('');
  const [nteCapCents, setNteCapCents] = useState('');
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
    setFeeAmountCents(tpl.defaultFeeAmountCents != null ? String(tpl.defaultFeeAmountCents) : '');
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
      if (feeAmountCents.trim()) body.feeAmountCents = Number(feeAmountCents);
      if (budgetHours.trim()) body.budgetHours = Number(budgetHours);
      if (nteCapCents.trim()) body.nteCapCents = Number(nteCapCents);
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
          <label style={{ display: 'block' }}>
            <span
              style={{
                fontSize: 11,
                color: tokens.color.textMuted,
                display: 'block',
                marginBottom: 4,
              }}
            >
              Client *
            </span>
            <select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              required
              style={fieldStyle}
            >
              <option value="">— select —</option>
              {activeClients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'block' }}>
            <span
              style={{
                fontSize: 11,
                color: tokens.color.textMuted,
                display: 'block',
                marginBottom: 4,
              }}
            >
              Start from template
            </span>
            <select
              value={pickedTemplateId}
              onChange={(e) => applyTemplate(e.target.value)}
              style={fieldStyle}
            >
              <option value="">— blank —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.isSystem ? ' (system)' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>

        {pickedTemplateId && (
          <p style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 12 }}>
            Prefilled from template. Edit any field below before creating.
          </p>
        )}

        <div style={{ display: 'grid', gap: 12 }}>
          <Input label="Name *" value={name} onChange={(e) => setName(e.target.value)} required />

          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
            <label style={{ display: 'block' }}>
              <span
                style={{
                  fontSize: 11,
                  color: tokens.color.textMuted,
                  display: 'block',
                  marginBottom: 4,
                }}
              >
                Fee structure
              </span>
              <select
                value={feeStructure}
                onChange={(e) => setFeeStructure(e.target.value as FeeStructure)}
                style={fieldStyle}
              >
                {FEE_STRUCTURES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <Input
              type="number"
              min={0}
              label="Fee amount (cents)"
              value={feeAmountCents}
              onChange={(e) => setFeeAmountCents(e.target.value)}
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
              type="number"
              min={0}
              label="NTE cap (cents)"
              value={nteCapCents}
              onChange={(e) => setNteCapCents(e.target.value)}
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
