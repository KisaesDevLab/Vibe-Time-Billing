// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0218 — public ACH micro-deposit verification page (…/verify-bank/:token).
// No portal auth: the token in the URL is the credential (same trust model
// as /pay/:token). Calls GET /api/ach-verify/:token for a safe summary,
// then POST /api/ach-verify/:token/verify with either the two deposit
// amounts (in cents) or the 6-digit SM descriptor code from the statement.

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { Button, Card, Input, Pill, tokens } from '@vibe/ui';

interface VerifyFirm {
  name: string;
  logoUrl: string | null;
  accentColor: string | null;
}

interface VerifyMeta {
  bankLabel: string;
  lastFour: string;
  clientName: string;
  firm: VerifyFirm;
  // 'pending' | 'verified' | 'expired' | 'voided'
  state: string;
}

export function VerifyBankPage(): JSX.Element {
  const { token } = useParams<{ token: string }>();
  const [meta, setMeta] = useState<VerifyMeta | null>(null);
  const [pageError, setPageError] = useState<'not_found' | 'failed' | null>(null);
  const [mode, setMode] = useState<'amounts' | 'code'>('amounts');
  const [a0, setA0] = useState('');
  const [a1, setA1] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const base = `/api/ach-verify/${encodeURIComponent(token ?? '')}`;

  const loadMeta = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(base, { credentials: 'same-origin' });
      if (!res.ok) {
        setPageError('not_found');
        return;
      }
      setMeta((await res.json()) as VerifyMeta);
    } catch {
      setPageError('failed');
    }
  }, [base]);

  useEffect(() => {
    if (!token) return;
    void loadMeta();
  }, [token, loadMeta]);

  async function submit(): Promise<void> {
    setBusy(true);
    setVerifyError(null);
    try {
      const payload =
        mode === 'code'
          ? { descriptorCode: code.trim().toUpperCase() }
          : { amounts: [Number(a0), Number(a1)] };
      const res = await fetch(`${base}/verify`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok && body.ok) {
        setDone(true);
        return;
      }
      if (body.error === 'verification_failed') {
        setVerifyError(
          'That did not match. Double-check the amounts (in cents, e.g. 32 and 45) or the SM code on your statement. After several wrong tries the deposits are locked and your accountant will need to re-add the account.',
        );
      } else if (body.error === 'rate_limited') {
        setVerifyError('Too many attempts — please wait a few minutes and try again.');
      } else if (body.error === 'link_not_usable') {
        setVerifyError('This link is no longer active. Please contact us for a new one.');
      } else {
        setVerifyError('Something went wrong. Please try again.');
      }
    } catch {
      setVerifyError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const accent = meta?.firm.accentColor ?? tokens.color.accent;
  const firmLabel = meta?.firm.name || 'Bank verification';

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
          <Pill tone="accent">secure verification</Pill>
        </span>
      </div>
      {children}
    </div>
  );

  if (pageError) {
    return shell(
      <Card title="Link unavailable">
        <p style={{ fontSize: 14, color: tokens.color.textMuted }}>
          This verification link is invalid or has expired. Please contact us for a new link.
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

  if (done || meta.state === 'verified') {
    return shell(
      <Card title="Bank account verified ✓">
        <p style={{ fontSize: 14, color: tokens.color.text }}>
          Thank you — your bank account <strong>{meta.bankLabel}</strong> is verified and ready for
          the payment you authorized with {meta.firm.name || 'your accounting firm'}. Nothing else
          is needed from you.
        </p>
      </Card>,
    );
  }
  if (meta.state === 'expired' || meta.state === 'voided') {
    return shell(
      <Card title="Link unavailable">
        <p style={{ fontSize: 14, color: tokens.color.textMuted }}>
          This verification link is no longer active. Please contact us for a new link.
        </p>
      </Card>,
    );
  }

  // ---- Pending: the verification form. ----
  return shell(
    <Card title="Confirm your bank account">
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <Pill tone="neutral">{meta.bankLabel}</Pill>
        {meta.clientName && <Pill tone="accent">{meta.clientName}</Pill>}
      </div>
      <p style={{ fontSize: 14, color: tokens.color.text, marginTop: 0 }}>
        To confirm you own this account, our payment processor sent it a small test deposit. Find it
        on your bank statement (it arrives 1–2 business days after setup), then enter it below. No
        account or login is required.
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <Button
          size="sm"
          variant={mode === 'amounts' ? 'primary' : 'ghost'}
          onClick={() => setMode('amounts')}
        >
          Two small deposits
        </Button>
        <Button
          size="sm"
          variant={mode === 'code' ? 'primary' : 'ghost'}
          onClick={() => setMode('code')}
        >
          One deposit with an SM code
        </Button>
      </div>
      {mode === 'amounts' ? (
        <div style={{ display: 'grid', gap: 8, maxWidth: 360 }}>
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            Enter the two deposit amounts in cents — for example, $0.32 is “32”.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <Input
              placeholder="First (e.g. 32)"
              inputMode="numeric"
              value={a0}
              onChange={(e) => setA0(e.target.value.replace(/\D/g, '').slice(0, 2))}
              aria-label="First deposit amount in cents"
            />
            <Input
              placeholder="Second (e.g. 45)"
              inputMode="numeric"
              value={a1}
              onChange={(e) => setA1(e.target.value.replace(/\D/g, '').slice(0, 2))}
              aria-label="Second deposit amount in cents"
            />
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8, maxWidth: 360 }}>
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            Your statement shows one deposit with a 6-digit code starting with “SM” in its
            description.
          </p>
          <Input
            placeholder="SM1234"
            value={code}
            onChange={(e) => setCode(e.target.value.slice(0, 10))}
            aria-label="Descriptor code from your bank statement"
          />
        </div>
      )}
      <div style={{ display: 'grid', gap: 8, maxWidth: 360, marginTop: 12 }}>
        <Button
          onClick={() => void submit()}
          disabled={busy || (mode === 'amounts' ? !a0 || !a1 : code.trim().length < 4)}
        >
          {busy ? 'Verifying…' : 'Verify bank account'}
        </Button>
        {verifyError && (
          <p style={{ fontSize: 12, color: tokens.color.danger, margin: 0 }}>{verifyError}</p>
        )}
      </div>
    </Card>,
  );
}
