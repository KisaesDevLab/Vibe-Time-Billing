// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Shared intake upload flow used by both the per-staff route (/:staffId)
// and the tokenized link (/t/:token). Collects recipient details + an
// optional message and/or files (picker or phone scanner) and runs
// create-session → upload-each → complete. At least one of files OR a
// message is required. When the firm has configured Cloudflare Turnstile, a
// CAPTCHA must be solved before sending.
//
// Rendered as a stepped wizard (Contact is step 1, owned by the page before
// this form; this form is Details → Documents → Success), styled with the
// shared intake design module in ../ui.

import { useEffect, useState } from 'react';

import { api, uploadRaw, type ApiError } from '../api-client';
import {
  Check,
  Stepper,
  TrustFooter,
  cardStyle,
  cardShadow,
  fieldLabelStyle,
  fieldStyle,
  ghostButtonStyle,
  headingStyle,
  infoNote,
  palette,
  primaryButtonStyle,
  subheadStyle,
} from '../ui';
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
  /** Step-2 Back handler (return to contact selection). Hidden when absent. */
  onChangeContact?: () => void;
}

let seq = 0;
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Cosmetic client-side reference shown on the success screen only.
function makeReference(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 5; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return `DOC-${out}`;
}

const STEPS = [
  { n: 1, label: 'Contact' },
  { n: 2, label: 'Details' },
  { n: 3, label: 'Send' },
];

export function UploadForm({
  targetStaffId,
  staffName,
  linkToken,
  onChangeContact,
}: Props): JSX.Element {
  const [step, setStep] = useState<2 | 3>(2);
  const [touched, setTouched] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [reference, setReference] = useState('');
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

  // ---- reach validation (step 2) ----------------------------------------
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const phoneValid = phone.replace(/\D/g, '').length >= 10;
  const emailFilled = email.trim().length > 0;
  const phoneFilled = phone.trim().length > 0;
  const reachOk = (emailFilled && emailValid) || (phoneFilled && phoneValid);
  const nameOk = name.trim().length > 0;

  let reachNote = 'Enter at least an email or a phone number so the firm can reach you.';
  let reachDanger = false;
  if (emailFilled && !emailValid) {
    reachNote = 'That email address doesn’t look right.';
    reachDanger = true;
  } else if (phoneFilled && !phoneValid) {
    reachNote = 'That phone number doesn’t look right.';
    reachDanger = true;
  } else if (touched && !reachOk) {
    reachNote = 'Please provide an email or a phone number.';
    reachDanger = true;
  }

  const hasContent = files.length > 0 || message.trim().length > 0;
  const canSubmit = nameOk && reachOk && hasContent && (!captchaSiteKey || Boolean(captchaToken));

  function continueToDocuments(): void {
    setTouched(true);
    if (nameOk && reachOk) setStep(3);
  }

  function reset(): void {
    setStep(2);
    setTouched(false);
    setName('');
    setEmail('');
    setPhone('');
    setMessage('');
    setFiles([]);
    setError(null);
    setDone(false);
    setReference('');
    setCaptchaToken(null);
    setCaptchaNonce((n) => n + 1);
  }

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
      setReference(makeReference());
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

  const summary =
    files.length > 0 ? `${files.length} file${files.length === 1 ? '' : 's'}` : 'message';

  return (
    <div style={cardStyle}>
      <Stepper steps={STEPS} current={done ? 4 : step} />

      {done ? (
        <div style={{ marginTop: 24 }}>
          <SuccessCheck />
          <h2 style={{ ...headingStyle(), textAlign: 'center', marginTop: 18 }}>Sent securely</h2>
          <p style={{ ...subheadStyle, textAlign: 'center', maxWidth: 420, margin: '0 auto' }}>
            {staffName ?? 'The firm'} has received your {summary}. We&apos;ve emailed you a receipt
            for your records.
          </p>

          <div
            style={{
              marginTop: 24,
              border: `1px solid ${palette.border}`,
              borderRadius: 16,
              padding: '18px 20px',
              background: '#fbfcfe',
            }}
          >
            <SummaryRow label="Sent to" value={staffName ?? 'The firm'} />
            <SummaryRow
              label="Files"
              value={
                files.length > 0 ? `${files.length} file${files.length === 1 ? '' : 's'}` : 'None'
              }
            />
            <div style={{ height: 1, background: palette.border, margin: '14px 0' }} />
            <SummaryRow label="Reference" value={reference} mono />
          </div>

          <button
            type="button"
            onClick={reset}
            style={{ ...ghostButtonStyle, width: '100%', marginTop: 20 }}
          >
            Send something else
          </button>
        </div>
      ) : step === 2 ? (
        <div style={{ marginTop: 24, display: 'grid', gap: 18 }}>
          <div>
            <h2 style={headingStyle()}>How can we reach you?</h2>
            <p style={subheadStyle}>
              So {staffName ?? 'the firm'} can follow up about your documents.
            </p>
          </div>

          <label style={{ display: 'grid', gap: 7 }}>
            <span style={fieldLabelStyle}>Your name</span>
            <input
              style={fieldStyle(touched && !nameOk)}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {touched && !nameOk && (
              <span style={{ fontSize: 13, color: palette.danger }}>Please enter your name.</span>
            )}
          </label>

          <div style={{ display: 'grid', gap: 7 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: 14,
              }}
            >
              <label style={{ display: 'grid', gap: 7 }}>
                <span style={fieldLabelStyle}>Email address</span>
                <input
                  style={fieldStyle(emailFilled && !emailValid)}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label style={{ display: 'grid', gap: 7 }}>
                <span style={fieldLabelStyle}>Phone number</span>
                <input
                  style={fieldStyle(phoneFilled && !phoneValid)}
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </label>
            </div>
            <span style={{ fontSize: 13, color: reachDanger ? palette.danger : palette.muted }}>
              {reachNote}
            </span>
          </div>

          <NavRow
            backLabel="Back"
            onBack={onChangeContact}
            primaryLabel="Continue"
            primaryEnabled={nameOk && reachOk}
            onPrimary={continueToDocuments}
            busy={false}
          />
        </div>
      ) : (
        <div style={{ marginTop: 24, display: 'grid', gap: 18 }}>
          <div>
            <h2 style={headingStyle()}>Send your documents</h2>
            <p style={subheadStyle}>
              Attach files, write a note, or both — at least one is required.
            </p>
          </div>

          <div
            style={{
              border: '1.5px dashed #c2d3ea',
              borderRadius: 16,
              background: '#fbfcfe',
              padding: '26px 20px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              textAlign: 'center',
              gap: 14,
            }}
          >
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 14,
                background: palette.accentSoft,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: palette.accent,
              }}
            >
              <UploadArrow />
            </div>
            <div style={{ fontSize: 14.5, color: palette.text, fontWeight: 600 }}>
              Drag files here, or choose how to add them
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
              <label
                style={{
                  ...primaryButtonStyle(true),
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
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
              <button type="button" onClick={() => setCamera(true)} style={ghostButtonStyle}>
                Scan with camera
              </button>
            </div>
          </div>

          {files.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 10 }}>
              {files.map((f) => (
                <li
                  key={f.key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: 12,
                    background: '#fff',
                    border: `1px solid ${palette.border}`,
                    borderRadius: 12,
                    boxShadow: cardShadow,
                    boxSizing: 'border-box',
                  }}
                >
                  <div
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 10,
                      background: palette.accentSoft,
                      color: palette.accent,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flex: 'none',
                    }}
                  >
                    <DocIcon />
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: 14,
                        color: palette.ink,
                        fontWeight: 600,
                      }}
                    >
                      {f.name}
                    </div>
                    <div style={{ fontSize: 12.5, color: palette.muted }}>{fmtSize(f.size)}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setFiles((prev) => prev.filter((x) => x.key !== f.key))}
                    disabled={busy}
                    aria-label={`Remove ${f.name}`}
                    style={{
                      flexShrink: 0,
                      border: 'none',
                      background: 'transparent',
                      color: palette.muted,
                      cursor: 'pointer',
                      fontSize: 20,
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

          <label style={{ display: 'grid', gap: 7 }}>
            <span style={fieldLabelStyle}>Message (optional)</span>
            <textarea
              style={{ ...fieldStyle(), resize: 'vertical' }}
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Add a note for the firm (you can send a message without attaching files)."
            />
          </label>

          {infoNote('Do not send passwords or payment-card numbers through this form.', true)}

          {captchaSiteKey && (
            <Turnstile key={captchaNonce} siteKey={captchaSiteKey} onToken={setCaptchaToken} />
          )}

          {error && <div style={{ color: palette.danger, fontSize: 13 }}>{error}</div>}

          <NavRow
            backLabel="Back"
            onBack={() => setStep(2)}
            primaryLabel={busy ? 'Sending…' : 'Send securely'}
            primaryEnabled={canSubmit}
            onPrimary={() => void submit()}
            busy={busy}
          />
        </div>
      )}

      <TrustFooter />

      {camera && <CameraCapture onCapture={addCapture} onClose={() => setCamera(false)} />}
    </div>
  );
}

function NavRow({
  backLabel,
  onBack,
  primaryLabel,
  primaryEnabled,
  onPrimary,
  busy,
}: {
  backLabel: string;
  onBack?: () => void;
  primaryLabel: string;
  primaryEnabled: boolean;
  onPrimary: () => void;
  busy: boolean;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
      {onBack && (
        <button type="button" onClick={onBack} disabled={busy} style={ghostButtonStyle}>
          {backLabel}
        </button>
      )}
      <button
        type="button"
        onClick={onPrimary}
        disabled={!primaryEnabled || busy}
        style={{ ...primaryButtonStyle(primaryEnabled && !busy), flex: 1 }}
      >
        {primaryLabel}
      </button>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0' }}>
      <span style={{ fontSize: 13.5, color: palette.muted }}>{label}</span>
      <span
        style={{
          fontSize: 13.5,
          fontWeight: 600,
          color: palette.ink,
          fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit',
        }}
      >
        {value}
      </span>
    </div>
  );
}

function SuccessCheck(): JSX.Element {
  return (
    <div
      style={{
        width: 72,
        height: 72,
        borderRadius: '50%',
        background: palette.success,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        margin: '0 auto',
        animation: 'vibe-pop .35s ease-out',
      }}
    >
      <style>
        {
          '@keyframes vibe-pop{0%{transform:scale(.4);opacity:0}60%{transform:scale(1.08)}100%{transform:scale(1);opacity:1}}'
        }
      </style>
      <Check size={34} stroke="#fff" />
    </div>
  );
}

function UploadArrow(): JSX.Element {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 16V4M12 4l-5 5M12 4l5 5M5 20h14"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DocIcon(): JSX.Element {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
      <path d="M14 3v5h5" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" />
    </svg>
  );
}
