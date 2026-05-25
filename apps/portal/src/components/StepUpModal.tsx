// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P4.5 — Portal step-up challenge dialog. Opens when the api-client
// intercepts a 403 step_up_required from the server. Lets the user
// pick a challenge type (email-otp / sms-otp), receive a code, and
// verify. On success the original request can be retried by the
// caller — this modal does not retry automatically because the
// originating call may not be idempotent.

import { useEffect, useState } from 'react';

import { Button, tokens } from '@vibe/ui';

import { api } from '../api-client';

type ChallengeType = 'email-otp' | 'sms-otp';

interface IssueResponse {
  challengeId: string;
  channel: 'EMAIL' | 'SMS' | null;
  sentTo: string | null;
  expiresAt: string;
}

const TCPA_CONSENT_VERSION = 'v1';
const TCPA_CONSENT_TEXT =
  'You agree to receive automated text messages from your firm for ' +
  'verification, billing, and account notices. Message and data rates ' +
  'may apply. Reply STOP to opt out.';

export function StepUpModal(): JSX.Element | null {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (): void => setOpen(true);
    window.addEventListener('portal:step-up-required', handler);
    return () => window.removeEventListener('portal:step-up-required', handler);
  }, []);

  if (!open) return null;
  return <StepUpDialog onClose={() => setOpen(false)} />;
}

function StepUpDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [type, setType] = useState<ChallengeType>('email-otp');
  const [challenge, setChallenge] = useState<IssueResponse | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function issue(): Promise<void> {
    setErr(null);
    setBusy(true);
    try {
      const r = await api<IssueResponse>('/api/portal/step-up/issue', {
        method: 'POST',
        body: JSON.stringify({ type, reason: 'sensitive-action' }),
      });
      setChallenge(r);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'issue failed';
      if (msg === 'sms_consent_required') {
        setErr('SMS verification is unavailable until you confirm consent in account settings.');
      } else if (msg === 'challenge_type_not_configured') {
        setErr('This challenge type is not yet available on this appliance.');
      } else {
        setErr(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  async function verify(): Promise<void> {
    if (!challenge) return;
    setErr(null);
    setBusy(true);
    try {
      await api('/api/portal/step-up/verify', {
        method: 'POST',
        body: JSON.stringify({ challengeId: challenge.challengeId, value: code }),
      });
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'verify failed';
      if (msg === 'step_up_locked_out') {
        setErr('Too many failed attempts. Please wait 30 minutes before trying again.');
      } else {
        setErr(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 1000,
      }}
    >
      <div
        style={{
          width: 'min(420px, 90vw)',
          background: tokens.color.surface,
          color: tokens.color.text,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          padding: 20,
          display: 'grid',
          gap: 12,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>Additional verification needed</h2>
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          For your security this action requires a fresh verification code. Pick a delivery method
          and enter the code we send.
        </p>

        {!challenge ? (
          <>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
              Delivery method
              <select
                value={type}
                onChange={(e) => setType(e.target.value as ChallengeType)}
                style={{
                  padding: '8px 10px',
                  fontSize: 13,
                  background: tokens.color.bg,
                  color: tokens.color.text,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                }}
              >
                <option value="email-otp">Email me a code</option>
                <option value="sms-otp">Text me a code</option>
              </select>
            </label>
            {type === 'sms-otp' && (
              <p
                style={{
                  fontSize: 11,
                  color: tokens.color.textMuted,
                  margin: 0,
                  padding: 8,
                  background: tokens.color.bg,
                  borderRadius: tokens.radius.sm,
                  border: `1px solid ${tokens.color.border}`,
                }}
              >
                {TCPA_CONSENT_TEXT}
              </p>
            )}
            {err && <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }}>{err}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="button" onClick={issue} disabled={busy}>
                {busy ? 'Sending…' : 'Send code'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, margin: 0 }}>
              We sent a code to <strong>{challenge.sentTo ?? 'your contact'}</strong>.
            </p>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
              6-digit code
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\s+/g, ''))}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={10}
                style={{
                  padding: '8px 10px',
                  fontSize: 16,
                  letterSpacing: 4,
                  textAlign: 'center',
                  background: tokens.color.bg,
                  color: tokens.color.text,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                }}
              />
            </label>
            {err && <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }}>{err}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
              <Button type="button" variant="ghost" onClick={() => setChallenge(null)}>
                Use a different method
              </Button>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button type="button" variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="button" onClick={verify} disabled={busy || code.length < 4}>
                  {busy ? 'Verifying…' : 'Verify'}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Exported so the SMS consent text + version can be used by the
// phone-verify flow (P4.3 — H.5) where the user first records consent.
export const PORTAL_TCPA_CONSENT = {
  text: TCPA_CONSENT_TEXT,
  version: TCPA_CONSENT_VERSION,
};
