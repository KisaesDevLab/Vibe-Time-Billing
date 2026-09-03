// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Stage 4 — portal Messages page. Lists engagement threads the active
// client participates in, lets the user open a thread and post a
// reply. All message bodies are decrypted server-side; the portal
// never sees ciphertext or holds any encryption material.

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  Button,
  Card,
  Paperclip,
  Pill,
  effectiveViewportWidth,
  tokens,
  useIsNarrow,
} from '@vibe/ui';

import { api, getCsrfToken } from '../api-client';

interface ThreadRow {
  threadId: string;
  engagementId: string | null;
  title: string | null;
  status: string;
  updatedAt: string;
}

interface Attachment {
  id: string;
  filename: string | null;
  mimeType: string | null;
  byteSize: number;
  isImage: boolean;
}

interface MessageRow {
  id: string;
  senderAppUserId: string | null;
  senderPortalIdentityId: string | null;
  senderName: string | null;
  body: string;
  createdAt: string;
  attachments?: Attachment[];
  /** 0235 — set when the message was a reply from the video player. */
  videoId?: string | null;
  videoTitle?: string | null;
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

export function MessagesPage(): JSX.Element {
  const narrow = useIsNarrow();
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  // 0235 — the video player deep-links to its engagement thread.
  const [searchParams] = useSearchParams();
  const [activeThreadId, setActiveThreadId] = useState<string | null>(searchParams.get('thread'));
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [composing, setComposing] = useState(false);
  const [newBody, setNewBody] = useState('');
  // Files staged in the new-thread composer. They can't upload until the
  // thread exists, so they're held as File objects and uploaded right
  // after creation.
  const [newFiles, setNewFiles] = useState<File[]>([]);
  const [starting, setStarting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const newFileInput = useRef<HTMLInputElement>(null);

  async function uploadOne(threadId: string, f: File): Promise<PendingAttachment> {
    const qs = new URLSearchParams({
      filename: f.name || 'pasted-image.png',
      mimeType: f.type || 'application/octet-stream',
    });
    const res = await fetch(`/api/portal/messaging/threads/${threadId}/attachments?${qs}`, {
      method: 'POST',
      headers: {
        'Content-Type': f.type || 'application/octet-stream',
        'X-CSRF-Token': getCsrfToken() ?? '',
      },
      body: f,
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
    return (await res.json()) as PendingAttachment;
  }

  async function uploadFiles(files: FileList | File[] | null): Promise<void> {
    if (!files) return;
    const arr = Array.from(files);
    if (arr.length === 0 || !activeThreadId) return;
    setUploading(true);
    setError(null);
    try {
      for (const f of arr) {
        const a = await uploadOne(activeThreadId, f);
        setPending((prev) => [...prev, a]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'upload_failed');
    } finally {
      setUploading(false);
    }
  }

  async function loadThreads(): Promise<void> {
    setError(null);
    try {
      const r = await api<{ items: ThreadRow[] }>('/api/portal/messaging/threads');
      setThreads(r.items ?? []);
      // Desktop: auto-open the newest thread beside the list. Phones show
      // ONE pane at a time — auto-selecting would land the user inside a
      // conversation with the inbox hidden. (Checked live, not via the
      // narrow state: this closure is created before hydration flips it.)
      const phone =
        typeof window !== 'undefined' && effectiveViewportWidth() <= tokens.breakpoint.narrow;
      if (!phone && !activeThreadId && r.items?.[0]) setActiveThreadId(r.items[0].threadId);
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

  async function startThread(): Promise<void> {
    const text = newBody.trim();
    if (!text) return;
    setStarting(true);
    setError(null);
    try {
      const r = await api<{ threadId: string }>('/api/portal/messaging/threads', {
        method: 'POST',
        body: JSON.stringify({ body: text }),
      });
      // Staged files upload after the thread exists, then post as an
      // attachments message right behind the text.
      if (r.threadId && newFiles.length > 0) {
        try {
          const uploaded: PendingAttachment[] = [];
          for (const f of newFiles) uploaded.push(await uploadOne(r.threadId, f));
          await api(`/api/portal/messaging/threads/${r.threadId}/messages`, {
            method: 'POST',
            body: JSON.stringify({
              body:
                uploaded.length === 1 ? uploaded[0]!.filename : `Shared ${uploaded.length} files`,
              attachmentIds: uploaded.map((a) => a.id),
            }),
          });
        } catch (err) {
          // The thread + text made it; surface the attachment failure but
          // don't treat the whole send as failed.
          setError(err instanceof Error ? err.message : 'attachment_upload_failed');
        }
      }
      setNewBody('');
      setNewFiles([]);
      setComposing(false);
      await loadThreads();
      if (r.threadId) setActiveThreadId(r.threadId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'start_failed');
    } finally {
      setStarting(false);
    }
  }

  async function send(): Promise<void> {
    const text = draft.trim();
    if (!activeThreadId || (!text && pending.length === 0)) return;
    setBusy(true);
    setError(null);
    const body =
      text || (pending.length === 1 ? pending[0]!.filename : `Shared ${pending.length} files`);
    try {
      await api(`/api/portal/messaging/threads/${activeThreadId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body, attachmentIds: pending.map((p) => p.id) }),
      });
      setDraft('');
      setPending([]);
      await loadMessages(activeThreadId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'send_failed');
    } finally {
      setBusy(false);
    }
  }

  const composer = (
    <div style={{ display: 'grid', gap: tokens.space.sm }}>
      <textarea
        value={newBody}
        onChange={(e) => setNewBody(e.target.value)}
        placeholder="Write your message to the firm…"
        rows={4}
        style={{
          width: '100%',
          boxSizing: 'border-box',
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
      {newFiles.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {newFiles.map((f, idx) => (
            <span
              key={`${f.name}-${idx}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.pill,
                padding: '2px 8px',
              }}
            >
              {f.name} <span style={{ color: tokens.color.textMuted }}>({fmtSize(f.size)})</span>
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                onClick={() => setNewFiles((prev) => prev.filter((_, i) => i !== idx))}
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
      <div style={{ display: 'flex', gap: tokens.space.sm }}>
        <input
          ref={newFileInput}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            setNewFiles((prev) => [...prev, ...Array.from(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <Button
          variant="ghost"
          onClick={() => newFileInput.current?.click()}
          disabled={starting}
          title="Attach files or images"
        >
          <Paperclip size={20} />
        </Button>
        <Button onClick={() => void startThread()} disabled={starting || !newBody.trim()}>
          {starting ? 'Sending…' : 'Send message'}
        </Button>
        {threads.length > 0 && (
          <Button
            variant="ghost"
            onClick={() => {
              setComposing(false);
              setNewBody('');
              setNewFiles([]);
            }}
            disabled={starting}
          >
            Cancel
          </Button>
        )}
      </div>
    </div>
  );

  if (threads.length === 0 && !error) {
    return (
      <Card title="Messages">
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: '0 0 12px' }}>
          You have no messages yet. Start a conversation with the firm below — you don&apos;t need
          an open engagement, and we&apos;ll route it to the right person.
        </p>
        {composer}
      </Card>
    );
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: narrow ? '1fr' : '260px 1fr',
        gap: tokens.space.lg,
      }}
    >
      {composing && (
        <div style={{ gridColumn: '1 / -1' }}>
          <Card title="New message">{composer}</Card>
        </div>
      )}

      {/* On phones, show one pane at a time: the thread list, or (once a
          thread is picked) the conversation with a back button. */}
      {(!narrow || !activeThreadId) && (
        <Card
          title="Threads"
          action={
            <button
              type="button"
              onClick={() => setComposing((v) => !v)}
              style={{
                border: 'none',
                background: 'transparent',
                color: tokens.color.accent,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              {composing ? 'Cancel' : '+ New message'}
            </button>
          }
        >
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
      )}

      {(!narrow || activeThreadId) && (
        <Card
          title={
            activeThreadId
              ? (threads.find((t) => t.threadId === activeThreadId)?.title ?? 'Thread')
              : 'Select a thread'
          }
          action={
            narrow && activeThreadId ? (
              <button
                type="button"
                onClick={() => setActiveThreadId(null)}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: tokens.color.accent,
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                ← Threads
              </button>
            ) : null
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
                    {m.videoId && (
                      <div style={{ marginBottom: 4 }}>
                        <Pill tone="accent">Re: video · {m.videoTitle ?? 'Video'}</Pill>
                      </div>
                    )}
                    <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{m.body}</div>
                    {m.attachments && m.attachments.length > 0 && (
                      <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
                        {m.attachments.map((a) => {
                          const url = `/api/portal/messaging/threads/${activeThreadId}/attachments/${a.id}`;
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
                              {a.filename ?? 'file'}{' '}
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

          {pending.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: tokens.space.sm }}>
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
                  }}
                >
                  {p.filename}{' '}
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
              marginTop: tokens.space.md,
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
              disabled={uploading || !activeThreadId}
              title="Attach files or images"
            >
              <Paperclip size={20} />
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
                  void uploadFiles(imgs);
                }
              }}
              placeholder="Type a reply… (paste an image to attach it)"
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
        </Card>
      )}
    </div>
  );
}
