// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CP2 — Client portal tax-payment view. Read-only privacy-filtered
// surface fed by /api/portal/tax-payments. Urgency-border rows per
// UI plan §5: red for due ≤7 days, amber for due ≤30 days.

import { useEffect, useMemo, useState } from 'react';

import { Card, EmptyState, Pill, SectionHeading, Stat, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { useScope } from '../scope-context';

interface PortalTaxPaymentRow {
  id: string;
  clientId?: string;
  engagementId: string | null;
  jurisdiction: string;
  paymentType: string;
  // 0090 — pre-resolved "Pay online" link snapshotted from the firm's
  // tax_payment_type catalog at create time.
  paymentUrl: string | null;
  taxYear: number | null;
  amountCents: number;
  dueDate: string;
  status: 'SCHEDULED' | 'PAID';
  paidDate: string | null;
  confirmationNumber: string | null;
}

const formatCents = (c: number): string =>
  `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function daysUntil(iso: string): number {
  const due = new Date(iso + 'T00:00:00Z').getTime();
  const now = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
  return Math.round((due - now) / (24 * 3600_000));
}

function urgencyBorder(days: number): string {
  if (days < 0) return tokens.color.danger; // overdue
  if (days <= 7) return tokens.color.danger;
  if (days <= 30) return tokens.color.warning;
  return tokens.color.border;
}

export function TaxPaymentsPage(): JSX.Element {
  const [items, setItems] = useState<PortalTaxPaymentRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { scope, scopeQuery, clientNames } = useScope();

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: PortalTaxPaymentRow[] }>(
          `/api/portal/tax-payments${scopeQuery}`,
        );
        setItems(r.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to load');
      } finally {
        setLoaded(true);
      }
    })();
  }, [scopeQuery]);

  const { upcoming, paid } = useMemo(() => {
    const upcoming = items.filter((i) => i.status === 'SCHEDULED');
    const paid = items.filter((i) => i.status === 'PAID');
    return { upcoming, paid };
  }, [items]);

  const nextDue = upcoming[0];
  const nextDueDays = nextDue ? daysUntil(nextDue.dueDate) : null;
  const totalUpcomingCents = upcoming.reduce((s, i) => s + i.amountCents, 0);

  const consolidated = scope === 'all_accessible';

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900, margin: '0 auto' }}>
      <SectionHeading
        title="Tax payments"
        description="Estimated tax obligations entered by your firm. Confirm with them before mailing checks or making payments."
      />
      {consolidated && (
        <div
          style={{
            padding: '8px 12px',
            background: tokens.color.accentMuted,
            borderRadius: tokens.radius.sm,
            fontSize: 12,
            color: tokens.color.accent,
          }}
        >
          Showing tax payments from <strong>all clients you can access</strong>.
        </div>
      )}

      <Card
        title="Disclaimer"
        style={{
          borderColor: tokens.color.warning,
          background: tokens.color.surface,
        }}
      >
        <p style={{ fontSize: 13, color: tokens.color.text, margin: 0 }}>
          These amounts are estimates entered by your firm. Always confirm with them directly before
          submitting payments to a tax authority. Payment receipts and confirmation numbers, when
          shown, reflect what your firm recorded after the fact.
        </p>
      </Card>

      <section>
        <SectionHeading title="Summary" eyebrow="At a glance" />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: tokens.space.md,
          }}
        >
          <Stat
            label="Upcoming count"
            value={upcoming.length}
            tone={upcoming.length > 0 ? 'accent' : 'neutral'}
          />
          <Stat
            label="Total upcoming"
            value={formatCents(totalUpcomingCents)}
            tone={totalUpcomingCents > 0 ? 'warning' : 'neutral'}
          />
          <Stat
            label="Next due"
            value={nextDue ? nextDue.dueDate : '—'}
            tone={
              nextDueDays == null
                ? 'neutral'
                : nextDueDays < 0
                  ? 'danger'
                  : nextDueDays <= 7
                    ? 'danger'
                    : nextDueDays <= 30
                      ? 'warning'
                      : 'neutral'
            }
            caption={
              nextDueDays == null
                ? 'No upcoming payments'
                : nextDueDays < 0
                  ? `Overdue by ${Math.abs(nextDueDays)} day${Math.abs(nextDueDays) === 1 ? '' : 's'}`
                  : `${nextDueDays} day${nextDueDays === 1 ? '' : 's'} away`
            }
          />
        </div>
      </section>

      <section>
        <SectionHeading title="Upcoming" />
        <Card>
          {!loaded ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
          ) : upcoming.length === 0 ? (
            <EmptyState
              icon="✓"
              title="No tax payments scheduled"
              body="Your firm has not entered any upcoming tax obligations. If you expect one, please reach out to them directly."
            />
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
              {upcoming.map((row) => {
                const d = daysUntil(row.dueDate);
                return (
                  <li
                    key={row.id}
                    style={{
                      padding: tokens.space.md,
                      borderLeft: `4px solid ${urgencyBorder(d)}`,
                      border: `1px solid ${tokens.color.border}`,
                      borderLeftWidth: 4,
                      borderRadius: tokens.radius.sm,
                      background: tokens.color.bg,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'baseline',
                        gap: 12,
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>
                          {row.jurisdiction}
                          {row.taxYear && (
                            <span
                              style={{
                                color: tokens.color.textMuted,
                                fontWeight: 400,
                                marginLeft: 6,
                              }}
                            >
                              · TY{row.taxYear}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 2 }}>
                          {row.paymentType}
                          {consolidated && row.clientId && clientNames[row.clientId] && (
                            <> · {clientNames[row.clientId]}</>
                          )}
                        </div>
                      </div>
                      <div
                        style={{
                          textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'flex-end',
                          gap: 4,
                        }}
                      >
                        <div style={{ fontWeight: 600 }}>{formatCents(row.amountCents)}</div>
                        <div
                          style={{
                            fontSize: 12,
                            color:
                              d < 0
                                ? tokens.color.danger
                                : d <= 7
                                  ? tokens.color.danger
                                  : d <= 30
                                    ? tokens.color.warning
                                    : tokens.color.textMuted,
                          }}
                        >
                          Due {row.dueDate}
                          {d < 0
                            ? ` (${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} overdue)`
                            : d <= 30
                              ? ` (${d} day${d === 1 ? '' : 's'})`
                              : ''}
                        </div>
                        {row.paymentUrl && (
                          <a
                            href={row.paymentUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              fontSize: 12,
                              padding: '4px 10px',
                              borderRadius: tokens.radius.sm,
                              background: tokens.color.accent,
                              color: '#fff',
                              textDecoration: 'none',
                              fontWeight: 500,
                              marginTop: 2,
                            }}
                          >
                            Pay online ↗
                          </a>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </section>

      {paid.length > 0 && (
        <section>
          <SectionHeading
            title="Recently paid"
            description="Payments your firm has recorded within the last 90 days."
          />
          <Card>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
              {paid.map((row) => (
                <li
                  key={row.id}
                  style={{
                    padding: tokens.space.md,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    background: tokens.color.bg,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    gap: 12,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 500, fontSize: 14 }}>
                      {row.jurisdiction}
                      {row.taxYear && (
                        <span style={{ color: tokens.color.textMuted, marginLeft: 6 }}>
                          · TY{row.taxYear}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 2 }}>
                      {row.paymentType}
                      {row.confirmationNumber && ` · #${row.confirmationNumber}`}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    <Pill tone="success">PAID</Pill>
                    <div style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 4 }}>
                      {formatCents(row.amountCents)} · {row.paidDate}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
    </div>
  );
}
