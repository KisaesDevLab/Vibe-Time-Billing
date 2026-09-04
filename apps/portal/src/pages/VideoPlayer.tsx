// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Portal video player (0235). Full-width <video> fed by a short-lived
// inline presigned URL; plays are logged (see lib/video-plays.ts); the
// client can reply in the engagement conversation right under the player.
//
// Stream-only is best-effort on the client (no download control, context
// menu disabled) — the real control is the expiring signed URL.

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Button, Card, EmptyState, Pill, SectionHeading, tokens } from '@vibe/ui';

import { api, type ApiError } from '../api-client';
import { useAuth } from '../auth-context';
import { createPlayTracker, type PlayTracker } from '../lib/video-plays';

export interface PortalVideo {
  id: string;
  engagementId: string;
  engagementName: string;
  clientName?: string;
  title: string;
  message: string | null;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
  expiresAt: string | null;
  firstPlayedAt: string | null;
  playedByMe: boolean;
}

interface ConversationItem {
  id: string;
  senderName: string | null;
  senderKind: 'staff' | 'client';
  mine: boolean;
  body: string;
  createdAt: string;
  aboutThisVideo: boolean;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; video: PortalVideo; url: string }
  | { kind: 'expired'; title?: string }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

const MAX_URL_REFRESHES = 2;

export function formatAvailableUntil(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return null;
  return `Available until ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

export function VideoPlayerPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { me } = useAuth();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [conversation, setConversation] = useState<{
    threadId: string | null;
    items: ConversationItem[];
  } | null>(null);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackerRef = useRef<PlayTracker | null>(null);
  const refreshesRef = useRef(0);
  const resumeAtRef = useRef<number | null>(null);

  const fetchStreamUrl = useCallback(async (): Promise<string> => {
    const r = await api<{ url: string }>(`/api/portal/videos/${id}/stream?format=json`);
    return r.url;
  }, [id]);

  const loadConversation = useCallback(async (): Promise<void> => {
    try {
      const r = await api<{ threadId: string | null; items: ConversationItem[] }>(
        `/api/portal/videos/${id}/messages`,
      );
      setConversation(r);
    } catch {
      setConversation({ threadId: null, items: [] });
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    trackerRef.current = createPlayTracker(id);
    refreshesRef.current = 0;
    void (async () => {
      try {
        const meta = await api<{ video: PortalVideo }>(`/api/portal/videos/${id}`);
        const url = await fetchStreamUrl();
        if (!cancelled) setState({ kind: 'ready', video: meta.video, url });
      } catch (err) {
        const e = err as ApiError;
        if (cancelled) return;
        if (e.status === 410) {
          const body = (e.body ?? {}) as { title?: string };
          setState({ kind: 'expired', ...(body.title ? { title: body.title } : {}) });
        } else if (e.status === 404) setState({ kind: 'missing' });
        else setState({ kind: 'error', message: e.message || 'load_failed' });
      }
    })();
    void loadConversation();
    return () => {
      cancelled = true;
    };
  }, [id, fetchStreamUrl, loadConversation]);

  // Flush progress when the tab is hidden / the page is torn down.
  useEffect(() => {
    const flush = (): void => {
      const v = videoRef.current;
      if (v && trackerRef.current) trackerRef.current.flush(v.currentTime, v.duration || null);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      flush();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  async function recoverFromError(): Promise<void> {
    const v = videoRef.current;
    if (!v || state.kind !== 'ready') return;
    const code = v.error?.code;
    // 2 = MEDIA_ERR_NETWORK — most likely the signed URL expired mid-session.
    if (code === 2 && refreshesRef.current < MAX_URL_REFRESHES) {
      refreshesRef.current += 1;
      resumeAtRef.current = v.currentTime;
      try {
        const url = await fetchStreamUrl();
        setState({ kind: 'ready', video: state.video, url });
        return;
      } catch {
        /* fall through */
      }
    }
    if (code === 3 || code === 4) {
      setPlaybackError(
        "This browser can't play this video — it may use a codec it doesn't support (for example HEVC inside a .mov file). Try Safari on a Mac or iPhone, or ask your firm to re-export it as MP4.",
      );
    } else {
      setPlaybackError('Playback stopped unexpectedly. Reload the page to try again.');
    }
  }

  function onLoadedMetadata(): void {
    const v = videoRef.current;
    if (v && resumeAtRef.current != null) {
      v.currentTime = resumeAtRef.current;
      resumeAtRef.current = null;
      void v.play().catch(() => undefined);
    }
  }

  async function sendReply(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!reply.trim() || sending || !id) return;
    setSending(true);
    setReplyError(null);
    try {
      await api(`/api/portal/videos/${id}/reply`, {
        method: 'POST',
        body: JSON.stringify({ body: reply.trim() }),
      });
      setReply('');
      await loadConversation();
    } catch (err) {
      setReplyError(err instanceof Error ? err.message : 'send_failed');
    } finally {
      setSending(false);
    }
  }

  const back = (
    <Link to="/" style={{ color: tokens.color.accent, fontSize: 13, textDecoration: 'none' }}>
      ← Back to home
    </Link>
  );

  if (state.kind === 'loading') {
    return (
      <div style={{ display: 'grid', gap: tokens.space.md, maxWidth: 960, margin: '0 auto' }}>
        {back}
        <Card>
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading video…</p>
        </Card>
      </div>
    );
  }
  if (state.kind !== 'ready') {
    const copy =
      state.kind === 'expired'
        ? {
            title: 'This video is no longer available',
            body: `${state.title ? `"${state.title}" ` : 'It '}was removed on the schedule your firm set. If you still need it, send them a message.`,
          }
        : state.kind === 'missing'
          ? { title: 'Video not found', body: 'It may have been removed, or the link is wrong.' }
          : { title: "Couldn't load this video", body: state.message };
    return (
      <div style={{ display: 'grid', gap: tokens.space.md, maxWidth: 960, margin: '0 auto' }}>
        {back}
        <Card>
          <EmptyState icon="🎬" title={copy.title} body={copy.body} />
          <div style={{ marginTop: 12 }}>
            <Link to="/messages" style={{ color: tokens.color.accent, fontSize: 13 }}>
              Message your firm →
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  const { video, url } = state;
  const availability = formatAvailableUntil(video.expiresAt);
  const canReply = !me?.isImpersonation;

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 960, margin: '0 auto' }}>
      {back}
      <SectionHeading
        eyebrow={video.engagementName}
        title={video.title}
        description={[video.clientName, availability].filter(Boolean).join(' · ') || undefined}
      />

      <div
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '16 / 9',
          background: '#000',
          borderRadius: tokens.radius.md,
          overflow: 'hidden',
        }}
      >
        {playbackError ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              padding: 24,
              color: '#fff',
              fontSize: 14,
              textAlign: 'center',
            }}
          >
            {playbackError}
          </div>
        ) : (
          // playsInline keeps iOS from forcing native fullscreen; no
          // autoplay, so the play event only ever comes from a real tap.
          // eslint-disable-next-line jsx-a11y/media-has-caption -- firm-recorded walkthroughs have no caption track
          <video
            ref={videoRef}
            key={url}
            src={url}
            controls
            playsInline
            preload="metadata"
            controlsList="nodownload noremoteplayback"
            disablePictureInPicture={false}
            onContextMenu={(e) => e.preventDefault()}
            onLoadedMetadata={onLoadedMetadata}
            onPlay={() => {
              const v = videoRef.current;
              trackerRef.current?.onPlay(v?.duration || null);
            }}
            onTimeUpdate={() => {
              const v = videoRef.current;
              if (v) trackerRef.current?.onProgress(v.currentTime, v.duration || null);
            }}
            onPause={() => {
              const v = videoRef.current;
              if (v && !v.ended) trackerRef.current?.flush(v.currentTime, v.duration || null);
            }}
            onEnded={() => {
              const v = videoRef.current;
              trackerRef.current?.onEnded(v?.duration || null);
            }}
            onError={() => void recoverFromError()}
            style={{ width: '100%', height: '100%', display: 'block', background: '#000' }}
          />
        )}
      </div>

      {video.message && (
        <Card>
          <p style={{ margin: 0, fontSize: 14, whiteSpace: 'pre-wrap' }}>{video.message}</p>
        </Card>
      )}

      <section>
        <SectionHeading
          title="Reply to your firm"
          description="Questions about this video? Your message goes to the team working on this engagement."
          action={
            conversation?.threadId ? (
              <Link
                to={`/messages?thread=${conversation.threadId}`}
                style={{ color: tokens.color.accent, fontSize: 13 }}
              >
                Open full conversation →
              </Link>
            ) : undefined
          }
        />
        <Card>
          {conversation && conversation.items.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
              {conversation.items.map((m) => (
                <div
                  key={m.id}
                  style={{
                    alignSelf: m.senderKind === 'client' ? 'flex-end' : 'flex-start',
                    maxWidth: '85%',
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.md,
                    padding: tokens.space.sm,
                    background:
                      m.senderKind === 'client' ? tokens.color.accentMuted : tokens.color.surface,
                  }}
                >
                  <div
                    style={{
                      fontSize: 11,
                      color: tokens.color.textMuted,
                      marginBottom: 4,
                      display: 'flex',
                      gap: 8,
                      flexWrap: 'wrap',
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ fontWeight: 500 }}>
                      {m.mine
                        ? 'You'
                        : (m.senderName ?? (m.senderKind === 'staff' ? 'Your firm' : 'Client'))}
                    </span>
                    <span>{new Date(m.createdAt).toLocaleString()}</span>
                    {m.aboutThisVideo && <Pill tone="accent">Re: this video</Pill>}
                  </div>
                  <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{m.body}</div>
                </div>
              ))}
            </div>
          )}
          {canReply ? (
            <form onSubmit={(e) => void sendReply(e)} style={{ display: 'grid', gap: 8 }}>
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={3}
                maxLength={10_000}
                placeholder="Type your reply…"
                aria-label="Reply to your firm about this video"
                style={{
                  padding: '8px 10px',
                  fontSize: 14,
                  fontFamily: 'inherit',
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  background: tokens.color.surface,
                  color: tokens.color.text,
                  resize: 'vertical',
                }}
              />
              {replyError && (
                <p role="alert" style={{ margin: 0, fontSize: 12, color: tokens.color.danger }}>
                  {replyError}
                </p>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button type="submit" size="sm" disabled={sending || !reply.trim()}>
                  {sending ? 'Sending…' : 'Send reply'}
                </Button>
              </div>
            </form>
          ) : (
            <p style={{ margin: 0, fontSize: 12, color: tokens.color.textMuted }}>
              Replies are disabled while viewing as this client.
            </p>
          )}
        </Card>
      </section>
    </div>
  );
}
