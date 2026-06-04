// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R3 — Client portal retainer offer page. The biller-generated offer
// link drops the user here. Renders Tier 1 (default) + Tier 2
// (upgrade) cards, a "how it works" section, and three CTAs. Expired
// or already-purchased offers render a short read-only view.

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { Button, Card, Pill, tokens, useIsNarrow } from '@vibe/ui';

import { api } from '../api-client';

interface OfferRow {
  id: string;
  status: 'pending' | 'pending_payment' | 'purchased' | 'declined' | 'expired';
  returnType: string;
  taxYear: number;
  prepFeeBasisCents: number;
  tier1PriceCents: number;
  tier2PriceCents: number;
  offerExpiresAt: string;
  purchasedTier: 'TIER_1' | 'TIER_2' | null;
  purchasedInvoiceId: string | null;
}

export function RetainerOfferPage(): JSX.Element {
  const narrow = useIsNarrow();
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [offer, setOffer] = useState<OfferRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<'TIER_1' | 'TIER_2' | 'DECLINE' | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ offer: OfferRow }>(`/api/portal/retainer-offers/${params.id}`);
        setOffer(r.offer);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'load failed');
      }
    })();
  }, [params.id]);

  async function select(tier: 'TIER_1' | 'TIER_2'): Promise<void> {
    if (!offer) return;
    setSubmitting(tier);
    setError(null);
    try {
      const r = await api<{ invoiceId: string }>(`/api/portal/retainer-offers/${offer.id}/select`, {
        method: 'POST',
        body: JSON.stringify({ tier }),
      });
      navigate(`/invoices/${r.invoiceId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'select failed');
      setSubmitting(null);
    }
  }

  async function decline(): Promise<void> {
    if (!offer) return;
    setSubmitting('DECLINE');
    setError(null);
    try {
      await api(`/api/portal/retainer-offers/${offer.id}/decline`, { method: 'POST' });
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'decline failed');
      setSubmitting(null);
    }
  }

  if (!offer && !error) {
    return <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>;
  }
  if (error || !offer) {
    return (
      <Card title="Retainer offer">
        <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>
      </Card>
    );
  }

  const expiresAt = new Date(offer.offerExpiresAt);
  const now = new Date();
  const daysLeft = Math.max(
    0,
    Math.ceil((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
  );
  const isExpired = offer.status === 'expired' || expiresAt < now;
  const isPurchased = offer.status === 'purchased' || offer.status === 'pending_payment';
  const isDeclined = offer.status === 'declined';

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 880 }}>
      <Card>
        <h1 style={{ fontSize: 24, margin: '0 0 8px 0' }}>
          Protect your TY{offer.taxYear} {offer.returnType} return
        </h1>
        <p style={{ fontSize: 14, color: tokens.color.textMuted, margin: 0 }}>
          A retainer prepays a set number of hours your accountant can apply to questions,
          revisions, and follow-up work after your return is filed. Unused hours expire 3 years
          after the original due date.
        </p>
        {!isExpired && !isPurchased && !isDeclined && (
          <p style={{ fontSize: 13, marginTop: 12 }}>
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
            You selected {offer.purchasedTier === 'TIER_1' ? 'Standard' : 'Premium'} —{' '}
            {offer.status === 'pending_payment' ? 'pending payment' : 'active'}
          </Pill>
        )}
        {isDeclined && <Pill tone="neutral">You declined this offer</Pill>}
      </Card>

      {!isExpired && !isPurchased && !isDeclined && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: narrow ? '1fr' : '1fr 1fr',
            gap: 16,
          }}
        >
          <TierCard
            label="Standard"
            badge="DEFAULT"
            priceCents={offer.tier1PriceCents}
            tier="TIER_1"
            onSelect={() => void select('TIER_1')}
            submitting={submitting === 'TIER_1'}
            disabled={submitting !== null}
          />
          <TierCard
            label="Premium"
            badge="UPGRADE"
            priceCents={offer.tier2PriceCents}
            tier="TIER_2"
            onSelect={() => void select('TIER_2')}
            submitting={submitting === 'TIER_2'}
            disabled={submitting !== null}
          />
        </div>
      )}

      {!isExpired && !isPurchased && !isDeclined && (
        <Card title="How it works">
          <ol style={{ fontSize: 13, paddingLeft: 18, marginTop: 0, lineHeight: 1.6 }}>
            <li>
              Pick a tier — Standard covers common follow-up work; Premium adds time for amendments
              or audit support.
            </li>
            <li>Pay the retainer invoice we issue when you select.</li>
            <li>
              Hours debit automatically as your accountant does work for you. We&apos;ll let you
              know when you&apos;re running low.
            </li>
            <li>Unused hours expire 3 years from the original return due date.</li>
          </ol>
          <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              type="button"
              variant="ghost"
              onClick={() => void decline()}
              disabled={submitting !== null}
            >
              {submitting === 'DECLINE' ? 'Declining…' : 'No thanks'}
            </Button>
          </div>
        </Card>
      )}

      {isPurchased && offer.purchasedInvoiceId && (
        <Card title="Next steps">
          <p style={{ fontSize: 13, margin: 0 }}>
            Your retainer purchase invoice has been issued.{' '}
            <a
              href={`/invoices/${offer.purchasedInvoiceId}`}
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

function TierCard({
  label,
  badge,
  priceCents,
  tier,
  onSelect,
  submitting,
  disabled,
}: {
  label: string;
  badge: string;
  priceCents: number;
  tier: 'TIER_1' | 'TIER_2';
  onSelect: () => void;
  submitting: boolean;
  disabled: boolean;
}): JSX.Element {
  return (
    <div
      style={{
        border: `1px solid ${tier === 'TIER_2' ? tokens.color.accent : tokens.color.border}`,
        borderRadius: tokens.radius.md,
        padding: 20,
        display: 'grid',
        gap: 12,
        background: tokens.color.surface,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong style={{ fontSize: 18 }}>{label}</strong>
        <Pill tone={tier === 'TIER_2' ? 'accent' : 'neutral'}>{badge}</Pill>
      </div>
      <div style={{ fontSize: 28, fontWeight: 600 }}>${(priceCents / 100).toFixed(2)}</div>
      <Button type="button" onClick={onSelect} disabled={disabled}>
        {submitting
          ? 'Loading…'
          : tier === 'TIER_1'
            ? 'Add Standard Coverage'
            : 'Upgrade to Premium'}
      </Button>
    </div>
  );
}
