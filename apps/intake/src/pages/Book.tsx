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

import { Turnstile } from '../components/Turnstile';
import {
  Check,
  SecureBadge,
  TrustFooter,
  cardStyle,
  fieldLabelStyle,
  fieldStyle,
  headFont,
  headingStyle,
  palette,
  primaryButtonStyle,
  subheadStyle,
} from '../ui';

const BASE = '/api/public/book';

type LocationType = 'VIDEO' | 'PHONE' | 'IN_PERSON';

interface BookType {
  id: string;
  name: string;
  durationMinutes: number;
}

// A way the firm offers to meet (video link, phone call, or a physical
// location). `locationOptionId` is non-null only for saved in-person presets;
// availability + the request body pass it through when present.
interface BookLocation {
  key: string;
  label: string;
  locationType: LocationType;
  locationOptionId: string | null;
  detail: string | null;
}

interface BookConfig {
  staffName: string;
  customMessage: string | null;
  types: BookType[];
  locations: BookLocation[];
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

interface MonthResponse {
  days: Record<string, boolean>;
  timezone: string;
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
  ...fieldLabelStyle,
  display: 'block',
  marginBottom: 6,
};
// A selectable pill "chip" used for the type / location selectors. Selected
// chips get the accent border + soft fill + accent ring.
function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: '10px 14px',
    border: active ? `1px solid ${palette.accent}` : `1px solid ${palette.borderStrong}`,
    borderRadius: 12,
    fontFamily: headFont,
    fontWeight: 600,
    fontSize: 14,
    background: active ? palette.accentSoft : '#fff',
    color: palette.ink,
    cursor: 'pointer',
    boxShadow: active ? `0 0 0 1px ${palette.accent}` : 'none',
  };
}

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

// --- Month-calendar helpers (replicated from the staff booking wizard so the
// public page matches its look; the intake app can't import from apps/web). ---

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

const pad2 = (n: number): string => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number): string => `${y}-${pad2(m)}-${pad2(d)}`;

// Today in the visitor's local timezone, as YYYY-MM-DD.
function todayYmd(): string {
  const n = new Date();
  return ymd(n.getFullYear(), n.getMonth() + 1, n.getDate());
}

// A month calendar with bookable days bolded/clickable, past/unavailable days
// dimmed, the selected day filled with the accent color, and today outlined.
function MonthCalendar({
  year,
  month,
  availability,
  selected,
  loading,
  canPrev,
  onSelect,
  onNav,
}: {
  year: number;
  month: number;
  availability: Record<string, boolean>;
  selected: string | null;
  loading: boolean;
  canPrev: boolean;
  onSelect: (d: string) => void;
  onNav: (delta: number) => void;
}): JSX.Element {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const today = todayYmd();
  const cells: (string | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(ymd(year, month, d));
  const navBtn = (disabled: boolean): React.CSSProperties => ({
    border: 'none',
    background: 'transparent',
    cursor: disabled ? 'default' : 'pointer',
    color: disabled ? palette.faint : palette.text,
    fontSize: 18,
    padding: '0 8px',
  });
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <button
          type="button"
          onClick={() => onNav(-1)}
          disabled={!canPrev}
          aria-label="Previous month"
          style={navBtn(!canPrev)}
        >
          ‹
        </button>
        <strong style={{ fontFamily: headFont, fontSize: 14, color: palette.ink }}>
          {MONTH_NAMES[month - 1]} {year}
        </strong>
        <button
          type="button"
          onClick={() => onNav(1)}
          aria-label="Next month"
          style={navBtn(false)}
        >
          ›
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {WEEKDAYS.map((w) => (
          <div
            key={w}
            style={{
              textAlign: 'center',
              fontSize: 10,
              fontWeight: 600,
              color: palette.muted,
              paddingBottom: 2,
            }}
          >
            {w}
          </div>
        ))}
        {cells.map((c, i) => {
          if (!c) return <div key={`e${i}`} />;
          const day = Number(c.slice(-2));
          const open = availability[c] === true;
          const isPast = c < today;
          const isSel = c === selected;
          const isToday = c === today;
          const clickable = open && !isPast;
          const border = isSel
            ? `1.5px solid ${palette.accent}`
            : isToday
              ? `1px solid ${palette.accent}`
              : '1px solid transparent';
          return (
            <button
              key={c}
              type="button"
              disabled={!clickable}
              onClick={() => onSelect(c)}
              style={{
                aspectRatio: '1',
                borderRadius: 10,
                fontFamily: headFont,
                fontSize: 13,
                cursor: clickable ? 'pointer' : 'default',
                border,
                background: isSel ? palette.accent : 'transparent',
                color: isSel
                  ? '#fff'
                  : isToday
                    ? palette.accent
                    : clickable
                      ? palette.ink
                      : palette.faint,
                fontWeight: clickable && !isSel ? 600 : 400,
                opacity: isPast ? 0.35 : 1,
              }}
            >
              {day}
            </button>
          );
        })}
      </div>
      {loading && (
        <div style={{ fontSize: 11, color: palette.muted, marginTop: 6 }}>
          Loading availability…
        </div>
      )}
    </div>
  );
}

export function Book(): JSX.Element {
  const { slug } = useParams<{ slug: string }>();

  const [config, setConfig] = useState<BookConfig | null | 'missing'>(null);
  const [typeId, setTypeId] = useState<string | null>(null);
  // The chosen way to meet (BookLocation.key), or null until picked. When the
  // page offers exactly one location it's auto-selected on load.
  const [selectedLocationKey, setSelectedLocationKey] = useState<string | null>(null);

  // Month being viewed in the calendar (1-based month). Default: current month.
  const [view, setView] = useState<{ year: number; month: number }>(() => {
    const n = new Date();
    return { year: n.getFullYear(), month: n.getMonth() + 1 };
  });
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  const [monthLoading, setMonthLoading] = useState(false);

  // Currently selected day (YYYY-MM-DD), or null until the visitor picks one.
  const [date, setDate] = useState<string | null>(null);

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

  // The currently chosen location object (or null). Availability + the request
  // body filter by its type, and by its id when the option carries one.
  const locations: BookLocation[] = config && config !== 'missing' ? config.locations : [];
  const selectedLocation = selectedLocationKey
    ? (locations.find((l) => l.key === selectedLocationKey) ?? null)
    : null;
  const locationType = selectedLocation?.locationType ?? null;
  const locationOptionId = selectedLocation?.locationOptionId ?? null;

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
        // Likewise, auto-select the only way to meet, if there's exactly one.
        const onlyLoc = cfg.locations.length === 1 ? cfg.locations[0] : undefined;
        if (onlyLoc) setSelectedLocationKey(onlyLoc.key);
      })
      .catch(() => {
        if (alive) setConfig('missing');
      });
    return () => {
      alive = false;
    };
  }, [slug]);

  // (Re)load the month availability grid on load, when the visitor navigates
  // months, and whenever the appointment type changes (openings differ by
  // type). Clears any selected day whose availability may no longer hold.
  useEffect(() => {
    if (!slug || config === null || config === 'missing') return;
    let alive = true;
    setMonthLoading(true);
    const qs = new URLSearchParams({ year: String(view.year), month: String(view.month) });
    if (typeId) qs.set('typeId', typeId);
    if (locationType) qs.set('location', locationType);
    if (locationOptionId) qs.set('locationId', locationOptionId);
    call<MonthResponse>(`/${encodeURIComponent(slug)}/month?${qs.toString()}`)
      .then((r) => {
        if (!alive) return;
        setAvailability(r.days);
        setMonthLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setAvailability({});
        setMonthLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [slug, config, view.year, view.month, typeId, locationType, locationOptionId]);

  // (Re)load slots whenever the chosen day or type changes.
  useEffect(() => {
    if (!slug || config === null || config === 'missing' || !date) {
      setSlotsResp(null);
      setSlotsState('idle');
      return;
    }
    let alive = true;
    setSlotsState('loading');
    setSelectedSlot(null);
    const qs = new URLSearchParams({ date });
    if (typeId) qs.set('typeId', typeId);
    if (locationType) qs.set('location', locationType);
    if (locationOptionId) qs.set('locationId', locationOptionId);
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
  }, [slug, config, date, typeId, locationType, locationOptionId]);

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

  // Disable the calendar's ‹ button at (or before) the current month so the
  // visitor can't navigate into past months.
  const now = new Date();
  const isCurrentOrEarlierMonth =
    view.year < now.getFullYear() ||
    (view.year === now.getFullYear() && view.month <= now.getMonth() + 1);

  const captchaSiteKey = config && config !== 'missing' ? config.captchaSiteKey : null;
  // When the page offers a choice of locations, one must be picked.
  const locationOk = locations.length <= 1 || selectedLocation !== null;
  const canSubmit =
    Boolean(selectedSlot) &&
    locationOk &&
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
          location: locationType ?? undefined,
          locationId: locationOptionId ?? undefined,
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
        if (slug && date) {
          const qs = new URLSearchParams({ date });
          if (typeId) qs.set('typeId', typeId);
          if (locationType) qs.set('location', locationType);
          if (locationOptionId) qs.set('locationId', locationOptionId);
          void call<SlotsResponse>(`/${encodeURIComponent(slug)}/slots?${qs.toString()}`)
            .then((res) => {
              setSlotsResp(res);
              setSlotsState('idle');
            })
            .catch(() => setSlotsState('error'));
          // Also refresh the month grid: the day may have lost its last slot.
          const mq = new URLSearchParams({ year: String(view.year), month: String(view.month) });
          if (typeId) mq.set('typeId', typeId);
          if (locationType) mq.set('location', locationType);
          if (locationOptionId) mq.set('locationId', locationOptionId);
          void call<MonthResponse>(`/${encodeURIComponent(slug)}/month?${mq.toString()}`)
            .then((res) => setAvailability(res.days))
            .catch(() => {});
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
    return (
      <div style={cardStyle}>
        <p style={{ ...subheadStyle, margin: 0 }}>Loading…</p>
      </div>
    );
  }

  if (config === 'missing') {
    return (
      <div style={cardStyle}>
        <h2 style={{ ...headingStyle(), fontSize: 'clamp(20px, 2.6vw, 24px)' }}>
          This booking link isn&apos;t available
        </h2>
        <p style={{ ...subheadStyle, margin: 0 }}>
          The link may have expired or been turned off. Please ask the firm for a new one.
        </p>
      </div>
    );
  }

  if (success) {
    return (
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <span
            style={{
              width: 40,
              height: 40,
              borderRadius: '50%',
              background: palette.success,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: 'none',
            }}
          >
            <Check size={18} stroke="#fff" />
          </span>
          <h2 style={{ ...headingStyle(), margin: 0, fontSize: 'clamp(20px, 2.6vw, 24px)' }}>
            Request received
          </h2>
        </div>
        <p style={{ ...subheadStyle, margin: 0 }}>{success}</p>
        <TrustFooter />
      </div>
    );
  }

  const selectedType =
    config.types.find((t) => t.id === typeId) ??
    (config.types.length === 1 ? config.types[0] : undefined);
  const durationLabel = selectedType ? `${selectedType.durationMinutes} min` : null;

  return (
    <div style={{ ...cardStyle, display: 'grid', gap: 24 }}>
      <div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '12px 16px',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
          }}
        >
          <h2 style={{ ...headingStyle(), fontSize: 'clamp(21px, 2.8vw, 27px)' }}>
            Book time with {config.staffName}
          </h2>
          <SecureBadge />
        </div>
        {config.customMessage && (
          <p style={{ ...subheadStyle, marginTop: 6 }}>{config.customMessage}</p>
        )}
        {durationLabel && (
          <p style={{ fontSize: 13, color: palette.muted, margin: '6px 0 0' }}>{durationLabel}</p>
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
                  onClick={() => {
                    setTypeId(t.id);
                    // Availability differs by type — drop any picked day.
                    setDate(null);
                  }}
                  style={chipStyle(active)}
                >
                  {t.name}
                  <span style={{ color: palette.muted, fontWeight: 500 }}>
                    {' '}
                    · {t.durationMinutes} min
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {locations.length > 1 && (
        <div>
          <span style={labelStyle}>How would you like to meet?</span>
          <div role="radiogroup" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {locations.map((loc) => {
              const active = loc.key === selectedLocationKey;
              return (
                <button
                  key={loc.key}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    setSelectedLocationKey(loc.key);
                    // Availability differs by location — drop any picked day.
                    setDate(null);
                  }}
                  style={chipStyle(active)}
                >
                  {loc.label}
                </button>
              );
            })}
          </div>
          {selectedLocation?.detail && (
            <p style={{ fontSize: 12, color: palette.muted, margin: '8px 0 0' }}>
              {selectedLocation.detail}
            </p>
          )}
        </div>
      )}

      {locations.length === 1 && selectedLocation?.detail && (
        <div>
          <span style={labelStyle}>Where</span>
          <p style={{ fontSize: 13, color: palette.text, margin: 0 }}>
            {selectedLocation.label}
            <span style={{ color: palette.muted }}> · {selectedLocation.detail}</span>
          </p>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
        <div style={{ width: 300, maxWidth: '100%' }}>
          <span style={labelStyle}>Select a day</span>
          <MonthCalendar
            year={view.year}
            month={view.month}
            availability={availability}
            selected={date}
            loading={monthLoading}
            canPrev={!isCurrentOrEarlierMonth}
            onSelect={(d) => setDate(d)}
            onNav={(delta) => {
              setDate(null);
              setView((v) => {
                const idx0 = v.month - 1 + delta; // 0-based month index, can go ±
                const year = v.year + Math.floor(idx0 / 12);
                const month = (((idx0 % 12) + 12) % 12) + 1; // wrap to 1..12
                return { year, month };
              });
            }}
          />
        </div>

        <div style={{ flex: '1 1 220px', minWidth: 200 }}>
          <span style={labelStyle}>
            {date ? dayFmt.format(new Date(`${date}T12:00:00`)) : 'Available times'}
          </span>
          {!date && (
            <p style={{ fontSize: 13, color: palette.muted, margin: 0 }}>
              Pick a highlighted day to see open times.
            </p>
          )}
          {slotsState === 'loading' && (
            <p style={{ fontSize: 13, color: palette.muted, margin: 0 }}>Loading times…</p>
          )}
          {slotsState === 'error' && (
            <p style={{ fontSize: 13, color: palette.danger, margin: 0 }}>
              Couldn&apos;t load times for this day. Try another day.
            </p>
          )}
          {slotsState === 'idle' && date && slotsResp && slotsResp.slots.length === 0 && (
            <p style={{ fontSize: 13, color: palette.muted, margin: 0 }}>
              No open times this day. Try another.
            </p>
          )}
          {slotsState === 'idle' && slotsResp && slotsResp.slots.length > 0 && (
            <div
              style={{
                display: 'grid',
                gap: 8,
                maxHeight: 300,
                overflowY: 'auto',
                paddingRight: 4,
              }}
            >
              {slotsResp.slots.map((slot) => {
                const active = selectedSlot?.start === slot.start;
                return (
                  <button
                    key={slot.start}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSelectedSlot(slot)}
                    style={{
                      padding: '11px 12px',
                      width: '100%',
                      textAlign: 'center',
                      border: active
                        ? `1px solid ${palette.accent}`
                        : `1px solid ${palette.borderStrong}`,
                      borderRadius: 12,
                      fontFamily: headFont,
                      fontSize: 14,
                      fontWeight: active ? 600 : 500,
                      background: active ? palette.accentSoft : '#fff',
                      color: active ? palette.accent : palette.ink,
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
            <p style={{ fontSize: 12, color: palette.muted, margin: '8px 0 0' }}>
              Times shown in {timezone}.
            </p>
          )}
        </div>
      </div>

      <div>
        <span style={labelStyle}>Your name *</span>
        <input style={fieldStyle()} value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px' }}>
          <span style={labelStyle}>Email *</span>
          <input
            style={fieldStyle()}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div style={{ flex: '1 1 200px' }}>
          <span style={labelStyle}>Phone</span>
          <input
            style={fieldStyle()}
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
      </div>

      <div>
        <span style={labelStyle}>Notes</span>
        <textarea
          style={{ ...fieldStyle(), minHeight: 72, resize: 'vertical' }}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything the firm should know ahead of time (optional)."
        />
      </div>

      {captchaSiteKey && (
        <Turnstile key={captchaNonce} siteKey={captchaSiteKey} onToken={setCaptchaToken} />
      )}

      {error && <div style={{ color: palette.danger, fontSize: 13 }}>{error}</div>}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={!canSubmit}
        style={primaryButtonStyle(canSubmit)}
      >
        {busy ? 'Sending…' : 'Request this time'}
      </button>
      {!selectedSlot && (
        <p style={{ fontSize: 12, color: palette.muted, margin: '-8px 0 0' }}>
          Pick a time above to continue.
        </p>
      )}

      <TrustFooter />
    </div>
  );
}
