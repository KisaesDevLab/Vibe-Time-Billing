// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Team messages panel — staff-to-staff direct + group chat. Same Card-based
// two-column layout as the Clients tab (thread list + ThreadView), with a
// "New conversation" action and unread highlighting on the thread rows.

import { useCallback, useEffect, useState } from 'react';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { NewConversationDialog } from './messaging/NewConversationDialog';
import { ThreadView } from './messaging/ThreadView';

interface ThreadRow {
  threadId: string;
  label: string;
  isDirect: boolean;
  memberCount: number;
  unread: number;
  updatedAt: string;
}

export function TeamMessagesPanel(): JSX.Element {
  const [threads, setThreads] = useState<ThreadRow[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const loadThreads = useCallback(async () => {
    try {
      const r = await api<{ threads: ThreadRow[] }>('/api/staff/internal-messaging/threads');
      setThreads(r.threads ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
      setThreads([]);
    }
  }, []);

  useEffect(() => {
    void loadThreads();
    const t = setInterval(() => void loadThreads(), 20000);
    return () => clearInterval(t);
  }, [loadThreads]);

  function open(threadId: string): void {
    setActiveId(threadId);
    // Optimistically clear this thread's unread; reading marks it read
    // server-side and the next poll reconciles.
    setThreads((prev) =>
      prev ? prev.map((t) => (t.threadId === threadId ? { ...t, unread: 0 } : t)) : prev,
    );
  }

  if (threads == null) {
    return (
      <Card title="Conversations">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
      </Card>
    );
  }

  const newBtn = <Button onClick={() => setShowNew(true)}>New conversation</Button>;
  const active = threads.find((t) => t.threadId === activeId) ?? null;

  return (
    <>
      <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '0 0 4px' }}>
        Internal — these conversations are never visible to clients.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: tokens.space.lg }}>
        <Card title={`Conversations (${threads.length})`} action={newBtn}>
          {threads.length === 0 ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
              No conversations yet. Start one with “New conversation”.
            </p>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                maxHeight: 'calc(100vh / var(--vibe-font-scale, 1) - 240px)',
                overflowY: 'auto',
              }}
            >
              {threads.map((t) => {
                const isActive = activeId === t.threadId;
                const hasUnread = t.unread > 0;
                return (
                  <button
                    key={t.threadId}
                    type="button"
                    onClick={() => open(t.threadId)}
                    style={{
                      textAlign: 'left',
                      padding: '10px 12px',
                      borderRadius: tokens.radius.sm,
                      // Active wins; otherwise unread rows get a tinted bubble.
                      background: isActive
                        ? tokens.color.accentMuted
                        : hasUnread
                          ? tokens.color.accentMuted
                          : 'transparent',
                      borderLeft: `3px solid ${
                        isActive
                          ? tokens.color.accent
                          : hasUnread
                            ? tokens.color.accent
                            : 'transparent'
                      }`,
                      color: isActive || hasUnread ? tokens.color.accent : tokens.color.text,
                      cursor: 'pointer',
                      fontSize: 13,
                      display: 'grid',
                      gap: 4,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <span
                        style={{
                          fontWeight: hasUnread ? 700 : 500,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {t.label}
                      </span>
                      {hasUnread && (
                        <span
                          style={{
                            background: tokens.color.accent,
                            color: '#fff',
                            borderRadius: tokens.radius.pill,
                            fontSize: 11,
                            padding: '1px 7px',
                            minWidth: 18,
                            textAlign: 'center',
                          }}
                        >
                          {t.unread}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
                      {t.isDirect ? 'Direct' : `Group · ${t.memberCount}`} · Updated{' '}
                      {new Date(t.updatedAt).toLocaleString()}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </Card>

        <Card
          title={active ? active.label : 'Pick a conversation'}
          action={active && !active.isDirect ? <Pill tone="neutral">Group</Pill> : null}
        >
          {error && (
            <p style={{ color: tokens.color.danger, fontSize: 13, marginBottom: 8 }} role="alert">
              {error}
            </p>
          )}
          {activeId ? (
            <ThreadView
              threadId={activeId}
              apiBase="/api/staff/internal-messaging"
              variant="internal"
              maxHeight={520}
              onSent={() => void loadThreads()}
            />
          ) : (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
              Pick a conversation on the left, or start a new one.
            </p>
          )}
        </Card>
      </div>

      {showNew && (
        <NewConversationDialog
          onClose={() => setShowNew(false)}
          onCreated={(threadId) => {
            setShowNew(false);
            void loadThreads();
            setActiveId(threadId);
          }}
        />
      )}
    </>
  );
}
