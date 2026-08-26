// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// "Send a link" dialog — generates a tokenized intake link bound to a staff
// member, optionally emailing/texting it to a recipient. Shows the URL so
// staff can copy it regardless of delivery.

import { useEffect, useRef, useState } from 'react';

import { Button, tokens } from '@vibe/ui';

import { api, type ApiError } from '../../api-client';

interface StaffOpt {
  id: string;
  name: string;
}

interface PersonHit {
  id: string;
  name: string;
  email: string;
  phone: string;
}

interface ChannelResult {
  attempted: boolean;
  ok: boolean;
  error?: string;
}
interface LinkResult {
  url: string;
  delivered: boolean;
  email?: ChannelResult;
  sms?: ChannelResult;
}

const CHANNEL_ERROR_LABEL: Record<string, string> = {
  send_failed: 'could not be sent — please share the link below instead',
  email_not_configured: 'email isn’t configured on this server',
  sms_not_configured: 'text messaging isn’t configured on this server',
  invalid_phone: 'that phone number looks invalid',
};

function channelLine(label: string, r: ChannelResult | undefined): JSX.Element | null {
  if (!r || !r.attempted) return null;
  const ok = r.ok;
  return (
    <div style={{ fontSize: 13, color: ok ? tokens.color.success : tokens.color.danger }}>
      {ok ? '✓' : '⚠'} {label}{' '}
      {ok ? 'sent' : (r.error && CHANNEL_ERROR_LABEL[r.error]) || 'could not be sent'}
    </div>
  );
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
  const [result, setResult] = useState<LinkResult | null>(null);

  // People typeahead — pick a directory person to prefill email/phone.
  const [personQuery, setPersonQuery] = useState('');
  const [hits, setHits] = useState<PersonHit[]>([]);
  const [hitsOpen, setHitsOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void api<{ staff: StaffOpt[] }>('/api/staff/intake/staff-options')
      .then((r) => {
        setStaff(r.staff);
        if (r.staff[0]) setTargetStaffId(r.staff[0].id);
      })
      .catch((err: ApiError) => setError(err.message));
  }, []);

  // Debounced directory search (min 2 chars), with cancellation.
  useEffect(() => {
    const q = personQuery.trim();
    if (q.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    let alive = true;
    setSearching(true);
    const t = setTimeout(() => {
      api<{ people: PersonHit[] }>(`/api/staff/intake/people-search?q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (!alive) return;
          setHits(r.people ?? []);
          setHitsOpen(true);
        })
        .catch(() => {
          if (alive) setHits([]);
        })
        .finally(() => {
          if (alive) setSearching(false);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [personQuery]);

  function pickPerson(p: PersonHit): void {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    setPersonQuery(p.name);
    if (p.email) setEmail(p.email);
    if (p.phone) setPhone(p.phone);
    setHitsOpen(false);
  }

  async function submit(): Promise<void> {
    if (!targetStaffId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<LinkResult>('/api/staff/intake/links', {
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
              {result.delivered ? 'Link sent.' : 'Link created.'} You can also share this URL
              directly:
            </p>
            {(channelLine('Email', result.email) || channelLine('Text', result.sms)) && (
              <div style={{ display: 'grid', gap: 4 }}>
                {channelLine('Email', result.email)}
                {channelLine('Text', result.sms)}
              </div>
            )}
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
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between' }}>
              <Button
                variant="ghost"
                onClick={() => void navigator.clipboard?.writeText(result.url)}
              >
                Copy link
              </Button>
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
            <div style={{ position: 'relative' }}>
              <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                Find a person (optional)
              </span>
              <input
                style={inputStyle}
                value={personQuery}
                placeholder="Search name, email, phone, or mobile…"
                autoComplete="off"
                onChange={(e) => setPersonQuery(e.target.value)}
                onFocus={() => {
                  if (hits.length) setHitsOpen(true);
                }}
                onBlur={() => {
                  blurTimer.current = setTimeout(() => setHitsOpen(false), 150);
                }}
              />
              {hitsOpen && (searching || hits.length > 0) && (
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    right: 0,
                    zIndex: 70,
                    marginTop: 2,
                    maxHeight: 220,
                    overflowY: 'auto',
                    background: tokens.color.bg,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
                  }}
                >
                  {searching && hits.length === 0 && (
                    <div
                      style={{ padding: '8px 10px', fontSize: 12, color: tokens.color.textMuted }}
                    >
                      Searching…
                    </div>
                  )}
                  {hits.map((p) => (
                    <button
                      type="button"
                      key={p.id}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pickPerson(p);
                      }}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 10px',
                        border: 'none',
                        borderBottom: `1px solid ${tokens.color.border}`,
                        background: 'transparent',
                        color: tokens.color.text,
                        cursor: 'pointer',
                        font: 'inherit',
                      }}
                    >
                      <div style={{ fontSize: 13 }}>{p.name}</div>
                      <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
                        {[p.email, p.phone].filter(Boolean).join(' · ') ||
                          'No email or phone on file'}
                      </div>
                    </button>
                  ))}
                </div>
              )}
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
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
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
