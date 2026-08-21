// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CP0 — Portal home shell. Per UI plan §3, the home page composes
// sections rather than rendering one monolithic welcome card. Each
// section pulls its own data and renders an EmptyState when there's
// nothing yet. CP2 will fill the "Upcoming tax payments" preview;
// future stages add engagement status and recent activity.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Card, EmptyState, Pill, SectionHeading, Stat, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { useAuth } from '../auth-context';
import { PayToUnlockBanner } from '../components/PayToUnlockBanner';
import { EngagementCard } from './Engagements';

interface InvoiceSummary {
  id: string;
  invoiceNumber: string;
  dueDate: string;
  totalCents: number;
  paidCents: number;
}

interface PortalTaxPaymentSummary {
  id: string;
  jurisdiction: string;
  paymentType: string;
  amountCents: number;
  dueDate: string;
  status: 'SCHEDULED' | 'PAID';
}

interface ReleasedReturnSummary {
  returnId: string;
  taxYear: number;
  formCode: string;
  jurisdiction: string;
  title: string;
  releasedAt: string;
  scope: 'FULL' | 'SELECTED';
  releaseKind: 'ORIGINAL' | 'AMENDED' | 'SUPERSEDED';
}

interface AppointmentSummary {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: 'VIDEO' | 'PHONE' | 'IN_PERSON';
  locationDetail: string | null;
  leadName: string | null;
  status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';
}

interface ActiveEngagementSummary {
  id: string;
  name: string;
  partnerName: string | null;
  startDate: string | null;
  endDate: string | null;
  dueDate: string | null;
  lastActivity: string;
  statusPill: 'in_progress' | 'awaiting_client' | 'scheduled' | 'filed' | 'blocked' | 'paused';
  progressPct: number | null;
  nextMilestone: { id: string; name: string; dueDate: string | null } | null;
  awaitingFromYou: number;
}

const formatCents = (c: number): string =>
  `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function HomePage(): JSX.Element {
  const { me } = useAuth();
  const [openInvoices, setOpenInvoices] = useState<InvoiceSummary[]>([]);
  const [taxPayments, setTaxPayments] = useState<PortalTaxPaymentSummary[]>([]);
  const [taxReturns, setTaxReturns] = useState<ReleasedReturnSummary[]>([]);
  const [engagements, setEngagements] = useState<ActiveEngagementSummary[]>([]);
  const [appointments, setAppointments] = useState<AppointmentSummary[]>([]);
  // 0222 — action items ("needs your attention").
  const [attention, setAttention] = useState<{
    unreadMessages: number;
    openRequests: number;
    lettersAwaiting: number;
    newFiles: number;
  } | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      // allSettled, not all: each section loads independently so one
      // failing endpoint (e.g. a 500 from appointments) can't blank every
      // other card on the overview.
      const [inv, tax, ret, eng, apt, att] = await Promise.allSettled([
        api<{ open: InvoiceSummary[] }>('/api/portal/invoices'),
        api<{ items: PortalTaxPaymentSummary[] }>('/api/portal/tax-payments'),
        api<{ items: ReleasedReturnSummary[] }>('/api/portal/tax/returns'),
        api<{ items: ActiveEngagementSummary[] }>('/api/portal/engagements/active'),
        api<{ items: AppointmentSummary[] }>('/api/portal/appointments'),
        api<{
          unreadMessages: number;
          openRequests: number;
          lettersAwaiting: number;
          newFiles: number;
        }>('/api/portal/notifications/attention'),
      ]);
      if (inv.status === 'fulfilled') setOpenInvoices(inv.value.open ?? []);
      if (tax.status === 'fulfilled') setTaxPayments(tax.value.items ?? []);
      if (ret.status === 'fulfilled') setTaxReturns(ret.value.items ?? []);
      if (eng.status === 'fulfilled') setEngagements(eng.value.items ?? []);
      if (apt.status === 'fulfilled') setAppointments(apt.value.items ?? []);
      if (att.status === 'fulfilled') setAttention(att.value);
      setLoaded(true);
    })();
  }, [me?.activeClientId]);

  const upcomingAppts = appointments
    .filter((a) => a.status === 'SCHEDULED' && new Date(a.startsAt).getTime() >= Date.now())
    .slice(0, 2);

  const upcomingTax = taxPayments.filter((t) => t.status === 'SCHEDULED').slice(0, 2);

  const totalOutstanding = openInvoices.reduce(
    (sum, inv) => sum + (inv.totalCents - inv.paidCents),
    0,
  );
  const nextDue = [...openInvoices].sort((a, b) =>
    a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0,
  )[0];

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900, margin: '0 auto' }}>
      <PayToUnlockBanner />

      {attention &&
        attention.unreadMessages +
          attention.openRequests +
          attention.lettersAwaiting +
          attention.newFiles >
          0 && (
          <section>
            <SectionHeading title="Needs your attention" />
            <div style={{ display: 'grid', gap: 8 }}>
              {attention.unreadMessages > 0 && (
                <AttentionRow
                  icon="💬"
                  label={`${attention.unreadMessages} unread message${
                    attention.unreadMessages === 1 ? '' : 's'
                  } from your firm`}
                  to="/messages"
                />
              )}
              {attention.openRequests > 0 && (
                <AttentionRow
                  icon="📄"
                  label={`${attention.openRequests} open request${
                    attention.openRequests === 1 ? '' : 's'
                  } — documents or answers your firm is waiting on`}
                  to="/requests"
                />
              )}
              {attention.lettersAwaiting > 0 && (
                <AttentionRow
                  icon="✍️"
                  label={`${attention.lettersAwaiting} letter${
                    attention.lettersAwaiting === 1 ? '' : 's'
                  } awaiting your signature`}
                  to="/letters"
                />
              )}
              {attention.newFiles > 0 && (
                <AttentionRow
                  icon="🆕"
                  label={`${attention.newFiles} file${
                    attention.newFiles === 1 ? '' : 's'
                  } shared with you in the last 14 days`}
                  to="/files"
                />
              )}
            </div>
          </section>
        )}

      <section>
        <SectionHeading
          eyebrow="At a glance"
          title="Account summary"
          description="Everything that needs your attention."
        />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: tokens.space.md,
          }}
        >
          <Stat
            label="Outstanding balance"
            value={formatCents(totalOutstanding)}
            tone={totalOutstanding > 0 ? 'warning' : 'success'}
          />
          <Stat
            label="Open invoices"
            value={openInvoices.length}
            tone={openInvoices.length > 0 ? 'accent' : 'neutral'}
          />
          <Stat
            label="Next due"
            value={nextDue ? nextDue.dueDate : '—'}
            caption={nextDue ? `Invoice ${nextDue.invoiceNumber}` : 'No invoices due'}
          />
        </div>
      </section>

      <section>
        <SectionHeading
          title="Upcoming appointments"
          action={
            upcomingAppts.length > 0 ? (
              <Link to="/appointments" style={{ color: tokens.color.accent, fontSize: 13 }}>
                View all →
              </Link>
            ) : undefined
          }
        />
        <Card>
          {!loaded ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
          ) : upcomingAppts.length === 0 ? (
            <EmptyState
              icon="📅"
              title="No appointments scheduled"
              body="Your firm will book meetings with you here when needed."
            />
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
              {upcomingAppts.map((a) => {
                const start = new Date(a.startsAt);
                return (
                  <li
                    key={a.id}
                    style={{
                      padding: tokens.space.md,
                      border: `1px solid ${tokens.color.border}`,
                      borderRadius: tokens.radius.sm,
                      background: tokens.color.bg,
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 12,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 500, fontSize: 14 }}>{a.title}</div>
                      <div style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 2 }}>
                        {start.toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                        {a.leadName && ` · with ${a.leadName}`}
                      </div>
                    </div>
                    {a.location === 'VIDEO' &&
                    a.locationDetail &&
                    /^https?:\/\//.test(a.locationDetail) ? (
                      <a
                        href={a.locationDetail}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: tokens.color.accent, fontSize: 13 }}
                      >
                        Join →
                      </a>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </section>

      <section>
        <SectionHeading
          title="Engagement status"
          action={
            engagements.length > 0 ? (
              <Link to="/engagements" style={{ color: tokens.color.accent, fontSize: 13 }}>
                View all →
              </Link>
            ) : undefined
          }
        />
        {!loaded ? (
          <Card>
            <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
          </Card>
        ) : engagements.length === 0 ? (
          <Card>
            <EmptyState
              icon="📋"
              title="No active engagements"
              body="When your firm starts work on your behalf, the engagement will appear here with status updates."
            />
          </Card>
        ) : (
          <div style={{ display: 'grid', gap: tokens.space.md }}>
            {engagements.slice(0, 2).map((e) => (
              <EngagementCard key={e.id} engagement={e} />
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionHeading
          title="Open invoices"
          action={
            openInvoices.length > 0 ? (
              <Link to="/invoices" style={{ color: tokens.color.accent, fontSize: 13 }}>
                View all →
              </Link>
            ) : undefined
          }
        />
        <Card>
          {!loaded ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
          ) : openInvoices.length === 0 ? (
            <EmptyState
              icon="✓"
              title="No open invoices"
              body="Your account is up to date. New invoices appear here when your firm sends them."
            />
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
              {openInvoices.slice(0, 3).map((inv) => (
                <li
                  key={inv.id}
                  style={{
                    padding: tokens.space.md,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    background: tokens.color.bg,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <Link
                      to={`/invoices/${inv.id}`}
                      style={{ color: tokens.color.accent, fontWeight: 500, fontSize: 14 }}
                    >
                      {inv.invoiceNumber}
                    </Link>
                    <div style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 2 }}>
                      Due {inv.dueDate}
                    </div>
                  </div>
                  <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
                    {formatCents(inv.totalCents - inv.paidCents)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section>
        <SectionHeading
          title="Tax returns"
          action={
            taxReturns.length > 0 ? (
              <Link to="/tax/returns" style={{ color: tokens.color.accent, fontSize: 13 }}>
                View all →
              </Link>
            ) : undefined
          }
        />
        <Card>
          {!loaded ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
          ) : taxReturns.length === 0 ? (
            <EmptyState
              icon="📄"
              title="No tax returns released yet"
              body="When your firm releases a tax return to you, it will appear here for secure viewing."
            />
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
              {taxReturns.slice(0, 3).map((r) => (
                <li
                  key={r.returnId}
                  style={{
                    padding: tokens.space.md,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    background: tokens.color.bg,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  <div>
                    <Link
                      to={`/tax/returns/${r.returnId}`}
                      style={{ color: tokens.color.accent, fontWeight: 500, fontSize: 14 }}
                    >
                      {r.taxYear} {r.formCode} — {r.jurisdiction}
                    </Link>
                    <div style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 2 }}>
                      Released {new Date(r.releasedAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    {r.releaseKind === 'AMENDED' && <Pill tone="warning">Amended</Pill>}
                    <Pill tone={r.scope === 'FULL' ? 'success' : 'neutral'}>
                      {r.scope === 'FULL' ? 'Full return' : 'Selected'}
                    </Pill>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section>
        <SectionHeading
          title="Upcoming tax payments"
          action={
            upcomingTax.length > 0 ? (
              <Link to="/tax-payments" style={{ color: tokens.color.accent, fontSize: 13 }}>
                View all →
              </Link>
            ) : undefined
          }
        />
        <Card>
          {!loaded ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
          ) : upcomingTax.length === 0 ? (
            <EmptyState
              icon="📅"
              title="No scheduled tax payments"
              body="Your firm has not entered any upcoming tax obligations. If you expect one, reach out to them directly."
            />
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
              {upcomingTax.map((tp) => (
                <li
                  key={tp.id}
                  style={{
                    padding: tokens.space.md,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    background: tokens.color.bg,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 500, fontSize: 14 }}>{tp.jurisdiction}</div>
                    <div style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 2 }}>
                      {tp.paymentType} · due {tp.dueDate}
                    </div>
                  </div>
                  <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
                    {formatCents(tp.amountCents)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}

// 0222 — one tappable action-item row on the dashboard.
function AttentionRow({
  icon,
  label,
  to,
}: {
  icon: string;
  label: string;
  to: string;
}): JSX.Element {
  return (
    <Link
      to={to}
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        padding: '12px 14px',
        border: `1px solid ${tokens.color.accent}`,
        background: tokens.color.accentMuted,
        borderRadius: tokens.radius.md,
        textDecoration: 'none',
        color: tokens.color.text,
        fontSize: 14,
        fontWeight: 500,
      }}
    >
      <span aria-hidden style={{ fontSize: 18 }}>
        {icon}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      <span style={{ color: tokens.color.accent }}>→</span>
    </Link>
  );
}
