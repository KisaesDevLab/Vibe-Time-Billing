// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CAL-5 — the staff "My Calendar" page reached from the Calendar nav. Links
// the staff member's own Microsoft 365 / Google calendar (MyCalendarsCard) and
// shows their upcoming appointments (MyCalendarPanel).

import { tokens } from '@vibe/ui';

import { MyCalendarsCard } from './account/MyCalendars';
import { MyCalendarPanel } from './calendar/MyCalendarPanel';

export function MyCalendarPage(): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 760 }}>
      <h1 style={{ margin: 0, fontSize: 22 }}>My calendar</h1>
      <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
        Connect your own Microsoft 365 or Google calendar so your availability drives booking and
        appointments sync to your calendar. If you don&apos;t see connect options below, your firm
        hasn&apos;t enabled a calendar provider yet — ask an admin to set one up under{' '}
        <strong>Settings → Calendar integrations</strong>.
      </p>
      <MyCalendarsCard />
      <MyCalendarPanel />
    </div>
  );
}
