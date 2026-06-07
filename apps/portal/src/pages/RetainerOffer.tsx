// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R3 / hybrid — Client portal retainer offer, presented as a proposal-style
// document. Three options: tax return only / + Standard / + Premium. Once the
// return invoice is paid, the "return only" option drops and the retainer cards
// show the add-on price. Client can pay online or choose to pay at the office;
// a printable handout (PDF) is available. Engine underneath is the retainer
// module (select → retainer invoice → pay online or office → activation).

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { Button, Card, Markdown, Pill, tokens, useIsNarrow } from '@vibe/ui';

import { api } from '../api-client';

type Tier = 'TIER_1' | 'TIER_2';

interface TierView {
  tier: Tier;
  name: string;
  description: string | null;
  hours: number;
  retainerPriceCents: number;
  bundledPriceCents: number;
}
interface Presentation {
  offer: {
    id: string;
    status: 'pending' | 'pending_payment' | 'purchased' | 'declined' | 'expired';
    returnType: string;
    taxYear: number;
    offerExpiresAt: string;
    purchasedTier: Tier | null;
    purchasedInvoiceId: string | null;
  };
  returnInvoice: {
    id: string;
    totalCents: number;
    paidCents: number;
    status: string;
    returnPaid: boolean;
  };
  tiers: TierView[];
  branding: { firmName: string; logoUrl: string | null; accentColor: string | null };
  client: { name: string };
  introMd: string | null;
  termsMd: string | null;
}

type Choice = 'RETURN_ONLY' | Tier;

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function RetainerOfferPage(): JSX.Element {
  const narrow = useIsNarrow();
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [p, setP] = useState<Presentation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [officeDone, setOfficeDone] = useState<{ tier: Tier; invoiceNumber: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ presentation: Presentation }>(
          `/api/portal/retainer-offers/${params.id}`,
        );
        setP(r.presentation);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'load failed');
      }
    })();
  }, [params.id]);

  async function selectTier(tier: Tier): Promise<{ invoiceId: string; invoiceNumber: string }> {
    return api<{ invoiceId: string; invoiceNumber: string }>(
      `/api/portal/retainer-offers/${p!.offer.id}/select`,
      { method: 'POST', body: JSON.stringify({ tier }) },
    );
  }

  async function payOnline(): Promise<void> {
    if (!p || !choice) return;
    setSubmitting(true);
    setError(null);
    try {
      if (choice === 'RETURN_ONLY') {
        navigate(`/invoices/${p.returnInvoice.id}`);
        return;
      }
      const r = await selectTier(choice);
      navigate(`/invoices/${r.invoiceId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'select failed');
      setSubmitting(false);
    }
  }

  async function payAtOffice(): Promise<void> {
    if (!p || !choice) return;
    setSubmitting(true);
    setError(null);
    try {
      if (choice === 'RETURN_ONLY') {
        // Nothing to reserve — the return invoice already exists; just confirm.
        setOfficeDone({ tier: 'TIER_1', invoiceNumber: '' });
        return;
      }
      const r = await selectTier(choice);
      setOfficeDone({ tier: choice, invoiceNumber: r.invoiceNumber });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'select failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function decline(): Promise<void> {
    if (!p) return;
    setSubmitting(true);
    setError(null);
    try {
      await api(`/api/portal/retainer-offers/${p.offer.id}/decline`, { method: 'POST' });
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'decline failed');
      setSubmitting(false);
    }
  }

  if (!p && !error) {
    return <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>;
  }
  if (error || !p) {
    return (
      <Card title="Tax representation offer">
        <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>
      </Card>
    );
  }

  const expiresAt = new Date(p.offer.offerExpiresAt);
  const now = new Date();
  const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / 86_400_000));
  const isExpired = p.offer.status === 'expired' || expiresAt < now;
  const isPurchased = p.offer.status === 'purchased' || p.offer.status === 'pending_payment';
  const isDeclined = p.offer.status === 'declined';
  const open = !isExpired && !isPurchased && !isDeclined;
  const returnPaid = p.returnInvoice.returnPaid;
  const printUrl = `/api/portal/retainer-offers/${p.offer.id}/print.html`;

  // Build the cards: return-only (unless paid) + the retainer tiers.
  const cards: {
    key: Choice;
    title: string;
    priceCents: number;
    sub?: string;
    body?: JSX.Element;
  }[] = [];
  if (!returnPaid) {
    cards.push({
      key: 'RETURN_ONLY',
      title: 'Tax return only',
      priceCents: p.returnInvoice.totalCents,
      sub: `Preparation & filing of your TY${p.offer.taxYear} ${p.offer.returnType} return.`,
    });
  }
  for (const t of p.tiers) {
    cards.push({
      key: t.tier,
      title: returnPaid ? `${t.name} representation` : `Tax return + ${t.name}`,
      priceCents: returnPaid ? t.retainerPriceCents : t.bundledPriceCents,
      sub: `${t.hours} prepaid representation hour${t.hours === 1 ? '' : 's'} for IRS/state notices & audits.${returnPaid ? ' Add-on to your paid return.' : ''}`,
      body: t.description ? <Markdown source={t.description} /> : undefined,
    });
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 920 }}>
      <Card>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div>
            <h1 style={{ fontSize: 24, margin: '0 0 4px' }}>Tax Representation Retainer</h1>
            <div style={{ fontSize: 13, color: tokens.color.textMuted }}>
              {p.branding.firmName} · TY{p.offer.taxYear} {p.offer.returnType} · Prepared for{' '}
              {p.client.name}
            </div>
          </div>
          <Button type="button" variant="ghost" onClick={() => window.open(printUrl, '_blank')}>
            Print / Download PDF
          </Button>
        </div>
        {p.introMd && (
          <div style={{ fontSize: 14, marginTop: 12 }}>
            <Markdown source={p.introMd} />
          </div>
        )}
        {open && (
          <p style={{ fontSize: 13, marginTop: 12, marginBottom: 0 }}>
            <strong>
              Offer expires in {daysLeft} day{daysLeft === 1 ? '' : 's'}
            </strong>{' '}
            ({expiresAt.toLocaleDateString()})
          </p>
        )}
        {isExpired && (
          <Pill tone="warning">This offer expired on {expiresAt.toLocaleDateString()}</Pill>
        )}
        {isPurchased && (
          <Pill tone="success">
            You selected {p.offer.purchasedTier === 'TIER_2' ? 'Premium' : 'Standard'} —{' '}
            {p.offer.status === 'pending_payment' ? 'pending payment' : 'active'}
          </Pill>
        )}
        {isDeclined && <Pill tone="neutral">You declined this offer</Pill>}
      </Card>

      {open && (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: narrow ? '1fr' : `repeat(${cards.length}, 1fr)`,
              gap: 14,
              alignItems: 'start',
            }}
          >
            {cards.map((c) => {
              const selected = choice === c.key;
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setChoice(c.key)}
                  aria-pressed={selected}
                  style={{
                    textAlign: 'left',
                    cursor: 'pointer',
                    border: `${selected ? 2 : 1}px solid ${selected ? tokens.color.accent : tokens.color.border}`,
                    borderRadius: tokens.radius.md,
                    padding: 18,
                    background: selected ? 'rgba(67,56,202,0.04)' : tokens.color.surface,
                    display: 'grid',
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <strong style={{ fontSize: 16 }}>{c.title}</strong>
                    {selected && <Pill tone="accent">Selected</Pill>}
                  </div>
                  <div style={{ fontSize: 26, fontWeight: 700 }}>{money(c.priceCents)}</div>
                  {c.sub && (
                    <div style={{ fontSize: 12, color: tokens.color.textMuted }}>{c.sub}</div>
                  )}
                  {c.body && <div style={{ fontSize: 13 }}>{c.body}</div>}
                </button>
              );
            })}
          </div>

          {officeDone ? (
            <Card title="Bring this to our office">
              <p style={{ fontSize: 14, margin: 0 }}>
                {officeDone.invoiceNumber
                  ? `Your selection is reserved (invoice ${officeDone.invoiceNumber}). `
                  : ''}
                Stop by the office to pay by cash or check, or pay online anytime from your
                invoices. Your representation coverage activates as soon as payment is received.
              </p>
            </Card>
          ) : (
            <Card>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <Button
                  type="button"
                  onClick={() => void payOnline()}
                  disabled={!choice || submitting}
                >
                  {submitting ? 'Working…' : 'Pay online now'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void payAtOffice()}
                  disabled={!choice || submitting}
                >
                  I&apos;ll pay at the office
                </Button>
                <span style={{ flex: 1 }} />
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void decline()}
                  disabled={submitting}
                >
                  No thanks
                </Button>
              </div>
              {!choice && (
                <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '8px 0 0' }}>
                  Select an option above to continue.
                </p>
              )}
              {error && (
                <p style={{ fontSize: 12, color: tokens.color.danger, margin: '8px 0 0' }}>
                  {error}
                </p>
              )}
            </Card>
          )}
        </>
      )}

      {p.termsMd && (
        <Card title="Representation terms">
          <div style={{ fontSize: 13 }}>
            <Markdown source={p.termsMd} />
          </div>
        </Card>
      )}

      {isPurchased && p.offer.purchasedInvoiceId && (
        <Card title="Next steps">
          <p style={{ fontSize: 13, margin: 0 }}>
            Your retainer purchase invoice has been issued.{' '}
            <a
              href={`/invoices/${p.offer.purchasedInvoiceId}`}
              style={{ color: tokens.color.accent }}
            >
              View invoice →
            </a>
          </p>
        </Card>
      )}
    </div>
  );
}
