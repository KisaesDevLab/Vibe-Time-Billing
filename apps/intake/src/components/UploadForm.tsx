// SPDX-License-Identifier: Elastic-2.0
//
// Shared intake upload flow used by both the per-staff route (/:staffId)
// and the tokenized link (/t/:token). Collects recipient details + an
// optional message and/or files (picker or phone scanner) and runs
// create-session → upload-each → complete. At least one of files OR a
// message is required. When the firm has configured Cloudflare Turnstile, a
// CAPTCHA must be solved before sending.

import { useEffect, useState } from 'react';

import { tokens } from '@vibe/ui';

import { api, uploadRaw, type ApiError } from '../api-client';
import { CameraCapture } from './CameraCapture';
import { Turnstile } from './Turnstile';

interface PendingFile {
  key: string;
  name: string;
  mimeType: string;
  size: number;
  blob: Blob;
}

interface Props {
  targetStaffId: string;
  staffName: string | null;
  /** Present when arriving via a send-a-link token. */
  linkToken?: string;
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: tokens.color.textMuted,
  marginBottom: tokens.space.xs,
};
const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: 10,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  fontSize: 15,
  background: tokens.color.bg,
  color: tokens.color.text,
  boxSizing: 'border-box',
};
const chipButtonStyle: React.CSSProperties = {
  padding: '10px 16px',
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  fontSize: 14,
  background: tokens.color.surface,
  color: tokens.color.text,
  cursor: 'pointer',
  boxSizing: 'border-box',
};

let seq = 0;
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function UploadForm({ targetStaffId, staffName, linkToken }: Props): JSX.Element {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // CAPTCHA: site key from the public config endpoint (null = disabled).
  const [captchaSiteKey, setCaptchaSiteKey] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaNonce, setCaptchaNonce] = useState(0);

  useEffect(() => {
    void api<{ turnstileSiteKey: string | null }>('/config')
      .then((r) => setCaptchaSiteKey(r.turnstileSiteKey))
      .catch(() => undefined);
  }, []);

  function addFiles(list: FileList | null): void {
    if (!list) return;
    const next: PendingFile[] = [];
    for (const f of Array.from(list)) {
      seq += 1;
      next.push({
        key: `f${seq}`,
        name: f.name,
        mimeType: f.type || 'application/octet-stream',
        size: f.size,
        blob: f,
      });
    }
    setFiles((prev) => [...prev, ...next]);
  }

  function addCapture(blob: Blob): void {
    seq += 1;
    setFiles((prev) => [
      ...prev,
      { key: `c${seq}`, name: `scan-${seq}.jpg`, mimeType: 'image/jpeg', size: blob.size, blob },
    ]);
  }

  const hasContent = files.length > 0 || message.trim().length > 0;
  const canSubmit =
    name.trim().length > 0 &&
    (email.trim().length > 0 || phone.trim().length > 0) &&
    hasContent &&
    (!captchaSiteKey || Boolean(captchaToken));

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { sessionId } = await api<{ sessionId: string }>('/session', {
        method: 'POST',
        body: JSON.stringify({
          targetStaffId,
          clientName: name.trim(),
          clientEmail: email.trim() || undefined,
          clientPhone: phone.trim() || undefined,
          message: message.trim() || undefined,
          linkToken,
          captchaToken: captchaToken ?? undefined,
        }),
      });
      for (const f of files) {
        await uploadRaw(`/session/${sessionId}/files`, f.blob, {
          filename: f.name,
          mimeType: f.mimeType,
        });
      }
      await api(`/session/${sessionId}/complete`, { method: 'POST' });
      setDone(true);
    } catch (err) {
      setError((err as ApiError).message || 'Upload failed. Please try again.');
      // Turnstile tokens are single-use — refresh the widget for a retry.
      if (captchaSiteKey) {
        setCaptchaToken(null);
        setCaptchaNonce((n) => n + 1);
      }
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div
        style={{
          padding: 16,
          background: tokens.color.surface,
          border: `1px solid ${tokens.color.success}`,
          borderRadius: tokens.radius.md,
        }}
      >
        <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>Thank you — your submission was sent</h2>
        <p style={{ margin: 0, fontSize: 13, color: tokens.color.textMuted }}>
          {staffName ?? 'The firm'} will receive your{' '}
          {files.length > 0
            ? `${files.length} file${files.length === 1 ? '' : 's'} after a quick security scan`
            : 'message'}
          . You can close this page.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>
        Send documents{staffName ? ` to ${staffName}` : ''}
      </h2>

      <div>
        <span style={labelStyle}>Your name *</span>
        <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 200px' }}>
            <span style={labelStyle}>Email</span>
            <input
              style={inputStyle}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div style={{ flex: '1 1 200px' }}>
            <span style={labelStyle}>Phone</span>
            <input
              style={inputStyle}
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
        </div>
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
          Enter at least an email or a phone number so the firm can reach you.
        </p>
      </div>

      <div>
        <span style={labelStyle}>Message</span>
        <textarea
          style={{ ...inputStyle, minHeight: 72, resize: 'vertical' }}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Add a note for the firm (you can send a message without attaching files)."
        />
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        <span style={labelStyle}>Documents</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <label style={chipButtonStyle}>
            Upload files
            <input
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
          <button type="button" onClick={() => setCamera(true)} style={chipButtonStyle}>
            Scan with camera
          </button>
        </div>

        {files.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {files.map((f) => (
              <li
                key={f.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  padding: 10,
                  background: tokens.color.surface,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  fontSize: 13,
                  boxSizing: 'border-box',
                }}
              >
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                  }}
                >
                  {f.name}{' '}
                  <span style={{ color: tokens.color.textMuted }}>({fmtSize(f.size)})</span>
                </span>
                <button
                  type="button"
                  onClick={() => setFiles((prev) => prev.filter((x) => x.key !== f.key))}
                  disabled={busy}
                  aria-label={`Remove ${f.name}`}
                  style={{
                    flexShrink: 0,
                    border: 'none',
                    background: 'transparent',
                    color: tokens.color.danger,
                    cursor: 'pointer',
                    fontSize: 18,
                    lineHeight: 1,
                    padding: '0 4px',
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
          Attach files or write a message — at least one is required.
        </p>
      </div>

      {captchaSiteKey && (
        <Turnstile key={captchaNonce} siteKey={captchaSiteKey} onToken={setCaptchaToken} />
      )}

      {error && <div style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</div>}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={!canSubmit || busy}
        style={{
          padding: '12px 16px',
          background: canSubmit && !busy ? tokens.color.accent : tokens.color.border,
          color: '#fff',
          border: 'none',
          borderRadius: tokens.radius.sm,
          fontSize: 15,
          cursor: canSubmit && !busy ? 'pointer' : 'not-allowed',
        }}
      >
        {busy ? 'Sending…' : 'Send securely'}
      </button>

      {camera && <CameraCapture onCapture={addCapture} onClose={() => setCamera(false)} />}
    </div>
  );
}
