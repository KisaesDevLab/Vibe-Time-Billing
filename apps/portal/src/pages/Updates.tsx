// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0146 — portal in-app notification inbox (the PORTAL channel of the
// staged-notification pipeline). Newest first, unread highlighted;
// clicking an item marks it read and follows its action link when set.
// Distinct from /notifications, which holds delivery PREFERENCES.

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Card, EmptyState, Pill, SectionHeading, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface UpdateRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  actionUrl: string | null;
  status: 'UNREAD' | 'READ';
  createdAt: string;
  readAt: string | null;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function UpdatesPage(): JSX.Element {
  const [items, setItems] = useState<UpdateRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: UpdateRow[] }>('/api/portal/notifications');
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(item: UpdateRow): Promise<void> {
    if (item.status === 'UNREAD') {
      await api(`/api/portal/notifications/${item.id}/read`, { method: 'POST' }).catch(
        () => undefined,
      );
      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, status: 'READ' as const } : i)),
      );
    }
    if (item.actionUrl) navigate(item.actionUrl);
  }

  async function markAllRead(): Promise<void> {
    await api('/api/portal/notifications/read-all', { method: 'POST' }).catch(() => undefined);
    void load();
  }

  const unread = items.filter((i) => i.status === 'UNREAD').length;

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      <SectionHeading
        title="Updates"
        description="Notices from your firm about your engagements and account"
        action={
          unread > 0 ? (
            <Button size="sm" variant="secondary" onClick={() => void markAllRead()}>
              Mark all read
            </Button>
          ) : undefined
        }
      />
      <Card>
        {!loaded && <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>}
        {loaded && error && <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>}
        {loaded && !error && items.length === 0 && (
          <EmptyState title="No updates yet" body="Notices from your firm will appear here." />
        )}
        <div style={{ display: 'grid', gap: 8 }}>
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => void open(item)}
              style={{
                textAlign: 'left',
                padding: '10px 12px',
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.color.border}`,
                background:
                  item.status === 'UNREAD' ? tokens.color.accentMuted : tokens.color.surface,
                cursor: 'pointer',
                display: 'grid',
                gap: 4,
              }}
            >
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 13,
                  fontWeight: item.status === 'UNREAD' ? 600 : 400,
                  color: tokens.color.text,
                }}
              >
                {item.status === 'UNREAD' && <Pill tone="accent">new</Pill>}
                <span style={{ flex: 1 }}>{item.title}</span>
                <span style={{ color: tokens.color.textMuted, fontWeight: 400, fontSize: 12 }}>
                  {relativeTime(item.createdAt)}
                </span>
              </span>
              {item.body && (
                <span style={{ fontSize: 12, color: tokens.color.textMuted }}>{item.body}</span>
              )}
            </button>
          ))}
        </div>
      </Card>
    </div>
  );
}
