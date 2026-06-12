// SPDX-License-Identifier: Elastic-2.0
//
// 0154 — staff "Share selected files" dialog. Creates ONE combined,
// gated, expiring link whose landing page lists every selected file for
// the recipient to download. POSTs /api/staff/files/share-bundle.
// Mirrors the single-file ShareFileDialog form.

import { useEffect, useState } from 'react';

import { tokens } from '@vibe/ui';

import { api, type ApiError } from '../../api-client';

interface Props {
  fileIds: string[];
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

export function BulkShareDialog({ fileIds, onClose, onShared }: Props): JSX.Element {
  const [recipientName, setRecipientName] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [organization, setOrganization] = useState('');
  const [accessLevel, setAccessLevel] = useState<'view' | 'download'>('view');
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [watermark, setWatermark] = useState(false);
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
      await api('/api/staff/files/share-bundle', {
        method: 'POST',
        body: JSON.stringify({
          fileIds,
          recipientName: recipientName.trim() || undefined,
          recipientEmail: recipientEmail.trim(),
          organization: organization.trim() || undefined,
          accessLevel,
          expiresInDays,
          watermark,
          personalMessage: personalMessage.trim() || undefined,
        }),
      });
      setDone({ email: recipientEmail.trim() });
      // Brief confirmation, then close + clear selection.
      setTimeout(onShared, 1200);
    } catch (err) {
      const e = err as ApiError;
      const code = typeof e.message === 'string' ? e.message : 'share_failed';
      setError(
        code === 'rate_limited_actor'
          ? 'You have created too many shares recently. Try again later.'
          : code === 'rate_limited_recipient'
            ? 'This recipient has too many active shares. Revoke some first.'
            : code === 'mixed_clients'
              ? 'All selected files must belong to the same client.'
              : code === 'no_files'
                ? 'No shareable files selected.'
                : `Could not create the share: ${code}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Share selected files"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 70,
        zIndex: 200,
      }}
    >
      <div
        style={{
          width: 'min(560px, 92vw)',
          maxHeight: '85vh',
          overflow: 'auto',
          background: tokens.color.bg,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          padding: 20,
          display: 'grid',
          gap: 14,
        }}
      >
        <strong style={{ fontSize: 15 }}>
          Share {fileIds.length} file{fileIds.length === 1 ? '' : 's'}
        </strong>

        {done ? (
          <p style={{ fontSize: 13, color: tokens.color.success, margin: 0 }}>
            One secure link to all {fileIds.length} files was sent to {done.email}.
          </p>
        ) : (
          <>
            <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
              The recipient gets a single access-code-gated link; its landing page lists all
              selected files to view or download.
            </p>
            <div>
              <span style={labelStyle}>Recipient email *</span>
              <input
                type="email"
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
                style={inputStyle}
                placeholder="recipient@example.com"
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <span style={labelStyle}>Recipient name</span>
                <input
                  value={recipientName}
                  onChange={(e) => setRecipientName(e.target.value)}
                  style={inputStyle}
                />
              </div>
              <div>
                <span style={labelStyle}>Organization</span>
                <input
                  value={organization}
                  onChange={(e) => setOrganization(e.target.value)}
                  style={inputStyle}
                />
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <span style={labelStyle}>Access</span>
                <select
                  value={accessLevel}
                  onChange={(e) => setAccessLevel(e.target.value as 'view' | 'download')}
                  style={inputStyle}
                >
                  <option value="view">View only</option>
                  <option value="download">View &amp; download</option>
                </select>
              </div>
              <div>
                <span style={labelStyle}>Expires in (days)</span>
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(Number(e.target.value))}
                  style={inputStyle}
                />
              </div>
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={watermark}
                onChange={(e) => setWatermark(e.target.checked)}
              />
              Watermark PDFs with the recipient&apos;s email
            </label>
            <div>
              <span style={labelStyle}>Personal message (optional)</span>
              <textarea
                value={personalMessage}
                onChange={(e) => setPersonalMessage(e.target.value)}
                rows={3}
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </div>
            {error && (
              <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }} role="alert">
                {error}
              </p>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                style={{
                  padding: '8px 14px',
                  borderRadius: tokens.radius.sm,
                  border: `1px solid ${tokens.color.border}`,
                  background: 'transparent',
                  color: tokens.color.text,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy}
                style={{
                  padding: '8px 14px',
                  borderRadius: tokens.radius.sm,
                  border: 'none',
                  background: tokens.color.accent,
                  color: '#fff',
                  cursor: 'pointer',
                }}
              >
                {busy ? 'Sending…' : 'Send link'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
