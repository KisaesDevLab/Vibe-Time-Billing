// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Staff Messages page — unified inbox across every engagement thread the
// signed-in staff user is a member of. Mirrors the portal /messages
// shape: thread list on the left, message stream + composer on the
// right. New threads aren't created here; they're provisioned
// automatically when an engagement is created (see
// apps/api/src/engagement-messaging/lifecycle.ts).

import { useEffect, useState } from 'react';

import { Card, Pill, tokens } from '@vibe/ui';

import { api } from '../api-client';

import { ThreadView } from './messaging/ThreadView';

interface ThreadRow {
  threadId: string;
  engagementId: string | null;
  title: string | null;
  status: string;
  updatedAt: string;
}

export function MessagesPage(): JSX.Element {
  const [threads, setThreads] = useState<ThreadRow[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadThreads(): Promise<void> {
    try {
      const r = await api<{ items: ThreadRow[] }>('/api/staff/engagement-messaging/threads');
      const items = r.items ?? [];
      setThreads(items);
      if (!activeId && items[0]) setActiveId(items[0].threadId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
      setThreads([]);
    }
  }

  useEffect(() => {
    void loadThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (threads == null) {
    return (
      <Card title="Messages">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
      </Card>
    );
  }

  if (threads.length === 0) {
    return (
      <Card title="Messages">
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 13, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          You aren&apos;t a member of any message threads yet. Threads are created automatically
          when an engagement is opened; ask the engagement partner to add you, or create an
          engagement and invite a portal contact for that client.
        </p>
      </Card>
    );
  }

  const activeThread = threads.find((t) => t.threadId === activeId) ?? null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: tokens.space.lg }}>
      <Card title={`Threads (${threads.length})`}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            maxHeight: 'calc(100vh / var(--vibe-font-scale, 1) - 220px)',
            overflowY: 'auto',
          }}
        >
          {threads.map((t) => {
            const isActive = activeId === t.threadId;
            return (
              <button
                key={t.threadId}
                type="button"
                onClick={() => setActiveId(t.threadId)}
                style={{
                  textAlign: 'left',
                  padding: '10px 12px',
                  borderRadius: tokens.radius.sm,
                  background: isActive ? tokens.color.accentMuted : 'transparent',
                  color: isActive ? tokens.color.accent : tokens.color.text,
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 13,
                  display: 'grid',
                  gap: 4,
                }}
              >
                <div style={{ fontWeight: 500 }}>{t.title ?? 'Engagement thread'}</div>
                <div
                  style={{
                    fontSize: 11,
                    color: tokens.color.textMuted,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {t.status === 'ARCHIVED' ? (
                    <Pill tone="neutral">Archived</Pill>
                  ) : (
                    <span>Updated {new Date(t.updatedAt).toLocaleString()}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      <Card
        title={activeThread ? (activeThread.title ?? 'Engagement thread') : 'Pick a thread'}
        action={
          activeThread?.engagementId ? (
            <a
              href={`/engagements/${activeThread.engagementId}`}
              style={{ fontSize: 12, color: tokens.color.accent, textDecoration: 'none' }}
            >
              Open engagement →
            </a>
          ) : null
        }
      >
        {activeId ? (
          <ThreadView threadId={activeId} maxHeight={520} onSent={() => void loadThreads()} />
        ) : (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Pick a thread on the left.</p>
        )}
      </Card>
    </div>
  );
}
