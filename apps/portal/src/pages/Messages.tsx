// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Stage 4 — portal Messages page. Lists engagement threads the active
// client participates in, lets the user open a thread and post a
// reply. All message bodies are decrypted server-side; the portal
// never sees ciphertext or holds any encryption material.

import { useEffect, useState } from 'react';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface ThreadRow {
  threadId: string;
  engagementId: string | null;
  title: string | null;
  status: string;
  updatedAt: string;
}

interface MessageRow {
  id: string;
  senderAppUserId: string | null;
  senderPortalIdentityId: string | null;
  senderName: string | null;
  body: string;
  createdAt: string;
}

export function MessagesPage(): JSX.Element {
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadThreads(): Promise<void> {
    setError(null);
    try {
      const r = await api<{ items: ThreadRow[] }>('/api/portal/messaging/threads');
      setThreads(r.items ?? []);
      if (!activeThreadId && r.items?.[0]) setActiveThreadId(r.items[0].threadId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  async function loadMessages(threadId: string): Promise<void> {
    try {
      const r = await api<{ items: MessageRow[] }>(
        `/api/portal/messaging/threads/${threadId}/messages`,
      );
      setMessages(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  useEffect(() => {
    void loadThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeThreadId) void loadMessages(activeThreadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

  async function send(): Promise<void> {
    if (!activeThreadId || !draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/portal/messaging/threads/${activeThreadId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body: draft.trim() }),
      });
      setDraft('');
      await loadMessages(activeThreadId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'send_failed');
    } finally {
      setBusy(false);
    }
  }

  if (threads.length === 0 && !error) {
    return (
      <Card title="Messages">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          You have no message threads yet. Your accountant will start one when work begins on an
          engagement.
        </p>
      </Card>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: tokens.space.lg }}>
      <Card title="Threads">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {threads.map((t) => (
            <button
              key={t.threadId}
              type="button"
              onClick={() => setActiveThreadId(t.threadId)}
              style={{
                textAlign: 'left',
                padding: '8px 10px',
                borderRadius: tokens.radius.sm,
                background:
                  activeThreadId === t.threadId ? tokens.color.accentMuted : 'transparent',
                color: activeThreadId === t.threadId ? tokens.color.accent : tokens.color.text,
                border: 'none',
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              <div style={{ fontWeight: 500 }}>{t.title ?? 'Engagement'}</div>
              <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
                {t.status === 'ARCHIVED' ? (
                  <Pill tone="neutral">Archived</Pill>
                ) : (
                  new Date(t.updatedAt).toLocaleString()
                )}
              </div>
            </button>
          ))}
        </div>
      </Card>

      <Card
        title={
          activeThreadId
            ? (threads.find((t) => t.threadId === activeThreadId)?.title ?? 'Thread')
            : 'Select a thread'
        }
      >
        {error && <p style={{ color: tokens.color.danger, fontSize: 13, margin: 0 }}>{error}</p>}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.space.sm,
            maxHeight: 480,
            overflowY: 'auto',
            paddingRight: tokens.space.sm,
          }}
        >
          {messages.length === 0 ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No messages yet.</p>
          ) : (
            messages.map((m) => {
              const isStaff = m.senderAppUserId != null;
              return (
                <div
                  key={m.id}
                  style={{
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.md,
                    padding: tokens.space.sm,
                    background: isStaff ? tokens.color.surface : tokens.color.accentMuted,
                  }}
                >
                  <div
                    style={{
                      fontSize: 11,
                      color: tokens.color.textMuted,
                      marginBottom: 4,
                      display: 'flex',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span>{isStaff ? (m.senderName ?? 'Your accountant') : 'You'}</span>
                    <span>{new Date(m.createdAt).toLocaleString()}</span>
                  </div>
                  <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{m.body}</div>
                </div>
              );
            })
          )}
        </div>

        <div
          style={{
            marginTop: tokens.space.md,
            display: 'flex',
            gap: tokens.space.sm,
            alignItems: 'flex-end',
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type a reply…"
            rows={3}
            style={{
              flex: 1,
              padding: tokens.space.sm,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              background: tokens.color.surface,
              color: tokens.color.text,
              fontSize: 13,
              fontFamily: tokens.font.body,
              resize: 'vertical',
            }}
          />
          <Button onClick={() => void send()} disabled={busy || !draft.trim()}>
            {busy ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
