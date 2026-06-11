// SPDX-License-Identifier: Elastic-2.0
//
// CAL-8 — "Did you just meet with X?" dashboard banner. Shows pending
// post-appointment time-entry suggestions with Log time / Not now (snooze)
// / Dismiss. Stacks multiple with a "1 of N" indicator.

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Suggestion {
  id: string;
  eventId: string;
  subject: string | null;
  startAt: string | null;
  clientId: string | null;
  clientName: string | null;
  durationMinutes: number;
}

export function TimeSuggestionBanner(): JSX.Element | null {
  const navigate = useNavigate();
  const [items, setItems] = useState<Suggestion[]>([]);
  const [idx, setIdx] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await api<{ suggestions: Suggestion[] }>('/api/staff/calendar/suggestions');
      setItems(r.suggestions ?? []);
      setIdx(0);
    } catch {
      setItems([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (items.length === 0) return null;
  const s = items[Math.min(idx, items.length - 1)]!;

  async function act(path: string, body?: object): Promise<void> {
    await api(`/api/staff/calendar/suggestions/${s.id}/${path}`, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => undefined);
    await load();
  }

  function logTime(): void {
    const params = new URLSearchParams({
      clientId: s.clientId ?? '',
      description: s.subject ?? '',
      minutes: String(s.durationMinutes),
      date: s.startAt ? s.startAt.slice(0, 10) : '',
    });
    void act('log').then(() => navigate(`/time?${params.toString()}`));
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 16px',
        background: tokens.color.accentMuted,
        border: `1px solid ${tokens.color.accent}`,
        borderRadius: tokens.radius.md,
      }}
    >
      <div style={{ flex: 1 }}>
        <strong>Did you just meet with {s.clientName ?? 'a client'}?</strong>
        <div style={{ fontSize: 13, color: tokens.color.textMuted }}>
          {s.subject ?? 'Appointment'} · {s.durationMinutes} min
          {items.length > 1 ? ` · ${idx + 1} of ${items.length}` : ''}
        </div>
      </div>
      {items.length > 1 && (
        <Button variant="ghost" onClick={() => setIdx((i) => (i + 1) % items.length)}>
          Next
        </Button>
      )}
      <Button variant="ghost" onClick={() => void act('snooze')}>
        Not now
      </Button>
      <Button variant="ghost" onClick={() => void act('dismiss')}>
        Dismiss
      </Button>
      <Button onClick={logTime}>Log time</Button>
    </div>
  );
}
