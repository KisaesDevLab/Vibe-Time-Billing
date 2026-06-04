// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Single-thread message list + reply composer. Reused by:
//   - Top-level staff /messages page (after a thread is picked)
//   - Engagement detail page (embedded; thread resolved by engagementId)
//
// Bodies arrive decrypted from the API. The component never sees
// ciphertext or any encryption material (CLAUDE.md non-negotiable).

import { useCallback, useEffect, useState } from 'react';

import { Button, tokens } from '@vibe/ui';

import { api } from '../../api-client';

export interface ThreadMessage {
  id: string;
  senderAppUserId: string | null;
  senderPortalIdentityId?: string | null;
  senderName: string | null;
  /** Client threads tag each message staff/client; internal threads omit it. */
  senderKind?: 'staff' | 'client';
  /** Internal threads flag the caller's own messages. */
  mine?: boolean;
  body: string;
  createdAt: string;
}

interface ThreadViewProps {
  threadId: string;
  /** Hide the thread title (used by the engagement card which has its own card title). */
  embedded?: boolean;
  /** Cap on the message-list scroll viewport. */
  maxHeight?: number;
  /** Called after a successful send so the parent can refresh thread metadata. */
  onSent?: () => void;
  /** API mount the thread lives under. Defaults to client/engagement
   *  messaging; the Team tab passes the internal-messaging mount. */
  apiBase?: string;
  /** 'client' shows the staff/client sender tags + portal hint; 'internal'
   *  is plain staff chat (right-aligns your own messages via `mine`). */
  variant?: 'client' | 'internal';
}

export function ThreadView({
  threadId,
  embedded = false,
  maxHeight = 480,
  onSent,
  apiBase = '/api/staff/engagement-messaging',
  variant = 'client',
}: ThreadViewProps): JSX.Element {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: ThreadMessage[] }>(`${apiBase}/threads/${threadId}/messages`);
      setMessages(r.items ?? []);
      setError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'load_failed';
      if (msg === 'not_a_member') {
        setError(
          "You aren't a member of this thread. Ask the engagement partner to add you, then refresh.",
        );
      } else {
        setError(`Could not load messages: ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  }, [threadId, apiBase]);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(): Promise<void> {
    if (!draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api(`${apiBase}/threads/${threadId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body: draft.trim() }),
      });
      setDraft('');
      await load();
      onSent?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'send_failed';
      if (msg === 'thread_archived') {
        setError('This thread is archived. Reopen the engagement to send a reply.');
      } else if (msg === 'not_a_member') {
        setError("You're no longer a member of this thread.");
      } else {
        setError(`Send failed: ${msg}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.md }}>
      {!embedded && error && (
        <p style={{ color: tokens.color.danger, fontSize: 13, margin: 0 }} role="alert">
          {error}
        </p>
      )}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: tokens.space.sm,
          maxHeight,
          overflowY: 'auto',
          paddingRight: tokens.space.sm,
        }}
      >
        {loading ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
        ) : messages.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
            {variant === 'internal'
              ? 'No messages yet. Send the first one below.'
              : 'No messages yet. Send the first one below — your client will see it in the portal.'}
          </p>
        ) : (
          messages.map((m) => {
            // Right-align "my" side: own messages (internal) or staff (client).
            const isRight = variant === 'internal' ? Boolean(m.mine) : m.senderKind === 'staff';
            const tag =
              variant === 'internal' ? '' : m.senderKind === 'staff' ? ' · staff' : ' · client';
            const fallbackName =
              variant === 'internal' ? 'Teammate' : m.senderKind === 'staff' ? 'Staff' : 'Client';
            return (
              <div
                key={m.id}
                style={{
                  alignSelf: isRight ? 'flex-end' : 'flex-start',
                  maxWidth: '75%',
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.md,
                  padding: tokens.space.sm,
                  background: isRight ? tokens.color.accentMuted : tokens.color.surface,
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    color: tokens.color.textMuted,
                    marginBottom: 4,
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <span style={{ fontWeight: 500 }}>
                    {m.senderName ?? fallbackName}
                    {tag}
                  </span>
                  <span>{new Date(m.createdAt).toLocaleString()}</span>
                </div>
                <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', color: tokens.color.text }}>
                  {m.body}
                </div>
              </div>
            );
          })
        )}
      </div>

      {embedded && error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }} role="alert">
          {error}
        </p>
      )}

      <div
        style={{
          display: 'flex',
          gap: tokens.space.sm,
          alignItems: 'flex-end',
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Type a reply… (Ctrl/Cmd+Enter to send)"
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
    </div>
  );
}
