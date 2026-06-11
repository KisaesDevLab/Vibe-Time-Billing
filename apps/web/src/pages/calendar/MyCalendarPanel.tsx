// SPDX-License-Identifier: Elastic-2.0
//
// CAL-5 — "My Calendar" staff dashboard panel. Today/week appointments with
// client chips (confirmed → client link; pending → amber "Review"; unmatched
// → grey), provider icon, location, and a Log Time quick action on
// confirmed-match cards. Renders nothing until events exist.

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface CalEvent {
  id: string;
  subject: string | null;
  startAt: string | null;
  endAt: string | null;
  location: string | null;
  webLink: string | null;
  provider: 'microsoft' | 'google' | null;
  matchStatus: string | null;
  matchTier: string | null;
  clientId: string | null;
  clientName: string | null;
}

const PROVIDER_ICON: Record<string, string> = { microsoft: 'Ⓜ', google: 'Ⓖ' };

function timeRange(startIso: string | null, endIso: string | null): string {
  if (!startIso) return '';
  const s = new Date(startIso);
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  const start = s.toLocaleTimeString([], opts);
  if (!endIso) return start;
  return `${start}–${new Date(endIso).toLocaleTimeString([], opts)}`;
}

function durationMinutes(startIso: string | null, endIso: string | null): number {
  if (!startIso || !endIso) return 0;
  return Math.max(
    0,
    Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000),
  );
}

export function MyCalendarPanel(): JSX.Element | null {
  const navigate = useNavigate();
  const [view, setView] = useState<'today' | 'week'>('today');
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasAny, setHasAny] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ events: CalEvent[] }>(`/api/staff/calendar/events/my?view=${view}`);
      setEvents(r.events ?? []);
      if (r.events && r.events.length > 0) setHasAny(true);
    } finally {
      setLoaded(true);
    }
  }, [view]);

  useEffect(() => {
    void load();
  }, [load]);

  // Hide the panel entirely if the firm/staff has no calendar events at all.
  if (loaded && !hasAny && events.length === 0) return null;

  function logTime(e: CalEvent): void {
    const params = new URLSearchParams({
      clientId: e.clientId ?? '',
      description: e.subject ?? '',
      minutes: String(durationMinutes(e.startAt, e.endAt)),
      date: e.startAt ? e.startAt.slice(0, 10) : '',
    });
    navigate(`/time?${params.toString()}`);
  }

  return (
    <Card
      title="My Calendar"
      action={
        <div style={{ display: 'flex', gap: 4 }}>
          {(['today', 'week'] as const).map((v) => (
            <Button key={v} variant={view === v ? 'primary' : 'ghost'} onClick={() => setView(v)}>
              {v === 'today' ? 'Today' : 'This week'}
            </Button>
          ))}
        </div>
      }
    >
      {events.length === 0 ? (
        <div style={{ fontSize: 13, color: tokens.color.textMuted }}>
          No appointments {view === 'today' ? 'today' : 'this week'}.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {events.map((e) => (
            <div
              key={e.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '6px 8px',
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
              }}
            >
              <div style={{ minWidth: 110, fontSize: 12, color: tokens.color.textMuted }}>
                {timeRange(e.startAt, e.endAt)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {e.provider && <span title={e.provider}>{PROVIDER_ICON[e.provider]} </span>}
                  {e.subject ?? '(no subject)'}
                </div>
                {e.location && (
                  <div style={{ fontSize: 11, color: tokens.color.textMuted }}>{e.location}</div>
                )}
              </div>
              <ClientChip event={e} onClick={(id) => navigate(`/clients/${id}`)} />
              {e.matchStatus === 'confirmed' && e.clientId && (
                <Button variant="secondary" onClick={() => logTime(e)}>
                  Log time
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ClientChip({
  event,
  onClick,
}: {
  event: CalEvent;
  onClick: (clientId: string) => void;
}): JSX.Element | null {
  if (event.matchStatus === 'confirmed' && event.clientId) {
    return (
      <button
        type="button"
        onClick={() => onClick(event.clientId!)}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
      >
        <Pill tone="success">{event.clientName ?? 'Client'}</Pill>
      </button>
    );
  }
  if (event.matchStatus === 'pending') {
    return <Pill tone="warning">Review match</Pill>;
  }
  if (event.matchTier === 'unmatched') {
    return <Pill tone="neutral">Unmatched</Pill>;
  }
  return null;
}
