// SPDX-License-Identifier: Elastic-2.0
//
// R6-followup — per-retainer detail page. Pulls /api/staff/retainers/:id/detail
// and renders four sections:
//   • Status header + hours bar + key dates
//   • Engagement + client meta + price + eligibility chips
//   • Ledger table — joined with time_entry context (date, hours, description)
//   • Timeline — audit_log rows for status / pause / void / etc.

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface DetailResponse {
  retainer: {
    id: string;
    name: string;
    tier: 'TIER_1' | 'TIER_2';
    returnType: string;
    taxYear: number;
    status: 'active' | 'exhausted' | 'expired' | 'void' | 'paused' | 'pending_payment';
    hoursPurchased: string;
    hoursConsumed: string;
    priceCents: number;
    purchaseDate: string;
    expiryDate: string;
    notes: string | null;
    offerId: string | null;
    purchaseInvoiceId: string | null;
    pausedAt: string | null;
    pausedReason: string | null;
    voidedAt: string | null;
    voidedReason: string | null;
  };
  client: { id: string; name: string } | null;
  engagement: {
    id: string;
    name: string;
    returnType: string | null;
    taxYear: number | null;
  } | null;
  purchaseInvoice: {
    id: string;
    invoiceNumber: string;
    status: string;
    totalCents: number;
    paidCents: number;
    issueDate: string;
    dueDate: string;
  } | null;
  eligibility: Array<{ id: string; key: string; name: string }>;
  ledger: Array<{
    id: string;
    kind: 'ACTIVATION' | 'CONSUME' | 'REVERSE';
    hoursDelta: string;
    hoursBalanceAfter: string;
    createdAt: string;
    timeEntryId: string | null;
    actorName: string | null;
    entryDate: string | null;
    entryHours: string | null;
    entryDescription: string | null;
    workCodeName: string | null;
  }>;
  timeline: Array<{
    id: string;
    occurredAt: string;
    action: string;
    actorName: string | null;
    before: unknown;
    after: unknown;
  }>;
}

export function RetainerDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    async function load(): Promise<void> {
      try {
        const r = await api<DetailResponse>(`/api/staff/retainers/${id}/detail`);
        setData(r);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'load failed');
      }
    }
    void load();
  }, [id]);

  if (error) {
    return <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>;
  }
  if (!data) {
    return <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>;
  }

  const { retainer, client, engagement, eligibility, ledger, timeline, purchaseInvoice } = data;
  const hp = Number(retainer.hoursPurchased);
  const hc = Number(retainer.hoursConsumed);
  const remaining = hp - hc;
  const pct = hp > 0 ? Math.min(100, Math.round((hc / hp) * 100)) : 0;
  const pctTone =
    pct >= 90 ? tokens.color.danger : pct >= 60 ? tokens.color.warning : tokens.color.success;

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <header
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}
      >
        <div>
          <Link
            to="/admin/retainers"
            style={{ color: tokens.color.accent, fontSize: 12, textDecoration: 'none' }}
          >
            ← All retainers
          </Link>
          <h1 style={{ margin: '4px 0 0', fontSize: 22 }}>
            {retainer.name}{' '}
            <span style={{ color: tokens.color.textMuted, fontWeight: 400, fontSize: 16 }}>
              · TY{retainer.taxYear} {retainer.returnType} · {retainer.tier}
            </span>
          </h1>
          {client && (
            <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: '4px 0 0' }}>
              <Link to={`/clients/${client.id}`} style={{ color: tokens.color.text }}>
                {client.name}
              </Link>
              {engagement && (
                <>
                  {' · '}
                  <Link to={`/engagements/${engagement.id}`} style={{ color: tokens.color.text }}>
                    {engagement.name}
                  </Link>
                </>
              )}
            </p>
          )}
        </div>
        <Pill
          tone={
            retainer.status === 'active'
              ? 'success'
              : retainer.status === 'exhausted'
                ? 'warning'
                : retainer.status === 'paused'
                  ? 'accent'
                  : retainer.status === 'pending_payment'
                    ? 'warning'
                    : retainer.status === 'expired'
                      ? 'neutral'
                      : 'danger'
          }
        >
          {retainer.status === 'pending_payment' ? 'awaiting payment' : retainer.status}
        </Pill>
      </header>

      {purchaseInvoice && (
        <Card title="Purchase invoice">
          <div
            style={{
              display: 'grid',
              gap: 12,
              gridTemplateColumns: '1fr auto',
              alignItems: 'center',
            }}
          >
            <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              <div>
                <Link
                  to={`/invoices/${purchaseInvoice.id}`}
                  style={{ color: tokens.color.accent, fontWeight: 600 }}
                >
                  {purchaseInvoice.invoiceNumber}
                </Link>{' '}
                <span style={{ color: tokens.color.textMuted }}>
                  · ${(purchaseInvoice.totalCents / 100).toFixed(2)} · issued{' '}
                  {new Date(purchaseInvoice.issueDate).toLocaleDateString()} · due{' '}
                  {new Date(purchaseInvoice.dueDate).toLocaleDateString()}
                </span>
              </div>
              <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                Paid ${(purchaseInvoice.paidCents / 100).toFixed(2)} of $
                {(purchaseInvoice.totalCents / 100).toFixed(2)}
                {retainer.status === 'pending_payment' && (
                  <>
                    {' · '}
                    <strong style={{ color: tokens.color.warning }}>
                      Retainer activates when this invoice is paid.
                    </strong>
                  </>
                )}
              </div>
            </div>
            <Pill
              tone={
                purchaseInvoice.status === 'PAID'
                  ? 'success'
                  : purchaseInvoice.status === 'PARTIAL'
                    ? 'accent'
                    : purchaseInvoice.status === 'VOIDED'
                      ? 'neutral'
                      : 'warning'
              }
            >
              {purchaseInvoice.status}
            </Pill>
          </div>
        </Card>
      )}

      <Card title="Hours">
        <div style={{ display: 'grid', gap: 8 }}>
          <div
            style={{
              fontSize: 28,
              fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
              color: pct >= 90 ? tokens.color.danger : tokens.color.text,
            }}
          >
            {remaining.toFixed(2)}{' '}
            <span style={{ fontSize: 14, color: tokens.color.textMuted, fontWeight: 400 }}>
              of {hp.toFixed(2)} remaining
            </span>
          </div>
          <div
            style={{
              width: '100%',
              height: 10,
              background: tokens.color.surface,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: 5,
              overflow: 'hidden',
            }}
          >
            <div style={{ width: `${pct}%`, height: '100%', background: pctTone }} />
          </div>
          <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
            {hc.toFixed(2)} hours consumed · {pct}% utilized
          </div>
        </div>
      </Card>

      <div style={{ display: 'grid', gap: tokens.space.lg, gridTemplateColumns: '1fr 1fr' }}>
        <Card title="Purchase">
          <Dl
            items={[
              ['Price', `$${(retainer.priceCents / 100).toFixed(2)}`],
              ['Purchased', new Date(retainer.purchaseDate).toLocaleDateString()],
              ['Expires', new Date(retainer.expiryDate).toLocaleDateString()],
              [
                'Activation',
                retainer.offerId
                  ? 'Portal purchase'
                  : retainer.purchaseInvoiceId
                    ? 'Invoice'
                    : 'Manual (firm-initiated)',
              ],
              ...(retainer.notes ? ([['Notes', retainer.notes]] as const) : []),
              ...(retainer.pausedAt
                ? ([
                    ['Paused at', new Date(retainer.pausedAt).toLocaleString()],
                    ['Paused reason', retainer.pausedReason ?? '—'],
                  ] as const)
                : []),
              ...(retainer.voidedAt
                ? ([
                    ['Voided at', new Date(retainer.voidedAt).toLocaleString()],
                    ['Voided reason', retainer.voidedReason ?? '—'],
                  ] as const)
                : []),
            ]}
          />
        </Card>

        <Card title="Eligible work codes">
          {eligibility.length === 0 ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
              No eligible work codes — time entries on this engagement always go to billable WIP.
            </p>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {eligibility.map((wc) => (
                <Pill key={wc.id} tone="neutral">
                  {wc.name}
                </Pill>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card title="Activity">
        {ledger.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No activity yet.</p>
        ) : (
          <Table<DetailResponse['ledger'][number]>
            columns={[
              {
                key: 'when',
                header: 'When',
                render: (r) => new Date(r.createdAt).toLocaleString(),
              },
              {
                key: 'kind',
                header: 'Type',
                render: (r) => (
                  <Pill
                    tone={
                      r.kind === 'CONSUME' ? 'warning' : r.kind === 'REVERSE' ? 'accent' : 'success'
                    }
                  >
                    {r.kind}
                  </Pill>
                ),
              },
              {
                key: 'delta',
                header: 'Hours',
                render: (r) => (
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {Number(r.hoursDelta) > 0 ? '+' : ''}
                    {Number(r.hoursDelta).toFixed(2)}
                  </span>
                ),
              },
              {
                key: 'balance',
                header: 'Balance',
                render: (r) => Number(r.hoursBalanceAfter).toFixed(2),
              },
              {
                key: 'context',
                header: 'Time entry',
                render: (r) =>
                  r.timeEntryId ? (
                    <div style={{ fontSize: 12 }}>
                      <div>
                        {r.entryDate ? new Date(r.entryDate).toLocaleDateString() : '—'}{' '}
                        {r.workCodeName && (
                          <span style={{ color: tokens.color.textMuted }}>· {r.workCodeName}</span>
                        )}
                      </div>
                      {r.entryDescription && (
                        <div style={{ color: tokens.color.textMuted, marginTop: 2 }}>
                          {r.entryDescription}
                        </div>
                      )}
                      {r.actorName && (
                        <div style={{ color: tokens.color.textMuted, fontSize: 11, marginTop: 2 }}>
                          by {r.actorName}
                        </div>
                      )}
                    </div>
                  ) : (
                    <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>
                      {r.kind === 'ACTIVATION' ? 'Activation seed' : '—'}
                    </span>
                  ),
              },
            ]}
            rows={ledger}
            rowKey={(r) => r.id}
          />
        )}
      </Card>

      <Card title="Timeline">
        {timeline.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No status changes recorded.</p>
        ) : (
          <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {timeline.map((evt) => (
              <li
                key={evt.id}
                style={{
                  padding: '8px 12px',
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  background: tokens.color.surface,
                  fontSize: 13,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 12,
                    color: tokens.color.textMuted,
                  }}
                >
                  <span>{new Date(evt.occurredAt).toLocaleString()}</span>
                  <span>{evt.actorName ?? 'system'}</span>
                </div>
                <div style={{ marginTop: 4 }}>
                  <strong>{evt.action}</strong>
                  {summarizeAfter(evt.after)}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

function summarizeAfter(after: unknown): string {
  if (!after || typeof after !== 'object') return '';
  const obj = after as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof obj['status'] === 'string') parts.push(`→ ${obj['status']}`);
  if (typeof obj['reason'] === 'string' && obj['reason']) parts.push(`(${obj['reason']})`);
  if (typeof obj['kind'] === 'string') parts.push(`kind=${obj['kind']}`);
  if (obj['resumed'] === true) parts.push('resumed');
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

function Dl({ items }: { items: ReadonlyArray<readonly [string, string]> }): JSX.Element {
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: '120px 1fr',
        gap: '6px 12px',
        margin: 0,
        fontSize: 13,
      }}
    >
      {items.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt style={{ color: tokens.color.textMuted }}>{k}</dt>
          <dd style={{ margin: 0 }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
