// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Right pane of the SMS inbox (addendum Phase 8): header chips + actions,
// triage prompt, message bubbles with delivery status, and the reply
// composer. Live-updates from the app stream; marks the thread read after
// it has been visible for a moment (unless "Mark unread" armed it).

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { usePermission, useAuth } from '../../auth-context';
import { useSmsStream } from '../../lib/sms-stream';
import { formatPhone } from './ConversationRow';
import { CreateSmsTimeEntryDialog } from './CreateSmsTimeEntryDialog';
import { LinkClientDialog } from './LinkClientDialog';
import { SmsComposer } from './SmsComposer';
import { SmsThreadHeader, type ThreadAction } from './SmsThreadHeader';
import { TriagePanel } from './TriagePanel';
import type { SmsConversation, SmsConversationDetail, SmsMessage, SmsTemplate } from './types';

export interface SmsThreadPaneProps {
  conversationId: string | null;
  narrow: boolean;
  onBack: () => void;
  onRowChanged: (row: SmsConversation) => void;
  onMarkUnread: (id: string) => void;
  onOpenConversation: (id: string) => void;
  emptyLabel: string;
  /** embedded in a client/engagement card: no header link chips, tighter */
  embedded?: boolean;
  maxHeight?: number;
}

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'danger' | 'warning'> = {
  delivered: 'success',
  undelivered: 'danger',
  failed: 'danger',
  dead_letter: 'danger',
  received: 'neutral',
};

export function describeTwilioError(code: number | null): string | null {
  switch (code) {
    case 21610:
      return 'Recipient has opted out (STOP).';
    case 30003:
      return 'Unreachable — device off or out of coverage.';
    case 30005:
      return 'Unknown destination number.';
    case 30006:
      return 'Landline or unreachable carrier.';
    case 30007:
      return 'Filtered by the carrier (possible spam classification).';
    case 30034:
      return 'Blocked: US A2P 10DLC registration incomplete.';
    default:
      return code ? `Twilio error ${code}` : null;
  }
}

export function MessageBubble({
  m,
  contactName,
}: {
  m: SmsMessage;
  contactName: string;
}): JSX.Element {
  const out = m.direction === 'outbound';
  const tone = STATUS_TONE[m.providerStatus] ?? 'neutral';
  const err = describeTwilioError(m.providerErrorCode);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: out ? 'flex-end' : 'flex-start',
      }}
    >
      <div
        style={{
          maxWidth: '85%',
          padding: '8px 12px',
          borderRadius: tokens.radius.md,
          background: out ? tokens.color.accentMuted : tokens.color.surface,
          border: `1px solid ${out ? tokens.color.accent : tokens.color.border}`,
          color: tokens.color.text,
          fontSize: 13,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
        }}
      >
        {m.body || (m.numMedia > 0 ? '' : '(empty)')}
        {m.media.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: m.body ? 6 : 0 }}>
            {m.media.map((md) => {
              const isImg = (md.contentType ?? '').startsWith('image/');
              const href = md.intakeSessionId ? `/intake?session=${md.intakeSessionId}` : md.url;
              const inner =
                isImg && md.url ? (
                  <img
                    src={md.url}
                    alt="attachment"
                    style={{
                      maxWidth: 160,
                      maxHeight: 160,
                      borderRadius: tokens.radius.sm,
                      display: 'block',
                    }}
                  />
                ) : (
                  <span style={{ fontSize: 12 }}>
                    📎 {md.contentType ?? 'file'}
                    {md.status === 'pending'
                      ? ' (processing…)'
                      : md.status === 'failed'
                        ? ' (failed)'
                        : ''}
                  </span>
                );
              return href ? (
                <a
                  key={md.id}
                  href={href}
                  style={{ color: tokens.color.accent }}
                  title={md.intakeSessionId ? 'Open in Intake' : 'Open'}
                >
                  {inner}
                </a>
              ) : (
                <span key={md.id}>{inner}</span>
              );
            })}
          </div>
        )}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          fontSize: 11,
          color: tokens.color.textMuted,
          marginTop: 2,
          flexWrap: 'wrap',
        }}
      >
        <span>
          {out
            ? (m.sentBy?.name ?? (m.contextKind === 'auto_reply' ? 'Auto-reply' : 'System'))
            : contactName}
        </span>
        <span>· {new Date(m.createdAt).toLocaleString()}</span>
        {out && (
          <span title={err ?? undefined}>
            <Pill tone={tone}>{m.providerStatus.replace('_', ' ')}</Pill>
          </span>
        )}
        {out && m.numSegments != null && m.numSegments > 1 && (
          <span>· {m.numSegments} segments</span>
        )}
        {m.parsedIntent === 'confirm' && <Pill tone="success">Confirmed appointment</Pill>}
        {m.parsedIntent === 'reschedule' && <Pill tone="warning">Reschedule requested</Pill>}
        {m.redactionFlags?.length > 0 && <Pill tone="neutral">PII pattern</Pill>}
      </div>
    </div>
  );
}

export function useSmsThread(conversationId: string | null): {
  detail: SmsConversationDetail | null;
  setDetail: (d: SmsConversationDetail | null) => void;
  messages: SmsMessage[];
  error: string | null;
  reloadDetail: () => Promise<SmsConversationDetail | null>;
  reloadMessages: () => Promise<void>;
} {
  const [detail, setDetail] = useState<SmsConversationDetail | null>(null);
  const [messages, setMessages] = useState<SmsMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const stream = useSmsStream();

  const reloadDetail = useCallback(async (): Promise<SmsConversationDetail | null> => {
    if (!conversationId) return null;
    try {
      const d = await api<SmsConversationDetail>(`/api/staff/sms/conversations/${conversationId}`);
      setDetail(d);
      return d;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
      return null;
    }
  }, [conversationId]);

  const reloadMessages = useCallback(async (): Promise<void> => {
    if (!conversationId) return;
    try {
      const r = await api<{ items: SmsMessage[] }>(
        `/api/staff/sms/conversations/${conversationId}/messages`,
      );
      setMessages(r.items ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
    }
  }, [conversationId]);

  useEffect(() => {
    setDetail(null);
    setMessages([]);
    setError(null);
    void reloadDetail();
    void reloadMessages();
  }, [reloadDetail, reloadMessages]);

  useEffect(() => {
    if (!conversationId) return;
    return stream.subscribe((evt) => {
      if (evt.type === 'sms.refresh') {
        void reloadMessages();
        return;
      }
      if (evt.conversationId !== conversationId) return;
      if (evt.type === 'sms.message.created' || evt.type === 'sms.message.status')
        void reloadMessages();
      if (evt.type !== 'sms.message.status') void reloadDetail();
    });
  }, [stream, conversationId, reloadDetail, reloadMessages]);

  return { detail, setDetail, messages, error, reloadDetail, reloadMessages };
}

export function SmsThreadPane(props: SmsThreadPaneProps): JSX.Element {
  const { conversationId, narrow, onBack, emptyLabel, onRowChanged, embedded } = props;
  const { detail, setDetail, messages, error, reloadDetail, reloadMessages } =
    useSmsThread(conversationId);
  const canWrite = usePermission('sms:write');
  const canAssign = usePermission('sms:assign');
  const canSettings = usePermission('sms:settings');
  const { me } = useAuth();
  const stream = useSmsStream();
  const [users, setUsers] = useState<Array<{ id: string; fullName: string; status?: string }>>([]);
  const [templates, setTemplates] = useState<SmsTemplate[]>([]);
  const [linking, setLinking] = useState(false);
  const [timeEntryOpen, setTimeEntryOpen] = useState(false);
  const [closePrompt, setClosePrompt] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const unreadArmed = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void api<{ users: Array<{ id: string; fullName: string; status?: string }> }>(
      '/api/staff/admin/users',
    )
      .then((r) => setUsers((r.users ?? []).filter((u) => u.status !== 'DISABLED')))
      .catch(() => undefined);
    void api<{ items: SmsTemplate[] }>('/api/staff/sms/templates')
      .then((r) => setTemplates(r.items ?? []))
      .catch(() => undefined);
  }, []);

  // Auto-scroll to the newest bubble.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, conversationId]);

  // Auto-read an unread thread after it's been visible briefly.
  useEffect(() => {
    if (!conversationId || !detail || detail.unreadCount === 0) return;
    if (unreadArmed.current === conversationId) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const t = setTimeout(() => {
      void api(`/api/staff/sms/conversations/${conversationId}/read`, { method: 'POST' })
        .then(() => {
          stream.refreshUnread();
          const fresh = { ...detail, unreadCount: 0 };
          setDetail(fresh);
          onRowChanged(fresh);
        })
        .catch(() => undefined);
    }, 1500);
    return () => clearTimeout(t);
  }, [conversationId, detail, stream, setDetail, onRowChanged]);

  function applyUpdated(d: SmsConversationDetail): void {
    setDetail(d);
    onRowChanged(d);
  }

  async function patch(body: Record<string, unknown>): Promise<void> {
    if (!conversationId) return;
    setActionError(null);
    try {
      const d = await api<SmsConversationDetail>(`/api/staff/sms/conversations/${conversationId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      applyUpdated(d);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'update_failed');
    }
  }

  async function act(a: ThreadAction): Promise<void> {
    if (!conversationId || !detail) return;
    setNotice(null);
    switch (a) {
      case 'mark_unread':
        unreadArmed.current = conversationId;
        props.onMarkUnread(conversationId);
        await api(`/api/staff/sms/conversations/${conversationId}/unread`, {
          method: 'POST',
        }).catch(() => undefined);
        await reloadDetail().then((d) => d && onRowChanged(d));
        stream.refreshUnread();
        break;
      case 'assign_me':
        await patch({ assignedUserId: me?.appUserId ?? null });
        break;
      case 'link':
        setLinking(true);
        break;
      case 'unlink':
        try {
          applyUpdated(
            await api<SmsConversationDetail>(
              `/api/staff/sms/conversations/${conversationId}/unlink`,
              { method: 'POST' },
            ),
          );
        } catch (err) {
          setActionError(err instanceof Error ? err.message : 'unlink_failed');
        }
        break;
      case 'rematch':
        try {
          const r = await api<{ result: string; detail: SmsConversationDetail }>(
            `/api/staff/sms/conversations/${conversationId}/rematch`,
            { method: 'POST' },
          );
          applyUpdated(r.detail);
          setNotice(
            r.result === 'none'
              ? 'No match found for this number.'
              : `Matched via ${r.result.replace('_', ' ')}.`,
          );
        } catch (err) {
          setActionError(err instanceof Error ? err.message : 'rematch_failed');
        }
        break;
      case 'close':
        await patch({ status: 'closed' });
        // D12 — prompt (never automatic) for a time entry on close.
        setClosePrompt(Boolean(detail.engagement));
        break;
      case 'spam':
        await patch({ status: 'spam' });
        break;
      case 'reopen':
        await patch({ status: 'open' });
        break;
      case 'set_engagement':
        setNotice('Pick an engagement in the composer — your next reply confirms it.');
        break;
      case 'time_entry':
        setTimeEntryOpen(true);
        break;
      default:
        break;
    }
  }

  async function reply(draft: { body: string; engagementId: string | null }): Promise<void> {
    if (!conversationId) return;
    await api(`/api/staff/sms/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: draft.body, engagementId: draft.engagementId }),
    });
    await reloadMessages();
    const d = await reloadDetail();
    if (d) onRowChanged(d);
    stream.refreshUnread();
  }

  async function recordConsent(): Promise<void> {
    if (!detail?.contact) return;
    await api(`/api/staff/people/${detail.contact.personId}/sms-consent`, {
      method: 'POST',
      body: JSON.stringify({ source: 'verbal' }),
    });
    const d = await reloadDetail();
    if (d) onRowChanged(d);
  }

  const contactName =
    detail?.contact?.name ?? (detail ? formatPhone(detail.externalNumberE164) : '');
  const title = detail
    ? [detail.contact?.name ?? formatPhone(detail.externalNumberE164), detail.client?.name]
        .filter(Boolean)
        .join(' — ')
    : conversationId
      ? 'Loading…'
      : 'Pick a conversation';
  const listMax = props.maxHeight ?? (embedded ? 360 : 440);

  return (
    <Card
      title={title}
      action={
        <span style={{ display: 'inline-flex', gap: 12, alignItems: 'center' }}>
          {embedded && conversationId && (
            <a
              href={`/messages?tab=sms&c=${conversationId}`}
              style={{ fontSize: 12, color: tokens.color.accent, textDecoration: 'none' }}
            >
              Open in inbox →
            </a>
          )}
          {narrow && conversationId && (
            <button
              type="button"
              onClick={onBack}
              style={{
                border: 'none',
                background: 'transparent',
                color: tokens.color.accent,
                cursor: 'pointer',
                fontSize: 13,
                padding: 0,
              }}
            >
              ← All conversations
            </button>
          )}
        </span>
      }
    >
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 13 }} role="alert">
          {error}
        </p>
      )}
      {!conversationId ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>{emptyLabel}</p>
      ) : (
        <>
          {detail && (
            <SmsThreadHeader
              detail={detail}
              users={users}
              canWrite={canWrite}
              canAssign={canAssign}
              onAction={(a) => void act(a)}
              onAssign={(userId) => void patch({ assignedUserId: userId })}
            />
          )}
          {detail?.needsTriage && (
            <TriagePanel
              detail={detail}
              canAssign={canAssign}
              onLinked={applyUpdated}
              onPickOther={() => setLinking(true)}
            />
          )}
          {(notice || actionError) && (
            <p
              style={{
                fontSize: 12,
                color: actionError ? tokens.color.danger : tokens.color.textMuted,
                margin: '0 0 8px',
              }}
              role={actionError ? 'alert' : 'status'}
            >
              {actionError ?? notice}
            </p>
          )}
          <div
            ref={scroller}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              maxHeight: listMax,
              overflowY: 'auto',
              padding: '4px 2px',
              marginBottom: 10,
            }}
          >
            {messages.length === 0 && !error && (
              <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
                No messages yet.
              </p>
            )}
            {messages.map((m) => (
              <MessageBubble key={m.id} m={m} contactName={contactName} />
            ))}
          </div>
          <SmsComposer
            mode="reply"
            detail={detail}
            canWrite={canWrite}
            canSettings={canSettings}
            templates={templates}
            engagementId={detail?.engagement?.id ?? null}
            block={detail?.replyBlockReason ?? null}
            onSubmit={reply}
            onRecordConsent={recordConsent}
            onReopen={() => patch({ status: 'open' })}
          />
          {closePrompt && detail && (
            <div
              role="status"
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                flexWrap: 'wrap',
                marginTop: 8,
                fontSize: 12,
              }}
            >
              <span>Closed. Create a time entry for this conversation?</span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setClosePrompt(false);
                  setTimeEntryOpen(true);
                }}
              >
                Create time entry
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setClosePrompt(false)}>
                Not now
              </Button>
            </div>
          )}
          {detail && detail.status !== 'open' && (
            <div style={{ marginTop: 6 }}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void patch({ status: 'open' })}
                disabled={!canWrite}
              >
                Reopen conversation
              </Button>
            </div>
          )}
        </>
      )}
      {timeEntryOpen && detail && (
        <CreateSmsTimeEntryDialog
          detail={detail}
          onClose={() => setTimeEntryOpen(false)}
          onCreated={() => {
            setTimeEntryOpen(false);
            setNotice('Time entry created.');
          }}
        />
      )}
      {linking && detail && (
        <LinkClientDialog
          detail={detail}
          initialClientId={detail.client?.id ?? null}
          onClose={() => setLinking(false)}
          onLinked={(d) => {
            setLinking(false);
            applyUpdated(d);
          }}
        />
      )}
    </Card>
  );
}
