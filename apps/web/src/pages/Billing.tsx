// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { Button, Card, ColumnFilter, Combobox, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { AdjustmentDialog } from './AdjustmentDialog';
import { PricingSuggestionPanel } from './engagements/PricingSuggestionPanel';
import { selectRows, useColumnView } from '../lib/column-view';
import { TableSearch } from '../components/TableSearch';

interface BatchRow {
  id: string;
  engagementId: string;
  engagementName: string;
  // 0086 — full list of engagements on this batch (primary first). One
  // element for single-engagement batches; >1 for consolidated bills.
  engagements?: Array<{ id: string; name: string }>;
  clientName: string | null;
  periodStart: string;
  periodEnd: string;
  status: 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'INVOICED' | 'CANCELLED';
  kind?: 'STANDARD' | 'RETAINER';
  retainerTargetAmountCents?: number | null;
  // 0052 — invoice composition saved on the batch.
  invoiceDescription?: string | null;
  invoiceLineItems?: Array<{ description: string; amountCents: number }> | null;
  // 0182 — realization-only close-out batch: never invoiceable.
  realizationOnly?: boolean;
}

interface Engagement {
  id: string;
  name: string;
  clientId: string;
}

interface ClientLite {
  id: string;
  name: string;
}

const BATCH_STATUS_VALUES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'IN_REVIEW', label: 'In review' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'INVOICED', label: 'Invoiced' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

interface BatchEntry {
  timeEntryId: string;
  entryDate: string;
  hours: string;
  standardAmountCents: number;
  action: 'INCLUDE' | 'DEFER' | 'WRITE_OFF';
  staffName?: string | null;
  description?: string | null;
  workCode?: string | null;
  // Per-entry amount after adjustments (0 for deferred / written-off).
  billedAmountCents?: number;
}

interface BatchDetail {
  batch: BatchRow;
  entries: BatchEntry[];
  aging: Record<string, number>;
  engagement?: { id: string; name: string; clientId: string; clientName: string } | null;
  // 0086 — full engagement list (primary first) for the batch header.
  engagements?: Array<{ id: string; name: string; clientId: string; clientName: string }>;
  adjustmentTotalCents?: number;
  // Invoice id once the batch is INVOICED (for print / send / unfinalize).
  invoiceId?: string | null;
  // R2 — firm retainer feature flag + biller-toggle default, so the
  // "Offer retainer to client" checkbox can honor the firm setting.
  retainer?: { featureEnabled: boolean; defaultBillerToggleOn: boolean };
}

interface ReasonCode {
  id: string;
  category: 'WRITE_DOWN' | 'WRITE_UP' | 'TRANSFER';
  label: string;
}

export function BillingBatchesPage(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<BatchListPage />} />
      <Route path="/:id" element={<BatchDetailPage />} />
    </Routes>
  );
}

function BatchListPage(): JSX.Element {
  const [items, setItems] = useState<BatchRow[]>([]);
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search] = useSearchParams();

  const view = useColumnView('vibe.billing.view', { sortCol: 'period', sortDir: 'desc' });
  // 0050 — client → engagement order. URL params from WIP "Bill" buttons
  // prefill all four fields.
  const [clientId, setClientId] = useState(search.get('clientId') ?? '');
  // 0086 — multi-select engagements. URL param `engagementId` (legacy
  // WIP "Bill" CTA) seeds a 1-element list.
  const seedEng = search.get('engagementId');
  const [selectedEngagementIds, setSelectedEngagementIds] = useState<string[]>(
    seedEng ? [seedEng] : [],
  );
  const [periodStart, setPeriodStart] = useState(
    search.get('periodStart') ??
      new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10),
  );
  const [periodEnd, setPeriodEnd] = useState(
    search.get('periodEnd') ?? new Date().toISOString().slice(0, 10),
  );
  // 0050 — batch kind picker (Standard vs Retainer)
  const [kind, setKind] = useState<'STANDARD' | 'RETAINER'>('STANDARD');
  const [retainerTargetDollars, setRetainerTargetDollars] = useState('');
  const navigate = useNavigate();

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [b, e, c] = await Promise.all([
        api<{ items: BatchRow[] }>('/api/staff/billing-batches'),
        api<{ items: Engagement[] }>('/api/staff/engagements'),
        api<{ items: ClientLite[] }>('/api/staff/clients'),
      ]);
      setItems(b.items ?? []);
      setEngagements(e.items ?? []);
      setClients(c.items ?? []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  const filteredEngagements = useMemo(
    () => engagements.filter((e) => !clientId || e.clientId === clientId),
    [engagements, clientId],
  );

  // 0086 — when the client changes, drop any selected engagements that
  // don't belong to the new client. Keeps the list internally
  // consistent without surprising the user.
  useEffect(() => {
    const allowed = new Set(filteredEngagements.map((e) => e.id));
    setSelectedEngagementIds((prev) => prev.filter((id) => allowed.has(id)));
  }, [filteredEngagements]);

  // Per-column filter value lists for the Billing batches table.
  const engValues = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of items) seen.set(r.engagementName, r.engagementName);
    return Array.from(seen.keys())
      .sort((a, b) => a.localeCompare(b))
      .map((v) => ({ value: v, label: v }));
  }, [items]);

  const clientValues = useMemo(() => {
    const seen = new Set<string>();
    for (const r of items) seen.add(r.clientName ?? '—');
    return Array.from(seen)
      .sort((a, b) => a.localeCompare(b))
      .map((v) => ({ value: v, label: v }));
  }, [items]);

  const visible = useMemo(
    () =>
      selectRows(items, view, {
        filters: {
          eng: (r) => r.engagementName,
          client: (r) => r.clientName ?? '—',
          status: (r) => r.status,
        },
        sortValues: {
          eng: (r) => r.engagementName,
          client: (r) => r.clientName ?? '',
          period: (r) => r.periodStart,
          status: (r) => r.status,
        },
        tieBreak: (a, b) => b.periodStart.localeCompare(a.periodStart),
        searchText: (r) => `${r.engagementName} ${r.clientName ?? ''} ${r.status}`,
      }),
    [items, view],
  );

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (selectedEngagementIds.length === 0) {
      setError('Select at least one engagement.');
      return;
    }
    if (kind === 'RETAINER' && selectedEngagementIds.length > 1) {
      setError('Retainer batches can only cover a single engagement.');
      return;
    }
    try {
      const body: Record<string, unknown> = {
        // 0086 — multi-engagement payload. The server also accepts the
        // legacy `engagementId` singular for backward compat.
        engagementIds: selectedEngagementIds,
        periodStart,
        periodEnd,
        kind,
      };
      if (kind === 'RETAINER') {
        const cents = Math.round(Number(retainerTargetDollars) * 100);
        if (!Number.isFinite(cents) || cents <= 0) {
          setError('Retainer target amount is required.');
          return;
        }
        body.retainerTargetAmountCents = cents;
      }
      const r = await api<{ id: string }>('/api/staff/billing-batches', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      navigate(`/billing/${r.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Open a billing batch">
        <form onSubmit={create} style={{ display: 'grid', gap: 12 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr 1fr',
              gap: 12,
              alignItems: 'end',
            }}
          >
            <div style={{ display: 'block', fontFamily: tokens.font.body }}>
              <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                Client
              </div>
              <Combobox
                ariaLabel="Client"
                required
                value={clientId}
                onChange={setClientId}
                options={clients.map((c) => ({ value: c.id, label: c.name }))}
                placeholder="— select —"
              />
            </div>
            <Input
              type="date"
              label="Period start"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
            />
            <Input
              type="date"
              label="Period end"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
            />
            <div style={{ display: 'block', fontFamily: tokens.font.body }}>
              <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                Batch type
              </div>
              <Combobox
                ariaLabel="Batch type"
                value={kind}
                onChange={(v) => setKind(v as 'STANDARD' | 'RETAINER')}
                options={[
                  { value: 'STANDARD', label: 'Standard' },
                  { value: 'RETAINER', label: 'Retainer' },
                ]}
              />
            </div>
          </div>

          {/* 0086 — multi-engagement checkbox list. One bill can cover
              many engagements for the same client. Retainer batches
              stay single-engagement (server enforces this too). */}
          <div style={{ display: 'block', fontFamily: tokens.font.body }}>
            <div
              style={{
                fontSize: 12,
                color: tokens.color.textMuted,
                marginBottom: 4,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span>
                Engagements{' '}
                {selectedEngagementIds.length > 0 && (
                  <span style={{ color: tokens.color.text }}>
                    ({selectedEngagementIds.length} selected)
                  </span>
                )}
              </span>
              {filteredEngagements.length > 0 && (
                <span style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedEngagementIds(
                        kind === 'RETAINER'
                          ? filteredEngagements.slice(0, 1).map((e) => e.id)
                          : filteredEngagements.map((e) => e.id),
                      )
                    }
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: tokens.color.accent,
                      fontSize: 11,
                      cursor: 'pointer',
                      padding: 0,
                    }}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedEngagementIds([])}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: tokens.color.accent,
                      fontSize: 11,
                      cursor: 'pointer',
                      padding: 0,
                    }}
                  >
                    Clear
                  </button>
                </span>
              )}
            </div>
            {!clientId ? (
              <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
                Pick a client first.
              </p>
            ) : filteredEngagements.length === 0 ? (
              <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
                No engagements found for this client.
              </p>
            ) : (
              <div
                role="group"
                aria-label="Engagements to bill"
                style={{
                  maxHeight: 220,
                  overflowY: 'auto',
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  padding: 8,
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                  gap: 4,
                  background: tokens.color.surface,
                }}
              >
                {filteredEngagements.map((e) => {
                  const checked = selectedEngagementIds.includes(e.id);
                  return (
                    <label
                      key={e.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 13,
                        cursor: 'pointer',
                        padding: '4px 6px',
                        borderRadius: tokens.radius.sm,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(evt) => {
                          setSelectedEngagementIds((prev) =>
                            evt.target.checked
                              ? // Retainer: one engagement only — replace.
                                kind === 'RETAINER'
                                ? [e.id]
                                : [...prev, e.id]
                              : prev.filter((id) => id !== e.id),
                          );
                        }}
                      />
                      <span>{e.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
            {selectedEngagementIds.length > 1 && (
              <p style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 4 }}>
                Consolidated bill: one invoice covering {selectedEngagementIds.length} engagements.
                Surcharge and tax are skipped on consolidated bills.
              </p>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'end', gap: 12 }}>
            <Button type="submit" disabled={selectedEngagementIds.length === 0 || !clientId}>
              Create
            </Button>
            {kind === 'RETAINER' && (
              <Input
                type="text"
                inputMode="decimal"
                label="Retainer target ($)"
                value={retainerTargetDollars}
                onChange={(e) => setRetainerTargetDollars(e.target.value)}
                placeholder="0.00"
              />
            )}
          </div>
        </form>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>

      <Card
        title={
          <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span>Billing batches</span>
            {items.length > 0 && (
              <span style={{ fontSize: 13, color: tokens.color.textMuted, fontWeight: 400 }}>
                {visible.length === items.length
                  ? `${items.length} batch${items.length === 1 ? '' : 'es'}`
                  : `${visible.length} of ${items.length}`}
              </span>
            )}
          </span>
        }
        action={
          view.anyFilterActive ? (
            <button
              type="button"
              onClick={view.clearFilters}
              style={{
                background: 'none',
                border: 'none',
                color: tokens.color.accent,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Clear filters
            </button>
          ) : undefined
        }
      >
        <div style={{ marginBottom: 12 }}>
          <TableSearch view={view} placeholder="Search batches…" />
        </div>
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table<BatchRow>
            columns={[
              {
                key: 'name',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Engagement{' '}
                    <ColumnFilter
                      ariaLabel="Filter / sort engagement"
                      values={engValues}
                      selected={view.filterFor('eng')}
                      sort={view.sortFor('eng')}
                      onApply={(sel, dir) => view.apply('eng', sel, dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (b) => {
                  const engs = b.engagements ?? [{ id: b.engagementId, name: b.engagementName }];
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <Link to={`/billing/${b.id}`} style={{ color: tokens.color.accent }}>
                        {engs[0]?.name ?? b.engagementName}
                      </Link>
                      {engs.length > 1 && (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {engs.slice(1).map((e) => (
                            <Pill key={e.id} tone="neutral">
                              {e.name}
                            </Pill>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                },
              },
              {
                key: 'client',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Client{' '}
                    <ColumnFilter
                      ariaLabel="Filter / sort client"
                      values={clientValues}
                      selected={view.filterFor('client')}
                      sort={view.sortFor('client')}
                      onApply={(sel, dir) => view.apply('client', sel, dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (b) => b.clientName ?? '—',
              },
              {
                key: 'period',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Period{' '}
                    <ColumnFilter
                      ariaLabel="Sort by period"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('period')}
                      onApply={(_, dir) => view.apply('period', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (b) => `${b.periodStart} → ${b.periodEnd}`,
              },
              {
                key: 'status',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Status{' '}
                    <ColumnFilter
                      ariaLabel="Filter / sort status"
                      values={BATCH_STATUS_VALUES}
                      selected={view.filterFor('status')}
                      sort={view.sortFor('status')}
                      searchable={false}
                      onApply={(sel, dir) => view.apply('status', sel, dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (b) => (
                  <Pill
                    tone={
                      b.status === 'APPROVED' || b.status === 'INVOICED' ? 'success' : 'neutral'
                    }
                  >
                    {b.status}
                  </Pill>
                ),
              },
            ]}
            rows={visible}
            rowKey={(b) => b.id}
            empty="No billing batches yet."
          />
        )}
      </Card>
    </div>
  );
}

function BatchDetailPage(): JSX.Element {
  const { id } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [actions, setActions] = useState<Map<string, BatchEntry['action']>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  // Print / send / unfinalize (invoiced batches) busy flag.
  const [acting, setActing] = useState(false);
  const [showAdjustDialog, setShowAdjustDialog] = useState(false);

  // 0052 — set-target form
  const [targetDollars, setTargetDollars] = useState('');
  const [targetReasonId, setTargetReasonId] = useState('');
  const [targetNotes, setTargetNotes] = useState('');
  const [reasonCodes, setReasonCodes] = useState<ReasonCode[]>([]);
  const [settingTarget, setSettingTarget] = useState(false);

  // 0052 — invoice composition draft
  // R2 — biller toggle to auto-create a retainer offer on this invoice.
  // Initialized from the firm's default_biller_toggle_on once the batch
  // detail loads (see load()); the server-side suppression rules (no
  // return_type, feature_enabled false, etc.) still decide whether an
  // offer actually lands. Starts true as a pre-load placeholder.
  const [offerRetainerOnGenerate, setOfferRetainerOnGenerate] = useState(true);
  const [entrySort, setEntrySort] = useState<{ key: string; dir: 'asc' | 'desc' }>({
    key: 'date',
    dir: 'asc',
  });
  const [invoiceDescription, setInvoiceDescription] = useState('');
  const [invoiceLines, setInvoiceLines] = useState<Array<{ description: string; dollars: string }>>(
    [],
  );
  const [savingComposition, setSavingComposition] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const d = await api<BatchDetail>(`/api/staff/billing-batches/${id}`);
      setDetail(d);
      // R2 — honor the firm's default biller-toggle preference.
      if (d.retainer) setOfferRetainerOnGenerate(d.retainer.defaultBillerToggleOn);
      const m = new Map<string, BatchEntry['action']>();
      for (const e of d.entries) m.set(e.timeEntryId, e.action);
      setActions(m);
      setInvoiceDescription(d.batch.invoiceDescription ?? '');
      setInvoiceLines(
        (d.batch.invoiceLineItems ?? []).map((l) => ({
          description: l.description,
          dollars: (l.amountCents / 100).toFixed(2),
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Pull write-down/up reason codes for the set-target form.
  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: ReasonCode[] }>('/api/staff/taxonomy/reason-codes');
        setReasonCodes(
          (r.items ?? []).filter((c) => c.category === 'WRITE_DOWN' || c.category === 'WRITE_UP'),
        );
      } catch {
        // Non-fatal.
      }
    })();
  }, []);

  async function finalize(): Promise<void> {
    if (!detail) return;
    setFinalizing(true);
    setError(null);
    try {
      await api(`/api/staff/billing-batches/${id}/finalize`, {
        method: 'PATCH',
        body: JSON.stringify({
          actions: detail.entries.map((e) => ({
            timeEntryId: e.timeEntryId,
            action: actions.get(e.timeEntryId) ?? e.action,
          })),
        }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'finalize failed');
    } finally {
      setFinalizing(false);
    }
  }

  function printInvoice(): void {
    if (!detail?.invoiceId) return;
    window.open(`/api/staff/invoices/${detail.invoiceId}/pdf`, '_blank', 'noopener,noreferrer');
  }

  async function sendInvoice(): Promise<void> {
    if (!detail?.invoiceId) return;
    if (!window.confirm('Email this invoice to the client now?')) return;
    setActing(true);
    setError(null);
    try {
      await api(`/api/staff/invoices/${detail.invoiceId}/send`, { method: 'POST' });
      setNotice('Invoice sent to the client.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'send failed');
    } finally {
      setActing(false);
    }
  }

  async function unfinalize(): Promise<void> {
    if (
      !window.confirm(
        'Unfinalize this invoice? The current invoice will be voided and a new editable draft created.',
      )
    )
      return;
    setActing(true);
    setError(null);
    try {
      const r = await api<{ newVersionId: string }>(`/api/staff/billing-batches/${id}/unfinalize`, {
        method: 'POST',
      });
      navigate(`/billing/${r.newVersionId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unfinalize failed';
      setError(
        msg === 'invoice_has_payments'
          ? 'Cannot unfinalize — the invoice already has a payment. Void it from the invoice screen instead.'
          : msg,
      );
    } finally {
      setActing(false);
    }
  }

  async function applyTarget(): Promise<void> {
    if (!targetDollars || !targetReasonId) {
      setError('Target amount and reason code are required.');
      return;
    }
    const cents = Math.round(Number(targetDollars) * 100);
    if (!Number.isFinite(cents) || cents < 0) {
      setError('Target amount must be a non-negative number.');
      return;
    }
    setSettingTarget(true);
    setError(null);
    try {
      await api(`/api/staff/billing-batches/${id}/set-target`, {
        method: 'POST',
        body: JSON.stringify({
          targetAmountCents: cents,
          reasonCodeId: targetReasonId,
          notes: targetNotes || undefined,
        }),
      });
      setTargetDollars('');
      setTargetNotes('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'set_target_failed');
    } finally {
      setSettingTarget(false);
    }
  }

  async function saveComposition(): Promise<void> {
    setSavingComposition(true);
    setError(null);
    try {
      const lines = invoiceLines
        .filter((l) => l.description.trim() && l.dollars.trim())
        .map((l) => ({
          description: l.description.trim(),
          amountCents: Math.round(Number(l.dollars) * 100),
        }));
      await api(`/api/staff/billing-batches/${id}/invoice-composition`, {
        method: 'PATCH',
        body: JSON.stringify({
          invoiceDescription: invoiceDescription || null,
          invoiceLineItems: lines.length > 0 ? lines : null,
        }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save_composition_failed');
    } finally {
      setSavingComposition(false);
    }
  }

  if (loading || !detail) {
    return <p style={{ color: tokens.color.textMuted }}>Loading…</p>;
  }

  const totals = detail.entries.reduce(
    (acc, e) => {
      const a = actions.get(e.timeEntryId) ?? e.action;
      if (a === 'INCLUDE') acc.included += e.standardAmountCents;
      else if (a === 'DEFER') acc.deferred += e.standardAmountCents;
      else acc.writtenOff += e.standardAmountCents;
      return acc;
    },
    { included: 0, deferred: 0, writtenOff: 0 },
  );
  // 0052 — billed = INCLUDE total + signed approved adjustments.
  const adjustmentTotalCents = detail.adjustmentTotalCents ?? 0;
  const billedCents = totals.included + adjustmentTotalCents;
  const lineSumCents = invoiceLines.reduce(
    (s, l) => s + (Number.isFinite(Number(l.dollars)) ? Math.round(Number(l.dollars) * 100) : 0),
    0,
  );
  const compositionMismatch =
    invoiceLines.filter((l) => l.description.trim() || l.dollars.trim()).length > 0 &&
    lineSumCents !== billedCents;
  const fmtCents = (c: number): string =>
    `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      {notice && <p style={{ color: tokens.color.success, fontSize: 13, margin: 0 }}>{notice}</p>}
      <Card
        title={(() => {
          // 0086 — render the client name + engagement set. For
          // multi-engagement batches show the count beside the primary
          // engagement; the full list of chips appears below.
          const engs = detail.engagements ?? (detail.engagement ? [detail.engagement] : []);
          if (engs.length === 0) return `Batch ${detail.batch.id.slice(0, 8)}`;
          const primary = engs[0]!;
          const more = engs.length - 1;
          return `${primary.clientName} · ${primary.name}${more > 0 ? ` (+${more})` : ''}`;
        })()}
        action={
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {detail.batch.kind === 'RETAINER' && <Pill tone="accent">Retainer</Pill>}
            {(detail.engagements?.length ?? 0) > 1 && (
              <Pill tone="accent">Consolidated · {detail.engagements!.length} engagements</Pill>
            )}
            {detail.batch.status === 'INVOICED' && detail.invoiceId && (
              <>
                <Button size="sm" variant="secondary" onClick={printInvoice} disabled={acting}>
                  Print
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={acting}
                  onClick={() => void sendInvoice()}
                >
                  Send
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={acting}
                  onClick={() => void unfinalize()}
                >
                  {acting ? 'Working…' : 'Unfinalize'}
                </Button>
              </>
            )}
            <Pill tone={detail.batch.status === 'APPROVED' ? 'success' : 'neutral'}>
              {detail.batch.status}
            </Pill>
          </span>
        }
      >
        {(detail.engagements?.length ?? 0) > 1 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ color: tokens.color.textMuted, fontSize: 11, marginBottom: 4 }}>
              Engagements on this bill
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {detail.engagements!.map((e, idx) => (
                <Pill key={e.id} tone={idx === 0 ? 'accent' : 'neutral'}>
                  {e.name}
                </Pill>
              ))}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 24, fontSize: 13, flexWrap: 'wrap' }}>
          <div>
            <div style={{ color: tokens.color.textMuted, fontSize: 11 }}>Period</div>
            <strong>
              {detail.batch.periodStart} → {detail.batch.periodEnd}
            </strong>
          </div>
          <div>
            <div style={{ color: tokens.color.textMuted, fontSize: 11 }}>
              Standard WIP (include)
            </div>
            <strong>${(totals.included / 100).toLocaleString()}</strong>
          </div>
          {adjustmentTotalCents !== 0 && (
            <div>
              <div style={{ color: tokens.color.textMuted, fontSize: 11 }}>
                Adjustments (write {adjustmentTotalCents < 0 ? 'down' : 'up'})
              </div>
              <strong
                style={{
                  color: adjustmentTotalCents < 0 ? tokens.color.danger : tokens.color.success,
                }}
              >
                {adjustmentTotalCents < 0 ? '−' : '+'}$
                {(Math.abs(adjustmentTotalCents) / 100).toLocaleString()}
              </strong>
            </div>
          )}
          <div>
            <div style={{ color: tokens.color.textMuted, fontSize: 11 }}>Total to invoice</div>
            <strong style={{ fontSize: 18 }}>
              ${(billedCents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </strong>
          </div>
          <div>
            <div style={{ color: tokens.color.textMuted, fontSize: 11 }}>Defer (carry-forward)</div>
            <strong>${(totals.deferred / 100).toLocaleString()}</strong>
          </div>
          <div>
            <div style={{ color: tokens.color.textMuted, fontSize: 11 }}>Write off</div>
            <strong>${(totals.writtenOff / 100).toLocaleString()}</strong>
          </div>
          {detail.batch.kind === 'RETAINER' && detail.batch.retainerTargetAmountCents != null && (
            <div>
              <div style={{ color: tokens.color.textMuted, fontSize: 11 }}>Retainer target</div>
              <strong>${(detail.batch.retainerTargetAmountCents / 100).toLocaleString()}</strong>
              {totals.included !== detail.batch.retainerTargetAmountCents && (
                <div style={{ color: tokens.color.warning, fontSize: 11 }}>
                  Include total ≠ target
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      <Card title="WIP aging">
        <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
          {(['0-30', '31-60', '61-90', '90+'] as const).map((b) => (
            <div key={b}>
              <div style={{ color: tokens.color.textMuted, fontSize: 11 }}>{b} days</div>
              <strong>${((detail.aging[b] ?? 0) / 100).toLocaleString()}</strong>
            </div>
          ))}
        </div>
      </Card>

      {/* 0052 — set the invoice target, server creates the write-up/down
          adjustment automatically. Hidden once batch is INVOICED. */}
      {(detail.batch.status === 'DRAFT' || detail.batch.status === 'IN_REVIEW') && (
        <Card title="Set target invoice amount">
          <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
            Enter the amount you want to bill — we&apos;ll auto-create a write-down or write-up
            adjustment for the delta against the current total to invoice ({fmtCents(billedCents)}).
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 2fr auto',
              gap: 12,
              alignItems: 'end',
            }}
          >
            <Input
              type="text"
              inputMode="decimal"
              label="Target ($)"
              value={targetDollars}
              onChange={(e) => setTargetDollars(e.target.value)}
              placeholder={(billedCents / 100).toFixed(2)}
            />
            <div>
              <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                Reason code
              </div>
              <Combobox
                ariaLabel="Reason code"
                value={targetReasonId}
                onChange={setTargetReasonId}
                options={reasonCodes.map((r) => ({
                  value: r.id,
                  label: `${r.label} (${r.category})`,
                }))}
                placeholder="— select —"
              />
            </div>
            <Input
              label="Notes (optional)"
              value={targetNotes}
              onChange={(e) => setTargetNotes(e.target.value)}
              placeholder="Why are we writing up/down?"
            />
            <Button
              onClick={() => void applyTarget()}
              disabled={settingTarget || !targetDollars || !targetReasonId}
            >
              {settingTarget ? 'Applying…' : 'Apply'}
            </Button>
          </div>
          {targetDollars && Number.isFinite(Number(targetDollars)) && (
            <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 8 }}>
              Delta: {fmtCents(Math.round(Number(targetDollars) * 100) - billedCents)} (
              {Math.round(Number(targetDollars) * 100) - billedCents >= 0
                ? 'write-up'
                : 'write-down'}
              )
            </p>
          )}
        </Card>
      )}

      {/* 0052 — invoice composition editor. Description seeds invoice
          notes; line items override the auto-generated single line.
          Sum of line amounts must equal the billed total. */}
      {(detail.batch.status === 'DRAFT' ||
        detail.batch.status === 'IN_REVIEW' ||
        detail.batch.status === 'APPROVED') && (
        <Card
          title="Invoice composition"
          action={
            <Button
              size="sm"
              onClick={() => void saveComposition()}
              disabled={savingComposition || compositionMismatch}
            >
              {savingComposition ? 'Saving…' : 'Save composition'}
            </Button>
          }
        >
          <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
            Customize the invoice memo and split the bill into multiple line items. Leave the line
            items empty to use the default single line.
          </p>
          <div style={{ display: 'grid', gap: 8 }}>
            <label
              style={{
                display: 'block',
                fontSize: 12,
                color: tokens.color.textMuted,
              }}
            >
              Invoice description (memo)
              <textarea
                value={invoiceDescription}
                onChange={(e) => setInvoiceDescription(e.target.value)}
                rows={2}
                placeholder="Optional memo that lands on the invoice header"
                style={{
                  width: '100%',
                  marginTop: 4,
                  padding: '6px 8px',
                  background: tokens.color.surface,
                  color: tokens.color.text,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  fontSize: 13,
                  boxSizing: 'border-box',
                  fontFamily: 'inherit',
                }}
              />
            </label>
            <div style={{ marginTop: 12 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 6,
                }}
              >
                <strong style={{ fontSize: 13 }}>Line items</strong>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setInvoiceLines((p) => [...p, { description: '', dollars: '' }])}
                >
                  + Add line
                </Button>
              </div>
              {invoiceLines.length === 0 ? (
                <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
                  No custom line items — the invoice will be generated with a single auto line for{' '}
                  {fmtCents(billedCents)}.
                </p>
              ) : (
                <div style={{ display: 'grid', gap: 6 }}>
                  {invoiceLines.map((l, idx) => (
                    <div
                      key={idx}
                      style={{ display: 'grid', gridTemplateColumns: '3fr 1fr auto', gap: 6 }}
                    >
                      <input
                        value={l.description}
                        onChange={(e) => {
                          const next = [...invoiceLines];
                          next[idx] = { ...next[idx]!, description: e.target.value };
                          setInvoiceLines(next);
                        }}
                        placeholder={`Line ${idx + 1} description`}
                        style={{
                          padding: '6px 8px',
                          background: tokens.color.surface,
                          color: tokens.color.text,
                          border: `1px solid ${tokens.color.border}`,
                          borderRadius: tokens.radius.sm,
                          fontSize: 13,
                        }}
                      />
                      <input
                        type="text"
                        inputMode="decimal"
                        value={l.dollars}
                        onChange={(e) => {
                          const next = [...invoiceLines];
                          next[idx] = { ...next[idx]!, dollars: e.target.value };
                          setInvoiceLines(next);
                        }}
                        placeholder="0.00"
                        style={{
                          padding: '6px 8px',
                          background: tokens.color.surface,
                          color: tokens.color.text,
                          border: `1px solid ${tokens.color.border}`,
                          borderRadius: tokens.radius.sm,
                          fontSize: 13,
                          textAlign: 'right',
                        }}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setInvoiceLines((p) => p.filter((_, i) => i !== idx))}
                        aria-label={`Remove line ${idx + 1}`}
                      >
                        ×
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {invoiceLines.length > 0 && (
                <div
                  style={{
                    marginTop: 12,
                    padding: 8,
                    borderRadius: tokens.radius.sm,
                    background: compositionMismatch
                      ? 'rgba(239, 68, 68, 0.08)'
                      : tokens.color.surface,
                    border: `1px solid ${compositionMismatch ? tokens.color.danger : tokens.color.border}`,
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 13,
                  }}
                >
                  <span>
                    Lines total: <strong>{fmtCents(lineSumCents)}</strong>
                  </span>
                  <span>
                    Total to invoice: <strong>{fmtCents(billedCents)}</strong>
                  </span>
                  <span
                    style={{
                      color: compositionMismatch ? tokens.color.danger : tokens.color.success,
                      fontWeight: 600,
                    }}
                  >
                    {compositionMismatch
                      ? `Delta ${fmtCents(billedCents - lineSumCents)} — must equal 0`
                      : 'Balanced ✓'}
                  </span>
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      <Card
        title="Entries"
        action={
          detail.batch.status === 'DRAFT' || detail.batch.status === 'IN_REVIEW' ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="secondary" size="sm" onClick={() => setShowAdjustDialog(true)}>
                Create adjustment
              </Button>
              <Button onClick={() => void finalize()} disabled={finalizing}>
                {finalizing ? 'Finalizing…' : 'Finalize'}
              </Button>
            </div>
          ) : detail.batch.status === 'APPROVED' && detail.batch.realizationOnly ? (
            <Pill tone="neutral">Realization only — not invoiceable</Pill>
          ) : detail.batch.status === 'APPROVED' ? (
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}
            >
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  color: tokens.color.textMuted,
                }}
              >
                <input
                  type="checkbox"
                  checked={offerRetainerOnGenerate}
                  onChange={(e) => setOfferRetainerOnGenerate(e.target.checked)}
                />
                Offer retainer to client
              </label>
              <Button
                onClick={async () => {
                  try {
                    const r = await api<{ id: string }>('/api/staff/invoices/generate-from-batch', {
                      method: 'POST',
                      body: JSON.stringify({
                        billingBatchId: detail.batch.id,
                        retainerOptions: { enabled: offerRetainerOnGenerate },
                      }),
                    });
                    window.location.href = `/invoices`;
                    void r;
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'invoice gen failed');
                  }
                }}
              >
                Generate invoice
              </Button>
            </div>
          ) : null
        }
      >
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        {(() => {
          const finalized =
            detail.batch.status === 'APPROVED' || detail.batch.status === 'INVOICED';
          const totalHours = detail.entries.reduce((s, e) => s + Number(e.hours), 0);
          const totalStandard = detail.entries.reduce((s, e) => s + e.standardAmountCents, 0);
          const totalBilled = detail.entries.reduce((s, e) => s + (e.billedAmountCents ?? 0), 0);
          const money = (cents: number): string => `$${(cents / 100).toLocaleString()}`;
          const sortVal = (e: BatchEntry): string | number => {
            switch (entrySort.key) {
              case 'date':
                return e.entryDate;
              case 'staff':
                return e.staffName ?? '';
              case 'workCode':
                return e.workCode ?? '';
              case 'hours':
                return Number(e.hours);
              case 'amt':
                return e.standardAmountCents;
              case 'billed':
                return e.billedAmountCents ?? 0;
              case 'desc':
                return e.description ?? '';
              case 'action':
                return e.action;
              default:
                return '';
            }
          };
          const sortedEntries = [...detail.entries].sort((a, b) => {
            const av = sortVal(a);
            const bv = sortVal(b);
            const cmp =
              typeof av === 'number' && typeof bv === 'number'
                ? av - bv
                : String(av).localeCompare(String(bv));
            return entrySort.dir === 'asc' ? cmp : -cmp;
          });
          const sortHeader = (key: string, label: string): JSX.Element => (
            <button
              type="button"
              onClick={() =>
                setEntrySort((s) => ({
                  key,
                  dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc',
                }))
              }
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                font: 'inherit',
                color: 'inherit',
                padding: 0,
              }}
            >
              {label}
              {entrySort.key === key ? (entrySort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
            </button>
          );
          return (
            <Table<BatchEntry>
              columns={[
                { key: 'date', header: sortHeader('date', 'Date'), render: (e) => e.entryDate },
                {
                  key: 'staff',
                  header: sortHeader('staff', 'Staff'),
                  render: (e) => e.staffName ?? '—',
                },
                {
                  key: 'workCode',
                  header: sortHeader('workCode', 'Work code'),
                  render: (e) => e.workCode ?? '—',
                },
                {
                  key: 'hours',
                  header: sortHeader('hours', 'Hours'),
                  align: 'right',
                  render: (e) => Number(e.hours).toFixed(2),
                },
                {
                  key: 'amt',
                  header: sortHeader('amt', 'Standard'),
                  align: 'right',
                  render: (e) => money(e.standardAmountCents),
                },
                {
                  key: 'billed',
                  header: sortHeader('billed', 'Billed'),
                  align: 'right',
                  render: (e) => (e.billedAmountCents != null ? money(e.billedAmountCents) : '—'),
                },
                {
                  key: 'desc',
                  header: sortHeader('desc', 'Description'),
                  render: (e) => e.description ?? '',
                },
                {
                  key: 'action',
                  header: 'Action',
                  render: (e) => (
                    <ActionPicker
                      value={actions.get(e.timeEntryId) ?? e.action}
                      disabled={finalized}
                      onChange={(v) => {
                        const m = new Map(actions);
                        m.set(e.timeEntryId, v);
                        setActions(m);
                      }}
                    />
                  ),
                },
              ]}
              rows={sortedEntries}
              rowKey={(e) => e.timeEntryId}
              empty="No entries in this batch."
              footer={[
                'Totals',
                '',
                totalHours.toFixed(2),
                money(totalStandard),
                money(totalBilled),
                '',
                '',
              ]}
            />
          );
        })()}
      </Card>

      {/* Suggested billing (pricing suggestion) for the batch's engagement,
          the same panel shown on the engagement screen. */}
      {detail.batch.engagementId && (
        <PricingSuggestionPanel engagementId={detail.batch.engagementId} />
      )}

      <PrebillNarrativePanel batchId={detail.batch.id} />

      <UntrackedMessagesPanel
        engagementId={detail.batch.engagementId}
        from={detail.batch.periodStart}
        to={detail.batch.periodEnd}
      />

      {showAdjustDialog && (
        <AdjustmentDialog
          billingBatchId={detail.batch.id}
          includedTotalCents={totals.included}
          currentAdjustmentCents={detail.adjustmentTotalCents ?? 0}
          onClose={() => setShowAdjustDialog(false)}
          onCreated={() => {
            setShowAdjustDialog(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function PrebillNarrativePanel({ batchId }: { batchId: string }): JSX.Element | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [narrative, setNarrative] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const s = await api<{ enabled: boolean }>('/api/staff/ai/status');
        setEnabled(s.enabled);
      } catch {
        setEnabled(false);
      }
    })();
  }, []);

  async function generate(): Promise<void> {
    setLoading(true);
    setErr(null);
    try {
      const r = await api<{ narrative: string }>('/api/staff/ai/prebill-narrative', {
        method: 'POST',
        body: JSON.stringify({ billingBatchId: batchId }),
      });
      setNarrative(r.narrative);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setLoading(false);
    }
  }

  if (enabled === null || enabled === false) return null;

  return (
    <Card
      title="AI pre-bill narrative"
      action={
        <Button variant="secondary" size="sm" onClick={() => void generate()} disabled={loading}>
          {loading ? 'Generating…' : narrative ? 'Regenerate' : 'Generate'}
        </Button>
      }
    >
      {err && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{err}</p>}
      {narrative ? (
        <p style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.55 }}>{narrative}</p>
      ) : (
        <p style={{ color: tokens.color.textMuted, fontSize: 12 }}>
          Click Generate to draft a client-facing narrative summarizing this batch.
        </p>
      )}
    </Card>
  );
}

// P2.4 — Pre-bill "Untracked client interactions" panel (D.5).
// Lists messages in the engagement thread during the billing period
// not linked to any time entry, so a partner can spot conversations
// the timekeeper never logged.
interface UntrackedMsg {
  id: string;
  senderAppUserId: string | null;
  senderPortalIdentityId: string | null;
  body: string;
  createdAt: string;
}

function UntrackedMessagesPanel({
  engagementId,
  from,
  to,
}: {
  engagementId: string;
  from: string;
  to: string;
}): JSX.Element | null {
  const [items, setItems] = useState<UntrackedMsg[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [threadAbsent, setThreadAbsent] = useState(false);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    void api<{
      items: UntrackedMsg[];
      total: number;
      threadId: string | null;
    }>(
      `/api/staff/engagement-messaging/engagements/${engagementId}/untracked-messages?from=${from}&to=${to}&page=${page}&pageSize=${pageSize}`,
    )
      .then((r) => {
        setItems(r.items);
        setTotal(r.total);
        setThreadAbsent(r.threadId === null);
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'failed'))
      .finally(() => setLoading(false));
  }, [engagementId, from, to, page, pageSize]);

  if (threadAbsent) return null;

  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <Card
      title={`Untracked client interactions${total > 0 ? ` (${total})` : ''}`}
      action={
        total > pageSize ? (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
            <Button
              size="sm"
              variant="secondary"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ‹
            </Button>
            <span style={{ color: tokens.color.textMuted }}>
              page {page} / {pages}
            </span>
            <Button
              size="sm"
              variant="secondary"
              disabled={page >= pages || loading}
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
            >
              ›
            </Button>
          </div>
        ) : null
      }
    >
      {err && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{err}</p>}
      {!err && total === 0 && (
        <p style={{ color: tokens.color.textMuted, fontSize: 12, margin: 0 }}>
          Every message in this engagement&apos;s thread during the billing period is linked to at
          least one time entry.
        </p>
      )}
      {items.length > 0 && (
        <Table<UntrackedMsg>
          rows={items}
          rowKey={(m) => m.id}
          empty="—"
          columns={[
            {
              key: 'when',
              header: 'When',
              render: (m) => (
                <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                  {new Date(m.createdAt).toLocaleString()}
                </span>
              ),
            },
            {
              key: 'sender',
              header: 'From',
              render: (m) => (
                <Pill tone={m.senderPortalIdentityId ? 'accent' : 'neutral'}>
                  {m.senderPortalIdentityId ? 'Client' : 'Staff'}
                </Pill>
              ),
            },
            {
              key: 'body',
              header: 'Excerpt',
              render: (m) => (
                <span style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
                  {m.body.length > 200 ? m.body.slice(0, 200) + '…' : m.body}
                </span>
              ),
            },
            {
              key: 'convert',
              header: '',
              render: (m) => <ConvertToTimeEntryButton message={m} engagementId={engagementId} />,
            },
          ]}
        />
      )}
    </Card>
  );
}

// CONNECT_INTEGRATION D.6 — partner-clicks-Convert shortcut. Routes to
// the time-entry form with the engagement pre-selected, the message
// body pre-filled as description, and a linkMessageId carried through
// the submit so the saved entry is auto-linked to this message.
function ConvertToTimeEntryButton({
  message,
  engagementId,
}: {
  message: UntrackedMsg;
  engagementId: string;
}): JSX.Element {
  const navigate = useNavigate();
  const onClick = (): void => {
    // Truncate the description to fit the 2000-char server limit.
    const description =
      message.body.length > 1900 ? message.body.slice(0, 1900) + '…' : message.body;
    const params = new URLSearchParams({
      engagementId,
      description,
      linkMessageId: message.id,
    });
    navigate(`/time?${params.toString()}`);
  };
  return (
    <Button size="sm" variant="secondary" onClick={onClick}>
      Convert
    </Button>
  );
}

function ActionPicker({
  value,
  onChange,
  disabled,
}: {
  value: BatchEntry['action'];
  onChange: (v: BatchEntry['action']) => void;
  disabled?: boolean;
}): JSX.Element {
  const choices: BatchEntry['action'][] = ['INCLUDE', 'DEFER', 'WRITE_OFF'];
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {choices.map((c) => (
        <button
          key={c}
          type="button"
          disabled={disabled}
          onClick={() => onChange(c)}
          style={{
            padding: '2px 8px',
            fontSize: 11,
            borderRadius: tokens.radius.sm,
            border: `1px solid ${value === c ? tokens.color.accent : tokens.color.border}`,
            background: value === c ? tokens.color.accentMuted : 'transparent',
            color: disabled ? tokens.color.textMuted : tokens.color.text,
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
          }}
        >
          {c.replace('_', ' ').toLowerCase()}
        </button>
      ))}
    </div>
  );
}
