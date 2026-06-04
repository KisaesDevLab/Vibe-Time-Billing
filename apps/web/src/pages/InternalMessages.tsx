// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Team messages panel — staff-to-staff direct + group chat. Thread list
// (with unread counts) on the left, conversation on the right, plus a
// new-conversation modal with a multi-staff picker. Light polling keeps it
// fresh (no websockets in this stack). Rendered as the "Team" tab of the
// Messages page.

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, tokens } from '@vibe/ui';

import { api, type ApiError } from '../api-client';
import { NewConversationDialog } from './messaging/NewConversationDialog';

interface ThreadRow {
  threadId: string;
  label: string;
  isDirect: boolean;
  memberCount: number;
  unread: number;
  updatedAt: string;
}

interface Msg {
  id: string;
  senderAppUserId: string | null;
  senderName: string | null;
  body: string;
  createdAt: string;
  mine: boolean;
}

export function TeamMessagesPanel(): JSX.Element {
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [label, setLabel] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const loadThreads = useCallback(async () => {
    try {
      const r = await api<{ threads: ThreadRow[] }>('/api/staff/internal-messaging/threads');
      setThreads(r.threads);
    } catch (err) {
      setError((err as ApiError).message);
    }
  }, []);

  const loadMessages = useCallback(async (threadId: string) => {
    try {
      const r = await api<{ items: Msg[] }>(
        `/api/staff/internal-messaging/threads/${threadId}/messages`,
      );
      setMessages(r.items);
    } catch (err) {
      setError((err as ApiError).message);
    }
  }, []);

  useEffect(() => {
    void loadThreads();
    const t = setInterval(() => void loadThreads(), 20000);
    return () => clearInterval(t);
  }, [loadThreads]);

  useEffect(() => {
    if (!selected) return;
    void loadMessages(selected);
    const t = setInterval(() => void loadMessages(selected), 8000);
    return () => clearInterval(t);
  }, [selected, loadMessages]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  function open(t: ThreadRow): void {
    setSelected(t.threadId);
    setLabel(t.label);
    setMessages([]);
    // Optimistically clear unread on this thread.
    setThreads((prev) => prev.map((x) => (x.threadId === t.threadId ? { ...x, unread: 0 } : x)));
  }

  async function send(): Promise<void> {
    if (!selected || !draft.trim()) return;
    setBusy(true);
    setError(null);
    const body = draft.trim();
    setDraft('');
    try {
      await api(`/api/staff/internal-messaging/threads/${selected}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      await loadMessages(selected);
      void loadThreads();
    } catch (err) {
      setError((err as ApiError).message);
      setDraft(body);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 4,
        }}
      >
        <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
          Internal — these conversations are never visible to clients.
        </span>
        <Button onClick={() => setShowNew(true)}>New conversation</Button>
      </div>
      {error && (
        <div style={{ color: tokens.color.danger, fontSize: 13, marginTop: 8 }}>{error}</div>
      )}

      <div
        style={{ display: 'flex', gap: 16, marginTop: 12, alignItems: 'stretch', height: '70vh' }}
      >
        {/* Thread list */}
        <div
          style={{
            flex: '0 0 280px',
            display: 'grid',
            gap: 6,
            alignContent: 'start',
            overflowY: 'auto',
          }}
        >
          {threads.length === 0 && (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
              No conversations yet. Start one with “New conversation”.
            </p>
          )}
          {threads.map((t) => (
            <button
              key={t.threadId}
              type="button"
              onClick={() => open(t)}
              style={{
                textAlign: 'left',
                padding: 10,
                border: `1px solid ${selected === t.threadId ? tokens.color.accent : tokens.color.border}`,
                borderRadius: tokens.radius.md,
                background: tokens.color.surface,
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ fontWeight: t.unread > 0 ? 700 : 500, fontSize: 14 }}>
                  {t.label}
                </span>
                {!t.isDirect && (
                  <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                    {' '}
                    · {t.memberCount}
                  </span>
                )}
              </span>
              {t.unread > 0 && (
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
            </button>
          ))}
        </div>

        {/* Conversation */}
        <div
          style={{
            flex: 1,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            display: 'flex',
            flexDirection: 'column',
            background: tokens.color.surface,
          }}
        >
          {!selected ? (
            <div style={{ margin: 'auto', color: tokens.color.textMuted, fontSize: 13 }}>
              Select a conversation.
            </div>
          ) : (
            <>
              <div
                style={{
                  padding: '10px 14px',
                  borderBottom: `1px solid ${tokens.color.border}`,
                  fontWeight: 600,
                }}
              >
                {label}
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'grid', gap: 8 }}>
                {messages.map((m) => (
                  <div
                    key={m.id}
                    style={{
                      justifySelf: m.mine ? 'end' : 'start',
                      maxWidth: '75%',
                      background: m.mine ? tokens.color.accent : tokens.color.bg,
                      color: m.mine ? '#fff' : tokens.color.text,
                      borderRadius: tokens.radius.md,
                      padding: '8px 12px',
                    }}
                  >
                    {!m.mine && (
                      <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 2 }}>
                        {m.senderName ?? 'Unknown'}
                      </div>
                    )}
                    <div style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{m.body}</div>
                    <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>
                      {new Date(m.createdAt).toLocaleString()}
                    </div>
                  </div>
                ))}
                <div ref={endRef} />
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  padding: 12,
                  borderTop: `1px solid ${tokens.color.border}`,
                }}
              >
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void send();
                  }}
                  placeholder="Write a message… (Ctrl/⌘+Enter to send)"
                  style={{
                    flex: 1,
                    resize: 'none',
                    minHeight: 44,
                    padding: 8,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    fontSize: 14,
                    background: tokens.color.bg,
                    color: tokens.color.text,
                  }}
                />
                <Button onClick={() => void send()} disabled={busy || !draft.trim()}>
                  Send
                </Button>
              </div>
            </>
          )}
        </div>
      </div>

      {showNew && (
        <NewConversationDialog
          onClose={() => setShowNew(false)}
          onCreated={(threadId) => {
            setShowNew(false);
            void loadThreads();
            setSelected(threadId);
            setLabel('');
          }}
        />
      )}
    </div>
  );
}
