// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0102 — staff "Share file" dialog. Securely share a file with an outside
// recipient: emailed, expiring, revocable link with view/download control
// and optional PDF watermark. POSTs /api/staff/files/:id/share.

import { useEffect, useState } from 'react';

import { tokens } from '@vibe/ui';

import { api, type ApiError } from '../../api-client';

interface FileLite {
  id: string;
  originalFilename: string;
  mimeType: string | null;
}

interface Props {
  file: FileLite;
  onClose: () => void;
  onShared: () => void;
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: tokens.color.textMuted,
  marginBottom: 4,
};
const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: 8,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  fontSize: 14,
};

export function ShareFileDialog({ file, onClose, onShared }: Props): JSX.Element {
  // Detect PDF by mime type, falling back to the filename extension —
  // some files were stored without a mime_type, which previously (wrongly)
  // disabled the PDF-only watermark option for genuine PDFs.
  const isPdf =
    (file.mimeType ?? '').toLowerCase().includes('pdf') ||
    file.originalFilename.toLowerCase().endsWith('.pdf');
  const [recipientName, setRecipientName] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [organization, setOrganization] = useState('');
  const [accessLevel, setAccessLevel] = useState<'view' | 'download'>('view');
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [watermark, setWatermark] = useState(isPdf);
  const [personalMessage, setPersonalMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ email: string } | null>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, busy]);

  async function submit(): Promise<void> {
    if (!recipientEmail.trim()) {
      setError('Recipient email is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/files/${file.id}/share`, {
        method: 'POST',
        body: JSON.stringify({
          recipientName: recipientName.trim() || undefined,
          recipientEmail: recipientEmail.trim(),
          organization: organization.trim() || undefined,
          accessLevel,
          expiresInDays,
          watermark: watermark && isPdf,
          personalMessage: personalMessage.trim() || undefined,
        }),
      });
      setDone({ email: recipientEmail.trim() });
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
      aria-label="Share file"
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
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        disabled={busy}
        style={{ position: 'absolute', inset: 0, background: 'transparent', border: 'none' }}
      />
      <div
        style={{
          background: tokens.color.surface,
          borderRadius: tokens.radius.md,
          padding: 20,
          width: 'min(520px, 92vw)',
          maxHeight: '90vh',
          overflowY: 'auto',
          boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
          position: 'relative',
          zIndex: 1,
        }}
      >
        <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>Share securely</h3>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: tokens.color.textMuted }}>
          <code>{file.originalFilename}</code> — the recipient gets an emailed, expiring link.
        </p>

        {done ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <div
              style={{
                padding: 10,
                background: '#e6f6ec',
                borderRadius: tokens.radius.sm,
                fontSize: 13,
              }}
            >
              Secure link sent to <strong>{done.email}</strong>. It expires in {expiresInDays} days
              and can be revoked anytime.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => {
                  onShared();
                }}
                style={{
                  padding: '6px 12px',
                  background: tokens.color.accent,
                  color: 'white',
                  border: 'none',
                  borderRadius: tokens.radius.sm,
                }}
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <span style={labelStyle}>Recipient email *</span>
              <input
                style={inputStyle}
                type="email"
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
                placeholder="recipient@example.com"
              />
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <span style={labelStyle}>Recipient name</span>
                <input
                  style={inputStyle}
                  value={recipientName}
                  onChange={(e) => setRecipientName(e.target.value)}
                />
              </div>
              <div style={{ flex: 1 }}>
                <span style={labelStyle}>Organization</span>
                <input
                  style={inputStyle}
                  value={organization}
                  onChange={(e) => setOrganization(e.target.value)}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <span style={labelStyle}>Access</span>
                <select
                  style={inputStyle}
                  value={accessLevel}
                  onChange={(e) => setAccessLevel(e.target.value as 'view' | 'download')}
                >
                  <option value="view">View only</option>
                  <option value="download">View &amp; download</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <span style={labelStyle}>Expires in</span>
                <select
                  style={inputStyle}
                  value={String(expiresInDays)}
                  onChange={(e) => setExpiresInDays(Number(e.target.value))}
                >
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                </select>
              </div>
            </div>
            <label
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                fontSize: 13,
                color: isPdf ? tokens.color.text : tokens.color.textMuted,
              }}
            >
              <input
                type="checkbox"
                checked={watermark && isPdf}
                disabled={!isPdf}
                onChange={(e) => setWatermark(e.target.checked)}
              />
              Watermark with recipient name {isPdf ? '' : '(PDFs only)'}
            </label>
            <div>
              <span style={labelStyle}>Message (optional)</span>
              <textarea
                style={{ ...inputStyle, minHeight: 56, resize: 'vertical' }}
                value={personalMessage}
                onChange={(e) => setPersonalMessage(e.target.value)}
              />
            </div>
            {error && <div style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                style={{
                  padding: '6px 12px',
                  background: 'transparent',
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy || !recipientEmail.trim()}
                style={{
                  padding: '6px 12px',
                  background: tokens.color.accent,
                  color: 'white',
                  border: 'none',
                  borderRadius: tokens.radius.sm,
                }}
              >
                {busy ? 'Sending…' : 'Send secure link'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
