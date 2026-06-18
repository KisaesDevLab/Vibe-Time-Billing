// SPDX-License-Identifier: Elastic-2.0
//
// Public self-service booking page (/book/:slug). A visitor opens a link the
// firm pasted into a text/email, picks an appointment type (when more than
// one is offered), chooses a day + open slot, fills in their details, and
// submits a booking *request* (staff approve it before it confirms).
//
// Anonymous surface: no session cookie, no CSRF token. Every call targets
// /api/public/book/* on the same origin (Caddy proxies that path here). We
// use plain fetch here rather than the intake api-client because that client
// is hard-bound to the /api/public/intake base path.

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

import { tokens } from '@vibe/ui';

import { Turnstile } from '../components/Turnstile';

const BASE = '/api/public/book';

interface BookType {
  id: string;
  name: string;
  durationMinutes: number;
}

interface BookConfig {
  staffName: string;
  customMessage: string | null;
  types: BookType[];
  captchaSiteKey: string | null;
}

interface Slot {
  start: string; // ISO instant
  end: string; // ISO instant
}

interface SlotsResponse {
  date: string;
  timezone: string;
  slots: Slot[];
}

interface RequestOk {
  ok: boolean;
  message: string;
}

interface FetchError {
  status: number;
  error: string;
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

// Read the raw response body, throwing a typed { status, error } on failure
// so callers can branch on the server's error code (slot_taken, etc.).
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    credentials: 'omit',
  });
  const ct = res.headers.get('content-type') ?? '';
  const body: unknown = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const error =
      typeof body === 'object' && body && 'error' in body
        ? String((body as { error: unknown }).error)
        : res.statusText;
    const err: FetchError = { status: res.status, error };
    throw err;
  }
  return body as T;
}

function isFetchError(e: unknown): e is FetchError {
  return typeof e === 'object' && e !== null && 'status' in e && 'error' in e;
}

// Today in the visitor's local timezone, as YYYY-MM-DD for the date input.
function todayLocalISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(iso: string, delta: number): string {
  // Parse as a local calendar date (avoid UTC shift) and re-format.
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  dt.setDate(dt.getDate() + delta);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function Book(): JSX.Element {
  const { slug } = useParams<{ slug: string }>();

  const [config, setConfig] = useState<BookConfig | null | 'missing'>(null);
  const [typeId, setTypeId] = useState<string | null>(null);
  const [date, setDate] = useState<string>(todayLocalISO());

  const [slotsState, setSlotsState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [slotsResp, setSlotsResp] = useState<SlotsResponse | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');

  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaNonce, setCaptchaNonce] = useState(0);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Load the booking config on mount / slug change.
  useEffect(() => {
    if (!slug) {
      setConfig('missing');
      return;
    }
    let alive = true;
    call<BookConfig>(`/${encodeURIComponent(slug)}`)
      .then((cfg) => {
        if (!alive) return;
        setConfig(cfg);
        // Auto-select the only type, if there's exactly one.
        const only = cfg.types.length === 1 ? cfg.types[0] : undefined;
        if (only) setTypeId(only.id);
      })
      .catch(() => {
        if (alive) setConfig('missing');
      });
    return () => {
      alive = false;
    };
  }, [slug]);

  // (Re)load slots whenever the chosen date or type changes.
  useEffect(() => {
    if (!slug || config === null || config === 'missing') return;
    let alive = true;
    setSlotsState('loading');
    setSelectedSlot(null);
    const qs = new URLSearchParams({ date });
    if (typeId) qs.set('typeId', typeId);
    call<SlotsResponse>(`/${encodeURIComponent(slug)}/slots?${qs.toString()}`)
      .then((r) => {
        if (!alive) return;
        setSlotsResp(r);
        setSlotsState('idle');
      })
      .catch(() => {
        if (!alive) return;
        setSlotsResp(null);
        setSlotsState('error');
      });
    return () => {
      alive = false;
    };
  }, [slug, config, date, typeId]);

  const timezone = slotsResp?.timezone ?? undefined;
  const timeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: timezone,
      }),
    [timezone],
  );
  const dayFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: timezone,
      }),
    [timezone],
  );

  const captchaSiteKey = config && config !== 'missing' ? config.captchaSiteKey : null;
  const canSubmit =
    Boolean(selectedSlot) &&
    name.trim().length > 0 &&
    email.trim().length > 0 &&
    (!captchaSiteKey || Boolean(captchaToken)) &&
    !busy;

  async function submit(): Promise<void> {
    if (!slug || !selectedSlot) return;
    setBusy(true);
    setError(null);
    try {
      const r = await call<RequestOk>(`/${encodeURIComponent(slug)}/request`, {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim() || undefined,
          notes: notes.trim() || undefined,
          startsAt: selectedSlot.start,
          typeId: typeId ?? undefined,
          captchaToken: captchaToken ?? undefined,
        }),
      });
      setSuccess(
        r.message || "Request received — you'll get a confirmation email once it's approved.",
      );
    } catch (e) {
      const code = isFetchError(e) ? e.error : 'unknown';
      const status = isFetchError(e) ? e.status : 0;
      if (status === 409 || code === 'slot_taken') {
        setError('That time was just taken. Please pick another slot.');
        // Refresh availability so the visitor sees current openings.
        setSelectedSlot(null);
        setSlotsState('loading');
        if (slug) {
          const qs = new URLSearchParams({ date });
          if (typeId) qs.set('typeId', typeId);
          void call<SlotsResponse>(`/${encodeURIComponent(slug)}/slots?${qs.toString()}`)
            .then((res) => {
              setSlotsResp(res);
              setSlotsState('idle');
            })
            .catch(() => setSlotsState('error'));
        }
      } else if (status === 429) {
        setError('Too many attempts. Please wait a moment and try again.');
      } else if (code === 'captcha_failed') {
        setError('The CAPTCHA check failed. Please try again.');
      } else if (code === 'invalid_payload') {
        setError('Some details look invalid. Please double-check and try again.');
      } else {
        setError('Something went wrong. Please try again.');
      }
      // Turnstile tokens are single-use — refresh the widget for a retry.
      if (captchaSiteKey) {
        setCaptchaToken(null);
        setCaptchaNonce((n) => n + 1);
      }
    } finally {
      setBusy(false);
    }
  }

  if (config === null) {
    return <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>;
  }

  if (config === 'missing') {
    return (
      <div
        style={{
          padding: 16,
          background: tokens.color.surface,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
        }}
      >
        <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>This booking link isn&apos;t available</h2>
        <p style={{ margin: 0, fontSize: 13, color: tokens.color.textMuted }}>
          The link may have expired or been turned off. Please ask the firm for a new one.
        </p>
      </div>
    );
  }

  if (success) {
    return (
      <div
        style={{
          padding: 16,
          background: tokens.color.surface,
          border: `1px solid ${tokens.color.success}`,
          borderRadius: tokens.radius.md,
        }}
      >
        <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>Request received</h2>
        <p style={{ margin: 0, fontSize: 13, color: tokens.color.textMuted }}>{success}</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      <div>
        <h2 style={{ fontSize: 16, margin: 0 }}>Book time with {config.staffName}</h2>
        {config.customMessage && (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: '6px 0 0' }}>
            {config.customMessage}
          </p>
        )}
      </div>

      {config.types.length > 1 && (
        <div>
          <span style={labelStyle}>What is this for?</span>
          <div role="radiogroup" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {config.types.map((t) => {
              const active = t.id === typeId;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setTypeId(t.id)}
                  style={{
                    padding: '10px 14px',
                    border: `1px solid ${active ? tokens.color.accent : tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    fontSize: 14,
                    background: active ? tokens.color.accentMuted : tokens.color.surface,
                    color: tokens.color.text,
                    cursor: 'pointer',
                  }}
                >
                  {t.name}
                  <span style={{ color: tokens.color.textMuted }}> · {t.durationMinutes} min</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <span style={labelStyle}>Pick a day</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => setDate((d) => addDays(d, -1))}
            disabled={date <= todayLocalISO()}
            aria-label="Previous day"
            style={{
              padding: '8px 12px',
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              background: tokens.color.surface,
              color: tokens.color.text,
              cursor: date <= todayLocalISO() ? 'not-allowed' : 'pointer',
              opacity: date <= todayLocalISO() ? 0.5 : 1,
            }}
          >
            ←
          </button>
          <input
            type="date"
            value={date}
            min={todayLocalISO()}
            onChange={(e) => setDate(e.target.value || todayLocalISO())}
            style={{ ...inputStyle, width: 'auto', flex: '1 1 160px' }}
            aria-label="Booking date"
          />
          <button
            type="button"
            onClick={() => setDate((d) => addDays(d, 1))}
            aria-label="Next day"
            style={{
              padding: '8px 12px',
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              background: tokens.color.surface,
              color: tokens.color.text,
              cursor: 'pointer',
            }}
          >
            →
          </button>
        </div>
      </div>

      <div>
        <span style={labelStyle}>Available times</span>
        {slotsState === 'loading' && (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading times…</p>
        )}
        {slotsState === 'error' && (
          <p style={{ fontSize: 13, color: tokens.color.danger, margin: 0 }}>
            Couldn&apos;t load times for this day. Try another day.
          </p>
        )}
        {slotsState === 'idle' && slotsResp && slotsResp.slots.length === 0 && (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            No open times on {dayFmt.format(new Date(`${date}T12:00:00`))}. Try another day.
          </p>
        )}
        {slotsState === 'idle' && slotsResp && slotsResp.slots.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {slotsResp.slots.map((slot) => {
              const active = selectedSlot?.start === slot.start;
              return (
                <button
                  key={slot.start}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSelectedSlot(slot)}
                  style={{
                    padding: '10px 14px',
                    border: `1px solid ${active ? tokens.color.accent : tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    fontSize: 14,
                    background: active ? tokens.color.accentMuted : tokens.color.surface,
                    color: tokens.color.text,
                    cursor: 'pointer',
                  }}
                >
                  {timeFmt.format(new Date(slot.start))}
                </button>
              );
            })}
          </div>
        )}
        {slotsResp && timezone && (
          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '8px 0 0' }}>
            Times shown in {timezone}.
          </p>
        )}
      </div>

      <div>
        <span style={labelStyle}>Your name *</span>
        <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px' }}>
          <span style={labelStyle}>Email *</span>
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

      <div>
        <span style={labelStyle}>Notes</span>
        <textarea
          style={{ ...inputStyle, minHeight: 72, resize: 'vertical' }}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything the firm should know ahead of time (optional)."
        />
      </div>

      {captchaSiteKey && (
        <Turnstile key={captchaNonce} siteKey={captchaSiteKey} onToken={setCaptchaToken} />
      )}

      {error && <div style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</div>}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={!canSubmit}
        style={{
          padding: '12px 16px',
          background: canSubmit ? tokens.color.accent : tokens.color.border,
          color: '#fff',
          border: 'none',
          borderRadius: tokens.radius.sm,
          fontSize: 15,
          cursor: canSubmit ? 'pointer' : 'not-allowed',
        }}
      >
        {busy ? 'Sending…' : 'Request this time'}
      </button>
      {!selectedSlot && (
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '-8px 0 0' }}>
          Pick a time above to continue.
        </p>
      )}
    </div>
  );
}
