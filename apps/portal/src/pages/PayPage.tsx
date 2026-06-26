// SPDX-License-Identifier: Elastic-2.0
//
// 0181 — public pay-by-link landing page (…/pay/:token). No portal auth:
// the token in the URL is the credential. Calls GET /api/pay/:token for a
// safe summary, then POST /api/pay/:token/checkout to open a Stripe-hosted
// Checkout Session (we redirect the browser to it). The success_url returns
// to …/pay/:token/done, where we poll GET /api/pay/:token/status until the
// webhook records the payment — the redirect itself is NOT proof of payment.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useLocation } from 'react-router-dom';

import { Button, Card, Pill, tokens } from '@vibe/ui';

interface PayFirm {
  name: string;
  logoUrl: string | null;
  accentColor: string | null;
}

interface PayMeta {
  invoiceNumber: string;
  balanceCents: number;
  dueDate: string | null;
  invoiceStatus: string;
  clientName: string;
  firm: PayFirm;
  // 'payable' | 'no_balance' | 'paid' | 'expired' | 'voided'
  state: string;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function PayPage(): JSX.Element {
  const { token } = useParams<{ token: string }>();
  const isDone = useLocation().pathname.endsWith('/done');
  const [meta, setMeta] = useState<PayMeta | null>(null);
  const [pageError, setPageError] = useState<'not_found' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const [stillProcessing, setStillProcessing] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const base = `/api/pay/${encodeURIComponent(token ?? '')}`;

  const loadMeta = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(base, { credentials: 'same-origin' });
      if (!res.ok) {
        setPageError('not_found');
        return;
      }
      setMeta((await res.json()) as PayMeta);
    } catch {
      setPageError('failed');
    }
  }, [base]);

  useEffect(() => {
    if (!token) return;
    void loadMeta();
  }, [token, loadMeta]);

  // Done page: poll the link status until the webhook flips it to PAID.
  useEffect(() => {
    if (!isDone || !token) return;
    let attempts = 0;
    const tick = async (): Promise<void> => {
      attempts += 1;
      try {
        const res = await fetch(`${base}/status`, { credentials: 'same-origin' });
        if (res.ok) {
          const body = (await res.json()) as { status: string };
          if (body.status === 'PAID') {
            setSettled(true);
            if (pollTimer.current) clearInterval(pollTimer.current);
            return;
          }
        }
      } catch {
        // transient; keep polling
      }
      if (attempts >= 15 && pollTimer.current) {
        // ~30s elapsed and still not settled — show a soft "processing" note.
        clearInterval(pollTimer.current);
        setStillProcessing(true);
      }
    };
    void tick();
    pollTimer.current = setInterval(() => void tick(), 2000);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [isDone, token, base]);

  async function startCheckout(): Promise<void> {
    setBusy(true);
    setCheckoutError(null);
    try {
      const res = await fetch(`${base}/checkout`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = (await res.json()) as { url?: string; error?: string };
      if (res.ok && body.url) {
        window.location.assign(body.url);
        return;
      }
      if (body.error === 'no_payment_provider_configured') {
        setCheckoutError('Online payment is not available right now. Please contact us to pay.');
      } else if (body.error === 'link_not_payable' || body.error === 'invoice_not_payable') {
        setCheckoutError('This invoice can no longer be paid online. Please contact us.');
      } else {
        setCheckoutError('We could not start the payment. Please try again.');
      }
    } catch {
      setCheckoutError('We could not start the payment. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const accent = meta?.firm.accentColor ?? tokens.color.accent;
  const firmLabel = meta?.firm.name || 'Secure payment';

  const shell = (children: JSX.Element): JSX.Element => (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: tokens.space.lg }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 0',
          marginBottom: tokens.space.md,
          borderBottom: `2px solid ${accent}`,
        }}
      >
        {meta?.firm.logoUrl && (
          <img src={meta.firm.logoUrl} alt="" style={{ height: 28, maxWidth: 140 }} />
        )}
        <span style={{ fontSize: 16, fontWeight: 600, color: tokens.color.text }}>{firmLabel}</span>
        <span style={{ marginLeft: 'auto' }}>
          <Pill tone="accent">secure payment</Pill>
        </span>
      </div>
      {children}
    </div>
  );

  if (pageError) {
    return shell(
      <Card title="Link unavailable">
        <p style={{ fontSize: 14, color: tokens.color.textMuted }}>
          This payment link is invalid or has expired. Please contact us for a new link.
        </p>
      </Card>,
    );
  }
  if (!meta) {
    return shell(
      <Card title="Loading…">
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>One moment.</p>
      </Card>,
    );
  }

  // ---- Post-redirect "done" page. ----
  if (isDone) {
    if (settled) {
      return shell(
        <Card title="Payment received">
          <p style={{ fontSize: 14, color: tokens.color.text }}>
            Thank you — your payment for invoice <strong>{meta.invoiceNumber}</strong> has been
            received. A receipt will follow by email.
          </p>
        </Card>,
      );
    }
    return shell(
      <Card title="Processing your payment…">
        <p style={{ fontSize: 14, color: tokens.color.textMuted }}>
          We&apos;re confirming your payment for invoice <strong>{meta.invoiceNumber}</strong>. This
          usually takes a few seconds.
        </p>
        {stillProcessing && (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
            Still working — you can safely close this page. If your card was charged, your payment
            will be recorded shortly and a receipt will be emailed to you.
          </p>
        )}
      </Card>,
    );
  }

  // ---- Already settled (paid / no balance). ----
  if (meta.state === 'paid' || meta.state === 'no_balance') {
    return shell(
      <Card title="Invoice paid">
        <p style={{ fontSize: 14, color: tokens.color.text }}>
          Invoice <strong>{meta.invoiceNumber}</strong> has no balance due. Thank you!
        </p>
      </Card>,
    );
  }
  if (meta.state === 'expired' || meta.state === 'voided') {
    return shell(
      <Card title="Link unavailable">
        <p style={{ fontSize: 14, color: tokens.color.textMuted }}>
          This payment link is no longer active. Please contact us for a new link.
        </p>
      </Card>,
    );
  }

  // ---- Payable. ----
  const dueLine = meta.dueDate
    ? `Due ${new Date(meta.dueDate).toLocaleDateString()}`
    : 'Payment requested';

  return shell(
    <Card title={`Pay invoice ${meta.invoiceNumber}`}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <Pill tone="neutral">{dueLine}</Pill>
        {meta.clientName && <Pill tone="accent">{meta.clientName}</Pill>}
      </div>
      <p style={{ fontSize: 14, color: tokens.color.text, marginTop: 0 }}>
        Balance due:{' '}
        <strong style={{ fontSize: 22, color: tokens.color.text }}>
          {dollars(meta.balanceCents)}
        </strong>
      </p>
      <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
        You&apos;ll be taken to our secure payment processor to complete your payment. No account or
        login is required.
      </p>
      <div style={{ display: 'grid', gap: 8, maxWidth: 320 }}>
        <Button onClick={() => void startCheckout()} disabled={busy}>
          {busy ? 'Starting…' : `Pay ${dollars(meta.balanceCents)}`}
        </Button>
        {checkoutError && (
          <p style={{ fontSize: 12, color: tokens.color.danger, margin: 0 }}>{checkoutError}</p>
        )}
      </div>
    </Card>,
  );
}
