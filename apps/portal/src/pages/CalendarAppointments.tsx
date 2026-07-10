// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CAL-6 — portal section listing appointments synced from the firm staff's
// calendars (matched to this client). Read-only; each has an "Add to
// calendar" .ics link. Renders nothing if there are none.

import { useEffect, useState } from 'react';
import { Card, SectionHeading, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface CalAppt {
  id: string;
  subject: string | null;
  startAt: string | null;
  endAt: string | null;
  location: string | null;
  staffName: string | null;
}

export function CalendarAppointments(): JSX.Element | null {
  const [items, setItems] = useState<CalAppt[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void api<{ items: CalAppt[] }>('/api/portal/calendar/appointments')
      .then((r) => setItems(r.items ?? []))
      .catch(() => setItems([]))
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded || items.length === 0) return null;

  const upcoming = items.filter((i) => i.startAt && new Date(i.startAt) >= new Date());

  return (
    <div>
      <SectionHeading title="Scheduled with your team" />
      <Card>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
          {(upcoming.length ? upcoming : items).map((a) => (
            <li
              key={a.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '8px 4px',
                borderBottom: `1px solid ${tokens.color.border}`,
              }}
            >
              <div style={{ minWidth: 160, fontSize: 13 }}>
                {a.startAt ? new Date(a.startAt).toLocaleString() : ''}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500, fontSize: 14 }}>{a.subject ?? 'Appointment'}</div>
                <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                  {a.staffName ? `With ${a.staffName}` : ''}
                  {a.location ? ` · ${a.location}` : ''}
                </div>
              </div>
              <a
                href={`/api/portal/calendar/appointments/${a.id}.ics`}
                style={{ fontSize: 13, color: tokens.color.accent }}
              >
                Add to calendar
              </a>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
