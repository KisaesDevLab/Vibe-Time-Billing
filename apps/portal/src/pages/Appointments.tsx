// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CP12 — Client portal appointments view (Build Plan §2.6).
//
// Read-only list of upcoming + recent meetings the firm has scheduled.
// Each row shows date block, title, time + duration, location, lead
// staff first name. RSVP / reschedule actions are deferred until the
// firm-side scheduler integration lands.

import { useEffect, useState } from 'react';

import { Card, EmptyState, Pill, SectionHeading, Stat, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { useScope } from '../scope-context';
import { CalendarAppointments } from './CalendarAppointments';

interface AppointmentRow {
  id: string;
  clientId: string;
  engagementId: string | null;
  engagementName: string | null;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  location: 'VIDEO' | 'PHONE' | 'IN_PERSON';
  locationDetail: string | null;
  leadName: string | null;
  status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';
  cancelledReason: string | null;
}

const locationLabel: Record<AppointmentRow['location'], string> = {
  VIDEO: 'Video',
  PHONE: 'Phone',
  IN_PERSON: 'In person',
};

function durationMinutes(startsAt: string, endsAt: string): number {
  return Math.max(
    1,
    Math.round((new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 60_000),
  );
}

export function AppointmentsPage(): JSX.Element {
  const [items, setItems] = useState<AppointmentRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { scope, scopeQuery, clientNames } = useScope();

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: AppointmentRow[] }>(`/api/portal/appointments${scopeQuery}`);
        setItems(r.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to load');
      } finally {
        setLoaded(true);
      }
    })();
  }, [scopeQuery]);

  const now = Date.now();
  const upcoming = items.filter(
    (i) => i.status === 'SCHEDULED' && new Date(i.startsAt).getTime() >= now,
  );
  const past = items.filter(
    (i) => i.status !== 'SCHEDULED' || new Date(i.startsAt).getTime() < now,
  );
  const next = upcoming[0];
  const minutesUntil = next ? Math.round((new Date(next.startsAt).getTime() - now) / 60_000) : null;

  const consolidated = scope === 'all_accessible';

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900, margin: '0 auto' }}>
      <SectionHeading
        title="Appointments"
        description="Scheduled meetings between you and your firm."
      />
      {consolidated && (
        <div
          style={{
            padding: '8px 12px',
            background: tokens.color.accentMuted,
            borderRadius: tokens.radius.sm,
            fontSize: 12,
            color: tokens.color.accent,
          }}
        >
          Showing appointments from <strong>all clients you can access</strong>.
        </div>
      )}

      <CalendarAppointments />

      <section>
        <SectionHeading title="Summary" eyebrow="At a glance" />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: tokens.space.md,
          }}
        >
          <Stat
            label="Upcoming"
            value={upcoming.length}
            tone={upcoming.length > 0 ? 'accent' : 'neutral'}
          />
          <Stat
            label="Next meeting"
            value={next ? new Date(next.startsAt).toLocaleDateString() : '—'}
            tone={
              minutesUntil == null
                ? 'neutral'
                : minutesUntil < 60
                  ? 'danger'
                  : minutesUntil < 24 * 60
                    ? 'warning'
                    : 'neutral'
            }
            caption={
              minutesUntil == null
                ? 'Nothing scheduled'
                : minutesUntil < 60
                  ? `In ${minutesUntil} min`
                  : minutesUntil < 24 * 60
                    ? `In ${Math.round(minutesUntil / 60)}h`
                    : `In ${Math.round(minutesUntil / 60 / 24)}d`
            }
          />
        </div>
      </section>

      <section>
        <SectionHeading title="Upcoming" />
        <Card>
          {!loaded ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
          ) : upcoming.length === 0 ? (
            <EmptyState
              icon="📅"
              title="No appointments scheduled"
              body="When your firm books a meeting with you, it'll appear here. Reach out to them directly to schedule something."
            />
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
              {upcoming.map((row) => (
                <AppointmentCard
                  key={row.id}
                  row={row}
                  clientName={consolidated && row.clientId ? clientNames[row.clientId] : undefined}
                />
              ))}
            </ul>
          )}
        </Card>
      </section>

      {past.length > 0 && (
        <section>
          <SectionHeading title="Recent" description="Past 30 days." />
          <Card>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
              {past.map((row) => (
                <AppointmentCard
                  key={row.id}
                  row={row}
                  clientName={consolidated && row.clientId ? clientNames[row.clientId] : undefined}
                />
              ))}
            </ul>
          </Card>
        </section>
      )}

      {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
    </div>
  );
}

function AppointmentCard({
  row,
  clientName,
}: {
  row: AppointmentRow;
  clientName?: string;
}): JSX.Element {
  const start = new Date(row.startsAt);
  const duration = durationMinutes(row.startsAt, row.endsAt);
  const tone =
    row.status === 'CANCELLED' ? 'danger' : row.status === 'COMPLETED' ? 'neutral' : 'success';
  return (
    <li
      style={{
        padding: tokens.space.md,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
        background: tokens.color.surface,
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        gap: tokens.space.md,
        alignItems: 'start',
      }}
    >
      <div
        style={{
          textAlign: 'center',
          padding: 6,
          background: tokens.color.bg,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.sm,
          minWidth: 60,
        }}
        aria-hidden
      >
        <div
          style={{
            fontSize: 10,
            color: tokens.color.textMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          {start.toLocaleString('en-US', { month: 'short' })}
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.1 }}>{start.getDate()}</div>
        <div style={{ fontSize: 10, color: tokens.color.textMuted }}>
          {start.toLocaleString('en-US', { weekday: 'short' })}
        </div>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{row.title}</div>
        <div
          style={{
            fontSize: 12,
            color: tokens.color.textMuted,
            marginTop: 2,
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
          }}
        >
          <span>
            {start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · {duration} min
          </span>
          <span>· {locationLabel[row.location]}</span>
          {row.leadName && <span>· with {row.leadName}</span>}
          {row.engagementName && (
            <span style={{ color: tokens.color.text }}>· {row.engagementName}</span>
          )}
        </div>
        {row.locationDetail && row.status === 'SCHEDULED' && (
          <div
            style={{
              fontSize: 12,
              color: tokens.color.accent,
              marginTop: 4,
              wordBreak: 'break-all',
            }}
          >
            {row.location === 'VIDEO' && /^https?:\/\//.test(row.locationDetail) ? (
              <a href={row.locationDetail} target="_blank" rel="noreferrer">
                Join meeting →
              </a>
            ) : (
              row.locationDetail
            )}
          </div>
        )}
        {row.description && (
          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '6px 0 0' }}>
            {row.description}
          </p>
        )}
        {row.cancelledReason && (
          <p style={{ fontSize: 12, color: tokens.color.danger, margin: '6px 0 0' }}>
            Cancelled: {row.cancelledReason}
          </p>
        )}
        {clientName && (
          <div style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 4 }}>
            Client: <strong style={{ color: tokens.color.text }}>{clientName}</strong>
          </div>
        )}
      </div>
      <Pill tone={tone}>{row.status}</Pill>
    </li>
  );
}
