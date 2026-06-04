// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Per-staff upload flow (/:staffId): recipient details + file picker +
// phone scanner, then submit (create session → upload each file → complete).

import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';

import { tokens } from '@vibe/ui';

import { api, uploadRaw, type ApiError } from '../api-client';
import { CameraCapture } from '../components/CameraCapture';

interface StaffCard {
  id: string;
  name: string;
  title: string | null;
  hasHeadshot: boolean;
}

interface PendingFile {
  key: string;
  name: string;
  mimeType: string;
  size: number;
  blob: Blob;
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: tokens.color.textMuted,
  marginBottom: 4,
};
const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: 10,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  fontSize: 15,
  background: tokens.color.bg,
  color: tokens.color.text,
};

let seq = 0;
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function Intake(): JSX.Element {
  const { staffId } = useParams<{ staffId: string }>();
  const [staff, setStaff] = useState<StaffCard | null | 'missing'>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let alive = true;
    api<{ staff: StaffCard[] }>('/staff')
      .then((r) => {
        if (!alive) return;
        setStaff(r.staff.find((s) => s.id === staffId) ?? 'missing');
      })
      .catch(() => {
        if (alive) setStaff('missing');
      });
    return () => {
      alive = false;
    };
  }, [staffId]);

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

  function removeFile(key: string): void {
    setFiles((prev) => prev.filter((f) => f.key !== key));
  }

  const canSubmit =
    name.trim().length > 0 &&
    (email.trim().length > 0 || phone.trim().length > 0) &&
    files.length > 0;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { sessionId } = await api<{ sessionId: string }>('/session', {
        method: 'POST',
        body: JSON.stringify({
          targetStaffId: staffId,
          clientName: name.trim(),
          clientEmail: email.trim() || undefined,
          clientPhone: phone.trim() || undefined,
          message: message.trim() || undefined,
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
    } finally {
      setBusy(false);
    }
  }

  if (staff === 'missing') {
    return (
      <div style={{ display: 'grid', gap: 12 }}>
        <p style={{ fontSize: 14 }}>That contact isn&apos;t available for document intake.</p>
        <Link to="/" style={{ fontSize: 13, color: tokens.color.accent }}>
          ← Choose a contact
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div style={{ display: 'grid', gap: 12 }}>
        <div
          style={{
            padding: 16,
            background: tokens.color.surface,
            border: `1px solid ${tokens.color.success}`,
            borderRadius: tokens.radius.md,
          }}
        >
          <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>Thank you — your documents were sent</h2>
          <p style={{ margin: 0, fontSize: 13, color: tokens.color.textMuted }}>
            {staff ? staff.name : 'The firm'} will receive your {files.length} file
            {files.length === 1 ? '' : 's'} after a quick security scan. You can close this page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div>
        <h2 style={{ fontSize: 16, margin: 0 }}>
          Send documents{staff ? ` to ${staff.name}` : ''}
        </h2>
        <Link to="/" style={{ fontSize: 12, color: tokens.color.accent }}>
          ← Choose a different contact
        </Link>
      </div>

      <div>
        <span style={labelStyle}>Your name *</span>
        <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
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
      <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '-8px 0 0' }}>
        Enter at least an email or a phone number so the firm can reach you.
      </p>
      <div>
        <span style={labelStyle}>Message (optional)</span>
        <textarea
          style={{ ...inputStyle, minHeight: 64, resize: 'vertical' }}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        <span style={labelStyle}>Documents *</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <label
            style={{
              padding: '10px 16px',
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
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
          <button
            type="button"
            onClick={() => setCamera(true)}
            style={{
              padding: '10px 16px',
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              fontSize: 14,
              background: 'transparent',
              color: tokens.color.text,
              cursor: 'pointer',
            }}
          >
            Scan with camera
          </button>
        </div>

        {files.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
            {files.map((f) => (
              <li
                key={f.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: '8px 10px',
                  background: tokens.color.surface,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  fontSize: 13,
                }}
              >
                <span
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {f.name}{' '}
                  <span style={{ color: tokens.color.textMuted }}>({fmtSize(f.size)})</span>
                </span>
                <button
                  type="button"
                  onClick={() => removeFile(f.key)}
                  disabled={busy}
                  aria-label={`Remove ${f.name}`}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: tokens.color.danger,
                    cursor: 'pointer',
                    fontSize: 18,
                    lineHeight: 1,
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

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
