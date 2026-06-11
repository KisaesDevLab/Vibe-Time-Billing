// SPDX-License-Identifier: Elastic-2.0
//
// BK-7 — staff notification center. Lists this user's in-app
// notifications (reschedule requests, client cancellations, calendar
// write failures) with mark-read / dismiss and a deep link to the
// relevant appointment.

import { useEffect, useState } from 'react';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  actionUrl: string | null;
  status: 'UNREAD' | 'READ' | 'DISMISSED' | 'ACTIONED';
  createdAt: string;
}

const TYPE_TONE: Record<string, 'accent' | 'warning' | 'danger' | 'neutral'> = {
  reschedule_requested: 'accent',
  appointment_cancelled_by_client: 'danger',
  provider_write_failed: 'warning',
};

export function NotificationsPage(): JSX.Element {
  const [items, setItems] = useState<Notification[]>([]);
  const [err, setErr] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: Notification[] }>('/api/staff/notifications');
      setItems(r.items ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function mark(id: string, action: 'read' | 'dismiss'): Promise<void> {
    await api(`/api/staff/notifications/${id}/${action}`, { method: 'POST' });
    await load();
  }
  async function readAll(): Promise<void> {
    await api('/api/staff/notifications/read-all', { method: 'POST' });
    await load();
  }

  const unread = items.filter((n) => n.status === 'UNREAD').length;

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 760 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Notifications</h1>
        {unread > 0 && (
          <Button size="sm" variant="secondary" onClick={() => void readAll()}>
            Mark all read
          </Button>
        )}
      </div>
      {err && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{err}</p>}
      <Card title={`Recent (${items.length})`}>
        {items.length === 0 && (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>You&apos;re all caught up.</p>
        )}
        {items.map((n) => (
          <div
            key={n.id}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              padding: '10px 0',
              borderBottom: `1px solid ${tokens.color.border}`,
              opacity: n.status === 'UNREAD' ? 1 : 0.6,
            }}
          >
            <Pill tone={TYPE_TONE[n.type] ?? 'neutral'}>{n.type.replace(/_/g, ' ')}</Pill>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: n.status === 'UNREAD' ? 600 : 400 }}>{n.title}</div>
              {n.body && (
                <div style={{ fontSize: 13, color: tokens.color.textMuted }}>{n.body}</div>
              )}
              <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
                {new Date(n.createdAt).toLocaleString()}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {n.actionUrl && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    window.location.href = n.actionUrl!;
                  }}
                >
                  Open
                </Button>
              )}
              {n.status === 'UNREAD' && (
                <Button size="sm" variant="secondary" onClick={() => void mark(n.id, 'read')}>
                  Read
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => void mark(n.id, 'dismiss')}>
                Dismiss
              </Button>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}
