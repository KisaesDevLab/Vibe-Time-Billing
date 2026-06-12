// SPDX-License-Identifier: Elastic-2.0
//
// The wedge UI. User picks an allocation method, sees the per-timekeeper
// preview live (debounced on input change), and submits. Cascade
// preview includes the role tier so you can see who absorbs what.

import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api, type ApiError } from '../api-client';

/** Surface the backend `detail` (the real allocation error) when present,
 *  else the error code, else a fallback. */
function errText(err: unknown, fallback: string): string {
  const body = (err as ApiError | undefined)?.body as
    | { detail?: string; error?: string }
    | undefined;
  if (body?.detail) return body.detail;
  if (err instanceof Error) return err.message;
  return fallback;
}

type AllocationMethod =
  | 'SPECIFIC_ENTRIES'
  | 'PRO_RATA_BY_VALUE'
  | 'PRO_RATA_BY_HOURS'
  | 'PARTNER_ABSORBS'
  | 'HIERARCHICAL_CASCADE'
  | 'CUSTOM_WEIGHTED';

interface ReasonCode {
  id: string;
  category: 'WRITE_DOWN' | 'WRITE_UP' | 'TRANSFER';
  label: string;
}

interface BatchEntryLite {
  timeEntryId: string;
  appUserId: string;
  staffName: string | null;
  standardAmountCents: number;
  hours: string;
  action: 'INCLUDE' | 'DEFER' | 'WRITE_OFF';
}

interface PreviewRow {
  timeEntryId: string;
  appUserId: string;
  appUserName: string | null;
  appUserRole: 'PARTNER' | 'MANAGER' | 'SENIOR' | 'STAFF' | 'ADMIN';
  originalValueCents: number;
  adjustedValueCents: number;
  adjustmentAmountCents: number;
}

interface PreviewResp {
  allocations: PreviewRow[];
  total: number;
}

export interface AdjustmentDialogProps {
  billingBatchId: string;
  includedTotalCents: number;
  /** Current net adjustment on the batch (signed cents) — seeds the
   *  Amount + Direction so the dialog opens matching the main screen. */
  currentAdjustmentCents?: number;
  onClose: () => void;
  onCreated: () => void;
}

const CASCADE_DEFAULT = ['STAFF', 'SENIOR', 'MANAGER', 'PARTNER'] as const;

export function AdjustmentDialog({
  billingBatchId,
  includedTotalCents,
  currentAdjustmentCents = 0,
  onClose,
  onCreated,
}: AdjustmentDialogProps): JSX.Element {
  const [reasonCodes, setReasonCodes] = useState<ReasonCode[]>([]);
  const [reasonCodeId, setReasonCodeId] = useState('');
  const [method, setMethod] = useState<'TIME' | 'FEE' | 'RATE'>('TIME');
  const [allocationMethod, setAllocationMethod] = useState<AllocationMethod>('PRO_RATA_BY_VALUE');
  // Amount in dollars (UI), converted to signed cents on submit. Seed from
  // the batch's current net adjustment so the dialog matches the summary;
  // fall back to a sensible default when there's no adjustment yet.
  const [amountDollars, setAmountDollars] = useState(
    currentAdjustmentCents !== 0 ? (Math.abs(currentAdjustmentCents) / 100).toFixed(2) : '100.00',
  );
  const [direction, setDirection] = useState<'WRITE_DOWN' | 'WRITE_UP'>(
    currentAdjustmentCents > 0 ? 'WRITE_UP' : 'WRITE_DOWN',
  );
  const [notes, setNotes] = useState('');
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Included batch entries — needed for SPECIFIC_ENTRIES (per-entry amounts)
  // and CUSTOM_WEIGHTED (per-timekeeper weights).
  const [entries, setEntries] = useState<BatchEntryLite[]>([]);
  // Per-entry amount (dollars, magnitude) for SPECIFIC_ENTRIES.
  const [entryAmounts, setEntryAmounts] = useState<Record<string, string>>({});
  // Per-timekeeper percent weight for CUSTOM_WEIGHTED.
  const [weights, setWeights] = useState<Record<string, string>>({});

  useEffect(() => {
    void api<{ entries: BatchEntryLite[] }>(`/api/staff/billing-batches/${billingBatchId}`)
      .then((r) => setEntries((r.entries ?? []).filter((e) => e.action === 'INCLUDE')))
      .catch(() => undefined);
  }, [billingBatchId]);

  // Distinct timekeepers across the included entries (for Custom weighted).
  const timekeepers = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of entries) m.set(e.appUserId, e.staffName ?? 'Unknown');
    return [...m.entries()].map(([appUserId, name]) => ({ appUserId, name }));
  }, [entries]);

  useEffect(() => {
    void api<{ items: ReasonCode[] }>('/api/staff/taxonomy/reason-codes').then((r) => {
      const filtered = (r.items ?? []).filter((rc) =>
        direction === 'WRITE_DOWN' ? rc.category === 'WRITE_DOWN' : rc.category === 'WRITE_UP',
      );
      setReasonCodes(filtered);
      if (filtered.length > 0 && !reasonCodeId) setReasonCodeId(filtered[0]!.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direction]);

  const totalCents =
    Math.round(Number(amountDollars) * 100) * (direction === 'WRITE_DOWN' ? -1 : 1);
  const sign = direction === 'WRITE_DOWN' ? -1 : 1;

  // SPECIFIC_ENTRIES: pre-fill per-entry amounts pro-rata by standard value
  // (re-spreads when the amount or entry set changes; still editable).
  useEffect(() => {
    if (allocationMethod !== 'SPECIFIC_ENTRIES' || entries.length === 0) return;
    const total = Math.abs(totalCents);
    const sumStd = entries.reduce((s, e) => s + Math.abs(e.standardAmountCents), 0);
    const next: Record<string, string> = {};
    for (const e of entries) {
      const share =
        sumStd > 0 ? (total * Math.abs(e.standardAmountCents)) / sumStd : total / entries.length;
      next[e.timeEntryId] = (share / 100).toFixed(2);
    }
    setEntryAmounts(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allocationMethod, entries, totalCents]);

  // CUSTOM_WEIGHTED: pre-fill equal percent weights (last absorbs remainder).
  useEffect(() => {
    if (allocationMethod !== 'CUSTOM_WEIGHTED' || timekeepers.length === 0) return;
    const n = timekeepers.length;
    const base = Math.floor((100 / n) * 100) / 100;
    const next: Record<string, string> = {};
    timekeepers.forEach((t, i) => {
      next[t.appUserId] = (
        i === n - 1 ? Number((100 - base * (n - 1)).toFixed(2)) : base
      ).toString();
    });
    setWeights(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allocationMethod, timekeepers]);

  // Build the method-specific payload fields.
  function allocationExtras(): Record<string, unknown> {
    if (allocationMethod === 'HIERARCHICAL_CASCADE') return { cascadeOrder: CASCADE_DEFAULT };
    if (allocationMethod === 'SPECIFIC_ENTRIES') {
      return {
        entrySelections: entries.map((e) => ({
          entryId: e.timeEntryId,
          amountCents: sign * Math.round(Number(entryAmounts[e.timeEntryId] ?? '0') * 100),
        })),
      };
    }
    if (allocationMethod === 'CUSTOM_WEIGHTED') {
      return {
        weightingMode: 'PERCENT',
        weights: timekeepers.map((t) => ({
          appUserId: t.appUserId,
          weight: Number(weights[t.appUserId] ?? '0'),
        })),
      };
    }
    return {};
  }

  // Client-side validity for the two methods that need extra input, so the
  // preview/submit don't bounce with a 400.
  const specificSumCents = entries.reduce(
    (s, e) => s + Math.round(Number(entryAmounts[e.timeEntryId] ?? '0') * 100),
    0,
  );
  const specificValid =
    allocationMethod !== 'SPECIFIC_ENTRIES' ||
    (entries.length > 0 && specificSumCents === Math.abs(totalCents));
  const weightsSum = timekeepers.reduce((s, t) => s + Number(weights[t.appUserId] ?? '0'), 0);
  const weightsValid =
    allocationMethod !== 'CUSTOM_WEIGHTED' ||
    (timekeepers.length > 0 && Math.abs(weightsSum - 100) < 0.01);

  const runPreview = useCallback(async () => {
    setPreviewError(null);
    // Hold the preview until the method's extra inputs are valid, so we
    // don't surface a transient 400 while the user is still filling them.
    if (!specificValid) {
      setPreviewError('Per-entry amounts must sum to the adjustment amount.');
      setPreview(null);
      return;
    }
    if (!weightsValid) {
      setPreviewError('Weights must sum to 100%.');
      setPreview(null);
      return;
    }
    try {
      const body: Record<string, unknown> = {
        billingBatchId,
        method,
        allocationMethod,
        totalAmountCents: totalCents,
        reasonCodeId: reasonCodeId || '00000000-0000-0000-0000-000000000000',
        notes,
        ...allocationExtras(),
      };
      const r = await api<PreviewResp>('/api/staff/adjustments/preview', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setPreview(r);
    } catch (err) {
      setPreviewError(errText(err, 'preview failed'));
      setPreview(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    allocationMethod,
    billingBatchId,
    method,
    notes,
    reasonCodeId,
    totalCents,
    entryAmounts,
    weights,
    entries,
    timekeepers,
    specificValid,
    weightsValid,
  ]);

  useEffect(() => {
    const id = setTimeout(() => void runPreview(), 300);
    return () => clearTimeout(id);
  }, [runPreview]);

  async function submit(): Promise<void> {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const body: Record<string, unknown> = {
        billingBatchId,
        method,
        allocationMethod,
        totalAmountCents: totalCents,
        reasonCodeId,
        notes,
        ...allocationExtras(),
      };
      await api('/api/staff/adjustments', { method: 'POST', body: JSON.stringify(body) });
      onCreated();
    } catch (err) {
      const msg = errText(err, 'submit failed');
      setSubmitError(
        msg === 'step_up_required'
          ? 'Your session needs a fresh TOTP step-up before creating adjustments. Verify in Account → Two-factor.'
          : msg,
      );
    } finally {
      setSubmitting(false);
    }
  }

  // Roll preview to per-timekeeper for the panel.
  const perUser = new Map<
    string,
    {
      name: string;
      role: PreviewRow['appUserRole'];
      original: number;
      adjusted: number;
      adjustment: number;
    }
  >();
  for (const a of preview?.allocations ?? []) {
    const cur = perUser.get(a.appUserId) ?? {
      name: a.appUserName ?? a.appUserId.slice(0, 8),
      role: a.appUserRole,
      original: 0,
      adjusted: 0,
      adjustment: 0,
    };
    cur.original += a.originalValueCents;
    cur.adjusted += a.adjustedValueCents;
    cur.adjustment += a.adjustmentAmountCents;
    perUser.set(a.appUserId, cur);
  }
  const userRows = Array.from(perUser.entries()).map(([id, v]) => ({
    id,
    ...v,
    realization: v.original === 0 ? 0 : v.adjusted / v.original,
  }));

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: tokens.space.xl,
      }}
    >
      <div
        style={{
          maxWidth: 920,
          width: '100%',
          maxHeight: '90vh',
          overflow: 'auto',
          display: 'grid',
          gap: tokens.space.lg,
        }}
      >
        <Card
          title={`Create adjustment — batch WIP $${(includedTotalCents / 100).toLocaleString()}`}
          action={
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          }
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 12,
              marginBottom: 12,
            }}
          >
            <label>
              <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                Direction
              </div>
              <select
                value={direction}
                onChange={(e) => setDirection(e.target.value as 'WRITE_DOWN' | 'WRITE_UP')}
                style={selectStyle}
              >
                <option value="WRITE_DOWN">Write-down</option>
                <option value="WRITE_UP">Write-up</option>
              </select>
            </label>
            <Input
              type="number"
              label="Amount (USD)"
              step={0.01}
              min={0}
              value={amountDollars}
              onChange={(e) => setAmountDollars(e.target.value)}
            />
            <label>
              <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                Method
              </div>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as 'TIME' | 'FEE' | 'RATE')}
                style={selectStyle}
              >
                <option value="TIME">Time</option>
                <option value="FEE">Fee</option>
                <option value="RATE">Rate</option>
              </select>
            </label>
            <label>
              <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                Allocation method
              </div>
              <select
                value={allocationMethod}
                onChange={(e) => setAllocationMethod(e.target.value as AllocationMethod)}
                style={selectStyle}
              >
                <option value="PRO_RATA_BY_VALUE">Pro-rata by value</option>
                <option value="PRO_RATA_BY_HOURS">Pro-rata by hours</option>
                <option value="PARTNER_ABSORBS">Partner absorbs</option>
                <option value="HIERARCHICAL_CASCADE">
                  Hierarchical cascade (junior held harmless)
                </option>
                <option value="SPECIFIC_ENTRIES">Specific entries</option>
                <option value="CUSTOM_WEIGHTED">Custom weighted</option>
              </select>
            </label>
            <label style={{ gridColumn: '1 / -1' }}>
              <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                Reason code
              </div>
              <select
                value={reasonCodeId}
                onChange={(e) => setReasonCodeId(e.target.value)}
                style={selectStyle}
                required
              >
                <option value="">— select —</option>
                {reasonCodes.map((rc) => (
                  <option key={rc.id} value={rc.id}>
                    {rc.label}
                  </option>
                ))}
              </select>
            </label>
            <Input
              label="Notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              style={{ gridColumn: '1 / -1' }}
            />
          </div>
        </Card>

        {allocationMethod === 'SPECIFIC_ENTRIES' && (
          <Card
            title="Per-entry amounts"
            action={
              <Pill tone={specificValid ? 'success' : 'warning'}>
                ${(specificSumCents / 100).toLocaleString()} of $
                {(Math.abs(totalCents) / 100).toLocaleString()}
              </Pill>
            }
          >
            <p style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 10 }}>
              Pre-filled pro-rata by standard value. Edit any line; the amounts must sum to the
              total adjustment of ${(Math.abs(totalCents) / 100).toLocaleString()}.
            </p>
            {entries.length === 0 ? (
              <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No included entries.</p>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {entries.map((e) => (
                  <div
                    key={e.timeEntryId}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto 140px',
                      gap: 10,
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ fontSize: 13 }}>{e.staffName ?? 'Unknown'}</span>
                    <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                      WIP ${(Math.abs(e.standardAmountCents) / 100).toLocaleString()}
                    </span>
                    <Input
                      type="number"
                      step={0.01}
                      min={0}
                      value={entryAmounts[e.timeEntryId] ?? ''}
                      onChange={(ev) =>
                        setEntryAmounts((m) => ({ ...m, [e.timeEntryId]: ev.target.value }))
                      }
                    />
                  </div>
                ))}
              </div>
            )}
            {!specificValid && entries.length > 0 && (
              <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>
                Amounts must sum to ${(Math.abs(totalCents) / 100).toLocaleString()}.
              </p>
            )}
          </Card>
        )}

        {allocationMethod === 'CUSTOM_WEIGHTED' && (
          <Card
            title="Custom weights (percent)"
            action={
              <Pill tone={weightsValid ? 'success' : 'warning'}>
                {weightsSum.toFixed(2)}% of 100%
              </Pill>
            }
          >
            <p style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 10 }}>
              Assign each timekeeper a share of the adjustment. Weights must sum to 100%.
            </p>
            {timekeepers.length === 0 ? (
              <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No timekeepers.</p>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {timekeepers.map((t) => (
                  <div
                    key={t.appUserId}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 140px',
                      gap: 10,
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ fontSize: 13 }}>{t.name}</span>
                    <Input
                      type="number"
                      step={0.01}
                      min={0}
                      value={weights[t.appUserId] ?? ''}
                      onChange={(ev) =>
                        setWeights((m) => ({ ...m, [t.appUserId]: ev.target.value }))
                      }
                    />
                  </div>
                ))}
              </div>
            )}
            {!weightsValid && timekeepers.length > 0 && (
              <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>
                Weights must sum to 100%.
              </p>
            )}
          </Card>
        )}

        {allocationMethod === 'PARTNER_ABSORBS' && (
          <Card title="Partner absorbs">
            <p style={{ fontSize: 12, color: tokens.color.textMuted }}>
              The full adjustment is allocated to partner-role time on this batch (pro-rata by
              value). If no partner has time entries here, allocation can&apos;t run — the preview
              below will say so.
            </p>
          </Card>
        )}

        <Card title="Per-timekeeper preview" action={<Pill tone="accent">live</Pill>}>
          {previewError && (
            <p style={{ color: tokens.color.danger, fontSize: 12 }}>{previewError}</p>
          )}
          <Table
            columns={[
              { key: 'name', header: 'Timekeeper', render: (r) => r.name },
              { key: 'role', header: 'Role', render: (r) => <Pill>{r.role}</Pill> },
              {
                key: 'wip',
                header: 'Standard WIP',
                align: 'right',
                render: (r) => `$${(r.original / 100).toLocaleString()}`,
              },
              {
                key: 'adj',
                header: 'Adjustment',
                align: 'right',
                render: (r) => (
                  <span
                    style={{ color: r.adjustment < 0 ? tokens.color.danger : tokens.color.success }}
                  >
                    {r.adjustment < 0 ? '-' : '+'}${(Math.abs(r.adjustment) / 100).toLocaleString()}
                  </span>
                ),
              },
              {
                key: 'post',
                header: 'After',
                align: 'right',
                render: (r) => `$${(r.adjusted / 100).toLocaleString()}`,
              },
              {
                key: 'real',
                header: 'Realization',
                align: 'right',
                render: (r) => `${(r.realization * 100).toFixed(1)}%`,
              },
            ]}
            rows={userRows}
            rowKey={(r) => r.id}
            empty="Adjust amount or method to see preview."
          />
        </Card>

        <Card title="Submit">
          {submitError && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{submitError}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={submitting || !reasonCodeId || !specificValid || !weightsValid}
            >
              {submitting ? 'Submitting…' : 'Create adjustment'}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontSize: 14,
  fontFamily: tokens.font.body,
};
