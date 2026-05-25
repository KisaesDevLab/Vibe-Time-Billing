// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
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

interface InvoiceSummary {
  id: string;
  invoiceNumber: string;
  dueDate: string;
  totalCents: number;
  paidCents: number;
}

const formatCents = (c: number): string =>
  `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function HomePage(): JSX.Element {
  const { me } = useAuth();
  const [openInvoices, setOpenInvoices] = useState<InvoiceSummary[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ open: InvoiceSummary[] }>('/api/portal/invoices');
        setOpenInvoices(r.open ?? []);
      } catch {
        // best-effort — empty state handles failure gracefully
      } finally {
        setLoaded(true);
      }
    })();
  }, [me?.activeClientId]);

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
          title="Upcoming tax payments"
          action={<Pill tone="neutral">coming soon</Pill>}
        />
        <Card>
          <EmptyState
            icon="📅"
            title="Tax payments unlock soon"
            body="Once your firm enters scheduled tax obligations, they'll appear here with due dates and reminders."
          />
        </Card>
      </section>
    </div>
  );
}
