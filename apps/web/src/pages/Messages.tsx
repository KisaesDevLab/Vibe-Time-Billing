// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Staff Messages — one place for all conversations, split into two tabs:
//   • Clients — staff ↔ client engagement threads (visible in the portal).
//   • Team    — staff ↔ staff internal direct + group chat (never shared).
//
// The Clients panel lists every engagement thread the signed-in user is a
// member of (threads are auto-provisioned on engagement create). The Team
// panel is the internal-messaging UI.

import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { Card, Input, Pill, tokens, useIsNarrow } from '@vibe/ui';

import { api } from '../api-client';

import { ThreadView } from './messaging/ThreadView';
import { TeamMessagesPanel } from './InternalMessages';

type Tab = 'clients' | 'team';

export function MessagesPage(): JSX.Element {
  const location = useLocation();
  const initialTab: Tab = location.search.includes('tab=team') ? 'team' : 'clients';
  const [tab, setTab] = useState<Tab>(initialTab);
  const [teamUnread, setTeamUnread] = useState(0);

  useEffect(() => {
    let alive = true;
    const poll = (): void => {
      void api<{ unread: number }>('/api/staff/internal-messaging/unread-count')
        .then((r) => alive && setTeamUnread(r.unread))
        .catch(() => undefined);
    };
    poll();
    const t = setInterval(poll, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [tab]);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <TabButton active={tab === 'clients'} onClick={() => setTab('clients')}>
          Clients
        </TabButton>
        <TabButton active={tab === 'team'} onClick={() => setTab('team')}>
          Team{teamUnread > 0 ? ` (${teamUnread})` : ''}
        </TabButton>
      </div>
      {tab === 'clients' ? <ClientMessagesPanel /> : <TeamMessagesPanel />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '6px 14px',
        borderRadius: tokens.radius.pill,
        border: `1px solid ${active ? tokens.color.accent : tokens.color.border}`,
        background: active ? tokens.color.accentMuted : 'transparent',
        color: active ? tokens.color.accent : tokens.color.text,
        fontSize: 14,
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

interface ThreadRow {
  threadId: string;
  engagementId: string | null;
  title: string | null;
  clientName: string | null;
  status: string;
  updatedAt: string;
  lastReplyBy: string | null;
  lastReplyKind: 'staff' | 'client' | null;
  lastReplyAt: string | null;
}

function ClientMessagesPanel(): JSX.Element {
  const [threads, setThreads] = useState<ThreadRow[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const narrow = useIsNarrow();

  async function loadThreads(): Promise<void> {
    try {
      const r = await api<{ items: ThreadRow[] }>('/api/staff/engagement-messaging/threads');
      const items = r.items ?? [];
      setThreads(items);
      // Desktop auto-opens the newest thread beside the list; phones show
      // ONE pane at a time, so auto-selecting would hide the inbox.
      if (!narrow && !activeId && items[0]) setActiveId(items[0].threadId);
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
      <Card title="Client conversations">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
      </Card>
    );
  }

  if (threads.length === 0) {
    return (
      <Card title="Client conversations">
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 13, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          You aren&apos;t a member of any client threads yet. Threads are created automatically when
          an engagement is opened; ask the engagement partner to add you, or create an engagement
          and invite a portal contact for that client.
        </p>
      </Card>
    );
  }

  const activeThread = threads.find((t) => t.threadId === activeId) ?? null;

  const q = search.trim().toLowerCase();
  const visibleThreads = q
    ? threads.filter(
        (t) =>
          (t.clientName ?? '').toLowerCase().includes(q) ||
          (t.title ?? '').toLowerCase().includes(q),
      )
    : threads;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: narrow ? '1fr' : '280px 1fr',
        gap: tokens.space.lg,
      }}
    >
      {/* Phones show one pane at a time: list, or the open conversation. */}
      {(!narrow || !activeId) && (
        <Card title={`Threads (${visibleThreads.length})`}>
          <div style={{ marginBottom: tokens.space.sm }}>
            <Input
              type="search"
              placeholder="Search client or engagement…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search threads by client or engagement"
            />
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              maxHeight: 'calc(100vh / var(--vibe-font-scale, 1) - 220px)',
              overflowY: 'auto',
            }}
          >
            {visibleThreads.length === 0 ? (
              <p style={{ fontSize: 12, color: tokens.color.textMuted, padding: '8px 4px' }}>
                No threads match “{search}”.
              </p>
            ) : null}
            {visibleThreads.map((t) => {
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
                  {/* Client name is the primary label; the engagement name
                    (thread title) is the secondary line. */}
                  <div style={{ fontWeight: 600 }}>{t.clientName ?? 'Client'}</div>
                  <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                    {t.title ?? 'Engagement thread'}
                  </div>
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
                    ) : t.lastReplyBy ? (
                      <span>
                        {t.lastReplyKind === 'client' ? '↩ ' : ''}
                        {t.lastReplyBy} · {new Date(t.lastReplyAt ?? t.updatedAt).toLocaleString()}
                      </span>
                    ) : (
                      <span>Updated {new Date(t.updatedAt).toLocaleString()}</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </Card>
      )}

      {(!narrow || activeId) && (
        <Card
          title={
            activeThread
              ? [activeThread.clientName, activeThread.title].filter(Boolean).join(' — ') ||
                'Engagement thread'
              : 'Pick a thread'
          }
          action={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
              {narrow && activeId && (
                <button
                  type="button"
                  onClick={() => setActiveId(null)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: tokens.color.accent,
                    cursor: 'pointer',
                    fontSize: 13,
                    padding: 0,
                  }}
                >
                  ← All threads
                </button>
              )}
              {activeThread?.engagementId ? (
                <a
                  href={`/engagements/${activeThread.engagementId}`}
                  style={{ fontSize: 12, color: tokens.color.accent, textDecoration: 'none' }}
                >
                  Open engagement →
                </a>
              ) : null}
            </span>
          }
        >
          {activeId ? (
            <ThreadView threadId={activeId} maxHeight={520} onSent={() => void loadThreads()} />
          ) : (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
              Pick a thread on the left.
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
