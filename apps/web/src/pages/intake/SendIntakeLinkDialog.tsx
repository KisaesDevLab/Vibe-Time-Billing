// SPDX-License-Identifier: Elastic-2.0
//
// "Send a link" dialog — generates a tokenized intake link bound to a staff
// member, optionally emailing/texting it to a recipient. Shows the URL so
// staff can copy it regardless of delivery.

import { useEffect, useState } from 'react';

import { Button, tokens } from '@vibe/ui';

import { api, type ApiError } from '../../api-client';

interface StaffOpt {
  id: string;
  name: string;
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: 8,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  fontSize: 14,
};

export function SendIntakeLinkDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [staff, setStaff] = useState<StaffOpt[]>([]);
  const [targetStaffId, setTargetStaffId] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(14);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; delivered: boolean } | null>(null);

  useEffect(() => {
    void api<{ staff: StaffOpt[] }>('/api/staff/intake/staff-options')
      .then((r) => {
        setStaff(r.staff);
        if (r.staff[0]) setTargetStaffId(r.staff[0].id);
      })
      .catch((err: ApiError) => setError(err.message));
  }, []);

  async function submit(): Promise<void> {
    if (!targetStaffId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ url: string; delivered: boolean }>('/api/staff/intake/links', {
        method: 'POST',
        body: JSON.stringify({
          targetStaffId,
          recipientEmail: email.trim() || undefined,
          recipientPhone: phone.trim() || undefined,
          expiresInDays,
        }),
      });
      setResult(r);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Send an intake link"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 60,
      }}
    >
      <div
        style={{
          background: tokens.color.surface,
          borderRadius: tokens.radius.md,
          padding: 20,
          width: 'min(480px, 92vw)',
        }}
      >
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>Send a secure upload link</h3>
        {result ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <p style={{ fontSize: 13, margin: 0 }}>
              {result.delivered ? 'Link sent.' : 'Link created.'} Share this URL:
            </p>
            <code
              style={{
                display: 'block',
                padding: 8,
                background: tokens.color.bg,
                borderRadius: tokens.radius.sm,
                fontSize: 12,
                wordBreak: 'break-all',
              }}
            >
              {result.url}
            </code>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button onClick={onClose}>Done</Button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <span style={{ fontSize: 12, color: tokens.color.textMuted }}>Send on behalf of</span>
              <select
                style={inputStyle}
                value={targetStaffId}
                onChange={(e) => setTargetStaffId(e.target.value)}
              >
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <span style={{ fontSize: 12, color: tokens.color.textMuted }}>Recipient email</span>
              <input
                style={inputStyle}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <span style={{ fontSize: 12, color: tokens.color.textMuted }}>Recipient phone</span>
              <input
                style={inputStyle}
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
            <div>
              <span style={{ fontSize: 12, color: tokens.color.textMuted }}>Expires in</span>
              <select
                style={inputStyle}
                value={String(expiresInDays)}
                onChange={(e) => setExpiresInDays(Number(e.target.value))}
              >
                <option value="7">7 days</option>
                <option value="14">14 days</option>
                <option value="30">30 days</option>
              </select>
            </div>
            {error && <div style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={() => void submit()} disabled={busy || !targetStaffId}>
                {busy ? 'Creating…' : 'Create link'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
