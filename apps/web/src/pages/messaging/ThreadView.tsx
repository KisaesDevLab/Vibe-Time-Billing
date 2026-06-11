// SPDX-License-Identifier: Elastic-2.0
//
// Single-thread message list + reply composer. Reused by:
//   - Top-level staff /messages page (after a thread is picked)
//   - Engagement detail page (embedded; thread resolved by engagementId)
//
// Bodies arrive decrypted from the API. The component never sees
// ciphertext or any encryption material (CLAUDE.md non-negotiable).

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, Paperclip, tokens } from '@vibe/ui';

import { api, getCsrfToken } from '../../api-client';

export interface MessageAttachment {
  id: string;
  filename: string | null;
  mimeType: string | null;
  byteSize: number;
  isImage: boolean;
}

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
  attachments?: MessageAttachment[];
}

interface PendingAttachment {
  id: string;
  filename: string;
  byteSize: number;
  isImage: boolean;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

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

  async function uploadFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const f of Array.from(files)) {
        const qs = new URLSearchParams({
          filename: f.name,
          mimeType: f.type || 'application/octet-stream',
        });
        const res = await fetch(`${apiBase}/threads/${threadId}/attachments?${qs.toString()}`, {
          method: 'POST',
          headers: {
            'Content-Type': f.type || 'application/octet-stream',
            'X-CSRF-Token': getCsrfToken() ?? '',
          },
          body: f,
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error(`Upload failed (${res.status})`);
        const a = (await res.json()) as PendingAttachment;
        setPending((prev) => [...prev, a]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'upload_failed');
    } finally {
      setUploading(false);
    }
  }

  async function send(): Promise<void> {
    const text = draft.trim();
    if (!text && pending.length === 0) return;
    setBusy(true);
    setError(null);
    // Attachment-only messages get a sensible caption.
    const body =
      text || (pending.length === 1 ? pending[0]!.filename : `Shared ${pending.length} files`);
    try {
      await api(`${apiBase}/threads/${threadId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body, attachmentIds: pending.map((p) => p.id) }),
      });
      setDraft('');
      setPending([]);
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
                {m.attachments && m.attachments.length > 0 && (
                  <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
                    {m.attachments.map((a) => {
                      const url = `${apiBase}/threads/${threadId}/attachments/${a.id}`;
                      return a.isImage ? (
                        <a key={a.id} href={url} target="_blank" rel="noreferrer">
                          <img
                            src={url}
                            alt={a.filename ?? 'image'}
                            style={{
                              maxWidth: '100%',
                              maxHeight: 240,
                              borderRadius: tokens.radius.sm,
                              border: `1px solid ${tokens.color.border}`,
                              display: 'block',
                            }}
                          />
                        </a>
                      ) : (
                        <a
                          key={a.id}
                          href={`${url}?download=1`}
                          style={{
                            fontSize: 12,
                            color: tokens.color.accent,
                            textDecoration: 'none',
                            border: `1px solid ${tokens.color.border}`,
                            borderRadius: tokens.radius.sm,
                            padding: '4px 8px',
                          }}
                        >
                          📎 {a.filename ?? 'file'}{' '}
                          <span style={{ color: tokens.color.textMuted }}>
                            ({fmtSize(a.byteSize)})
                          </span>
                        </a>
                      );
                    })}
                  </div>
                )}
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

      {pending.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {pending.map((p) => (
            <span
              key={p.id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.pill,
                padding: '2px 8px',
                background: tokens.color.surface,
              }}
            >
              {p.isImage ? '🖼' : '📎'} {p.filename}{' '}
              <span style={{ color: tokens.color.textMuted }}>({fmtSize(p.byteSize)})</span>
              <button
                type="button"
                aria-label={`Remove ${p.filename}`}
                onClick={() => setPending((prev) => prev.filter((x) => x.id !== p.id))}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: tokens.color.danger,
                  cursor: 'pointer',
                  fontSize: 15,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          gap: tokens.space.sm,
          alignItems: 'flex-end',
        }}
      >
        <input
          ref={fileInput}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            void uploadFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <Button
          variant="ghost"
          onClick={() => fileInput.current?.click()}
          disabled={uploading}
          title="Attach files or images"
        >
          {uploading ? '…' : <Paperclip size={20} />}
        </Button>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const imgs = Array.from(e.clipboardData.files).filter((f) =>
              f.type.startsWith('image/'),
            );
            if (imgs.length > 0) {
              e.preventDefault();
              const dt = new DataTransfer();
              imgs.forEach((f) => dt.items.add(f));
              void uploadFiles(dt.files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Type a reply… (paste an image to attach; Ctrl/Cmd+Enter to send)"
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
        <Button
          onClick={() => void send()}
          disabled={busy || (!draft.trim() && pending.length === 0)}
        >
          {busy ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </div>
  );
}
