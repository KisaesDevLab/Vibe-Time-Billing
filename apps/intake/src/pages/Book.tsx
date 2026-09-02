/* eslint-disable jsx-a11y/label-has-associated-control -- labels wrap their text + control as siblings inside grid cells; revisit with htmlFor/id pairs in a polish pass */
// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Public self-service booking page (/book/:slug). A visitor opens a link the
// firm pasted into a text/email and walks a short wizard: pick an appointment
// type (when more than one is offered), pick how to meet (when more than one is
// offered), choose a day + open slot, fill in their details, then submit a
// booking *request* (staff approve it before it confirms).
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
  Stepper,
  TrustFooter,
  bodyFont,
  cardStyle,
  fieldLabelStyle,
  fieldStyle,
  ghostButtonStyle,
  headFont,
  headingStyle,
  palette,
  primaryButtonStyle,
  subheadStyle,
} from '../ui';
import type { Step } from '../ui';

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

// --- Date helpers ------------------------------------------------------

const pad2 = (n: number): string => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number): string => `${y}-${pad2(m)}-${pad2(d)}`;

// Today in the visitor's local timezone, as YYYY-MM-DD.
function todayYmd(): string {
  const n = new Date();
  return ymd(n.getFullYear(), n.getMonth() + 1, n.getDate());
}

// The next `count` calendar days starting today (each as a noon-local Date so
// the YYYY-MM-DD label is stable regardless of the visitor's offset).
function buildDayStrip(count: number): { key: string; date: Date }[] {
  const out: { key: string; date: Date }[] = [];
  const base = new Date();
  base.setHours(12, 0, 0, 0);
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    out.push({ key: ymd(d.getFullYear(), d.getMonth() + 1, d.getDate()), date: d });
  }
  return out;
}

const DAY_STRIP_COUNT = 21;

// --- Inline location-type icons ---------------------------------------

function LocationIcon({ type }: { type: LocationType }): JSX.Element {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: palette.accent,
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (type === 'IN_PERSON') {
    return (
      <svg {...common}>
        <path d="M12 21s-6-5.2-6-10a6 6 0 1 1 12 0c0 4.8-6 10-6 10Z" />
        <circle cx="12" cy="11" r="2.2" />
      </svg>
    );
  }
  if (type === 'PHONE') {
    return (
      <svg {...common}>
        <path d="M5 4h3l1.6 4-2 1.4a12 12 0 0 0 5.6 5.6l1.4-2 4 1.6v3a2 2 0 0 1-2.2 2A16 16 0 0 1 3 6.2 2 2 0 0 1 5 4Z" />
      </svg>
    );
  }
  // VIDEO
  return (
    <svg {...common}>
      <rect x="3" y="6" width="12" height="12" rx="2" />
      <path d="M15 10.5 21 7v10l-6-3.5" />
    </svg>
  );
}

// --- small presentational helpers --------------------------------------

function durationPill(text: string): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-block',
        background: '#eef1f6',
        color: palette.muted,
        fontSize: 12,
        fontWeight: 600,
        fontFamily: bodyFont,
        borderRadius: 999,
        padding: '4px 11px',
      }}
    >
      {text}
    </span>
  );
}

// A round check badge pinned to a card's top-right corner when selected.
function SelectBadge(): JSX.Element {
  return (
    <span
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        width: 22,
        height: 22,
        borderRadius: '50%',
        background: palette.accent,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Check size={12} stroke="#fff" />
    </span>
  );
}

function selectableCardStyle(active: boolean): React.CSSProperties {
  return {
    position: 'relative',
    textAlign: 'left',
    padding: '18px 18px',
    borderRadius: 16,
    cursor: 'pointer',
    border: active ? `1px solid ${palette.accent}` : `1px solid ${palette.border}`,
    background: active ? palette.accentSoft : '#fff',
    boxShadow: active ? `0 0 0 1px ${palette.accent}` : 'none',
    color: palette.ink,
    width: '100%',
  };
}

function fieldErrorText(text: string): JSX.Element {
  return <p style={{ margin: '6px 0 0', fontSize: 12.5, color: palette.danger }}>{text}</p>;
}

// Step identifiers — drives the dynamic step list.
type StepId = 'service' | 'format' | 'datetime' | 'details';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function Book(): JSX.Element {
  const { slug } = useParams<{ slug: string }>();

  const [config, setConfig] = useState<BookConfig | null | 'missing'>(null);
  const [typeId, setTypeId] = useState<string | null>(null);
  // The chosen way to meet (BookLocation.key), or null until picked. When the
  // page offers exactly one location it's auto-selected on load.
  const [selectedLocationKey, setSelectedLocationKey] = useState<string | null>(null);

  // Unioned availability across the current month and next month, keyed by
  // YYYY-MM-DD. A day is bookable when its value is true.
  const [availability, setAvailability] = useState<Record<string, boolean>>({});

  // Currently selected day (YYYY-MM-DD), or null until the visitor picks one.
  const [date, setDate] = useState<string | null>(null);

  const [slotsState, setSlotsState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [slotsResp, setSlotsResp] = useState<SlotsResponse | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  // 0234 / D8a — opt-in to text reminders for this appointment.
  const [smsConsent, setSmsConsent] = useState(false);
  const [notes, setNotes] = useState('');
  // Which detail fields the visitor has interacted with (controls error text).
  const [touched, setTouched] = useState<{ name: boolean; email: boolean; phone: boolean }>({
    name: false,
    email: false,
    phone: false,
  });

  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaNonce, setCaptchaNonce] = useState(0);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Index into the active step list.
  const [stepIndex, setStepIndex] = useState(0);

  // The currently chosen location object (or null). Availability + the request
  // body filter by its type, and by its id when the option carries one.
  const locations: BookLocation[] = config && config !== 'missing' ? config.locations : [];
  const types: BookType[] = config && config !== 'missing' ? config.types : [];
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

  // (Re)load month availability whenever the type or way-to-meet changes (and
  // on load). We fetch the current month AND next month and union them so the
  // ~21-day strip is fully populated. Clears any picked day on change.
  useEffect(() => {
    if (!slug || config === null || config === 'missing') return;
    let alive = true;
    setDate(null);
    setSelectedSlot(null);
    const now = new Date();
    const months: { year: number; month: number }[] = [
      { year: now.getFullYear(), month: now.getMonth() + 1 },
    ];
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    months.push({ year: next.getFullYear(), month: next.getMonth() + 1 });

    const fetches = months.map((m) => {
      const qs = new URLSearchParams({ year: String(m.year), month: String(m.month) });
      if (typeId) qs.set('typeId', typeId);
      if (locationType) qs.set('location', locationType);
      if (locationOptionId) qs.set('locationId', locationOptionId);
      return call<MonthResponse>(`/${encodeURIComponent(slug)}/month?${qs.toString()}`);
    });

    Promise.all(fetches)
      .then((results) => {
        if (!alive) return;
        const merged: Record<string, boolean> = {};
        for (const r of results) {
          for (const [day, open] of Object.entries(r.days)) {
            if (open) merged[day] = true;
          }
        }
        setAvailability(merged);
      })
      .catch(() => {
        if (alive) setAvailability({});
      });
    return () => {
      alive = false;
    };
  }, [slug, config, typeId, locationType, locationOptionId]);

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
  const longDateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: timezone,
      }),
    [timezone],
  );

  // --- dynamic step list -------------------------------------------------
  const activeSteps: StepId[] = useMemo(() => {
    const out: StepId[] = [];
    if (types.length > 1) out.push('service');
    if (locations.length > 1) out.push('format');
    out.push('datetime');
    out.push('details');
    return out;
  }, [types.length, locations.length]);

  const stepperSteps: Step[] = useMemo(
    () =>
      activeSteps.map((id, i) => ({
        n: i + 1,
        label:
          id === 'service'
            ? 'Service'
            : id === 'format'
              ? 'Format'
              : id === 'datetime'
                ? 'Date & time'
                : 'Your details',
      })),
    [activeSteps],
  );

  // Keep the index in range if the active step list shrinks (config loads).
  const clampedIndex = Math.min(stepIndex, activeSteps.length - 1);
  const currentStep: StepId | undefined = activeSteps[clampedIndex];

  const captchaSiteKey = config && config !== 'missing' ? config.captchaSiteKey : null;

  // --- per-step validity -------------------------------------------------
  const emailValid = EMAIL_RE.test(email.trim());
  const phoneDigits = phone.replace(/\D/g, '');
  const phoneValid = phone.trim() === '' || phoneDigits.length >= 10;
  const detailsValid =
    name.trim().length > 0 &&
    emailValid &&
    phoneValid &&
    (!captchaSiteKey || Boolean(captchaToken)) &&
    !busy;

  function stepValid(id: StepId | undefined): boolean {
    switch (id) {
      case 'service':
        return typeId !== null;
      case 'format':
        return selectedLocation !== null;
      case 'datetime':
        return selectedSlot !== null;
      case 'details':
        return detailsValid;
      default:
        return false;
    }
  }

  const isLastStep = clampedIndex === activeSteps.length - 1;
  const continueEnabled = stepValid(currentStep);

  function goBack(): void {
    setError(null);
    setStepIndex((i) => Math.max(0, i - 1));
  }

  function goNext(): void {
    setError(null);
    if (isLastStep) {
      void submit();
      return;
    }
    setStepIndex((i) => Math.min(activeSteps.length - 1, i + 1));
  }

  // Jump back to the Date & time step (used when a slot is taken at submit).
  function gotoDateTime(): void {
    const idx = activeSteps.indexOf('datetime');
    if (idx >= 0) setStepIndex(idx);
  }

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
          smsConsent: phone.trim() ? smsConsent : undefined,
          notes: notes.trim() || undefined,
          startsAt: selectedSlot.start,
          typeId: typeId ?? undefined,
          location: locationType ?? undefined,
          locationId: locationOptionId ?? undefined,
          captchaToken: captchaToken ?? undefined,
        }),
      });
      setSuccess(
        r.message ||
          "Your request was received — you'll get a confirmation email once the firm approves it.",
      );
    } catch (e) {
      const code = isFetchError(e) ? e.error : 'unknown';
      const status = isFetchError(e) ? e.status : 0;
      if (status === 409 || code === 'slot_taken') {
        setError('That time was just taken. Please pick another slot.');
        // Bounce back to the Date & time step and refresh openings.
        setSelectedSlot(null);
        gotoDateTime();
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
          const now = new Date();
          const months: { year: number; month: number }[] = [
            { year: now.getFullYear(), month: now.getMonth() + 1 },
          ];
          const nm = new Date(now.getFullYear(), now.getMonth() + 1, 1);
          months.push({ year: nm.getFullYear(), month: nm.getMonth() + 1 });
          void Promise.all(
            months.map((m) => {
              const mq = new URLSearchParams({ year: String(m.year), month: String(m.month) });
              if (typeId) mq.set('typeId', typeId);
              if (locationType) mq.set('location', locationType);
              if (locationOptionId) mq.set('locationId', locationOptionId);
              return call<MonthResponse>(`/${encodeURIComponent(slug)}/month?${mq.toString()}`);
            }),
          )
            .then((results) => {
              const merged: Record<string, boolean> = {};
              for (const res of results) {
                for (const [day, open] of Object.entries(res.days)) {
                  if (open) merged[day] = true;
                }
              }
              setAvailability(merged);
            })
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

  // Reset everything back to the first active step (success → "Book another").
  function resetWizard(): void {
    setSuccess(null);
    setError(null);
    setStepIndex(0);
    setDate(null);
    setSlotsResp(null);
    setSlotsState('idle');
    setSelectedSlot(null);
    setName('');
    setEmail('');
    setPhone('');
    setNotes('');
    setTouched({ name: false, email: false, phone: false });
    setCaptchaToken(null);
    setCaptchaNonce((n) => n + 1);
    // Keep auto-selected single type/location; clear multi-option choices.
    if (types.length !== 1) setTypeId(null);
    if (locations.length !== 1) setSelectedLocationKey(null);
  }

  // --- derived labels for summaries -------------------------------------
  const selectedType = types.find((t) => t.id === typeId) ?? null;
  const typeName = selectedType?.name ?? null;
  const formatLabel = selectedLocation?.label ?? null;
  const longDate = date ? longDateFmt.format(new Date(`${date}T12:00:00`)) : null;
  const timeLabel = selectedSlot ? timeFmt.format(new Date(selectedSlot.start)) : null;

  // ---- loading / missing states ----------------------------------------
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

  // ---- header: brand eyebrow + "Booking with" pill ---------------------
  const initials =
    config.staffName
      .trim()
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase())
      .slice(0, 2)
      .join('') || 'V';

  const headerRow = (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '12px 16px',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <span
        style={{
          fontFamily: headFont,
          fontWeight: 700,
          fontSize: 12,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: palette.accent,
        }}
      >
        Book Appointment
      </span>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: '#fff',
          border: `1px solid ${palette.border}`,
          borderRadius: 999,
          padding: '6px 14px 6px 6px',
          boxShadow: '0 1px 2px rgba(16,24,40,0.04)',
        }}
      >
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: '50%',
            background: palette.accentSoft2,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: headFont,
            fontWeight: 700,
            fontSize: 13,
            color: palette.accent,
            flex: 'none',
          }}
        >
          {initials}
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
          <span style={{ fontSize: 11, color: palette.muted }}>Booking with</span>
          <span style={{ fontFamily: headFont, fontWeight: 600, fontSize: 14, color: palette.ink }}>
            {config.staffName}
          </span>
        </span>
      </div>
    </div>
  );

  // ---- success step ----------------------------------------------------
  if (success) {
    const summaryRows: { label: string; value: string }[] = [];
    if (typeName) summaryRows.push({ label: 'Service', value: typeName });
    if (formatLabel) summaryRows.push({ label: 'Format', value: formatLabel });
    if (longDate && timeLabel)
      summaryRows.push({ label: 'When', value: `${longDate} · ${timeLabel}` });
    summaryRows.push({ label: 'Advisor', value: config.staffName });

    return (
      <div style={{ ...cardStyle, display: 'grid', gap: 24 }}>
        {headerRow}
        <div style={{ display: 'grid', gap: 16, justifyItems: 'center', textAlign: 'center' }}>
          <span
            style={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              background: palette.success,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              animation: 'book-pop .35s ease-out',
            }}
          >
            <Check size={30} stroke="#fff" />
          </span>
          <style>{`@keyframes book-pop{0%{transform:scale(.4);opacity:0}60%{transform:scale(1.1)}100%{transform:scale(1);opacity:1}}`}</style>
          <h2 style={{ ...headingStyle(), margin: 0 }}>Request received</h2>
          <p style={{ ...subheadStyle, maxWidth: 460 }}>{success}</p>
        </div>

        <div
          style={{
            border: `1px solid ${palette.border}`,
            borderRadius: 16,
            padding: '6px 18px',
          }}
        >
          {summaryRows.map((row, i) => (
            <div
              key={row.label}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 16,
                padding: '12px 0',
                borderTop: i === 0 ? 'none' : `1px solid ${palette.border}`,
              }}
            >
              <span style={{ fontSize: 13.5, color: palette.muted }}>{row.label}</span>
              <span
                style={{
                  fontFamily: headFont,
                  fontWeight: 600,
                  fontSize: 14,
                  color: palette.ink,
                  textAlign: 'right',
                }}
              >
                {row.value}
              </span>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={resetWizard}
          style={{ ...primaryButtonStyle(true), width: '100%' }}
        >
          Book another time
        </button>

        <TrustFooter />
      </div>
    );
  }

  // ---- step bodies -----------------------------------------------------
  function renderService(): JSX.Element {
    return (
      <div style={{ display: 'grid', gap: 18 }}>
        <div>
          <h2 style={headingStyle()}>How can we help you?</h2>
          <p style={subheadStyle}>Choose the type of appointment you&apos;d like to book.</p>
        </div>
        <div
          role="radiogroup"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(225px, 1fr))',
            gap: 12,
          }}
        >
          {types.map((t) => {
            const active = t.id === typeId;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => {
                  setTypeId(t.id);
                  setDate(null);
                  setSelectedSlot(null);
                }}
                style={selectableCardStyle(active)}
              >
                {active && <SelectBadge />}
                <div
                  style={{
                    fontFamily: headFont,
                    fontWeight: 600,
                    fontSize: 16.5,
                    color: palette.ink,
                    marginBottom: 12,
                    paddingRight: 24,
                  }}
                >
                  {t.name}
                </div>
                {durationPill(`${t.durationMinutes} min`)}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  function renderFormat(): JSX.Element {
    return (
      <div style={{ display: 'grid', gap: 18 }}>
        <div>
          <h2 style={headingStyle()}>How would you like to meet?</h2>
          <p style={subheadStyle}>Pick whatever&apos;s most convenient.</p>
        </div>
        <div role="radiogroup" style={{ display: 'grid', gap: 12 }}>
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
                  setDate(null);
                  setSelectedSlot(null);
                }}
                style={{
                  ...selectableCardStyle(active),
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                }}
              >
                <span
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: 12,
                    background: palette.accentSoft2,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flex: 'none',
                  }}
                >
                  <LocationIcon type={loc.locationType} />
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span
                    style={{
                      fontFamily: headFont,
                      fontWeight: 600,
                      fontSize: 16.5,
                      color: palette.ink,
                    }}
                  >
                    {loc.label}
                  </span>
                  {loc.detail && (
                    <span style={{ fontSize: 13.5, color: palette.muted }}>{loc.detail}</span>
                  )}
                </span>
                {active && (
                  <span style={{ marginLeft: 'auto', flex: 'none' }}>
                    <span
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: '50%',
                        background: palette.accent,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Check size={12} stroke="#fff" />
                    </span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  function renderDateTime(): JSX.Element {
    const today = todayYmd();
    const strip = buildDayStrip(DAY_STRIP_COUNT);
    const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: timezone });
    const monthShortFmt = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      timeZone: timezone,
    });
    const dayNumFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', timeZone: timezone });
    const tzLabel = timezone ?? slotsResp?.timezone ?? 'your local time zone';

    return (
      <div style={{ display: 'grid', gap: 18 }}>
        <div>
          <h2 style={headingStyle()}>Choose a date &amp; time</h2>
          <p style={subheadStyle}>Times are shown in {tzLabel}.</p>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 10,
            overflowX: 'auto',
            scrollSnapType: 'x mandatory',
            paddingBottom: 6,
          }}
        >
          {strip.map(({ key, date: d }) => {
            const open = availability[key] === true && key >= today;
            const selected = key === date;
            return (
              <button
                key={key}
                type="button"
                disabled={!open}
                onClick={() => setDate(key)}
                style={{
                  width: 66,
                  flex: 'none',
                  scrollSnapAlign: 'start',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 2,
                  padding: '12px 0',
                  borderRadius: 14,
                  cursor: open ? 'pointer' : 'not-allowed',
                  opacity: open ? 1 : 0.4,
                  border: selected ? `1px solid ${palette.accent}` : `1px solid ${palette.border}`,
                  background: selected ? palette.accentSoft : '#fff',
                  boxShadow: selected ? `0 0 0 1px ${palette.accent}` : 'none',
                }}
              >
                <span style={{ fontSize: 12, color: palette.muted }}>{weekdayFmt.format(d)}</span>
                <span
                  style={{
                    fontFamily: headFont,
                    fontWeight: 600,
                    fontSize: 20,
                    color: selected ? palette.accent : palette.ink,
                  }}
                >
                  {dayNumFmt.format(d)}
                </span>
                <span style={{ fontSize: 11, color: palette.faint }}>
                  {monthShortFmt.format(d)}
                </span>
              </button>
            );
          })}
        </div>

        <div>
          <span style={{ ...fieldLabelStyle, display: 'block', marginBottom: 10 }}>
            Available times
          </span>
          {!date && (
            <div
              style={{
                border: `1px dashed ${palette.borderStrong}`,
                borderRadius: 14,
                padding: '26px 18px',
                textAlign: 'center',
                color: palette.muted,
                fontSize: 14,
              }}
            >
              Pick a day above to see open times.
            </div>
          )}
          {date && slotsState === 'loading' && (
            <p style={{ fontSize: 14, color: palette.muted, margin: 0 }}>Loading times…</p>
          )}
          {date && slotsState === 'error' && (
            <p style={{ fontSize: 14, color: palette.danger, margin: 0 }}>
              Couldn&apos;t load times for this day. Try another day.
            </p>
          )}
          {date && slotsState === 'idle' && slotsResp && slotsResp.slots.length === 0 && (
            <p style={{ fontSize: 14, color: palette.muted, margin: 0 }}>
              No open times this day. Try another.
            </p>
          )}
          {date && slotsState === 'idle' && slotsResp && slotsResp.slots.length > 0 && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(102px, 1fr))',
                gap: 8,
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
                      textAlign: 'center',
                      border: active
                        ? `1px solid ${palette.accent}`
                        : `1px solid ${palette.borderStrong}`,
                      borderRadius: 12,
                      fontFamily: headFont,
                      fontSize: 14,
                      fontWeight: active ? 600 : 500,
                      background: active ? palette.accent : '#fff',
                      color: active ? '#fff' : palette.ink,
                      cursor: 'pointer',
                    }}
                  >
                    {timeFmt.format(new Date(slot.start))}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderDetails(): JSX.Element {
    const summaryParts: string[] = [];
    if (typeName) summaryParts.push(typeName);
    if (formatLabel) summaryParts.push(formatLabel);
    if (longDate) summaryParts.push(longDate);
    if (timeLabel) summaryParts.push(timeLabel);

    return (
      <div style={{ display: 'grid', gap: 18 }}>
        <div>
          <h2 style={headingStyle()}>Your details</h2>
          <p style={subheadStyle}>We&apos;ll send your confirmation and a reminder here.</p>
        </div>

        {summaryParts.length > 0 && (
          <div
            style={{
              background: palette.accentSoft,
              border: '1px solid #d4e3f7',
              borderRadius: 14,
              padding: '12px 16px',
              fontFamily: headFont,
              fontWeight: 600,
              fontSize: 14,
              color: palette.ink,
            }}
          >
            {summaryParts.join(' • ')}
          </div>
        )}

        <div>
          <label style={{ ...fieldLabelStyle, display: 'block', marginBottom: 6 }}>Full name</label>
          <input
            style={fieldStyle(touched.name && name.trim().length === 0)}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, name: true }))}
          />
          {touched.name && name.trim().length === 0 && fieldErrorText('Please enter your name.')}
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 200px' }}>
            <label style={{ ...fieldLabelStyle, display: 'block', marginBottom: 6 }}>
              Email address
            </label>
            <input
              style={fieldStyle(touched.email && !emailValid)}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, email: true }))}
            />
            {touched.email && !emailValid && fieldErrorText('Please enter a valid email address.')}
          </div>
          <div style={{ flex: '1 1 200px' }}>
            <label style={{ ...fieldLabelStyle, display: 'block', marginBottom: 6 }}>
              Phone number
            </label>
            <input
              style={fieldStyle(touched.phone && !phoneValid)}
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, phone: true }))}
            />
            {touched.phone && !phoneValid && fieldErrorText('Please enter a valid phone number.')}
            {phone.trim() !== '' && (
              <label
                style={{
                  ...fieldLabelStyle,
                  display: 'flex',
                  gap: 8,
                  alignItems: 'flex-start',
                  marginTop: 8,
                  fontWeight: 400,
                }}
              >
                <input
                  type="checkbox"
                  checked={smsConsent}
                  onChange={(e) => setSmsConsent(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  You may text me about this appointment (reminders and confirmations). Message and
                  data rates may apply; reply STOP to opt out.
                </span>
              </label>
            )}
          </div>
        </div>

        <div>
          <label style={{ ...fieldLabelStyle, display: 'block', marginBottom: 6 }}>Notes</label>
          <textarea
            style={{ ...fieldStyle(), minHeight: 84, resize: 'vertical' }}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything we should know? (optional)"
          />
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            fontSize: 13,
            color: palette.muted,
          }}
        >
          <span
            style={{
              width: 17,
              height: 17,
              borderRadius: '50%',
              background: palette.successBg,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: 'none',
            }}
          >
            <Check size={9} stroke={palette.success} />
          </span>
          Your information is encrypted and never shared. No payment is needed to book.
        </div>

        {captchaSiteKey && (
          <Turnstile key={captchaNonce} siteKey={captchaSiteKey} onToken={setCaptchaToken} />
        )}
      </div>
    );
  }

  function renderStep(): JSX.Element {
    switch (currentStep) {
      case 'service':
        return renderService();
      case 'format':
        return renderFormat();
      case 'datetime':
        return renderDateTime();
      case 'details':
        return renderDetails();
      default:
        return <div />;
    }
  }

  return (
    <div style={{ ...cardStyle, display: 'grid', gap: 24 }}>
      {headerRow}
      <Stepper steps={stepperSteps} current={clampedIndex + 1} />

      {renderStep()}

      {error && <div style={{ color: palette.danger, fontSize: 13 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between' }}>
        {clampedIndex > 0 ? (
          <button type="button" onClick={goBack} style={ghostButtonStyle}>
            Back
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={goNext}
          disabled={!continueEnabled}
          style={primaryButtonStyle(continueEnabled)}
        >
          {isLastStep ? (busy ? 'Sending…' : 'Request appointment') : 'Continue'}
        </button>
      </div>

      <TrustFooter />
    </div>
  );
}
