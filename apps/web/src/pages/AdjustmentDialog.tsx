// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// The wedge UI. User picks an allocation method, sees the per-timekeeper
// preview live (debounced on input change), and submits. Cascade
// preview includes the role tier so you can see who absorbs what.

import { useCallback, useEffect, useState } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

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
  onClose: () => void;
  onCreated: () => void;
}

const CASCADE_DEFAULT = ['STAFF', 'SENIOR', 'MANAGER', 'PARTNER'] as const;

export function AdjustmentDialog({
  billingBatchId,
  includedTotalCents,
  onClose,
  onCreated,
}: AdjustmentDialogProps): JSX.Element {
  const [reasonCodes, setReasonCodes] = useState<ReasonCode[]>([]);
  const [reasonCodeId, setReasonCodeId] = useState('');
  const [method, setMethod] = useState<'TIME' | 'FEE' | 'RATE'>('TIME');
  const [allocationMethod, setAllocationMethod] = useState<AllocationMethod>('PRO_RATA_BY_VALUE');
  // Amount in dollars (UI), converted to signed cents on submit
  const [amountDollars, setAmountDollars] = useState('100.00');
  const [direction, setDirection] = useState<'WRITE_DOWN' | 'WRITE_UP'>('WRITE_DOWN');
  const [notes, setNotes] = useState('');
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  const runPreview = useCallback(async () => {
    setPreviewError(null);
    try {
      const body: Record<string, unknown> = {
        billingBatchId,
        method,
        allocationMethod,
        totalAmountCents: totalCents,
        reasonCodeId: reasonCodeId || '00000000-0000-0000-0000-000000000000',
        notes,
      };
      if (allocationMethod === 'HIERARCHICAL_CASCADE') body['cascadeOrder'] = CASCADE_DEFAULT;
      const r = await api<PreviewResp>('/api/staff/adjustments/preview', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setPreview(r);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'preview failed');
      setPreview(null);
    }
  }, [allocationMethod, billingBatchId, method, notes, reasonCodeId, totalCents]);

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
      };
      if (allocationMethod === 'HIERARCHICAL_CASCADE') body['cascadeOrder'] = CASCADE_DEFAULT;
      await api('/api/staff/adjustments', { method: 'POST', body: JSON.stringify(body) });
      onCreated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'submit failed';
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
            <Button onClick={() => void submit()} disabled={submitting || !reasonCodeId}>
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
