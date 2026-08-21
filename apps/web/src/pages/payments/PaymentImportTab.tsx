// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Payments → Import tab (0158). Upload a payroll-charges CSV, pick the
// engagement type it bills, preview the per-client plan (matched client,
// engagement, unbilled WIP vs billed total, write-up/down), then commit.
// The commit orchestrates the EXISTING endpoints per client group —
// billing batch → adjustment → finalize → generate invoice → receive
// payment — or records an unapplied prepayment (credit memo) when no
// engagement/time exists. Every CSV line is logged for dedupe + audit.

import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface EngType {
  id: string;
  name: string;
}
interface ReasonCode {
  id: string;
  category: string;
  label: string;
}
interface PreviewRow {
  line: number;
  clientCode: string;
  clientName: string;
  chargeDate: string;
  description: string;
  amountCents: number;
  duplicate: boolean;
}
interface Group {
  clientCode: string;
  csvClientName: string;
  client: { id: string; name: string } | null;
  engagements: { id: string; name: string; wipCents: number; wipEntryCount: number }[];
  engagementId: string | null;
  wipCents: number;
  wipEntryCount: number;
  targetCents: number;
  adjustmentCents: number;
  maxChargeDate: string;
  rows: PreviewRow[];
  plan: 'BILL_AND_PAY' | 'PREPAYMENT' | 'PICK_ENGAGEMENT' | 'UNMATCHED' | 'ALL_DUPLICATE';
}
interface PreviewResp {
  engagementType: EngType;
  groups: Group[];
  errors: { line: number; error: string }[];
  reasonCodes: ReasonCode[];
}
interface GroupResult {
  status: 'done' | 'error';
  outcome?: string;
  detail?: string;
}

const METHOD_KEY = 'PAYROLL_DRAFT';
const METHOD_LABEL = 'Payroll draft';

const usd = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const PLAN_LABEL: Record<Group['plan'], string> = {
  BILL_AND_PAY: 'Bill + pay',
  PREPAYMENT: 'Prepayment',
  PICK_ENGAGEMENT: 'Pick engagement',
  UNMATCHED: 'No client match',
  ALL_DUPLICATE: 'Already imported',
};
const PLAN_TONE: Record<Group['plan'], 'success' | 'warning' | 'danger' | 'neutral'> = {
  BILL_AND_PAY: 'success',
  PREPAYMENT: 'warning',
  PICK_ENGAGEMENT: 'warning',
  UNMATCHED: 'danger',
  ALL_DUPLICATE: 'neutral',
};

export function PaymentImportTab(): JSX.Element {
  const [types, setTypes] = useState<EngType[]>([]);
  const [typeId, setTypeId] = useState('');
  const [fileName, setFileName] = useState('');
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  // Per-group engagement picks (for PICK_ENGAGEMENT groups).
  const [picks, setPicks] = useState<Record<string, string>>({});
  // Manual overrides: client pick for UNMATCHED groups, and an optional
  // engagement pick ('' = prepayment) once a client is known.
  const [allClients, setAllClients] = useState<{ id: string; name: string }[]>([]);
  const [clientPicks, setClientPicks] = useState<Record<string, string>>({});
  const [engOptions, setEngOptions] = useState<Record<string, Group['engagements']>>({});
  const [engPicks, setEngPicks] = useState<Record<string, string>>({});
  const [writeUpCode, setWriteUpCode] = useState('');
  const [writeDownCode, setWriteDownCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, GroupResult>>({});
  const [committed, setCommitted] = useState(false);

  useEffect(() => {
    void api<{ items: EngType[] }>('/api/staff/taxonomy/engagement-types')
      .then((r) => {
        const items = r.items ?? [];
        setTypes(items);
        const payroll = items.find((t) => /payroll/i.test(t.name));
        if (payroll) setTypeId((prev) => prev || payroll.id);
      })
      .catch(() => undefined);
  }, []);

  function onFile(f: File | null): void {
    if (!f) return;
    setFileName(f.name);
    setPreview(null);
    setResults({});
    setCommitted(false);
    void f.text().then(setCsv);
  }

  async function runPreview(): Promise<void> {
    if (!csv || !typeId) return;
    setBusy(true);
    setErr(null);
    setResults({});
    setCommitted(false);
    try {
      const r = await api<PreviewResp>('/api/staff/payment-imports/preview', {
        method: 'POST',
        body: JSON.stringify({ csv, engagementTypeId: typeId }),
      });
      setPreview(r);
      setPicks({});
      setClientPicks({});
      setEngPicks({});
      setEngOptions({});
      // Manual pickers: clients list (for unmatched codes) + each matched
      // client's billable engagements when the type produced no match.
      if (r.groups.some((g) => !g.client)) {
        void api<{ items: { id: string; name: string }[] }>('/api/staff/clients/picker')
          .then((c) => setAllClients(c.items ?? []))
          .catch(() => undefined);
      }
      for (const g of r.groups) {
        if (g.client && g.plan === 'PREPAYMENT' && g.engagements.length === 0) {
          void loadEngOptions(g.clientCode, g.client.id);
        }
      }
      const ups = (r.reasonCodes ?? []).filter((c) => c.category === 'WRITE_UP');
      const downs = (r.reasonCodes ?? []).filter((c) => c.category === 'WRITE_DOWN');
      setWriteUpCode(ups[0]?.id ?? '');
      setWriteDownCode(downs[0]?.id ?? '');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'preview_failed');
    } finally {
      setBusy(false);
    }
  }

  async function loadEngOptions(code: string, clientId: string): Promise<void> {
    try {
      const r = await api<{ items: Group['engagements'] }>(
        `/api/staff/payment-imports/client-engagements?clientId=${clientId}`,
      );
      setEngOptions((p) => ({ ...p, [code]: r.items ?? [] }));
    } catch {
      setEngOptions((p) => ({ ...p, [code]: [] }));
    }
  }

  function pickClient(code: string, clientId: string): void {
    setClientPicks((p) => ({ ...p, [code]: clientId }));
    setEngPicks((p) => ({ ...p, [code]: '' }));
    if (clientId) void loadEngOptions(code, clientId);
  }

  // Resolve a group's effective plan (client, engagement, WIP) after the
  // manual client/engagement overrides.
  function effective(g: Group): {
    plan: Group['plan'];
    client: { id: string; name: string } | null;
    engagementId: string | null;
    wipCents: number;
    wipEntryCount: number;
  } {
    const none = { engagementId: null, wipCents: 0, wipEntryCount: 0 };
    if (g.plan === 'ALL_DUPLICATE') return { plan: g.plan, client: g.client, ...none };
    const pickedClient = clientPicks[g.clientCode]
      ? (allClients.find((c) => c.id === clientPicks[g.clientCode]) ?? null)
      : null;
    const client = g.client ?? pickedClient;
    if (!client) return { plan: 'UNMATCHED', client: null, ...none };

    // Engagement: ambiguity pick → manual pick → auto match.
    let eng: Group['engagements'][number] | null = null;
    if (g.plan === 'PICK_ENGAGEMENT') {
      eng = g.engagements.find((e) => e.id === picks[g.clientCode]) ?? null;
      if (!eng) return { plan: 'PICK_ENGAGEMENT', client, ...none };
    } else if (engPicks[g.clientCode]) {
      eng = (engOptions[g.clientCode] ?? []).find((e) => e.id === engPicks[g.clientCode]) ?? null;
    } else if (g.engagementId) {
      eng = {
        id: g.engagementId,
        name: '',
        wipCents: g.wipCents,
        wipEntryCount: g.wipEntryCount,
      };
    }
    if (eng && eng.wipCents > 0) {
      return {
        plan: 'BILL_AND_PAY',
        client,
        engagementId: eng.id,
        wipCents: eng.wipCents,
        wipEntryCount: eng.wipEntryCount,
      };
    }
    return {
      plan: 'PREPAYMENT',
      client,
      engagementId: eng?.id ?? null,
      wipCents: 0,
      wipEntryCount: 0,
    };
  }

  async function commit(): Promise<void> {
    if (!preview) return;
    setBusy(true);
    setErr(null);
    const out: Record<string, GroupResult> = {};
    setResults(out);
    try {
      const imp = await api<{ id: string }>('/api/staff/payment-imports', {
        method: 'POST',
        body: JSON.stringify({
          engagementTypeId: typeId,
          paymentMethodKey: METHOD_KEY,
          paymentMethodLabel: METHOD_LABEL,
          fileName: fileName || undefined,
        }),
      });

      for (const g of preview.groups) {
        const eff = effective(g);
        const live = g.rows.filter((r) => !r.duplicate);
        const logRows = (extra: {
          outcome: 'INVOICED_PAID' | 'PREPAYMENT' | 'SKIPPED';
          detail?: string;
          engagementId?: string | null;
          invoiceId?: string | null;
          paymentReceiptId?: string | null;
          creditMemoId?: string | null;
          rows?: PreviewRow[];
        }) =>
          api(`/api/staff/payment-imports/${imp.id}/rows`, {
            method: 'POST',
            body: JSON.stringify({
              rows: (extra.rows ?? live).map((r) => ({
                clientCode: r.clientCode,
                clientName: r.clientName || null,
                chargeDate: r.chargeDate,
                description: r.description || null,
                amountCents: r.amountCents,
                clientId: eff.client?.id ?? null,
                engagementId: extra.engagementId ?? null,
                invoiceId: extra.invoiceId ?? null,
                paymentReceiptId: extra.paymentReceiptId ?? null,
                creditMemoId: extra.creditMemoId ?? null,
                outcome: extra.outcome,
                detail: extra.detail ?? null,
              })),
            }),
          });

        try {
          if (eff.plan === 'ALL_DUPLICATE' || live.length === 0) {
            out[g.clientCode] = { status: 'done', outcome: 'Skipped (already imported)' };
            setResults({ ...out });
            continue;
          }
          if (eff.plan === 'UNMATCHED' || eff.plan === 'PICK_ENGAGEMENT' || !eff.client) {
            await logRows({
              outcome: 'SKIPPED',
              detail: eff.plan === 'UNMATCHED' ? 'no client match' : 'engagement not chosen',
            });
            out[g.clientCode] = {
              status: 'error',
              detail:
                eff.plan === 'UNMATCHED'
                  ? 'No client chosen — pick one, or set the client’s External/AWS id.'
                  : 'Pick an engagement before importing.',
            };
            setResults({ ...out });
            continue;
          }

          if (eff.plan === 'BILL_AND_PAY' && eff.engagementId && eff.wipCents > 0) {
            // 1. pre-bill batch sweeping all unbilled time through the
            //    latest charge date.
            const batch = await api<{ id: string }>('/api/staff/billing-batches', {
              method: 'POST',
              body: JSON.stringify({
                engagementId: eff.engagementId,
                periodStart: '2000-01-01',
                periodEnd: g.maxChargeDate,
              }),
            });
            const detail = await api<{ entries: { timeEntryId: string }[] }>(
              `/api/staff/billing-batches/${batch.id}`,
            );
            // 2. true-up adjustment so the invoice equals the billed total.
            const delta = g.targetCents - eff.wipCents;
            if (delta !== 0) {
              const reasonCodeId = delta > 0 ? writeUpCode : writeDownCode;
              if (!reasonCodeId) throw new Error('missing_reason_code');
              const adj = await api<{ id: string; requiresApproval: boolean }>(
                '/api/staff/adjustments',
                {
                  method: 'POST',
                  body: JSON.stringify({
                    billingBatchId: batch.id,
                    method: 'FEE',
                    allocationMethod: 'PRO_RATA_BY_VALUE',
                    totalAmountCents: delta,
                    reasonCodeId,
                    notes: `Payroll import true-up (${fileName || 'csv'})`,
                  }),
                },
              );
              if (adj.requiresApproval) {
                throw new Error(
                  `adjustment of ${usd(delta)} needs partner approval — approve it, then finish this client from Billing`,
                );
              }
            }
            // 3. finalize (include every entry) + 4. generate the invoice.
            await api(`/api/staff/billing-batches/${batch.id}/finalize`, {
              method: 'POST',
              body: JSON.stringify({
                actions: detail.entries.map((e) => ({
                  timeEntryId: e.timeEntryId,
                  action: 'INCLUDE',
                })),
              }),
            });
            const inv = await api<{ id: string; totalCents: number }>(
              '/api/staff/invoices/generate-from-batch',
              {
                method: 'POST',
                body: JSON.stringify({
                  billingBatchId: batch.id,
                  retainerOptions: { enabled: false },
                }),
              },
            );
            // 5. record the payment in full (any cent of rounding
            //    surplus lands as client credit automatically).
            const alloc = Math.min(g.targetCents, inv.totalCents);
            const rcpt = await api<{ receiptId: string; createdCredit: { id: string } | null }>(
              '/api/staff/payments/receive',
              {
                method: 'POST',
                body: JSON.stringify({
                  payerClientId: eff.client.id,
                  paymentDate: g.maxChargeDate,
                  paymentMethod: METHOD_KEY,
                  amountReceivedCents: g.targetCents,
                  reference: `Payroll import ${fileName || ''}`.trim(),
                  allocations: [{ invoiceId: inv.id, amountCents: alloc }],
                }),
              },
            );
            await logRows({
              outcome: 'INVOICED_PAID',
              engagementId: eff.engagementId,
              invoiceId: inv.id,
              paymentReceiptId: rcpt.receiptId,
              creditMemoId: rcpt.createdCredit?.id ?? null,
            });
            out[g.clientCode] = {
              status: 'done',
              outcome: `Invoiced ${usd(inv.totalCents)} + paid`,
            };
          } else {
            // Prepayment — money received with no allocations becomes an
            // open credit memo on the client.
            const rcpt = await api<{ receiptId: string; createdCredit: { id: string } | null }>(
              '/api/staff/payments/receive',
              {
                method: 'POST',
                body: JSON.stringify({
                  payerClientId: eff.client.id,
                  paymentDate: g.maxChargeDate,
                  paymentMethod: METHOD_KEY,
                  amountReceivedCents: g.targetCents,
                  reference: `Payroll import ${fileName || ''}`.trim(),
                  allocations: [],
                }),
              },
            );
            await logRows({
              outcome: 'PREPAYMENT',
              engagementId: eff.engagementId,
              paymentReceiptId: rcpt.receiptId,
              creditMemoId: rcpt.createdCredit?.id ?? null,
            });
            out[g.clientCode] = {
              status: 'done',
              outcome: `Prepayment credit ${usd(g.targetCents)}`,
            };
          }
        } catch (e) {
          out[g.clientCode] = {
            status: 'error',
            detail: e instanceof Error ? e.message : 'failed',
          };
        }
        setResults({ ...out });
      }
      setCommitted(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'import_failed');
    } finally {
      setBusy(false);
    }
  }

  const committable = useMemo(() => {
    if (!preview) return false;
    return preview.groups.some((g) => {
      const eff = effective(g);
      return (
        g.rows.some((r) => !r.duplicate) &&
        (eff.plan === 'BILL_AND_PAY' || eff.plan === 'PREPAYMENT')
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, picks]);

  const writeUps = (preview?.reasonCodes ?? []).filter((c) => c.category === 'WRITE_UP');
  const writeDowns = (preview?.reasonCodes ?? []).filter((c) => c.category === 'WRITE_DOWN');

  const selStyle: React.CSSProperties = {
    padding: '7px 10px',
    borderRadius: tokens.radius.sm,
    border: `1px solid ${tokens.color.border}`,
    background: tokens.color.surface,
    color: tokens.color.text,
    fontSize: 13,
  };

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      <Card title="Import client charges">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>
          Upload a payroll charges CSV (client code, charge date, description, amount). Matched
          clients with an active engagement and unbilled time get an invoice priced to the billed
          amount and the payment recorded against it; everything else is recorded as an unapplied
          prepayment on the client. Lines already imported are skipped.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }}>
          <label style={{ display: 'grid', gap: 4, fontSize: 12, color: tokens.color.textMuted }}>
            CSV file
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => onFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 12, color: tokens.color.textMuted }}>
            Engagement type
            <select value={typeId} onChange={(e) => setTypeId(e.target.value)} style={selStyle}>
              <option value="">Choose…</option>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <Button onClick={() => void runPreview()} disabled={busy || !csv || !typeId}>
            {busy && !preview ? 'Analyzing…' : 'Preview'}
          </Button>
        </div>
      </Card>

      {preview && (
        <Card title={`Preview — ${preview.groups.length} client(s)`}>
          {preview.errors.length > 0 && (
            <div style={{ fontSize: 12, color: tokens.color.danger, marginBottom: 8 }}>
              {preview.errors.map((e) => `line ${e.line}: ${e.error}`).join(' · ')}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 12, color: tokens.color.textMuted }}>
              Write-up reason
              <select
                value={writeUpCode}
                onChange={(e) => setWriteUpCode(e.target.value)}
                style={selStyle}
              >
                {writeUps.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 12, color: tokens.color.textMuted }}>
              Write-down reason
              <select
                value={writeDownCode}
                onChange={(e) => setWriteDownCode(e.target.value)}
                style={selStyle}
              >
                {writeDowns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div style={{ display: 'grid', gap: 10 }}>
            {preview.groups.map((g) => {
              const eff = effective(g);
              const res = results[g.clientCode];
              return (
                <div
                  key={g.clientCode}
                  style={{
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.md,
                    padding: tokens.space.md,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13 }}>
                      {eff.client?.name ?? g.csvClientName}{' '}
                      <span style={{ color: tokens.color.textMuted, fontWeight: 400 }}>
                        ({g.clientCode})
                      </span>
                    </strong>
                    <Pill tone={PLAN_TONE[eff.plan]}>{PLAN_LABEL[eff.plan]}</Pill>
                    {eff.plan === 'BILL_AND_PAY' && (
                      <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                        WIP {usd(eff.wipCents)} ({eff.wipEntryCount} entries) → bill{' '}
                        {usd(g.targetCents)}
                        {g.targetCents - eff.wipCents !== 0 &&
                          ` (${g.targetCents - eff.wipCents > 0 ? 'write-up' : 'write-down'} ${usd(
                            Math.abs(g.targetCents - eff.wipCents),
                          )})`}
                      </span>
                    )}
                    {eff.plan === 'PREPAYMENT' && (
                      <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                        {g.client
                          ? g.engagementId
                            ? 'No unbilled time — record as client credit'
                            : 'No active engagement of this type — record as client credit'
                          : ''}{' '}
                        {usd(g.targetCents)}
                      </span>
                    )}
                    {g.plan === 'PICK_ENGAGEMENT' && (
                      <select
                        value={picks[g.clientCode] ?? ''}
                        onChange={(e) =>
                          setPicks((p) => ({ ...p, [g.clientCode]: e.target.value }))
                        }
                        style={selStyle}
                        aria-label="Choose engagement"
                      >
                        <option value="">Choose engagement…</option>
                        {g.engagements.map((en) => (
                          <option key={en.id} value={en.id}>
                            {en.name}
                          </option>
                        ))}
                      </select>
                    )}
                    {!g.client && g.plan !== 'ALL_DUPLICATE' && (
                      <select
                        value={clientPicks[g.clientCode] ?? ''}
                        onChange={(e) => pickClient(g.clientCode, e.target.value)}
                        style={selStyle}
                        aria-label="Choose client"
                      >
                        <option value="">Choose client…</option>
                        {allClients.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    )}
                    {eff.client &&
                      g.plan !== 'PICK_ENGAGEMENT' &&
                      g.plan !== 'ALL_DUPLICATE' &&
                      !g.engagementId &&
                      (engOptions[g.clientCode]?.length ?? 0) > 0 && (
                        <select
                          value={engPicks[g.clientCode] ?? ''}
                          onChange={(e) =>
                            setEngPicks((p) => ({ ...p, [g.clientCode]: e.target.value }))
                          }
                          style={selStyle}
                          aria-label="Choose engagement or prepay"
                        >
                          <option value="">Apply as prepayment</option>
                          {(engOptions[g.clientCode] ?? []).map((en) => (
                            <option key={en.id} value={en.id}>
                              {en.name} — WIP {usd(en.wipCents)}
                            </option>
                          ))}
                        </select>
                      )}
                    <div style={{ marginLeft: 'auto' }}>
                      {res &&
                        (res.status === 'done' ? (
                          <Pill tone="success">{res.outcome}</Pill>
                        ) : (
                          <Pill tone="danger">{res.detail}</Pill>
                        ))}
                    </div>
                  </div>
                  <table style={{ width: '100%', fontSize: 12, marginTop: 8 }}>
                    <tbody>
                      {g.rows.map((r) => (
                        <tr
                          key={r.line}
                          style={{
                            color: r.duplicate ? tokens.color.textMuted : tokens.color.text,
                            textDecoration: r.duplicate ? 'line-through' : 'none',
                          }}
                        >
                          <td style={{ padding: '2px 8px 2px 0', whiteSpace: 'nowrap' }}>
                            {r.chargeDate}
                          </td>
                          <td style={{ padding: '2px 8px' }}>{r.description}</td>
                          <td
                            style={{ padding: '2px 0', textAlign: 'right', whiteSpace: 'nowrap' }}
                          >
                            {usd(r.amountCents)}
                            {r.duplicate ? ' (imported)' : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14 }}>
            <Button onClick={() => void commit()} disabled={busy || committed || !committable}>
              {busy ? 'Importing…' : committed ? 'Imported' : 'Import'}
            </Button>
            {err && <span style={{ fontSize: 12, color: tokens.color.danger }}>{err}</span>}
            {committed && (
              <span style={{ fontSize: 12, color: tokens.color.success }}>
                Import complete — invoices and payments are visible on each client.
              </span>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
